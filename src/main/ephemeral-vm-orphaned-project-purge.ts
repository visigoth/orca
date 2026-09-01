import type { Store } from './persistence'
import { toSshExecutionHostId, type ExecutionHostId } from '../shared/execution-host'

/**
 * Remove the project rows left behind when a per-workspace environment is destroyed.
 *
 * An SSH-mode environment's project is hosted on the runtime-owned SSH target. Once that target
 * is gone the project is dead — never connectable — but it still shows up in `repo list` and,
 * worse, still answers to `name:` selectors. Several of them for the same repo make
 * `--repo name:<x>` fail with selector_ambiguous, so the leftovers actively break the next
 * workspace rather than merely cluttering.
 *
 * Ported from the renderer's purgeOrphanedRuntimeSshProjects, which runs only in the desktop app.
 * Purging is driven by CONFIRMED-destroyed targets, never by "we tried to clean up": a runtime
 * whose teardown failed keeps both its target and its project so the next attempt can still find
 * them.
 */
export function purgeOrphanedRuntimeSshProjects(
  store: Store,
  destroyedSshTargetIds: readonly string[]
): void {
  if (destroyedSshTargetIds.length === 0) {
    return
  }
  // Drop blanks once, before both lookups, so a repo with no connectionId never matches below.
  const purgeable = destroyedSshTargetIds.filter((id) => id !== '')
  if (purgeable.length === 0) {
    return
  }
  const destroyedTargetIds = new Set(purgeable)
  const destroyedHostIds = new Set<ExecutionHostId>(purgeable.map((id) => toSshExecutionHostId(id)))

  const purgedRepoIds = new Set<string>()
  const orphanedSetupIds = (store.getProjectHostSetups?.() ?? [])
    .filter((setup) => destroyedHostIds.has(setup.hostId as ExecutionHostId))
    .map((setup) => setup.id)
  for (const setupId of orphanedSetupIds) {
    try {
      const result = store.deleteProjectHostSetup?.({ setupId })
      if (result?.repo) {
        purgedRepoIds.add(result.repo.id)
      }
    } catch (error) {
      console.error('[ephemeral-vm] failed to purge orphaned per-workspace-env project:', error)
    }
  }

  // A repo whose only host was the destroyed runtime can outlive its setup — a projection refresh
  // prunes the setup first — so remove it directly rather than leaving a dead project behind.
  const orphanedRepoIds = store
    .getRepos()
    .filter(
      (repo) => destroyedTargetIds.has(repo.connectionId ?? '') && !purgedRepoIds.has(repo.id)
    )
    .map((repo) => repo.id)
  for (const repoId of orphanedRepoIds) {
    try {
      store.removeProject?.(repoId)
    } catch (error) {
      console.error('[ephemeral-vm] failed to purge orphaned per-workspace-env repo:', error)
    }
  }
}
