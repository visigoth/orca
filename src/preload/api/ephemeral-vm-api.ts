import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from '../../shared/ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmProvisionedWorkspaceTarget } from '../../shared/ephemeral-vm-host'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'

export type EphemeralVmApi = {
  listRecipes: (args: { repoId: string }) => Promise<{
    status: 'ok' | 'error'
    repoPath: string | null
    recipes: OrcaHooks['environmentRecipes']
    diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
    message?: string
  }>
  listRecipeCatalog: () => Promise<
    {
      repoId: string
      repoName: string
      repoPath: string
      recipes: NonNullable<OrcaHooks['environmentRecipes']>
      diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
    }[]
  >
  doctor: (args: { repoId: string; recipeId: string }) => Promise<EphemeralVmRecipeDoctorResult>
  provision: (args: {
    repoId: string
    recipeId: string
    workspaceName?: string
    projectId?: string
    workspaceId?: string
    branch?: string
    ref?: string
    provisionId?: string
  }) => Promise<
    | {
        ok: true
        connectionType: 'orca-server'
        runtime: EphemeralVmRuntimeRecord
        environment: PublicKnownRuntimeEnvironment
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | {
        ok: true
        connectionType: 'ssh'
        runtime: EphemeralVmRuntimeRecord
        sshTargetId: string
        expectedRefHead?: string
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | { ok: false; error: string; stderr: string; stdout: string }
  >
  /**
   * Provision AND register the checkout in one call, for a client that cannot run the two-step
   * desktop flow: `provision` streams progress over IPC and hands back a local host id that only
   * the desktop can register. Present only where the runtime does the work (the browser client),
   * so callers feature-detect it rather than assume it.
   *
   * One call, not two, deliberately: a client that died between them would leave a booted
   * environment nothing references.
   */
  provisionWorkspaceTarget?: (args: {
    repoId: string
    recipeId: string
    workspaceName?: string
    projectId?: string
    branch?: string
    ref?: string
  }) => Promise<EphemeralVmProvisionedWorkspaceTarget>
  cancelProvision: (args: { provisionId: string }) => Promise<{ cancelled: boolean }>
  onProvisionEvent: (
    callback: (event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void
  ) => () => void
  listRuntimes: () => Promise<EphemeralVmRuntimeRecord[]>
  attachWorkspace: (args: {
    runtimeId: string
    workspaceId: string
  }) => Promise<EphemeralVmRuntimeRecord>
  suspendWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmRuntimeRecord | null>
  resumeWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmRuntimeRecord | null>
  cleanup: (args: { runtimeId: string }) => Promise<EphemeralVmRuntimeRecord>
  stopCleanup: (args: { runtimeId: string }) => Promise<EphemeralVmRuntimeRecord>
  getCleanupCommand: (args: { runtimeId: string }) => Promise<{
    runtimeId: string
    command: string | null
    payloadJson: string
    cleanupDisabled: boolean
    message?: string
  }>
}
