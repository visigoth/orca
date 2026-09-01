import { app } from 'electron'
import type { Store } from './persistence'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import {
  isRuntimeOwnedSshTargetId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../shared/execution-host'
import { composeWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import { cleanupEphemeralVmRuntimeById } from './ephemeral-vm-cleanup'

/**
 * Tear down the ephemeral-VM runtimes behind deleted workspaces, on the MAIN side.
 *
 * This mirrors renderer/src/lib/ephemeral-vm-runtime-cleanup.ts, which is where the behaviour
 * lived exclusively. That is fine for the desktop app and wrong everywhere else: a headless
 * `orca serve` has no renderer, and the web client has no ephemeralVm preload API, so deleting a
 * workspace over RPC left the provisioned container running, its runtime record in place, and its
 * SSH-bound repo row registered. Those accumulate — one per workspace — and the duplicate repo
 * rows make `--repo name:<x>` ambiguous on the second workspace for a repo.
 *
 * Matching is deliberately three-way, copied from the renderer rather than simplified:
 *
 *   - by workspaceId, the ordinary case;
 *   - by HOST-QUALIFIED workspace identity, because the same workspace id can exist on several
 *     hosts and matching the bare id would tear down a sibling that is still in use;
 *   - by runtime-owned SSH target id, for repo removal — an SSH-mode per-workspace environment's
 *     workspace IS the repo's main worktree, so deleting it routes through project removal, and
 *     without this the live container and its hidden SSH target leak.
 *
 * Failures are swallowed per runtime and reported through the summary: cleanup is best-effort
 * housekeeping attached to a deletion the caller already committed to, and throwing here would
 * turn a successful delete into a failed one.
 */

export type EphemeralVmCleanupSummary = {
  destroyedSshTargetIds: string[]
  retainedSshTargetIds: string[]
}

export async function cleanupEphemeralVmRuntimesForDeleted(args: {
  store: Store
  workspaceIds?: readonly string[]
  /** Workspace owners whose same-id siblings on other hosts must survive. */
  hostScopedWorkspaces?: readonly { workspaceId: string; executionHostId: ExecutionHostId }[]
  /** Raw runtime-owned SSH target ids (a removed repo's connectionId) to tear down too. */
  runtimeOwnedSshTargetIds?: readonly string[]
}): Promise<EphemeralVmCleanupSummary> {
  const destroyedSshTargetIds = new Set<string>()
  const retainedSshTargetIds = new Set<string>()
  const userDataPath = app.getPath('userData')
  try {
    const workspaceIdSet = new Set(args.workspaceIds ?? [])
    const sshTargetIdSet = new Set(
      (args.runtimeOwnedSshTargetIds ?? []).filter((id) => isRuntimeOwnedSshTargetId(id))
    )
    const hostScopedWorkspaceIdentities = new Set(
      (args.hostScopedWorkspaces ?? []).map((target) =>
        composeWorktreeHostIdentity(target.executionHostId, target.workspaceId)
      )
    )
    if (
      workspaceIdSet.size === 0 &&
      sshTargetIdSet.size === 0 &&
      hostScopedWorkspaceIdentities.size === 0
    ) {
      return { destroyedSshTargetIds: [], retainedSshTargetIds: [] }
    }

    const matching = listEphemeralVmRuntimes(userDataPath).filter(
      (runtime) =>
        // Why the sshTargetId disjunct: a runtime whose provider resources are already gone can
        // still own a registered SSH target, and that target must be unregistered too.
        (runtime.cleanupStatus !== 'succeeded' || runtime.sshTargetId !== undefined) &&
        ((runtime.workspaceId !== undefined && workspaceIdSet.has(runtime.workspaceId)) ||
          (runtime.workspaceId !== undefined &&
            ((runtime.runtimeEnvironmentId !== undefined &&
              hostScopedWorkspaceIdentities.has(
                composeWorktreeHostIdentity(
                  toRuntimeExecutionHostId(runtime.runtimeEnvironmentId),
                  runtime.workspaceId
                )
              )) ||
              (runtime.sshTargetId !== undefined &&
                hostScopedWorkspaceIdentities.has(
                  composeWorktreeHostIdentity(
                    toSshExecutionHostId(runtime.sshTargetId),
                    runtime.workspaceId
                  )
                )))) ||
          (runtime.sshTargetId !== undefined && sshTargetIdSet.has(runtime.sshTargetId)))
    )

    for (const runtime of matching) {
      try {
        const cleaned = await cleanupEphemeralVmRuntimeById({
          store: args.store,
          userDataPath,
          runtimeId: runtime.id
        })
        if (runtime.sshTargetId) {
          // A target that survives cleanup is retained, not destroyed — the caller uses this to
          // decide whether the repo row pinned to it can be purged.
          const bucket = cleaned.sshTargetId ? retainedSshTargetIds : destroyedSshTargetIds
          bucket.add(runtime.sshTargetId)
        }
      } catch (error) {
        console.error('[ephemeral-vm] cleanup failed for deleted workspace:', error)
        if (runtime.sshTargetId) {
          retainedSshTargetIds.add(runtime.sshTargetId)
        }
      }
    }
  } catch (error) {
    console.error('[ephemeral-vm] cleanup failed for deleted workspace:', error)
    for (const targetId of args.runtimeOwnedSshTargetIds ?? []) {
      if (isRuntimeOwnedSshTargetId(targetId)) {
        retainedSshTargetIds.add(targetId)
      }
    }
  }
  return {
    destroyedSshTargetIds: [...destroyedSshTargetIds],
    retainedSshTargetIds: [...retainedSshTargetIds]
  }
}
