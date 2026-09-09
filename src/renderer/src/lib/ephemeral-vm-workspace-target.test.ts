import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  prepareEphemeralVmWorkspaceTarget,
  type PrepareEphemeralVmWorkspaceTargetArgs
} from './ephemeral-vm-workspace-target'
import type { ProjectHostSetupResult } from '../../../shared/project-types'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: vi.fn()
}))

import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'

describe('prepareEphemeralVmWorkspaceTarget', () => {
  beforeEach(() => {
    globalThis.window = {
      api: {
        ephemeralVm: {
          provision: vi.fn(),
          cleanup: vi.fn()
        }
      }
    } as never
    vi.clearAllMocks()
    vi.mocked(assertRuntimeEnvironmentCapability).mockResolvedValue(undefined)
  })

  it('provisions a recipe and imports the returned project root on the runtime host', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
      stderr: 'creating sandbox',
      warnings: [],
      environment: {
        id: 'env-1',
        name: 'Repo VM',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-env-1', kind: 'websocket', label: 'WebSocket', endpoint: 'wss://x' }],
        preferredEndpointId: 'ws-env-1'
      },
      runtime: {
        id: 'runtime-1',
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        runtimeEnvironmentId: 'env-1',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: {
          schemaVersion: 1,
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/repo'
        }
      }
    })
    const setupResult = {
      project: { id: 'project-1' },
      setup: { id: 'setup-1', hostId: 'local', projectId: 'project-1' },
      repo: { id: 'repo-runtime', path: '/workspace/repo' }
    } as ProjectHostSetupResult
    const setupExistingFolder = vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>(
      async () => setupResult
    )

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(window.api.ephemeralVm.provision).toHaveBeenCalledWith({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race'
    })
    expect(setupExistingFolder).toHaveBeenCalledWith({
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      path: '/workspace/repo',
      setupMethod: 'imported-existing-folder'
    })
    expect(result).toEqual({
      ok: true,
      target: {
        repoId: 'repo-runtime',
        path: '/workspace/repo',
        projectId: 'project-1',
        projectHostSetupId: 'setup-1',
        hostId: 'runtime:env-1'
      },
      runtimeId: 'runtime-1',
      checkoutMode: 'orca-worktree',
      environmentId: 'env-1',
      stderr: 'creating sandbox',
      warnings: []
    })
    expect(window.api.ephemeralVm.cleanup).not.toHaveBeenCalled()
  })

  it('carries a provisioned-root source commit through runtime-owned SSH import', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'ssh',
      stderr: 'creating sandbox',
      warnings: [],
      sshTargetId: 'runtime-ssh-runtime-1',
      expectedRefHead: 'abc123',
      runtime: {
        id: 'runtime-1',
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        connectionMode: 'ssh',
        sshTargetId: 'runtime-ssh-runtime-1',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: {
          schemaVersion: 2,
          checkoutMode: 'provisioned-root',
          connection: {
            type: 'ssh',
            projectRoot: '/workspace/repo',
            target: {
              label: 'Sandbox',
              host: 'sandbox.example.com',
              port: 22,
              username: 'root'
            }
          }
        }
      }
    })
    const setupResult = {
      project: { id: 'project-1' },
      setup: { id: 'setup-1', hostId: 'local', projectId: 'project-1' },
      repo: { id: 'repo-runtime', path: '/workspace/repo' }
    } as ProjectHostSetupResult
    const setupExistingFolder = vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>(
      async () => setupResult
    )

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(assertRuntimeEnvironmentCapability).not.toHaveBeenCalled()
    expect(setupExistingFolder).toHaveBeenCalledWith({
      projectId: 'project-1',
      hostId: 'ssh:runtime-ssh-runtime-1',
      path: '/workspace/repo',
      setupMethod: 'imported-existing-folder'
    })
    expect(result).toEqual({
      ok: true,
      target: {
        repoId: 'repo-runtime',
        path: '/workspace/repo',
        projectId: 'project-1',
        projectHostSetupId: 'setup-1',
        hostId: 'ssh:runtime-ssh-runtime-1'
      },
      runtimeId: 'runtime-1',
      checkoutMode: 'provisioned-root',
      expectedRefHead: 'abc123',
      stderr: 'creating sandbox',
      warnings: []
    })
    expect(window.api.ephemeralVm.cleanup).not.toHaveBeenCalled()
  })

  it('uses the runtime single-call path when the client cannot provision locally', async () => {
    // The browser client's provision + register happen in ONE RPC; the two-step desktop flow
    // cannot run there at all, because its local-provider registration refuses the ssh: host a
    // recipe produces.
    window.api.ephemeralVm.provisionWorkspaceTarget = vi.fn().mockResolvedValue({
      runtimeId: 'runtime-1',
      connectionType: 'ssh',
      checkoutMode: 'orca-worktree',
      hostId: 'ssh:runtime-ssh-runtime-1',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-provisioned',
      projectId: 'github:symmory/stoa',
      path: '/mnt/workspace/stoa',
      warnings: [{ id: 'recipe.slow', message: 'Provider took 4m' }]
    })
    const setupExistingFolder = vi.fn()

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'workhorse',
      projectId: 'github:symmory/stoa',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(window.api.ephemeralVm.provisionWorkspaceTarget).toHaveBeenCalledWith({
      repoId: 'repo-1',
      recipeId: 'workhorse',
      projectId: 'github:symmory/stoa',
      workspaceName: 'Fix Login Race'
    })
    expect(result).toEqual({
      ok: true,
      target: {
        repoId: 'repo-provisioned',
        path: '/mnt/workspace/stoa',
        projectId: 'github:symmory/stoa',
        projectHostSetupId: 'setup-1',
        hostId: 'ssh:runtime-ssh-runtime-1'
      },
      runtimeId: 'runtime-1',
      checkoutMode: 'orca-worktree',
      stderr: '',
      warnings: [{ id: 'recipe.slow', message: 'Provider took 4m' }]
    })
    // The workspace is created against the repo the recipe produced, never the source repo —
    // creating on the source would put the agent back on the Orca host.
    expect(window.api.ephemeralVm.provision).not.toHaveBeenCalled()
    expect(setupExistingFolder).not.toHaveBeenCalled()
  })

  it('reports a failed runtime provision instead of throwing at the caller', async () => {
    window.api.ephemeralVm.provisionWorkspaceTarget = vi
      .fn()
      .mockRejectedValue(new Error('create.sh exited 1\nno such image'))

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'workhorse',
      projectId: 'github:symmory/stoa',
      workspaceName: 'Fix Login Race',
      setupExistingFolder: vi.fn()
    })

    expect(result).toEqual({
      ok: false,
      error: 'create.sh exited 1\nno such image',
      stderr: ''
    })
  })

  it('cleans up a runtime-provisioned root that came back without SSH', async () => {
    window.api.ephemeralVm.provisionWorkspaceTarget = vi.fn().mockResolvedValue({
      runtimeId: 'runtime-1',
      connectionType: 'orca-server',
      checkoutMode: 'provisioned-root',
      hostId: 'runtime:env-1',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-provisioned',
      projectId: 'github:symmory/stoa',
      path: '/mnt/workspace/stoa',
      warnings: []
    })

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'workhorse',
      projectId: 'github:symmory/stoa',
      workspaceName: 'Fix Login Race',
      setupExistingFolder: vi.fn()
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Provisioned-root recipes currently require a direct SSH connection.'
    })
    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
  })

  it('rejects and cleans up an Orca-server provisioned root before project import', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
      stderr: 'creating sandbox',
      warnings: [],
      environment: {
        id: 'env-1',
        name: 'Repo VM',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-env-1', kind: 'websocket', label: 'WebSocket', endpoint: 'wss://x' }],
        preferredEndpointId: 'ws-env-1'
      },
      runtime: {
        id: 'runtime-1',
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        runtimeEnvironmentId: 'env-1',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: {
          schemaVersion: 2,
          checkoutMode: 'provisioned-root',
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/repo'
        }
      }
    })
    const setupExistingFolder = vi.fn()

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Provisioned-root recipes currently require a direct SSH connection.'
    })
    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(setupExistingFolder).not.toHaveBeenCalled()
  })

  it('cleans up the runtime when required project setup capability is missing', async () => {
    vi.mocked(assertRuntimeEnvironmentCapability).mockRejectedValue(
      new Error('The recipe-created Orca server does not support project setup.')
    )
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
      stderr: 'creating sandbox',
      warnings: [],
      environment: {
        id: 'env-1',
        name: 'Repo VM',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-env-1', kind: 'websocket', label: 'WebSocket', endpoint: 'wss://x' }],
        preferredEndpointId: 'ws-env-1'
      },
      runtime: {
        id: 'runtime-1',
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        runtimeEnvironmentId: 'env-1',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: {
          schemaVersion: 1,
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/repo'
        }
      }
    })
    const setupExistingFolder =
      vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>()

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      'project-host-setup.v1',
      'The recipe-created Orca server does not support project setup.'
    )
    expect(setupExistingFolder).not.toHaveBeenCalled()
    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(result).toEqual({
      ok: false,
      error: 'The recipe-created Orca server does not support project setup.',
      stderr: 'creating sandbox'
    })
  })

  it('returns the provision failure without importing a project root', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: false,
      error: 'Recipe stdout must be one JSON object.',
      stdout: 'nope',
      stderr: 'logs'
    })
    const setupExistingFolder =
      vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>()

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(setupExistingFolder).not.toHaveBeenCalled()
    expect(window.api.ephemeralVm.cleanup).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      error: 'Recipe stdout must be one JSON object.',
      stderr: 'logs'
    })
  })

  it('cleans up the runtime when importing the project root fails', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
      stderr: 'creating sandbox',
      warnings: [],
      environment: {
        id: 'env-1',
        name: 'Repo VM',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-env-1', kind: 'websocket', label: 'WebSocket', endpoint: 'wss://x' }],
        preferredEndpointId: 'ws-env-1'
      },
      runtime: {
        id: 'runtime-1',
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        runtimeEnvironmentId: 'env-1',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: {
          schemaVersion: 1,
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/repo'
        }
      }
    })
    const setupExistingFolder = vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>(
      async () => null
    )

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(result).toEqual({
      ok: false,
      error: 'Failed to register the recipe-created project root on the runtime.',
      stderr: 'creating sandbox'
    })
  })

  it('cleans up the runtime when the returned project root is not a git repo', async () => {
    vi.mocked(window.api.ephemeralVm.provision).mockResolvedValue({
      ok: true,
      connectionType: 'orca-server',
      stderr: 'creating sandbox',
      warnings: [],
      environment: {
        id: 'env-1',
        name: 'Repo VM',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-env-1', kind: 'websocket', label: 'WebSocket', endpoint: 'wss://x' }],
        preferredEndpointId: 'ws-env-1'
      },
      runtime: {
        id: 'runtime-1',
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        runtimeEnvironmentId: 'env-1',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: {
          schemaVersion: 1,
          pairingCode: 'orca://pair?code=test',
          projectRoot: '/workspace/not-a-repo'
        }
      }
    })
    const setupExistingFolder = vi.fn<PrepareEphemeralVmWorkspaceTargetArgs['setupExistingFolder']>(
      async () => {
        throw new Error('Not a valid git repository: /workspace/not-a-repo')
      }
    )

    const result = await prepareEphemeralVmWorkspaceTarget({
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      setupExistingFolder
    })

    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    expect(result).toEqual({
      ok: false,
      error: 'Not a valid git repository: /workspace/not-a-repo',
      stderr: 'creating sandbox'
    })
  })
})
