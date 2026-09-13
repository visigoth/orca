import type { EphemeralVmRuntimeRecord } from '../ephemeral-vm-runtimes'

/**
 * Collapsing the two rows a per-workspace environment creates for one checkout.
 *
 * Provisioning a recipe registers a SECOND repo row for the same repository, told apart only by
 * execution host. Both rows then enumerate worktrees out of the same git repository, because the
 * recipe bind-mounts the workspace tree into the container at the SAME absolute path so every
 * container agrees on paths. One directory, listed twice, and the two copies are not
 * interchangeable: only the provisioned one owns the container, and only it tears the environment
 * down when removed. Removing the other deletes the directory and leaves the container running
 * with nothing beneath it.
 *
 * What makes this safe to collapse is that Orca already records the relationship rather than
 * leaving it to be inferred. A runtime record names the repo the recipe ran against (`repoId`),
 * the ssh target its host id is built from (`sshTargetId`), and the row the workspace was created
 * under (`workspaceId`). So a row on that host and a row under that source repo, at one path, are
 * one directory BY CONSTRUCTION.
 *
 * Every cheaper key was measured and rejected:
 *   - Path equality alone would merge two genuinely remote machines that happen to share an
 *     absolute path, hiding a real workspace. This rule only ever collapses a pair Orca itself
 *     created.
 *   - `instanceId` and `canonicalWorktreeIdentity` cannot help: each repo row mints its own
 *     instanceId for the same directory, and the identity key embeds the host on purpose.
 *   - An equal git common dir proves one path spelling, not one filesystem.
 */

/** The fields this needs from a worktree row, so callers are not forced to build a whole one. */
export type PairableWorktree = {
  id: string
  repoId: string
  path: string
}

export type ProvisionedHostLink = {
  /** Execution host id of the provisioned repo row, e.g. `ssh:runtime-ssh-orca-<id>`. */
  executionHostId: string
  /** The repo the recipe ran against, whose tree the container mounts. */
  sourceRepoId: string
  runtimeId: string
}

/** `ssh:` + the runtime's ssh target is how the provisioned repo's execution host id is spelled. */
export function provisionedExecutionHostId(sshTargetId: string): string {
  return `ssh:${sshTargetId}`
}

/**
 * The live provisioned-host links, from the runtime registry.
 *
 * Cleaned runtimes are excluded deliberately. Their rows are retained as history, but the
 * container is gone, so the surviving presentation of that checkout should be the source row --
 * collapsing onto a dead host would hide the workspace behind something that cannot open it.
 */
export function collectProvisionedHostLinks(
  runtimes: readonly EphemeralVmRuntimeRecord[]
): ProvisionedHostLink[] {
  const links: ProvisionedHostLink[] = []
  for (const runtime of runtimes) {
    if (runtime.status !== 'running') {
      continue
    }
    if (!runtime.sshTargetId || !runtime.repoId) {
      continue
    }
    links.push({
      executionHostId: provisionedExecutionHostId(runtime.sshTargetId),
      sourceRepoId: runtime.repoId,
      runtimeId: runtime.id
    })
  }
  return links
}

export type WorktreePairing<T extends PairableWorktree> = {
  /** The row to present and to act on: the provisioned one, which owns the environment. */
  presented: T
  /** The source-repo row for the same directory, when one is currently listed. */
  shadowed: T | undefined
  runtimeId: string
}

/**
 * Pair provisioned rows with the source rows they duplicate.
 *
 * Returned keyed by the presented row's id so callers can both filter a list and, at removal time,
 * recover the other row that has to go with it.
 */
export function pairProvisionedWorktrees<T extends PairableWorktree>(
  worktrees: readonly T[],
  links: readonly ProvisionedHostLink[],
  getExecutionHostId: (repoId: string) => string | null | undefined
): Map<string, WorktreePairing<T>> {
  const byId = new Map<string, WorktreePairing<T>>()
  if (links.length === 0) {
    return byId
  }
  const linkByHost = new Map(links.map((link) => [link.executionHostId, link]))
  for (const candidate of worktrees) {
    const hostId = getExecutionHostId(candidate.repoId)
    const link = hostId ? linkByHost.get(hostId) : undefined
    if (!link) {
      continue
    }
    // Same directory, under the repo the recipe provisioned from.
    const shadowed = worktrees.find(
      (other) => other.repoId === link.sourceRepoId && other.path === candidate.path
    )
    byId.set(candidate.id, { presented: candidate, shadowed, runtimeId: link.runtimeId })
  }
  return byId
}

/**
 * Drop rows that a provisioned row already presents.
 *
 * Order is preserved, and a row is only dropped when its provisioned counterpart is actually in
 * this list -- filtering to one repo must never make a workspace vanish because the row that would
 * have presented it was filtered out.
 */
export function withoutShadowedWorktrees<T extends PairableWorktree>(
  worktrees: readonly T[],
  pairings: ReadonlyMap<string, WorktreePairing<T>>
): T[] {
  if (pairings.size === 0) {
    return [...worktrees]
  }
  const shadowedIds = new Set<string>()
  for (const pairing of pairings.values()) {
    if (pairing.shadowed) {
      shadowedIds.add(pairing.shadowed.id)
    }
  }
  return worktrees.filter((worktree) => !shadowedIds.has(worktree.id))
}

/**
 * Workspace ids to tear down alongside a removed worktree row.
 *
 * Removal already tears down a runtime whose recorded `workspaceId` IS the removed row, which
 * covers deleting the provisioned entry. It does not cover deleting the SOURCE entry for the same
 * directory: the runtime records the provisioned id, nothing matches, and the container is left
 * running with its workspace directory deleted from under it. That asymmetry is the whole bug --
 * the two entries looked like alternatives while only one of them cleaned up.
 *
 * Matched on the runtime's own fields: it was provisioned FROM the removed row's repo, and its
 * workspace sits at the removed row's path. Both are recorded, neither is inferred.
 */
export function provisionedWorkspaceIdsForRemovedWorktree(
  removed: PairableWorktree,
  runtimes: readonly EphemeralVmRuntimeRecord[]
): string[] {
  const ids: string[] = []
  for (const runtime of runtimes) {
    if (runtime.status !== 'running' || !runtime.workspaceId || !runtime.repoId) {
      continue
    }
    // Already handled by the caller's own teardown; adding it again would be a no-op at best.
    if (runtime.workspaceId === removed.id) {
      continue
    }
    if (runtime.repoId !== removed.repoId) {
      continue
    }
    if (!runtime.workspaceId.endsWith(`::${removed.path}`)) {
      continue
    }
    ids.push(runtime.workspaceId)
  }
  return ids
}
