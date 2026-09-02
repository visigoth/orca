import type { Store } from '../persistence'
import type { PluginService } from '../plugins/plugin-service'
import type {
  EphemeralVmCleanupOutcome,
  EphemeralVmHost,
  EphemeralVmProvisionOutcome,
  EphemeralVmProvisionRequest,
  EphemeralVmRepoRegistration
} from '../../shared/ephemeral-vm-host'
import { getAppEnvironment } from '../../shared/app-environment'
import { parseExecutionHostId } from '../../shared/execution-host'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { cleanupEphemeralVmRuntimeById } from '../ephemeral-vm-cleanup'
import { cleanupEphemeralVmRuntimesForDeleted } from '../ephemeral-vm-cleanup-for-deleted'
import { attachEphemeralVmRuntimeToWorkspace } from '../ephemeral-vm-runtime-attachment'
import { provisionEphemeralVmForRepo } from '../ephemeral-vm-provision-core'
import { listRecipes } from '../ipc/ephemeral-vm-recipe-context'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import { addRemoteRepoFromPath } from '../ipc/repos/remote-repo-registration'
import { alignRepoWithRequestedProject } from '../ipc/repos/project-host-setup-handlers'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'

/**
 * Desktop-backed EphemeralVmHost.
 *
 * This is the ONLY module that joins the environment-recipe RPCs to their implementations, and
 * it lives here rather than beside those RPCs on purpose: everything imported above reaches
 * `electron`, directly or transitively through the SSH IPC layer, and the runtime must stay
 * bootable on plain Node. Concentrating those imports in one host module keeps the runtime's
 * import graph free of them — which `pnpm run build:orcad` and the runtime-electron ratchet both
 * verify against an intentionally empty baseline.
 *
 * The store and plugin service arrive as accessors rather than instances because host ports are
 * installed during preflight, before the ready phase constructs either one. Reading them per call
 * keeps this install beside every other port instead of being the one that has to wait.
 */
export class ElectronEphemeralVmHost implements EphemeralVmHost {
  constructor(
    private readonly getStore: () => Store,
    private readonly getPluginService: () => PluginService | undefined
  ) {}

  private userDataPath(): string {
    return getAppEnvironment().getPath('userData')
  }

  async listRecipes(repoId: string): Promise<unknown> {
    return listRecipes(
      this.getStore(),
      repoId,
      await getApprovedPluginVmRecipes(this.getPluginService())
    )
  }

  async provision(request: EphemeralVmProvisionRequest): Promise<EphemeralVmProvisionOutcome> {
    const result = await provisionEphemeralVmForRepo(
      this.getStore(),
      this.getPluginService(),
      request
    )
    if (!result.ok) {
      return { ok: false, error: result.error, stderr: result.stderr, stdout: result.stdout }
    }
    // Flatten to the structural shape the port declares, so the RPC layer never handles an
    // Electron-flavoured record.
    return {
      ok: true,
      connectionType: result.connectionType,
      runtimeId: result.runtime.id,
      ...(result.connectionType === 'ssh' ? { sshTargetId: result.sshTargetId } : {}),
      ...(result.connectionType === 'orca-server' ? { environmentId: result.environment.id } : {}),
      recipeResult: result.runtime.recipeResult,
      ...(result.connectionType === 'ssh' && result.expectedRefHead
        ? { expectedRefHead: result.expectedRefHead }
        : {}),
      warnings: result.warnings
    }
  }

  async registerProvisionedRepo(args: {
    hostId: string
    projectId: string
    path: string
    sshTargetId?: string
  }): Promise<EphemeralVmRepoRegistration> {
    // An ssh: host cannot go through the local-provider path: it uses the LOCAL git and
    // filesystem providers, so it would probe this machine and register the result as remote —
    // which is why that RPC refuses ssh: hosts outright.
    if (parseExecutionHostId(args.hostId)?.kind !== 'ssh') {
      return { ok: false, error: `Unsupported host for provisioned repo: ${args.hostId}` }
    }
    const store = this.getStore()
    const registered = await addRemoteRepoFromPath(store, {
      connectionId: args.sshTargetId ?? '',
      remotePath: args.path,
      setupMethod: 'imported-existing-folder'
    })
    if ('error' in registered) {
      return { ok: false, error: registered.error }
    }
    try {
      const setup = alignRepoWithRequestedProject(
        store,
        registered.repo,
        args.projectId,
        'imported-existing-folder'
      )
      invalidateAuthorizedRootsCache()
      return {
        ok: true,
        repoId: setup.repo.id,
        projectHostSetupId: setup.setup.id,
        projectId: setup.project.id,
        path: setup.repo.path
      }
    } catch (error) {
      // An import that cannot be linked must not leave a repo registration or an authorization
      // root behind — the same cleanup the desktop handler performs.
      if (!registered.alreadyExisted) {
        store.removeProject(registered.repo.id)
      }
      invalidateAuthorizedRootsCache()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  attachWorkspace(args: { runtimeId: string; workspaceId: string }): unknown {
    return attachEphemeralVmRuntimeToWorkspace({
      userDataPath: this.userDataPath(),
      runtimeId: args.runtimeId,
      workspaceId: args.workspaceId
    })
  }

  listRuntimes(): unknown[] {
    return listEphemeralVmRuntimes(this.userDataPath())
  }

  async cleanupRuntime(runtimeId: string): Promise<EphemeralVmCleanupOutcome> {
    const userDataPath = this.userDataPath()
    // Read the target BEFORE cleanup: afterwards the record no longer names it, and the project
    // rows pinned to it could not be found.
    const targetBefore = listEphemeralVmRuntimes(userDataPath).find(
      (entry) => entry.id === runtimeId
    )?.sshTargetId
    const cleaned = await cleanupEphemeralVmRuntimeById({
      store: this.getStore(),
      userDataPath,
      runtimeId
    })
    if (targetBefore && !cleaned.sshTargetId) {
      const { purgeOrphanedRuntimeSshProjects } =
        await import('../ephemeral-vm-orphaned-project-purge')
      purgeOrphanedRuntimeSshProjects(this.getStore(), [targetBefore])
    }
    return {
      runtimeId: cleaned.id,
      ...(cleaned.cleanupStatus ? { cleanupStatus: cleaned.cleanupStatus } : {}),
      ...(cleaned.sshTargetId ? { sshTargetId: cleaned.sshTargetId } : {})
    }
  }

  async cleanupForDeleted(args: {
    workspaceIds?: readonly string[]
    hostScopedWorkspaces?: readonly { workspaceId: string; executionHostId: string }[]
    runtimeOwnedSshTargetIds?: readonly string[]
  }): Promise<{ destroyedSshTargetIds: string[]; retainedSshTargetIds: string[] }> {
    return cleanupEphemeralVmRuntimesForDeleted({
      store: this.getStore(),
      ...args
    } as Parameters<typeof cleanupEphemeralVmRuntimesForDeleted>[0])
  }
}
