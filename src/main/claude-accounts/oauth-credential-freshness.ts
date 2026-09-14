// The pure half of the OAuth credential handling: parsing a stored blob and deciding whether its
// access token is still usable.
//
// Split out of oauth-refresh.ts, which imports `electron` for the token-endpoint request. Callers
// that only need to ASK whether a credential is still good should not have to pull Electron in
// with them -- the SSH layer is one, and the runtime is meant to stay runnable on plain Node (see
// check-runtime-electron-ratchet.mjs). oauth-refresh.ts re-exports these so there is still one
// definition of "expiring" rather than a second opinion that drifts.

// Refresh slightly ahead of expiry so a token doesn't expire mid-launch. The CLI uses the same
// 5-minute skew for its own refresh decision.
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000

export type ClaudeOauthBlob = {
  accessToken?: unknown
  refreshToken?: unknown
  expiresAt?: unknown
  scopes?: unknown
  [key: string]: unknown
}

export type ClaudeCredentials = {
  claudeAiOauth?: ClaudeOauthBlob
  [key: string]: unknown
}

/**
 * Parse the `claudeAiOauth` object from a credentials JSON string.
 * Returns null when the string is not parseable or lacks the OAuth block.
 */
export function parseClaudeOauthBlob(credentialsJson: string): ClaudeOauthBlob | null {
  try {
    const parsed = JSON.parse(credentialsJson) as ClaudeCredentials
    const oauth = parsed?.claudeAiOauth
    return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth : null
  } catch {
    return null
  }
}

/** Read a stored refresh token, or null when absent/blank. */
export function readRefreshToken(credentialsJson: string): string | null {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  const token = oauth?.refreshToken
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

/**
 * Whether the stored access token is expired or within the refresh buffer.
 *
 * A missing/non-numeric `expiresAt` is treated as "needs refresh" so a blob with no usable expiry
 * metadata still gets a proactive refresh attempt rather than being trusted indefinitely. `now` is
 * injectable for tests.
 */
export function isOauthTokenExpiring(credentialsJson: string, now: number = Date.now()): boolean {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  if (!oauth) {
    return false
  }
  const expiresAt = oauth.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return true
  }
  return now + OAUTH_EXPIRY_BUFFER_MS >= expiresAt
}

/**
 * Whether a credential is worth handing to an agent that cannot refresh it for us.
 *
 * Distinct from `isOauthTokenExpiring`, which answers "should Orca refresh this soon" and returns
 * false for an unparseable blob so the refresh path leaves it alone. This answers "will this
 * actually log anybody in", so anything it cannot vouch for is a no: no blob, no access token, or
 * an expiry at or behind the buffer.
 */
export function isOauthCredentialUsable(
  credentialsJson: string,
  now: number = Date.now()
): boolean {
  const oauth = parseClaudeOauthBlob(credentialsJson)
  if (!oauth) {
    return false
  }
  const accessToken = oauth.accessToken
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    return false
  }
  return !isOauthTokenExpiring(credentialsJson, now)
}
