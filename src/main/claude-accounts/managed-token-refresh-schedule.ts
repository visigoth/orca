/**
 * Keep the managed Claude token alive on a host where nothing else will.
 *
 * Orca refreshes a managed OAuth token inside syncForCurrentSelection, and that runs when an agent
 * launches locally, when the selection changes, or across an auth-preserving restart. A headless
 * host does none of those: agents launch on the far side of a relay, and the selection is set once
 * and never touched. So the refresh path exists and is simply never entered, and the token expires
 * in place with a refresh token that is still valid sitting right beside it.
 *
 * Measured 2026-09-14: access token dead for two days, refresh token good for another month, every
 * workspace opening logged out, and the log reporting the account as applied.
 *
 * `syncForCurrentSelection` is the entry point rather than the refresh itself because it is the
 * one that serializes. The refresh token is SINGLE USE -- rotating it twice concurrently
 * invalidates a copy -- and the service's mutation queue is what prevents that. It also already
 * defers while a live PTY owns the credentials, for the same reason.
 *
 * A tick is cheap and almost always a no-op: the refresh only fires inside the expiry buffer, and
 * a host with no selected account returns immediately.
 */

/** Long enough to be invisible against a token lifetime measured in hours, short enough that a
 *  missed tick is not a lapse. */
export const MANAGED_TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000

export type ManagedTokenRefreshDeps = {
  sync: () => Promise<void>
  intervalMs?: number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  log?: (message: string, error: unknown) => void
}

/** Start the schedule. Returns a stop function; starting twice is the caller's problem to avoid. */
export function startManagedTokenRefreshSchedule(deps: ManagedTokenRefreshDeps): () => void {
  const intervalMs = deps.intervalMs ?? MANAGED_TOKEN_REFRESH_INTERVAL_MS
  const setTimer = deps.setInterval ?? setInterval
  const clearTimer = deps.clearInterval ?? clearInterval
  const log =
    deps.log ??
    ((message: string, error: unknown) => console.warn(`[claude-token-refresh] ${message}`, error))

  let running = false
  const tick = async (): Promise<void> => {
    // Why: a sync that outlives the interval must not have a second one started on top of it. The
    // service serializes internally, so overlapping calls would queue rather than corrupt -- but
    // queueing refreshes behind a stalled one is a slow leak, not a safety net.
    if (running) {
      return
    }
    running = true
    try {
      await deps.sync()
    } catch (error) {
      // Why swallowed: this is maintenance, not a user action. A failed refresh leaves the
      // existing token exactly where it was, and the next tick tries again; throwing from a timer
      // would take the process with it.
      log('scheduled managed-token refresh failed', error)
    } finally {
      running = false
    }
  }

  const timer = setTimer(() => void tick(), intervalMs)
  // Why unref: this must never be the reason the process stays alive.
  timer.unref?.()
  return () => clearTimer(timer)
}
