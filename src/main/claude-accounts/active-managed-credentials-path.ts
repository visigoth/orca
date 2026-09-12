import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  getClaudeManagedAccountsRoot,
  resolveOwnedClaudeManagedAuthPath
} from './managed-auth-path'

/**
 * The active managed account's credentials file, or null.
 *
 * Ownership is re-verified rather than assumed: `resolveOwnedClaudeManagedAuthPath` is what rejects
 * a directory that is a symlink or otherwise not Orca's, and this path is about to be handed to a
 * remote upload. A null here is an ordinary answer — no account added, none selected, or the stored
 * one no longer checks out — and every caller treats it as "nothing to do".
 */
export function resolveActiveManagedClaudeCredentialsPath(
  activeAccountId: string | null | undefined
): string | null {
  if (!activeAccountId) {
    return null
  }
  const candidate = join(getClaudeManagedAccountsRoot(), activeAccountId, 'auth')
  const ownedPath = resolveOwnedClaudeManagedAuthPath(activeAccountId, candidate)
  if (!ownedPath) {
    return null
  }
  const credentialsPath = join(ownedPath, '.credentials.json')
  return existsSync(credentialsPath) ? credentialsPath : null
}
