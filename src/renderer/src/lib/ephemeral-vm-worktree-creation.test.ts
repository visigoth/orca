import { beforeEach, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation } from './pending-worktree-creation'

const { prepareTargetMock } = vi.hoisted(() => ({ prepareTargetMock: vi.fn() }))

const store = {
  repos: [{ id: 'repo-1' }],
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  activePendingCreationId: 'creation-1',
  updatePendingWorktreeCreation: vi.fn(),
  setupProjectExistingFolder: vi.fn(),
  fetchRepos: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/ephemeral-vm-workspace-target', () => ({
  prepareEphemeralVmWorkspaceTarget: prepareTargetMock
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { prepareRequestForCreate } from './ephemeral-vm-worktree-creation'

beforeEach(() => {
  vi.clearAllMocks()
  store.pendingWorktreeCreations = {
    'creation-1': {
      creationId: 'creation-1',
      phase: 'provisioning-vm',
      status: 'creating',
      startedAt: 1,
      indeterminate: true,
      loaderVisible: true,
      request: {} as never
    }
  }
  globalThis.window = {
    api: { ephemeralVm: { onProvisionEvent: vi.fn(() => vi.fn()) } }
  } as never
})

it('carries the captured provisioned-root ref identity into adoption', async () => {
  prepareTargetMock.mockResolvedValue({
    ok: true,
    runtimeId: 'runtime-1',
    checkoutMode: 'provisioned-root',
    expectedRefHead: 'abc123',
    stderr: '',
    warnings: [],
    target: {
      repoId: 'repo-runtime',
      path: '/workspace/repo',
      projectId: 'project-1',
      projectHostSetupId: 'setup-runtime',
      hostId: 'ssh:runtime-ssh-runtime-1'
    }
  })

  const prepared = await prepareRequestForCreate('creation-1', {
    repoId: 'repo-1',
    name: 'feature',
    baseBranch: 'origin/main',
    branchNameOverride: 'feature/ref-check',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ephemeralVmRecipe: {
      sourceRepoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'github:stablyai/orca',
      checkoutMode: 'provisioned-root'
    }
  })

  expect(prepareTargetMock).toHaveBeenCalledWith(
    expect.objectContaining({ branch: 'feature/ref-check', ref: 'origin/main' })
  )
  expect(prepared).toMatchObject({
    ephemeralVmRuntimeId: 'runtime-1',
    ephemeralVmCheckoutMode: 'provisioned-root',
    ephemeralVmExpectedRefHead: 'abc123'
  })
  // A runtime registered the provisioned checkout host-side, so the repo the workspace is about
  // to be created against is not in this client's catalog yet.
  expect(store.fetchRepos).toHaveBeenCalled()
})
