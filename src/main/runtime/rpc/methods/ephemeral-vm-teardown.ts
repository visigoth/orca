import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getEphemeralVmHost } from '../../../../shared/ephemeral-vm-host'

/**
 * Best-effort teardown of the ephemeral-VM runtime behind a deleted workspace or project.
 *
 * Shared by worktree.rm and the project removal handler because both must trigger it — an
 * SSH-mode per-workspace environment's workspace IS the repo's main worktree, so its deletion
 * arrives through project removal rather than worktree.rm, and wiring only one of them still
 * leaks the live container and its hidden SSH target.
 *
 * Two invariants live here rather than at each call site:
 *
 *   - These NEVER throw. The deletion has already happened by the time they run, so a teardown
 *     failure must be logged, not raised; raising would report a successful delete as a failure.
 *     That is not hypothetical — an earlier version threw when the store was not injected and
 *     broke worktree.rm outright.
 *   - Cleanup arrives through the EphemeralVmHost port rather than an import. It reaches the SSH
 *     stack, and the runtime must stay bootable on plain Node; the ratchet measures reachability,
 *     so even a dynamic import() would pull that subgraph into the runtime bundle. A host with no
 *     port installed simply has nothing to tear down.
 */

export async function tearDownEphemeralVmForWorkspace(args: {
  workspaceId: string
  executionHostId?: ExecutionHostId
}): Promise<void> {
  try {
    const host = getEphemeralVmHost()
    if (!host) {
      return
    }
    await host.cleanupForDeleted({
      workspaceIds: [args.workspaceId],
      // Host-scoped so a same-id workspace on another host is not torn down alongside it.
      ...(args.executionHostId
        ? {
            hostScopedWorkspaces: [
              { workspaceId: args.workspaceId, executionHostId: args.executionHostId }
            ]
          }
        : {})
    })
  } catch (error) {
    console.error('[ephemeral-vm] teardown after worktree.rm failed:', error)
  }
}

export async function tearDownEphemeralVmForSshTarget(connectionId: string): Promise<void> {
  try {
    const host = getEphemeralVmHost()
    if (!host) {
      return
    }
    await host.cleanupForDeleted({ runtimeOwnedSshTargetIds: [connectionId] })
  } catch (error) {
    console.error('[ephemeral-vm] teardown after project removal failed:', error)
  }
}
