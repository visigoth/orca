import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-types'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { withoutProvisionedDuplicateWorktrees } from './runtime-provisioned-worktree-dedupe'

/**
 * Assembling one page of the managed worktree list.
 *
 * Split out of RuntimeManagedWorktreeQueries rather than grown in place: that file sits at its
 * 300-line budget, and the repo's max-lines ratchet exists to make a file split instead of
 * acquiring a bypass.
 */
export function listManagedWorktreeRows(args: {
  limit: number
  repoId: string | null
  resolved: readonly ResolvedWorktree[]
  repos: readonly Repo[]
  visibilityDefaults: GlobalSettings['worktreeVisibilityDefaults']
  isVisible(
    worktree: ResolvedWorktree,
    matcher: WorktreeVisibilitySourceMatcher | undefined
  ): boolean
  listProvisionedRuntimes?: () => readonly EphemeralVmRuntimeRecord[]
}): RuntimeWorktreeListResult {
  if (!Number.isInteger(args.limit) || args.limit <= 0) {
    throw new Error('invalid_limit')
  }
  const pathsByRepo = new Map<string, string[]>()
  for (const worktree of args.resolved) {
    const paths = pathsByRepo.get(worktree.repoId) ?? []
    paths.push(worktree.path)
    pathsByRepo.set(worktree.repoId, paths)
  }
  const matchers = new Map(
    args.repos.map((repo) => [
      repo.id,
      createWorktreeVisibilitySourceMatcher(
        [repo.path, ...(pathsByRepo.get(repo.id) ?? [])],
        resolveCustomWorktreeVisibilitySources(repo, args.visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
    ])
  )
  // One directory, listed once. A recipe-backed workspace is tracked by two repo rows -- the repo
  // the recipe ran against and the one registered for the environment's ssh host -- and both
  // enumerate the same git repository, because the container mounts that tree at the same absolute
  // path. Deduped BEFORE the slice below, or totalCount and truncated would describe a longer list
  // than the one returned.
  const worktrees = withoutProvisionedDuplicateWorktrees(
    args.resolved.filter(
      (worktree) =>
        (!args.repoId || worktree.repoId === args.repoId) &&
        args.isVisible(worktree, matchers.get(worktree.repoId))
    ),
    args.repoId,
    { listProvisionedRuntimes: args.listProvisionedRuntimes, getRepos: () => args.repos }
  )
  return {
    worktrees: worktrees.slice(0, args.limit),
    totalCount: worktrees.length,
    truncated: worktrees.length > args.limit
  }
}
