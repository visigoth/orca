import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  collectProvisionedHostLinks,
  pairProvisionedWorktrees,
  withoutShadowedWorktrees
} from '../../shared/worktree/provisioned-worktree-pairing'

/**
 * Drop source-repo rows that a live provisioned row already presents.
 *
 * Kept out of RuntimeManagedWorktreeQueries so that file stays under its 300-line ratchet, and
 * because this is the only part of listing that needs to know ephemeral VMs exist at all.
 */
export function withoutProvisionedDuplicateWorktrees<
  T extends { id: string; repoId: string; path: string }
>(
  worktrees: readonly T[],
  /** Set when the caller named one repo: that query must return that repo's own rows, untouched. */
  repoId: string | null,
  deps: {
    listProvisionedRuntimes?(): readonly EphemeralVmRuntimeRecord[]
    getRepos(): readonly Repo[]
  }
): T[] {
  if (repoId) {
    return [...worktrees]
  }
  const links = collectProvisionedHostLinks(deps.listProvisionedRuntimes?.() ?? [])
  if (links.length === 0) {
    return [...worktrees]
  }
  const reposById = new Map(deps.getRepos().map((repo) => [repo.id, repo]))
  const pairings = pairProvisionedWorktrees(worktrees, links, (id) => {
    const repo = reposById.get(id)
    return repo ? getRepoExecutionHostId(repo) : null
  })
  return withoutShadowedWorktrees(worktrees, pairings)
}
