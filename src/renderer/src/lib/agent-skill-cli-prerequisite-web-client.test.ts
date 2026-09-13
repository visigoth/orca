import { describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import {
  isCliRegistrationManagedOffClient,
  isOrcaCliAvailableOnPath
} from './agent-skill-cli-prerequisite'

// The exact status the web build's cli API returns, from web-cli-api.ts. Copied rather than
// imported because the point is that this shape reaches the gate unchanged.
const WEB_CLIENT_STATUS = {
  platform: 'linux',
  commandName: 'orca-ide',
  commandPath: null,
  pathDirectory: null,
  pathConfigured: false,
  launcherPath: null,
  installMethod: null,
  supported: false,
  state: 'unsupported',
  currentTarget: null,
  unsupportedReason: 'launch_mode_unavailable',
  detail: 'CLI registration is managed on the Orca server, not in the web browser.'
} as unknown as CliInstallStatus

function status(overrides: Partial<CliInstallStatus>): CliInstallStatus {
  return { ...WEB_CLIENT_STATUS, ...overrides } as CliInstallStatus
}

describe('isOrcaCliAvailableOnPath', () => {
  // Why this test exists: a browser session reported "Orca CLI is missing" on a server where the
  // CLI was installed and on PATH, permanently, because the answer came from the browser.
  it('does not call the CLI missing in a client that cannot host one', () => {
    expect(isOrcaCliAvailableOnPath(WEB_CLIENT_STATUS)).toBe(true)
    expect(isCliRegistrationManagedOffClient(WEB_CLIENT_STATUS)).toBe(true)
  })

  // A dev build reports the same reason but names the path it would install to, so its prompt is
  // actionable and must survive.
  it('still reports a dev build as unavailable, since it names a path it could install to', () => {
    const devBuild = status({
      commandPath: '/home/dev/.local/bin/orca-dev',
      pathDirectory: '/home/dev/.local/bin',
      commandName: 'orca-dev'
    })
    expect(isCliRegistrationManagedOffClient(devBuild)).toBe(false)
    expect(isOrcaCliAvailableOnPath(devBuild)).toBe(false)
  })

  it('reports a real installation as available', () => {
    expect(
      isOrcaCliAvailableOnPath(
        status({
          state: 'installed',
          supported: true,
          pathConfigured: true,
          commandPath: '/home/orca/.local/bin/orca-ide',
          unsupportedReason: null
        })
      )
    ).toBe(true)
  })

  it('still reports a genuinely broken desktop installation as unavailable', () => {
    const conflict = status({
      state: 'conflict',
      supported: true,
      pathConfigured: true,
      commandPath: '/home/orca/.local/bin/orca-ide',
      unsupportedReason: null
    })
    const offPath = status({
      state: 'installed',
      supported: true,
      pathConfigured: false,
      commandPath: '/home/orca/.local/bin/orca-ide',
      unsupportedReason: null
    })
    expect(isOrcaCliAvailableOnPath(conflict)).toBe(false)
    expect(isOrcaCliAvailableOnPath(offPath)).toBe(false)
  })

  it('treats a missing status as unavailable rather than assuming the best', () => {
    expect(isOrcaCliAvailableOnPath(null)).toBe(false)
    expect(isOrcaCliAvailableOnPath(undefined)).toBe(false)
  })
})
