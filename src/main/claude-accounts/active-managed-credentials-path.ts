import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  getClaudeManagedAccountsRoot,
  resolveOwnedClaudeManagedAuthPath
} from './managed-auth-path'

/**
 * Which managed account should an SSH workspace run as?
 *
 * The explicit selection when there is one. Otherwise the only registered account, if there is
 * exactly one -- because on a headless host there is no way to make a selection at all. `orca
 * account add` registers an account and `orca account list` shows it, but selecting one is a
 * Settings-UI action with no CLI equivalent, so requiring an explicit selection would mean the CLI
 * can add an account that can never be used. One account and no selection is not ambiguous; two and
 * no selection is, and stays null rather than guessing which identity to run as.
 *
 * Mirrors the fallback getSelectedClaudeAccountIdForTarget already makes for WSL targets.
 */
export function resolveActiveManagedClaudeAccountId(args: {
  activeAccountId: string | null | undefined
  registeredAccountIds: readonly string[]
}): string | null {
  if (args.activeAccountId) {
    return args.activeAccountId
  }
  return args.registeredAccountIds.length === 1 ? args.registeredAccountIds[0] : null
}

/**
 * The chosen account's credentials file, or null.
 *
 * Ownership is re-verified rather than assumed: `resolveOwnedClaudeManagedAuthPath` is what rejects
 * a directory that is a symlink or otherwise not Orca's, and this path is about to be handed to a
 * remote upload. A null here is an ordinary answer -- nothing added, nothing selected out of
 * several, or the stored one no longer checks out -- and every caller treats it as "nothing to do".
 */
export function resolveActiveManagedClaudeCredentialsPath(args: {
  activeAccountId: string | null | undefined
  registeredAccountIds: readonly string[]
}): string | null {
  const accountId = resolveActiveManagedClaudeAccountId(args)
  if (!accountId) {
    return null
  }
  const candidate = join(getClaudeManagedAccountsRoot(), accountId, 'auth')
  const ownedPath = resolveOwnedClaudeManagedAuthPath(accountId, candidate)
  if (!ownedPath) {
    return null
  }
  const credentialsPath = join(ownedPath, '.credentials.json')
  return existsSync(credentialsPath) ? credentialsPath : null
}
