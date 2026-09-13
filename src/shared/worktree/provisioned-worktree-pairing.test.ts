import { describe, expect, it } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../ephemeral-vm-runtimes'
import {
  collectProvisionedHostLinks,
  pairProvisionedWorktrees,
  withoutShadowedWorktrees,
  provisionedWorkspaceIdsForRemovedWorktree,
  type PairableWorktree
} from './provisioned-worktree-pairing'

// The shape measured on karkhana 2026-09-13: one directory, two rows, different repos.
const SOURCE_REPO = '91297aad'
const PROVISIONED_REPO = 'ac45ce82'
const SSH_TARGET = 'runtime-ssh-orca-354b8954'
const HOST_BY_REPO: Record<string, string> = {
  [SOURCE_REPO]: 'local',
  [PROVISIONED_REPO]: `ssh:${SSH_TARGET}`
}
const hostOf = (repoId: string): string | undefined => HOST_BY_REPO[repoId]

function wt(repoId: string, path: string): PairableWorktree {
  return { id: `${repoId}::${path}`, repoId, path }
}

function runtime(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: 'orca-354b8954',
    recipeId: 'stoa-generic',
    repoId: SOURCE_REPO,
    sshTargetId: SSH_TARGET,
    status: 'running',
    ...overrides
  } as EphemeralVmRuntimeRecord
}

const BASE = '/mnt/workspace/stoa'
const WORKSPACE = '/mnt/workspace/stoa-duperepro'

describe('collectProvisionedHostLinks', () => {
  it('links the provisioned host back to the repo the recipe ran against', () => {
    expect(collectProvisionedHostLinks([runtime()])).toEqual([
      {
        executionHostId: `ssh:${SSH_TARGET}`,
        sourceRepoId: SOURCE_REPO,
        runtimeId: 'orca-354b8954'
      }
    ])
  })

  // Cleaned runtimes are kept as history but their container is gone. Collapsing onto a dead host
  // would hide the workspace behind a row that cannot open it.
  it('ignores runtimes that are no longer running', () => {
    expect(collectProvisionedHostLinks([runtime({ status: 'cleaned' })])).toEqual([])
  })

  it('ignores records too incomplete to prove the relationship', () => {
    expect(collectProvisionedHostLinks([runtime({ sshTargetId: undefined })])).toEqual([])
    expect(collectProvisionedHostLinks([runtime({ repoId: undefined })])).toEqual([])
  })
})

describe('pairProvisionedWorktrees', () => {
  const rows = [
    wt(SOURCE_REPO, BASE),
    wt(PROVISIONED_REPO, BASE),
    wt(SOURCE_REPO, WORKSPACE),
    wt(PROVISIONED_REPO, WORKSPACE)
  ]
  const links = collectProvisionedHostLinks([runtime()])

  it('pairs each provisioned row with the source row for the same directory', () => {
    const pairings = pairProvisionedWorktrees(rows, links, hostOf)

    expect(pairings.size).toBe(2)
    const workspace = pairings.get(`${PROVISIONED_REPO}::${WORKSPACE}`)
    expect(workspace?.presented.repoId).toBe(PROVISIONED_REPO)
    expect(workspace?.shadowed?.repoId).toBe(SOURCE_REPO)
    expect(workspace?.shadowed?.path).toBe(WORKSPACE)
    expect(workspace?.runtimeId).toBe('orca-354b8954')
  })

  // The reason removal has to go through the pairing: the other row must be removed with it, or it
  // is left pointing at a directory that no longer exists.
  it('exposes the shadowed row so removal can take both', () => {
    const pairings = pairProvisionedWorktrees(rows, links, hostOf)
    const ids = [...pairings.values()].map((p) => p.shadowed?.id)
    expect(ids).toEqual([`${SOURCE_REPO}::${BASE}`, `${SOURCE_REPO}::${WORKSPACE}`])
  })

  it('pairs nothing when no environment is running', () => {
    expect(pairProvisionedWorktrees(rows, [], hostOf).size).toBe(0)
  })

  // A provisioned row with no source counterpart is still the row to act on; it just shadows
  // nothing.
  it('handles a provisioned row whose source row is not listed', () => {
    const onlyProvisioned = [wt(PROVISIONED_REPO, WORKSPACE)]
    const pairings = pairProvisionedWorktrees(onlyProvisioned, links, hostOf)
    expect(pairings.get(`${PROVISIONED_REPO}::${WORKSPACE}`)?.shadowed).toBeUndefined()
  })
})

describe('withoutShadowedWorktrees', () => {
  const rows = [
    wt(SOURCE_REPO, BASE),
    wt(PROVISIONED_REPO, BASE),
    wt(SOURCE_REPO, WORKSPACE),
    wt(PROVISIONED_REPO, WORKSPACE)
  ]

  it('lists each directory once, keeping the row that owns the environment', () => {
    const pairings = pairProvisionedWorktrees(
      rows,
      collectProvisionedHostLinks([runtime()]),
      hostOf
    )
    const listed = withoutShadowedWorktrees(rows, pairings)

    expect(listed.map((w) => w.id)).toEqual([
      `${PROVISIONED_REPO}::${BASE}`,
      `${PROVISIONED_REPO}::${WORKSPACE}`
    ])
  })

  it('leaves an unprovisioned list exactly as it found it', () => {
    const plain = [wt(SOURCE_REPO, BASE), wt(SOURCE_REPO, WORKSPACE)]
    expect(withoutShadowedWorktrees(plain, new Map())).toEqual(plain)
  })

  // Why: filtering to one repo must not make a workspace disappear because the row that would have
  // presented it was filtered out of the list first.
  it('does not drop a source row whose provisioned counterpart is absent from this list', () => {
    const sourceOnly = [wt(SOURCE_REPO, BASE), wt(SOURCE_REPO, WORKSPACE)]
    const pairings = pairProvisionedWorktrees(
      sourceOnly,
      collectProvisionedHostLinks([runtime()]),
      hostOf
    )
    expect(withoutShadowedWorktrees(sourceOnly, pairings).map((w) => w.id)).toEqual(
      sourceOnly.map((w) => w.id)
    )
  })

  // Two genuinely remote machines can hold the same absolute path, and those are different
  // checkouts. Nothing links them, so nothing collapses them.
  it('never collapses same-path rows that no runtime relates', () => {
    const remoteHosts: Record<string, string> = {
      'repo-a': 'ssh:laptop',
      'repo-b': 'ssh:desktop'
    }
    const sameAbsolutePath = [wt('repo-a', '/home/me/code'), wt('repo-b', '/home/me/code')]
    const pairings = pairProvisionedWorktrees(
      sameAbsolutePath,
      collectProvisionedHostLinks([runtime()]),
      (repoId) => remoteHosts[repoId]
    )
    expect(pairings.size).toBe(0)
    expect(withoutShadowedWorktrees(sameAbsolutePath, pairings)).toHaveLength(2)
  })
})

describe('provisionedWorkspaceIdsForRemovedWorktree', () => {
  const provisionedWorkspaceId = `${PROVISIONED_REPO}::${WORKSPACE}`
  const live = runtime({ workspaceId: provisionedWorkspaceId })

  // The incident: the source row was deleted, nothing matched the runtime's recorded workspace,
  // and the container kept running with its directory deleted beneath it.
  it('tears down the environment when the SOURCE row is the one removed', () => {
    const removed = wt(SOURCE_REPO, WORKSPACE)
    expect(provisionedWorkspaceIdsForRemovedWorktree(removed, [live])).toEqual([
      provisionedWorkspaceId
    ])
  })

  // Removing the provisioned row already matches the runtime directly at the call site.
  it('adds nothing when the removed row is already the runtime workspace', () => {
    const removed = { ...wt(PROVISIONED_REPO, WORKSPACE), id: provisionedWorkspaceId }
    expect(provisionedWorkspaceIdsForRemovedWorktree(removed, [live])).toEqual([])
  })

  it('leaves other workspaces of the same repo alone', () => {
    const removed = wt(SOURCE_REPO, '/mnt/workspace/stoa-something-else')
    expect(provisionedWorkspaceIdsForRemovedWorktree(removed, [live])).toEqual([])
  })

  it('ignores runtimes that are already cleaned', () => {
    const removed = wt(SOURCE_REPO, WORKSPACE)
    const cleaned = runtime({ workspaceId: provisionedWorkspaceId, status: 'cleaned' })
    expect(provisionedWorkspaceIdsForRemovedWorktree(removed, [cleaned])).toEqual([])
  })

  // A path that merely ends with the same characters is not the same path.
  it('does not match a path that is only a suffix of another', () => {
    const removed = wt(SOURCE_REPO, '/mnt/workspace/stoa-dupe')
    const other = runtime({ workspaceId: `${PROVISIONED_REPO}::/mnt/workspace/not-stoa-dupe` })
    expect(provisionedWorkspaceIdsForRemovedWorktree(removed, [other])).toEqual([])
  })
})
