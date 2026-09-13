import { describe, expect, it } from 'vitest'
import { getRecipeDetail, type EphemeralVmRecipeOption } from './run-target-options'

function recipe(overrides: Partial<EphemeralVmRecipeOption> = {}): EphemeralVmRecipeOption {
  return {
    id: 'stoa-generic',
    name: 'stoa — generic (whole repo)',
    create: '.orca/recipes/devcontainer-create.sh generic',
    destroy: '.orca/recipes/devcontainer-destroy.sh',
    ...overrides
  } as EphemeralVmRecipeOption
}

describe('getRecipeDetail', () => {
  it('shows the description the recipe author wrote', () => {
    expect(getRecipeDetail(recipe({ description: 'Go devcontainer; lands in code/go.' }))).toBe(
      'Go devcontainer; lands in code/go.'
    )
  })

  // The reason this line changed at all: a repo whose recipes all dispatch through one script
  // rendered the identical create command on every row, so the detail line -- half the row --
  // could not tell any two recipes apart.
  it('does not fall back to a create command that is identical across recipes', () => {
    const details = ['generic', 'ansible', 'autocoder'].map((variant) =>
      getRecipeDetail(
        recipe({
          id: `stoa-${variant}`,
          description: `The ${variant} environment.`,
          create: `.orca/recipes/devcontainer-create.sh ${variant}`
        })
      )
    )

    expect(new Set(details).size).toBe(details.length)
  })

  it('still describes the command when the recipe has no description', () => {
    expect(getRecipeDetail(recipe({ description: undefined }))).toBe(
      '.orca/recipes/devcontainer-create.sh · destroy configured'
    )
  })

  it('treats a blank description as absent rather than rendering an empty line', () => {
    expect(getRecipeDetail(recipe({ description: '   ' }))).toContain('destroy configured')
  })

  // "destroy configured" is reassurance and only crowds out the description; an environment that
  // will be left running is a consequence worth carrying on the row.
  it('keeps the teardown warning alongside the description, but not the reassurance', () => {
    const described = { description: 'Debian base with the ansible toolchain.' }

    expect(getRecipeDetail(recipe(described))).toBe('Debian base with the ansible toolchain.')
    expect(getRecipeDetail(recipe({ ...described, destroy: undefined }))).toBe(
      'Debian base with the ansible toolchain. · no destroy'
    )
    expect(getRecipeDetail(recipe({ ...described, destroyDisabled: true }))).toBe(
      'Debian base with the ansible toolchain. · destroy disabled'
    )
  })
})
