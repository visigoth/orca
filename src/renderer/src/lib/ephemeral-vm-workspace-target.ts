import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../../shared/project-types'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../../../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from '../../../shared/ephemeral-vm-recipe-diagnostics'
import { PROJECT_HOST_SETUP_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { translate } from '@/i18n/i18n'
import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'

export type PrepareEphemeralVmWorkspaceTargetArgs = {
  repoId: string
  recipeId: string
  projectId: string
  workspaceName: string
  branch?: string
  ref?: string
  provisionId?: string
  setupExistingFolder: (
    args: ProjectHostSetupExistingFolderArgs
  ) => Promise<ProjectHostSetupResult | null>
}

/**
 * Where the workspace will be created, flattened out of whatever registered it.
 *
 * A projection rather than the `ProjectHostSetupResult` itself: the runtime's single-call
 * registration returns these five fields and nothing else, and fabricating a Project/Repo pair
 * around them to satisfy a type would invent rows that do not exist here.
 */
export type PreparedEphemeralVmWorkspaceTarget = {
  repoId: string
  path: string
  projectId: string
  projectHostSetupId: string
  hostId: ExecutionHostId
}

export type PrepareEphemeralVmWorkspaceTargetResult =
  | {
      ok: true
      target: PreparedEphemeralVmWorkspaceTarget
      runtimeId: string
      checkoutMode: 'orca-worktree' | 'provisioned-root'
      environmentId?: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: false
      error: string
      stderr: string
    }

export async function prepareEphemeralVmWorkspaceTarget(
  args: PrepareEphemeralVmWorkspaceTargetArgs
): Promise<PrepareEphemeralVmWorkspaceTargetResult> {
  // The browser client cannot run the two-step flow below: `provision` streams progress over
  // Electron IPC, and the local-provider registration that follows it refuses the ssh: host a
  // recipe produces. The runtime does both halves in one RPC instead, so prefer it wherever it
  // exists — see EphemeralVmApi.provisionWorkspaceTarget.
  const provisionWorkspaceTarget = window.api.ephemeralVm.provisionWorkspaceTarget
  if (provisionWorkspaceTarget) {
    return await prepareOnRuntime(provisionWorkspaceTarget, args)
  }
  const provisioned = await window.api.ephemeralVm.provision({
    repoId: args.repoId,
    recipeId: args.recipeId,
    projectId: args.projectId,
    workspaceName: args.workspaceName,
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.ref ? { ref: args.ref } : {}),
    ...(args.provisionId ? { provisionId: args.provisionId } : {})
  })
  if (!provisioned.ok) {
    return { ok: false, error: provisioned.error, stderr: provisioned.stderr }
  }

  const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult)
  if (checkoutMode === 'provisioned-root' && provisioned.connectionType !== 'ssh') {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
    return {
      ok: false,
      error: translate(
        'auto.lib.ephemeralVmWorkspaceTarget.provisionedRootRequiresSsh',
        'Provisioned-root recipes currently require a direct SSH connection.'
      ),
      stderr: provisioned.stderr
    }
  }

  const hostId =
    provisioned.connectionType === 'ssh'
      ? toSshExecutionHostId(provisioned.sshTargetId)
      : toRuntimeExecutionHostId(provisioned.environment.id)

  if (provisioned.connectionType === 'orca-server') {
    try {
      await assertRuntimeEnvironmentCapability(
        provisioned.environment.id,
        PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
        'The recipe-created Orca server does not support project setup.'
      )
    } catch (error) {
      await cleanupProvisionedRuntime(provisioned.runtime.id)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stderr: provisioned.stderr
      }
    }
  }

  let setup: ProjectHostSetupResult | null
  try {
    setup = await args.setupExistingFolder({
      projectId: args.projectId,
      hostId,
      path: getEphemeralVmRecipeResultProjectRoot(provisioned.runtime.recipeResult),
      setupMethod: 'imported-existing-folder'
    })
  } catch (error) {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: provisioned.stderr
    }
  }
  if (!setup) {
    await cleanupProvisionedRuntime(provisioned.runtime.id)
    return {
      ok: false,
      error: translate(
        'auto.lib.ephemeralVmWorkspaceTarget.projectRootRegistrationFailed',
        'Failed to register the recipe-created project root on the runtime.'
      ),
      stderr: provisioned.stderr
    }
  }
  setup = {
    ...setup,
    setup: {
      ...setup.setup,
      // Why: the sandbox reports its own checkout as "local"; the desktop app
      // must route follow-up worktree operations back through this runtime.
      hostId
    }
  }

  const success = {
    ok: true,
    target: {
      repoId: setup.repo.id,
      path: setup.repo.path,
      projectId: setup.setup.projectId,
      projectHostSetupId: setup.setup.id,
      hostId
    },
    runtimeId: provisioned.runtime.id,
    checkoutMode,
    ...(checkoutMode === 'provisioned-root' &&
    provisioned.connectionType === 'ssh' &&
    provisioned.expectedRefHead
      ? { expectedRefHead: provisioned.expectedRefHead }
      : {}),
    stderr: provisioned.stderr,
    warnings: provisioned.warnings
  } satisfies PrepareEphemeralVmWorkspaceTargetResult

  return provisioned.connectionType === 'orca-server'
    ? { ...success, environmentId: provisioned.environment.id }
    : success
}

/**
 * The runtime-RPC path: one call provisions the environment AND registers the checkout on it.
 *
 * No progress stream and no cancellation, because there is no per-chunk channel behind an RPC —
 * the recipe's stderr reaches the caller only if the create FAILS, carried on the error.
 */
async function prepareOnRuntime(
  provisionWorkspaceTarget: NonNullable<typeof window.api.ephemeralVm.provisionWorkspaceTarget>,
  args: PrepareEphemeralVmWorkspaceTargetArgs
): Promise<PrepareEphemeralVmWorkspaceTargetResult> {
  let provisioned: Awaited<ReturnType<typeof provisionWorkspaceTarget>>
  try {
    provisioned = await provisionWorkspaceTarget({
      repoId: args.repoId,
      recipeId: args.recipeId,
      projectId: args.projectId,
      workspaceName: args.workspaceName,
      ...(args.branch ? { branch: args.branch } : {}),
      ...(args.ref ? { ref: args.ref } : {})
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: ''
    }
  }

  if (provisioned.checkoutMode === 'provisioned-root' && provisioned.connectionType !== 'ssh') {
    await cleanupProvisionedRuntime(provisioned.runtimeId)
    return {
      ok: false,
      error: translate(
        'auto.lib.ephemeralVmWorkspaceTarget.provisionedRootRequiresSsh',
        'Provisioned-root recipes currently require a direct SSH connection.'
      ),
      stderr: ''
    }
  }

  const parsedHost = parseExecutionHostId(provisioned.hostId)
  return {
    ok: true,
    target: {
      repoId: provisioned.repoId,
      path: provisioned.path,
      projectId: provisioned.projectId,
      projectHostSetupId: provisioned.projectHostSetupId,
      hostId: parsedHost?.id ?? LOCAL_EXECUTION_HOST_ID
    },
    runtimeId: provisioned.runtimeId,
    checkoutMode: provisioned.checkoutMode,
    ...(parsedHost?.kind === 'runtime' ? { environmentId: parsedHost.environmentId } : {}),
    ...(provisioned.expectedRefHead ? { expectedRefHead: provisioned.expectedRefHead } : {}),
    stderr: '',
    warnings: provisioned.warnings
  }
}

async function cleanupProvisionedRuntime(runtimeId: string): Promise<void> {
  try {
    await window.api.ephemeralVm.cleanup({ runtimeId })
  } catch {
    // Best effort: the caller still needs the original setup/provisioning error.
  }
}
