import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliInstaller } from './cli-installer'
import { makeFixture } from './cli-installer-test-fixtures'

// Why: `pathConfigured` answers "does typing the command run Orca", and the install directory being
// on PATH is only the most common way for that to be true. A packaged Linux image can put the same
// launcher on PATH itself, and callers gate real behaviour on this flag -- agent-skill setup reads a
// false as "the Orca CLI is missing" and shows its prompt forever on a host where the CLI works.
describe.skipIf(process.platform === 'win32')('cli install path resolution', () => {
  it('reports pathConfigured when the same launcher is reachable from another PATH entry', async () => {
    const fixture = await makeFixture()
    const homeBin = join(fixture.root, 'home', '.local', 'bin')
    const systemBin = join(fixture.root, 'usr', 'local', 'bin')
    const bundledLauncher = join(fixture.root, 'opt', 'orca', 'resources', 'bin', 'orca-ide')
    await mkdir(homeBin, { recursive: true })
    await mkdir(systemBin, { recursive: true })
    await mkdir(join(fixture.root, 'opt', 'orca', 'resources', 'bin'), { recursive: true })
    await writeFile(bundledLauncher, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

    // The shape a container image produces: the managed command in ~/.local/bin, which is NOT on
    // PATH, and the identical launcher exposed at /usr/local/bin, which is.
    const commandPath = join(homeBin, 'orca-ide')
    await symlink(bundledLauncher, commandPath)
    await symlink(bundledLauncher, join(systemBin, 'orca-ide'))

    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: fixture.userDataPath,
      execPath: join(fixture.root, 'opt', 'orca', 'orca-ide'),
      appPath: fixture.appPath,
      resourcesPath: join(fixture.root, 'opt', 'orca', 'resources'),
      commandPathOverride: commandPath,
      processPathEnv: systemBin
    })

    const status = await installer.getStatus()
    expect(status.pathConfigured).toBe(true)
  })

  it('leaves pathConfigured false when a same-named command on PATH is not ours', async () => {
    const fixture = await makeFixture()
    const homeBin = join(fixture.root, 'home', '.local', 'bin')
    const systemBin = join(fixture.root, 'usr', 'local', 'bin')
    const bundledLauncher = join(fixture.root, 'opt', 'orca', 'resources', 'bin', 'orca-ide')
    await mkdir(homeBin, { recursive: true })
    await mkdir(systemBin, { recursive: true })
    await mkdir(join(fixture.root, 'opt', 'orca', 'resources', 'bin'), { recursive: true })
    await writeFile(bundledLauncher, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

    const commandPath = join(homeBin, 'orca-ide')
    await symlink(bundledLauncher, commandPath)
    // Someone else's binary of the same name must not count as ours.
    await writeFile(join(systemBin, 'orca-ide'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 })

    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: fixture.userDataPath,
      execPath: join(fixture.root, 'opt', 'orca', 'orca-ide'),
      appPath: fixture.appPath,
      resourcesPath: join(fixture.root, 'opt', 'orca', 'resources'),
      commandPathOverride: commandPath,
      processPathEnv: systemBin
    })

    const status = await installer.getStatus()
    expect(status.pathConfigured).toBe(false)
  })

  it('still reports pathConfigured when the install directory itself is on PATH', async () => {
    const fixture = await makeFixture()
    const homeBin = join(fixture.root, 'home', '.local', 'bin')
    const bundledLauncher = join(fixture.root, 'opt', 'orca', 'resources', 'bin', 'orca-ide')
    await mkdir(homeBin, { recursive: true })
    await mkdir(join(fixture.root, 'opt', 'orca', 'resources', 'bin'), { recursive: true })
    await writeFile(bundledLauncher, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

    const commandPath = join(homeBin, 'orca-ide')
    await symlink(bundledLauncher, commandPath)

    const installer = new CliInstaller({
      platform: 'linux',
      isPackaged: true,
      userDataPath: fixture.userDataPath,
      execPath: join(fixture.root, 'opt', 'orca', 'orca-ide'),
      appPath: fixture.appPath,
      resourcesPath: join(fixture.root, 'opt', 'orca', 'resources'),
      commandPathOverride: commandPath,
      processPathEnv: homeBin
    })

    const status = await installer.getStatus()
    expect(status.pathConfigured).toBe(true)
  })
})
