import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

type Call = { method: string; params: unknown }

async function installWithRuntime(
  respond: (method: string, params: unknown) => unknown
): Promise<{ api: Window['api']; calls: Call[] }> {
  const calls: Call[] = []
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> {
        calls.push({ method, params })
        try {
          return Promise.resolve({
            id: method,
            ok: true,
            result: respond(method, params),
            _meta: { runtimeId: 'runtime-web' }
          })
        } catch (error) {
          return Promise.resolve({
            id: method,
            ok: false,
            error: { code: 'remote_failure', message: (error as Error).message },
            _meta: { runtimeId: 'runtime-web' }
          })
        }
      }

      close(): void {}
    }
  }))
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage, 'web-env-1')
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  return { api: globals.window.api, calls }
}

describe('web preload ephemeral VM API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('lists a repo’s recipes over vm.listRecipes instead of the empty list fallback', async () => {
    const { api, calls } = await installWithRuntime(() => ({
      status: 'ok',
      repoPath: '/mnt/workspace/stoa',
      recipes: [{ id: 'workhorse', name: 'Workhorse', create: 'create.sh' }],
      diagnostics: []
    }))

    await expect(api.ephemeralVm.listRecipes({ repoId: 'repo-1' })).resolves.toMatchObject({
      status: 'ok',
      recipes: [{ id: 'workhorse' }]
    })
    expect(calls).toContainEqual({ method: 'vm.listRecipes', params: { repo: 'repo-1' } })
  })

  it('provisions and registers the workspace target in one runtime call', async () => {
    const target = {
      runtimeId: 'runtime-1',
      connectionType: 'ssh',
      checkoutMode: 'orca-worktree',
      hostId: 'ssh:runtime-ssh-runtime-1',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-provisioned',
      projectId: 'github:symmory/stoa',
      path: '/mnt/workspace/stoa',
      warnings: []
    }
    const { api, calls } = await installWithRuntime(() => target)

    await expect(
      api.ephemeralVm.provisionWorkspaceTarget?.({
        repoId: 'repo-1',
        recipeId: 'workhorse',
        workspaceName: 'fix-login',
        projectId: 'github:symmory/stoa'
      })
    ).resolves.toEqual(target)
    expect(calls).toContainEqual({
      method: 'vm.provisionWorkspaceTarget',
      params: {
        repo: 'repo-1',
        recipeId: 'workhorse',
        workspaceName: 'fix-login',
        projectId: 'github:symmory/stoa'
      }
    })
    // The desktop's streaming provision has no runtime equivalent, so it must refuse rather than
    // resolve undefined and let a caller believe an environment exists.
    await expect(
      api.ephemeralVm.provision({ repoId: 'repo-1', recipeId: 'workhorse' })
    ).rejects.toThrow(/desktop app/)
  })

  it('reads the runtime record back after cleanup so callers see its real status', async () => {
    const record = {
      id: 'runtime-1',
      recipeId: 'workhorse',
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastError: 'destroy.sh exited 1',
      sshTargetId: 'runtime-ssh-runtime-1'
    }
    const { api, calls } = await installWithRuntime((method) =>
      method === 'vm.listRuntimes' ? [record] : { runtimeId: 'runtime-1' }
    )

    await expect(api.ephemeralVm.cleanup({ runtimeId: 'runtime-1' })).resolves.toMatchObject({
      cleanupStatus: 'failed',
      cleanupLastError: 'destroy.sh exited 1',
      sshTargetId: 'runtime-ssh-runtime-1'
    })
    expect(calls.map((call) => call.method)).toEqual(['vm.cleanup', 'vm.listRuntimes'])
  })
})
