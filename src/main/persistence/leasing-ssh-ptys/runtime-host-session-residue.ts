import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'

/**
 * Reclaim the per-host workspace-session buckets left behind by destroyed per-workspace
 * environments.
 *
 * Every recipe-provisioned environment gets an execution host of its own — `ssh:runtime-ssh-<id>` —
 * and the session partition keyed by it holds that workspace's tabs, layouts and pane bindings.
 * When the environment is torn down the container, the SSH target and the project rows all go, but
 * the partition does not: no removal path is keyed by host, only by repo, and
 * `removeRepoFromHostWorkspaceSessions` prunes a bucket's CONTENTS while keeping the key. The
 * residue is then rendered as a workspace that can never be opened, because the host it names is
 * unreachable by construction.
 *
 * Only runtime-owned hosts are reclaimable. A user-registered SSH target that is merely offline
 * must keep its partition — it will be reachable again — and the target id is the only thing that
 * tells the two apart, so both entry points below refuse anything without the runtime prefix.
 */
export function forgetHostWorkspaceSessions(
  sessions: PersistedState['workspaceSessionsByHostId'],
  hostIds: readonly ExecutionHostId[]
): { sessions: PersistedState['workspaceSessionsByHostId']; removed: ExecutionHostId[] } {
  const removed = hostIds.filter((hostId) => sessions?.[hostId] !== undefined)
  if (removed.length === 0) {
    return { sessions, removed: [] }
  }
  const next = { ...sessions }
  for (const hostId of removed) {
    delete next[hostId]
  }
  return { sessions: next, removed }
}

/** Host ids for the runtime-owned SSH targets named here, whether or not a bucket exists. */
export function runtimeHostIdsForSshTargets(sshTargetIds: readonly string[]): ExecutionHostId[] {
  return sshTargetIds
    .filter((targetId) => targetId !== '' && isRuntimeOwnedSshTargetId(targetId))
    .map((targetId) => toSshExecutionHostId(targetId))
}

/**
 * Session buckets whose runtime-owned SSH target is no longer registered.
 *
 * This is the load-time backstop for the buckets already past recovery. Cleanup clears
 * `sshTargetId` from the runtime record as its last act — deliberately, so the project rows pinned
 * to it can still be found first — which severs the only link from a cleaned runtime back to its
 * host key. Once that link is gone the orphan cannot be found by walking the runtime registry at
 * all, so this sweeps from the other direction: the bucket names its own target, and a target that
 * is not in `sshTargets` is one nothing can reconnect to.
 */
export function collectUnreachableRuntimeHostSessionIds(
  state: Pick<PersistedState, 'workspaceSessionsByHostId' | 'sshTargets'>
): ExecutionHostId[] {
  const liveTargetIds = new Set((state.sshTargets ?? []).map((target) => target.id))
  const unreachable: ExecutionHostId[] = []
  for (const hostId of Object.keys(state.workspaceSessionsByHostId ?? {})) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'ssh' || !isRuntimeOwnedSshTargetId(parsed.targetId)) {
      continue
    }
    if (!liveTargetIds.has(parsed.targetId)) {
      unreachable.push(hostId as ExecutionHostId)
    }
  }
  return unreachable
}
