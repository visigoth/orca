import { z } from 'zod'
import { defineMethod } from '../core'
import { requiredString } from '../schemas'
import { getEphemeralVmHost, type EphemeralVmHost } from '../../../../shared/ephemeral-vm-host'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../../../../shared/ephemeral-vm-recipes'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'

/**
 * Environment recipes over runtime RPC.
 *
 * The recipe surface was previously Electron IPC only, so it was reachable from the app window
 * and nowhere else. `orca worktree create` therefore had no way to ask for a workspace on a
 * recipe-provisioned environment, and a scripted workspace silently ran on the Orca host instead
 * — which is exactly where an agent should not be when the host holds privileged sockets.
 *
 * Everything the work actually needs — provisioning, SSH-backed registration, teardown — arrives
 * through the EphemeralVmHost port rather than being imported. That is not stylistic: those
 * facilities reach `electron` and, through the SSH IPC layer, the browser stack and
 * `node:sqlite`. The runtime must stay bootable on plain Node (`pnpm run build:orcad`), and the
 * ratchet measures REACHABILITY, so even a dynamic `import()` here would pull the whole subgraph
 * into the runtime's bundle.
 *
 * `vm.provisionWorkspaceTarget` deliberately does provision-then-register in ONE call. The
 * renderer runs those as two steps because it drives a progress UI between them; a CLI caller has
 * no such need, and splitting it would orphan a provisioned environment whenever the second call
 * failed or the client died in between.
 */

function requireHost(): EphemeralVmHost {
  const host = getEphemeralVmHost()
  if (!host) {
    throw new Error('Environment recipes are not available on this runtime')
  }
  return host
}

const VmListRecipes = z.object({
  repo: requiredString('Missing repo selector')
})

const VmRuntimeId = z.object({ runtimeId: requiredString('Missing runtime id') })

const VmAttachWorkspace = z.object({
  runtimeId: requiredString('Missing runtime id'),
  workspaceId: requiredString('Missing workspace id')
})

const VmProvisionWorkspaceTarget = z.object({
  repo: requiredString('Missing repo selector'),
  recipeId: requiredString('Missing recipe id'),
  workspaceName: z.string().optional(),
  projectId: z.string().optional(),
  branch: z.string().optional(),
  ref: z.string().optional()
})

export const EPHEMERAL_VM_METHODS = [
  defineMethod({
    // Why: listing and cleaning provisioned runtimes was IPC-only, so a headless host could see
    // neither what it had provisioned nor tear any of it down. A create that fails partway leaves
    // a runtime behind by design — its SSH target stays registered so it can be retried or
    // released — and without these it stays behind forever.
    name: 'vm.listRuntimes',
    params: null,
    handler: async () => requireHost().listRuntimes()
  }),
  defineMethod({
    name: 'vm.cleanup',
    params: VmRuntimeId,
    handler: async (params) => requireHost().cleanupRuntime(params.runtimeId)
  }),
  defineMethod({
    // Why this exists: provisioning happens BEFORE the workspace, so the runtime record starts
    // with no workspaceId. The desktop binds them afterwards over IPC; without the same step the
    // record stays unattached and deletion can never match it — the environment then survives
    // every workspace it was created for.
    name: 'vm.attachWorkspace',
    params: VmAttachWorkspace,
    handler: async (params) =>
      requireHost().attachWorkspace({
        runtimeId: params.runtimeId,
        workspaceId: params.workspaceId
      })
  }),
  defineMethod({
    name: 'vm.listRecipes',
    params: VmListRecipes,
    handler: async (params, { runtime }) => {
      const repo = await runtime.showRepo(params.repo)
      return requireHost().listRecipes(repo.id)
    }
  }),
  defineMethod({
    name: 'vm.provisionWorkspaceTarget',
    params: VmProvisionWorkspaceTarget,
    handler: async (params, { runtime }) => {
      const host = requireHost()
      const repo = await runtime.showRepo(params.repo)
      const provisioned = await host.provision({
        repoId: repo.id,
        recipeId: params.recipeId,
        ...(params.workspaceName ? { workspaceName: params.workspaceName } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.branch ? { branch: params.branch } : {}),
        ...(params.ref ? { ref: params.ref } : {})
      })
      if (!provisioned.ok) {
        // Why: carry the recipe's own stderr. A create script fails for reasons only its output
        // explains — a missing image, an unreachable provider — and without it the caller gets a
        // bare "provisioning failed" with nothing to act on.
        throw new Error(
          provisioned.stderr.trim()
            ? `${provisioned.error}\n${provisioned.stderr.trim()}`
            : provisioned.error
        )
      }

      const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.recipeResult)
      const hostId =
        provisioned.connectionType === 'ssh'
          ? toSshExecutionHostId(provisioned.sshTargetId ?? '')
          : toRuntimeExecutionHostId(provisioned.environmentId ?? '')

      // projectId is required downstream. The renderer gates on a github: key to preserve
      // behaviour for portable projects, but a CLI caller always needs *some* id, and the shared
      // identity key is the canonical one — falling back to git:/repo: rather than inventing one.
      const projectId = params.projectId ?? getProjectIdentityKey(repo)
      const projectRoot = getEphemeralVmRecipeResultProjectRoot(provisioned.recipeResult)

      // An ssh: host goes through the port, because registering it needs the SSH providers and
      // the local-provider RPC below refuses ssh: hosts by design. A runtime: host is local to
      // this process and uses the ordinary path.
      let repoId: string
      let projectHostSetupId: string
      let resolvedProjectId: string
      let path: string
      if (provisioned.connectionType === 'ssh') {
        const registered = await host.registerProvisionedRepo({
          hostId,
          projectId,
          path: projectRoot,
          ...(provisioned.sshTargetId ? { sshTargetId: provisioned.sshTargetId } : {})
        })
        if (!registered.ok) {
          throw new Error(registered.error)
        }
        ;({ repoId, projectHostSetupId, path } = registered)
        resolvedProjectId = registered.projectId
      } else {
        const setup = await runtime.setupProjectExistingFolder({
          projectId,
          hostId,
          path: projectRoot,
          setupMethod: 'imported-existing-folder'
        })
        repoId = setup.repo.id
        projectHostSetupId = setup.setup.id
        resolvedProjectId = setup.project.id
        path = setup.repo.path
      }

      return {
        runtimeId: provisioned.runtimeId,
        connectionType: provisioned.connectionType,
        checkoutMode,
        hostId,
        projectHostSetupId,
        repoId,
        projectId: resolvedProjectId,
        path,
        ...(provisioned.expectedRefHead ? { expectedRefHead: provisioned.expectedRefHead } : {}),
        warnings: provisioned.warnings
      }
    }
  })
]
