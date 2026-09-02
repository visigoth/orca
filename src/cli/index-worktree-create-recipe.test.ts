import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree create --recipe', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('provisions the recipe first and creates the workspace on the provisioned repo', async () => {
    queueFixtures(
      callMock,
      // Why: create infers the parent/repo from cwd first, so this list call precedes the
      // provision call and would otherwise consume the provision fixture.
      worktreeListFixture([]),
      okFixture('req_provision', {
        runtimeId: 'runtime-1',
        connectionType: 'ssh',
        checkoutMode: 'worktree',
        hostId: 'ssh:target-1',
        projectHostSetupId: 'setup-1',
        repoId: 'provisioned-repo-1',
        projectId: 'github:acme/app',
        path: '/mnt/workspace/app',
        warnings: []
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/mnt/workspace/app/task', 'task', 'abc', 'provisioned-repo-1'),
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main([
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'task',
      '--recipe',
      'workhorse'
    ])

    const provisionCall = callMock.mock.calls.find(
      (call) => call[0] === 'vm.provisionWorkspaceTarget'
    )
    expect(provisionCall?.[1]).toMatchObject({
      repo: 'id:repo-1',
      recipeId: 'workhorse',
      workspaceName: 'task',
      // Why: provisioned-root recipes clone inside the environment, so the branch must be known
      // before the worktree exists.
      branch: 'task'
    })

    // The workspace must be created against the repo the recipe produced, NOT the source repo —
    // creating on the source would silently put the agent back on the Orca host, which is the
    // failure this flag exists to prevent.
    const createCall = callMock.mock.calls.find((call) => call[0] === 'worktree.create')
    expect(createCall?.[1]).toMatchObject({ repo: 'id:provisioned-repo-1', name: 'task' })
  })

  it('creates locally with no provisioning when --recipe is absent', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/task', 'task', 'abc', 'repo-1'),
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['worktree', 'create', '--repo', 'id:repo-1', '--name', 'task'])

    expect(callMock.mock.calls.some((call) => call[0] === 'vm.provisionWorkspaceTarget')).toBe(
      false
    )
    const createCall = callMock.mock.calls.find((call) => call[0] === 'worktree.create')
    expect(createCall?.[1]).toMatchObject({ repo: 'id:repo-1' })
  })
})
