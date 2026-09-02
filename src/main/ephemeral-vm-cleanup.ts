import type { Store } from './persistence'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { removeEnvironment } from '../shared/runtime-environment-store'
import { cleanupEphemeralVmRuntime } from './ephemeral-vm-runtime-service'
import { removeEphemeralVmRuntimeSshTarget } from './ephemeral-vm-runtime-ssh-cleanup'
import { removeRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'
import { getRuntimeRecipeContext } from './ipc/ephemeral-vm-recipe-context'

/**
 * Clean up one ephemeral-VM runtime: run the recipe's destroy hook, drop the local environment
 * row, and unregister the runtime-owned SSH target.
 *
 * Extracted from the `ephemeralVm:cleanup` IPC handler so the main-side deletion path can reuse
 * it. Previously this existed only behind IPC, which meant only a renderer could ever trigger a
 * teardown — see ephemeral-vm-cleanup-for-deleted.ts for why that left headless runtimes leaking.
 */
export async function cleanupEphemeralVmRuntimeById(args: {
  store: Store
  userDataPath: string
  runtimeId: string
}): Promise<EphemeralVmRuntimeRecord> {
  const { store, userDataPath, runtimeId } = args
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
  }
  if (!runtime.repoId) {
    throw new Error(`Ephemeral VM runtime has no repo id: ${runtimeId}`)
  }
  let result
  if (runtime.cleanupStatus === 'succeeded') {
    result = { ok: true as const, runtime, skipped: false }
  } else {
    let resolved: ReturnType<typeof getRuntimeRecipeContext>
    try {
      resolved = getRuntimeRecipeContext(store, userDataPath, runtime.id)
    } catch (error) {
      // Why: a recipe that can no longer be resolved (repo gone, recipe removed from orca.yaml)
      // must still release the SSH target, or the runtime is unreachable AND still registered.
      const failed = updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastAttemptAt: Date.now(),
        cleanupLastError: error instanceof Error ? error.message : String(error)
      })
      return removeEphemeralVmRuntimeSshTarget({
        userDataPath,
        runtime: failed,
        removeTarget: removeRuntimeOwnedSshTarget
      })
    }
    result = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath: resolved.repo.repo.path,
      recipe: resolved.recipe,
      runtimeId: runtime.id
    })
  }
  if (result.ok && runtime.runtimeEnvironmentId) {
    try {
      removeEnvironment(userDataPath, runtime.runtimeEnvironmentId)
    } catch {
      // Cleanup of provider resources matters more than hiding a stale local
      // environment row; users can still remove that manually.
    }
  }
  if (!result.ok) {
    return result.runtime
  }
  return removeEphemeralVmRuntimeSshTarget({
    userDataPath,
    runtime: result.runtime,
    removeTarget: removeRuntimeOwnedSshTarget
  })
}
