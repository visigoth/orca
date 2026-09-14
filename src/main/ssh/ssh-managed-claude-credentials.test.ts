import { describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  buildRemoteProbeCommand,
  isRemoteProbeUsable,
  materializeManagedClaudeCredentials,
  shellQuote
} from './ssh-managed-claude-credentials'

const linux = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

function makeDeps(
  overrides: Partial<Parameters<typeof materializeManagedClaudeCredentials>[0]> = {}
): Parameters<typeof materializeManagedClaudeCredentials>[0] {
  return {
    hostPlatform: linux,
    remoteNodePath: '/usr/local/bin/node',
    execRemote: vi.fn(async (command: string) =>
      command.startsWith('printf') ? '/home/node/.claude' : 'STALE'
    ),
    uploadFile: vi.fn(async () => {}),
    readLocalCredentials: vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: { accessToken: 'live-token', expiresAt: Date.now() + 60 * 60 * 1000 }
      })
    ),
    resolveManagedCredentialsPath: vi.fn(async () => '/managed/acct/auth/.credentials.json'),
    log: () => {},
    ...overrides
  }
}

describe('materializeManagedClaudeCredentials', () => {
  it('uploads the managed credentials when the remote has none usable', async () => {
    const deps = makeDeps()
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe('written')
    expect(deps.uploadFile).toHaveBeenCalledWith(
      '/managed/acct/auth/.credentials.json',
      '/home/node/.claude/.credentials.json'
    )
    const commands = (deps.execRemote as ReturnType<typeof vi.fn>).mock.calls.map(
      ([command]) => command as string
    )
    // The private directory must exist before the file lands in it, and the file is tightened after.
    expect(commands.some((c) => c.includes('chmod 700'))).toBe(true)
    expect(commands.at(-1)).toContain('chmod 600')
  })

  // Why: a login the user performed inside the workspace outranks ours, and clobbering it would
  // silently swap which account their agent is running as.
  it('leaves an already-authenticated remote alone', async () => {
    const deps = makeDeps({
      execRemote: vi.fn(async (command: string) =>
        command.startsWith('printf') ? '/home/node/.claude' : 'USABLE'
      )
    })
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe(
      'remote-already-authenticated'
    )
    expect(deps.uploadFile).not.toHaveBeenCalled()
  })

  // Why: Claude Code rewrites this file to empty tokens after a failed refresh, and treating that
  // as authenticated is what strands a workspace at the login prompt forever.
  it('overwrites credentials the remote cleared after a failed refresh', async () => {
    const deps = makeDeps({
      execRemote: vi.fn(async (command: string) =>
        command.startsWith('printf') ? '/home/node/.claude' : 'STALE'
      )
    })
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe('written')
    expect(deps.uploadFile).toHaveBeenCalled()
  })

  it('does nothing when no managed account is registered', async () => {
    const deps = makeDeps({ resolveManagedCredentialsPath: vi.fn(async () => null) })
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe('no-managed-account')
    expect(deps.uploadFile).not.toHaveBeenCalled()
    expect(deps.execRemote).not.toHaveBeenCalled()
  })

  // Why: the command vocabulary here is POSIX, and guessing at a Windows config-dir rule would
  // write a secret to the wrong place.
  it('skips Windows remotes rather than guessing their dialect', async () => {
    const deps = makeDeps({ hostPlatform: windows })
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe('unsupported-remote')
    expect(deps.uploadFile).not.toHaveBeenCalled()
  })

  it('never fails session establish when the remote misbehaves', async () => {
    const deps = makeDeps({
      execRemote: vi.fn(async () => {
        throw new Error('connection reset')
      })
    })
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe('unavailable')
    expect(deps.uploadFile).not.toHaveBeenCalled()
  })

  it('refuses a config dir the remote could not resolve', async () => {
    const deps = makeDeps({ execRemote: vi.fn(async () => '') })
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe('unavailable')
    expect(deps.uploadFile).not.toHaveBeenCalled()
  })

  it('uploads without the probe when the remote node path is unknown', async () => {
    const deps = makeDeps({ remoteNodePath: null })
    await expect(materializeManagedClaudeCredentials(deps)).resolves.toBe('written')
  })
})

describe('remote probe', () => {
  it('treats only an unexpired access token as usable', () => {
    expect(isRemoteProbeUsable('USABLE')).toBe(true)
    expect(isRemoteProbeUsable(' USABLE\n')).toBe(true)
    expect(isRemoteProbeUsable('STALE')).toBe(false)
    expect(isRemoteProbeUsable('')).toBe(false)
  })

  // Why: the probe program is embedded in a single-quoted shell word, so a stray single quote in it
  // would end the quoting and hand the rest to the remote shell.
  it('embeds a probe program with no single quotes of its own', () => {
    const command = buildRemoteProbeCommand('/usr/local/bin/node', '/home/node/.claude')
    const program = command.slice(command.indexOf("-e '") + 4, command.lastIndexOf("' '"))
    expect(program).not.toContain("'")
    expect(command).toContain('/home/node/.claude/.credentials.json')
  })
})

describe('shellQuote', () => {
  it('survives a quote in a path', () => {
    expect(shellQuote("/home/o'brien/.claude")).toBe(`'/home/o'\\''brien/.claude'`)
  })
})

describe('a stale managed account is refused, not sent', () => {
  // The 2026-09-14 failure, reproduced: a token that expired two days earlier satisfied every
  // other check -- account registered, file present, shape correct -- and was materialised and
  // reported applied. The agent then opened logged out while the log claimed success.
  it('refuses a source token that has already expired', async () => {
    const uploadFile = vi.fn(async () => {})
    const outcome = await materializeManagedClaudeCredentials(
      makeDeps({
        uploadFile,
        readLocalCredentials: async () =>
          JSON.stringify({
            claudeAiOauth: {
              accessToken: 'expired-token',
              refreshToken: 'r',
              expiresAt: Date.now() - 2 * 24 * 60 * 60 * 1000
            }
          })
      })
    )

    expect(outcome).toBe('stale-managed-account')
    expect(uploadFile).not.toHaveBeenCalled()
  })

  // What the far side wrote back after failing to rotate the expired token: correct shape, no
  // tokens. Sending that on would be indistinguishable from sending nothing.
  it('refuses a blob whose tokens are blank', async () => {
    const uploadFile = vi.fn(async () => {})
    const outcome = await materializeManagedClaudeCredentials(
      makeDeps({
        uploadFile,
        readLocalCredentials: async () =>
          JSON.stringify({
            claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: Date.now() + 3600000 }
          })
      })
    )

    expect(outcome).toBe('stale-managed-account')
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('refuses rather than throwing when the source cannot be read', async () => {
    const uploadFile = vi.fn(async () => {})
    const outcome = await materializeManagedClaudeCredentials(
      makeDeps({
        uploadFile,
        readLocalCredentials: async () => {
          throw new Error('ENOENT')
        }
      })
    )

    expect(outcome).toBe('stale-managed-account')
    expect(uploadFile).not.toHaveBeenCalled()
  })

  // Expiring within the 5-minute skew is treated as unusable: the agent on the far side cannot
  // refresh for us, so a token about to die is not worth the trip.
  it('refuses a token inside the refresh buffer', async () => {
    const outcome = await materializeManagedClaudeCredentials(
      makeDeps({
        readLocalCredentials: async () =>
          JSON.stringify({
            claudeAiOauth: { accessToken: 'almost-dead', expiresAt: Date.now() + 60000 }
          })
      })
    )

    expect(outcome).toBe('stale-managed-account')
  })

  it('still sends a live token', async () => {
    const uploadFile = vi.fn(async () => {})
    const outcome = await materializeManagedClaudeCredentials(makeDeps({ uploadFile }))

    expect(outcome).toBe('written')
    expect(uploadFile).toHaveBeenCalled()
  })
})
