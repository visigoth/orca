import type { PreloadApi } from '../../../../preload/api-types'
import type { EphemeralVmProvisionedWorkspaceTarget } from '../../../../shared/ephemeral-vm-host'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import type { OrcaVmRecipe } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { callRuntimeResult } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

/**
 * Environment recipes for the browser client.
 *
 * Without this the whole surface fell through the fallback proxy: `listRecipes` answered `[]`
 * like every other `list*`, so the "Run on" picker had no recipes to show and a web-created
 * workspace could only ever run on the Orca host itself — the one place holding the podman
 * socket the workhorse containers deliberately lack. The runtime already exposes the work over
 * RPC for the CLI (`vm.*`); this is the same surface reached from the browser.
 *
 * Two methods are deliberately NOT the desktop's:
 *   - `provision` needs an in-process progress channel and a follow-up local registration, so it
 *     stays Electron-only. Web callers use `provisionWorkspaceTarget`, which does
 *     provision-then-register in ONE RPC — splitting it would orphan a booted environment
 *     whenever the browser tab died in between.
 *   - `listRecipeCatalog` has no RPC of its own, so it is composed here from `repo.list` plus a
 *     per-repo `vm.listRecipes`. The catalog is a settings-pane read of a handful of repos, not
 *     a hot path.
 *
 * The rest of the surface — doctor, cleanup command preview, suspend/resume — has no runtime RPC
 * behind it at all. Each reports itself unavailable rather than silently answering `undefined`,
 * which is what the fallback proxy did and what made this feature look broken instead of absent.
 */

const UNAVAILABLE = 'This action is only available from the Orca desktop app.'

// Recipe hooks boot real environments: a container pull, an image build, a devcontainer up. The
// default per-call budget is sized for interactive RPCs and would abort a create that is still
// working, leaving the environment running with nobody holding its id.
const PROVISION_TIMEOUT_MS = 30 * 60_000

export type WebEphemeralVmApi = PreloadApi['ephemeralVm'] & {
  provisionWorkspaceTarget: (args: {
    repoId: string
    recipeId: string
    workspaceName?: string
    projectId?: string
    branch?: string
    ref?: string
  }) => Promise<EphemeralVmProvisionedWorkspaceTarget>
}

type RecipeListResult = Awaited<ReturnType<PreloadApi['ephemeralVm']['listRecipes']>>

export function createWebEphemeralVmApi(): WebEphemeralVmApi {
  return {
    listRecipes: (args) =>
      callRuntimeResult<RecipeListResult>('vm.listRecipes', { repo: args.repoId }),
    listRecipeCatalog: async () => {
      const { repos } = await callRuntimeResult<{ repos: Repo[] }>('repo.list')
      const entries = await Promise.all(
        repos.map(async (repo) => {
          try {
            const result = await callRuntimeResult<RecipeListResult>('vm.listRecipes', {
              repo: repo.id
            })
            return {
              repoId: repo.id,
              repoName: repo.displayName,
              repoPath: result.repoPath ?? repo.path,
              recipes: (result.recipes ?? []) as OrcaVmRecipe[],
              diagnostics: result.diagnostics ?? []
            }
          } catch {
            // Why: a repo the host cannot read recipes for (a folder row, an SSH-owned checkout)
            // must not blank the catalog for every other repo.
            return null
          }
        })
      )
      return entries
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .filter((entry) => entry.recipes.length > 0 || entry.diagnostics.length > 0)
    },
    doctor: async () => {
      throw new Error(UNAVAILABLE)
    },
    provision: async () => {
      throw new Error(UNAVAILABLE)
    },
    cancelProvision: () => Promise.resolve({ cancelled: false }),
    // Provisioning happens inside one RPC here, so there is no stream to subscribe to.
    onProvisionEvent: () => noopUnsubscribe,
    provisionWorkspaceTarget: (args) =>
      callRuntimeResult<EphemeralVmProvisionedWorkspaceTarget>(
        'vm.provisionWorkspaceTarget',
        {
          repo: args.repoId,
          recipeId: args.recipeId,
          ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
          ...(args.projectId ? { projectId: args.projectId } : {}),
          ...(args.branch ? { branch: args.branch } : {}),
          ...(args.ref ? { ref: args.ref } : {})
        },
        PROVISION_TIMEOUT_MS
      ),
    listRuntimes: () => callRuntimeResult<EphemeralVmRuntimeRecord[]>('vm.listRuntimes'),
    attachWorkspace: (args) =>
      callRuntimeResult<EphemeralVmRuntimeRecord>('vm.attachWorkspace', args),
    // Sleep/resume of a provisioned environment is desktop-only; null means "nothing suspended",
    // which is what the sleep flow already handles for a workspace with no environment.
    suspendWorkspace: () => Promise.resolve(null),
    resumeWorkspace: () => Promise.resolve(null),
    // `vm.cleanup` answers with the three fields the CLI prints, but every renderer caller reads
    // the RUNTIME RECORD: its cleanup status, its last error, whether it still owns an SSH
    // target. So the record is read back rather than the outcome reshaped into something that
    // looks like one — a synthesized record would report "cleaned, no error" for a cleanup that
    // failed.
    cleanup: async (args) => {
      await callRuntimeResult('vm.cleanup', args, PROVISION_TIMEOUT_MS)
      const runtimes = await callRuntimeResult<EphemeralVmRuntimeRecord[]>('vm.listRuntimes')
      const record = runtimes.find((runtime) => runtime.id === args.runtimeId)
      if (!record) {
        throw new Error(`Cleaned up ${args.runtimeId}, but the runtime record is no longer listed.`)
      }
      return record
    },
    stopCleanup: async () => {
      throw new Error(UNAVAILABLE)
    },
    getCleanupCommand: (args) =>
      Promise.resolve({
        runtimeId: args.runtimeId,
        command: null,
        payloadJson: '',
        cleanupDisabled: false,
        message: UNAVAILABLE
      })
  }
}
