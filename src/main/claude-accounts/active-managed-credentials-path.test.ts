import { describe, expect, it } from 'vitest'
import { resolveActiveManagedClaudeAccountId } from './active-managed-credentials-path'

describe('resolveActiveManagedClaudeAccountId', () => {
  it('honours an explicit selection', () => {
    expect(
      resolveActiveManagedClaudeAccountId({
        activeAccountId: 'chosen',
        registeredAccountIds: ['chosen', 'other']
      })
    ).toBe('chosen')
  })

  // Why: selecting an account is a Settings-UI action with no CLI equivalent, so on a headless host
  // `orca account add` registers an account whose selection stays null forever. Requiring an
  // explicit selection would make the CLI able to add an account that can never be used.
  it('falls back to the only registered account when nothing is selected', () => {
    expect(
      resolveActiveManagedClaudeAccountId({
        activeAccountId: null,
        registeredAccountIds: ['only']
      })
    ).toBe('only')
  })

  // Why: two accounts and no selection is a real ambiguity, and picking one would silently decide
  // which identity every remote workspace runs as.
  it('refuses to guess between several unselected accounts', () => {
    expect(
      resolveActiveManagedClaudeAccountId({
        activeAccountId: null,
        registeredAccountIds: ['a', 'b']
      })
    ).toBeNull()
  })

  it('is null when nothing is registered', () => {
    expect(
      resolveActiveManagedClaudeAccountId({ activeAccountId: null, registeredAccountIds: [] })
    ).toBeNull()
  })

  it('tolerates undefined', () => {
    expect(
      resolveActiveManagedClaudeAccountId({
        activeAccountId: undefined,
        registeredAccountIds: ['only']
      })
    ).toBe('only')
  })
})
