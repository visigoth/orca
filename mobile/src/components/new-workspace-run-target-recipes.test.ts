import { describe, expect, it } from 'vitest'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import { buildNewWorkspaceRunTargetOptions } from './new-workspace-project-targets'

const repo = {
  id: 'repo-1',
  displayName: 'stoa',
  path: '/mnt/workspace/stoa',
  executionHostId: null
}

const recipes = [
  { id: 'stoa-generic', name: 'stoa — generic', create: 'x', description: 'Whole repo' },
  { id: 'stoa-scraps', name: 'stoa — scraps', create: 'x' }
]

// Derived, not guessed: the identity key is computed from the repo, not its display name.
const projectId = getProjectIdentityKey(repo)

function idsFor(options: ReturnType<typeof buildNewWorkspaceRunTargetOptions>) {
  return options.map((option) => option.id)
}

describe('run target options with recipes', () => {
  it('keeps the host option and appends one option per recipe', () => {
    const options = buildNewWorkspaceRunTargetOptions([repo], projectId, 'linux', recipes)
    expect(idsFor(options)).toEqual(['repo-1', 'repo-1::stoa-generic', 'repo-1::stoa-scraps'])
    expect(options[0]?.recipeId).toBeUndefined()
    expect(options[1]?.recipeId).toBe('stoa-generic')
  })

  // Why a compound id: one repo now yields several run targets, and a picker keyed on the repo id
  // alone could not tell the host option from the recipes that share its repo.
  it('gives every option a distinct id even though they share a repo', () => {
    const options = buildNewWorkspaceRunTargetOptions([repo], projectId, 'linux', recipes)
    expect(new Set(idsFor(options)).size).toBe(options.length)
    for (const option of options) {
      expect(option.repo.id).toBe('repo-1')
    }
  })

  it('labels a recipe by name and falls back to its id', () => {
    const options = buildNewWorkspaceRunTargetOptions([repo], projectId, 'linux', [
      { id: 'bare', name: '', create: 'x' }
    ])
    expect(options[1]?.label).toBe('bare')
    expect(options[1]?.detail).toBe('Per-workspace environment')
  })

  // Why: this is the behaviour every existing caller depends on, and the one that must not move.
  it('is unchanged when no recipes are supplied', () => {
    expect(buildNewWorkspaceRunTargetOptions([repo], projectId, 'linux')).toEqual(
      buildNewWorkspaceRunTargetOptions([repo], projectId, 'linux', [])
    )
    expect(idsFor(buildNewWorkspaceRunTargetOptions([repo], projectId, 'linux'))).toEqual([
      'repo-1'
    ])
  })

  it('offers nothing when no project is selected, recipes or not', () => {
    expect(buildNewWorkspaceRunTargetOptions([repo], null, 'linux', recipes)).toEqual([])
  })

  // Why: recipes are answered by the machine that owns the checkout and provision from it, so an
  // empty host list means there is nothing for them to hang off.
  it('drops recipes when the project has no host option to anchor them', () => {
    expect(buildNewWorkspaceRunTargetOptions([], projectId, 'linux', recipes)).toEqual([])
  })
})
