import { describe, expect, it, vi } from 'vitest'
import {
  MANAGED_TOKEN_REFRESH_INTERVAL_MS,
  startManagedTokenRefreshSchedule
} from './managed-token-refresh-schedule'

/** A hand-driven interval, so ticks happen when the test says rather than when a clock does. */
function fakeTimer() {
  let fn: (() => void) | null = null
  let cleared = false
  const setIntervalFn = ((callback: () => void) => {
    fn = callback
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval
  const clearIntervalFn = (() => {
    cleared = true
  }) as unknown as typeof clearInterval
  return {
    setIntervalFn,
    clearIntervalFn,
    tick: () => fn?.(),
    get cleared() {
      return cleared
    }
  }
}

describe('startManagedTokenRefreshSchedule', () => {
  it('syncs on each tick', async () => {
    const timer = fakeTimer()
    const sync = vi.fn(async () => {})
    startManagedTokenRefreshSchedule({
      sync,
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn
    })

    timer.tick()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    timer.tick()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
  })

  // Why this matters more than it looks: the service serializes internally, so overlapping calls
  // queue rather than corrupt -- but queueing refreshes behind one that has stalled is a slow
  // leak. A tick that finds the previous one still running does nothing.
  it('does not start a second sync while one is still running', async () => {
    const timer = fakeTimer()
    let release: (() => void) | undefined
    const sync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    startManagedTokenRefreshSchedule({
      sync,
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn
    })

    timer.tick()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    timer.tick()
    timer.tick()
    expect(sync).toHaveBeenCalledTimes(1)

    release?.()
    await vi.waitFor(() => expect(release).toBeDefined())
    timer.tick()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
  })

  // A failed refresh leaves the existing token where it was and the next tick retries. Throwing
  // out of a timer would take the process with it.
  it('survives a failing sync and keeps ticking', async () => {
    const timer = fakeTimer()
    const log = vi.fn()
    const sync = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue(undefined)
    startManagedTokenRefreshSchedule({
      sync,
      log,
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn
    })

    timer.tick()
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
    timer.tick()
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
  })

  it('stops when told to', () => {
    const timer = fakeTimer()
    const stop = startManagedTokenRefreshSchedule({
      sync: async () => {},
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn
    })
    stop()
    expect(timer.cleared).toBe(true)
  })

  // Half an hour against a token lifetime measured in hours: invisible, and a missed tick is not
  // a lapse.
  it('defaults to a interval well inside the token lifetime', () => {
    expect(MANAGED_TOKEN_REFRESH_INTERVAL_MS).toBe(30 * 60 * 1000)
  })
})
