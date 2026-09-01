import { getAppEnvironment } from '../shared/app-environment'
import type { Store } from './persistence'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeResultWarning
} from '../shared/ephemeral-vm-recipe-diagnostics'
import { getProvisionedRootRecipeRepoUrl } from '../shared/ephemeral-vm-recipe-repo-url'
import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { addEnvironmentFromPairingCode } from '../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../shared/runtime-environments'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import { connectRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'
import { getRecipeRepo, resolveRecipeForRepo } from './ipc/ephemeral-vm-recipe-context'
import type { PluginService } from './plugins/plugin-service'
import { getApprovedPluginVmRecipes } from './plugins/plugin-approved-vm-recipes'
import { resolveProvisionedRootSource } from './ephemeral-vm-provisioned-root-source'

/**
 * Provisioning an environment recipe, independent of how the caller reached us.
 *
 * This logic used to live inline in the `ephemeralVm:provision` IPC handler, which made it
 * reachable only from the renderer. The CLI speaks runtime RPC rather than Electron IPC, so a
 * `worktree create --recipe` needs the same work available to an RPC method. Extracting it keeps
 * one implementation instead of two that drift: both the IPC handler and the RPC method are thin
 * wrappers over this.
 *
 * The only genuine difference between the callers is progress reporting — the renderer streams
 * stdout/stderr into a provisioning log, while an RPC caller has nowhere to stream to — so that
 * is expressed as optional hooks rather than a second code path.
 */

export type EphemeralVmProvisionResult =
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
  | {
      ok: false
      error: string
      stderr: string
      stdout: string
    }

export type ProvisionEphemeralVmArgs = {
  repoId: string
  recipeId: string
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  branch?: string
  ref?: string
}

export type ProvisionEphemeralVmHooks = {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  signal?: AbortSignal
}

export async function provisionEphemeralVmForRepo(
  store: Store,
  pluginService: PluginService | undefined,
  args: ProvisionEphemeralVmArgs,
  hooks: ProvisionEphemeralVmHooks = {}
): Promise<EphemeralVmProvisionResult> {
  const repo = getRecipeRepo(store, args.repoId)
  if (!repo.ok) {
    return { ok: false, error: repo.message, stdout: '', stderr: '' }
  }
  const recipe = resolveRecipeForRepo(
    repo.repo.path,
    args.recipeId,
    await getApprovedPluginVmRecipes(pluginService)
  )
  if (!recipe) {
    return { ok: false, error: `Recipe not found: ${args.recipeId}`, stdout: '', stderr: '' }
  }
  const signal = hooks.signal

  let recipeRepoUrl = repo.repo.gitRemoteIdentity?.remoteUrl
  let sourceRef = args.ref
  let expectedRefHead: string | undefined
  if (recipe.checkoutMode === 'provisioned-root') {
    const source = await resolveProvisionedRootSource(store, repo.repo, args.ref, signal)
    if (signal?.aborted) {
      return { ok: false, error: 'Provisioning cancelled.', stdout: '', stderr: '' }
    }
    if (!source) {
      return {
        ok: false,
        error: args.ref
          ? `Could not resolve provisioned-root start ref: ${args.ref}`
          : 'Could not resolve a default provisioned-root start ref.',
        stdout: '',
        stderr: ''
      }
    }
    sourceRef = source.ref
    expectedRefHead = source.head
    recipeRepoUrl = source.remoteUrl ?? recipeRepoUrl
  }
  const repoUrl = getProvisionedRootRecipeRepoUrl(recipe.checkoutMode, recipeRepoUrl)
  const result = await provisionEphemeralVmRuntime({
    userDataPath: getAppEnvironment().getPath('userData'),
    repoPath: repo.repo.path,
    repoId: repo.repo.id,
    recipe,
    projectId: args.projectId,
    workspaceId: args.workspaceId,
    workspaceName: args.workspaceName,
    ...(repoUrl ? { repoUrl } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(sourceRef ? { ref: sourceRef } : {}),
    ...(expectedRefHead ? { expectedRefHead } : {}),
    ...(signal ? { signal } : {}),
    ...(hooks.onStdout ? { onStdout: hooks.onStdout } : {}),
    ...(hooks.onStderr ? { onStderr: hooks.onStderr } : {})
  })
  if (!result.ok) {
    return {
      ok: false,
      error: result.start.error,
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
    }
  }

  const connection = getEphemeralVmRecipeResultConnection(result.start.result)
  if (connection.type === 'ssh') {
    try {
      const ssh = await connectRuntimeOwnedSshTarget({
        runtimeId: result.runtime.id,
        connection,
        ...(signal ? { signal } : {})
      })
      const runtime = updateEphemeralVmRuntimeStatus(
        getAppEnvironment().getPath('userData'),
        result.runtime.id,
        {
          sshTargetId: ssh.targetId
        }
      )
      return {
        ok: true,
        connectionType: 'ssh',
        runtime,
        sshTargetId: ssh.targetId,
        ...(expectedRefHead ? { expectedRefHead } : {}),
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
        warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
      }
    } catch (error) {
      // Why: a failed SSH connect leaves a running environment nobody can reach, so tear it
      // down rather than leaking a paid/booted resource on every failed attempt.
      await cleanupEphemeralVmRuntime({
        userDataPath: getAppEnvironment().getPath('userData'),
        repoPath: repo.repo.path,
        recipe,
        runtimeId: result.runtime.id
      }).catch(() => undefined)
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
        stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
      }
    }
  }

  let environment: ReturnType<typeof addEnvironmentFromPairingCode>
  try {
    environment = addEnvironmentFromPairingCode(getAppEnvironment().getPath('userData'), {
      name: buildEphemeralEnvironmentName(repo.repo.displayName, result.runtime.id),
      pairingCode: connection.pairingCode,
      source: 'ephemeral-vm'
    })
  } catch (error) {
    await cleanupEphemeralVmRuntime({
      userDataPath: getAppEnvironment().getPath('userData'),
      repoPath: repo.repo.path,
      recipe,
      runtimeId: result.runtime.id
    }).catch(() => undefined)
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: redactEphemeralVmRecipeDiagnosticText(result.start.stdout),
      stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr)
    }
  }
  const runtime = updateEphemeralVmRuntimeStatus(
    getAppEnvironment().getPath('userData'),
    result.runtime.id,
    {
      runtimeEnvironmentId: environment.id
    }
  )
  return {
    ok: true,
    connectionType: 'orca-server',
    runtime,
    environment: redactRuntimeEnvironment(environment),
    stderr: redactEphemeralVmRecipeDiagnosticText(result.start.stderr),
    warnings: getEphemeralVmRecipeResultWarnings(result.start.result)
  }
}

// Verbatim from the IPC handler this was extracted from — the name is user-visible in the
// environment list, so the refactor must not quietly restyle it.
function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}
