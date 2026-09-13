import { describe, expect, it, vi } from 'vitest'
import {
  attachRecipeRuntimeToWorkspace,
  provisionRecipeTarget
} from './workspace-create-recipe-target'

function client(sendRequest: ReturnType<typeof vi.fn>) {
  return { sendRequest } as unknown as Parameters<typeof provisionRecipeTarget>[0]['client']
}

describe('provisionRecipeTarget', () => {
  it('provisions against the source repo and returns the target repo to create in', async () => {
    const sendRequest = vi.fn(async () => ({
      ok: true,
      result: { repoId: 'provisioned-repo', runtimeId: 'rt-1' }
    }))
    const result = await provisionRecipeTarget({
      client: client(sendRequest),
      repoId: 'source-repo',
      recipeId: 'stoa-generic',
      workspaceName: 'my-workspace'
    })

    expect(result.repoId).toBe('provisioned-repo')
    const [method, params] = sendRequest.mock.calls[0] as [string, Record<string, unknown>]
    expect(method).toBe('vm.provisionWorkspaceTarget')
    expect(params.repo).toBe('id:source-repo')
    expect(params.recipeId).toBe('stoa-generic')
    // Why branch: provisioned-root recipes clone inside the environment, which is created before
    // the worktree exists, so the branch has to travel with the provision request.
    expect(params.branch).toBe('my-workspace')
    expect(params).not.toHaveProperty('ref')
  })

  it('passes a base branch through as the start ref when one is chosen', async () => {
    const sendRequest = vi.fn(async () => ({ ok: true, result: { repoId: 'r' } }))
    await provisionRecipeTarget({
      client: client(sendRequest),
      repoId: 'source',
      recipeId: 'r1',
      workspaceName: 'w',
      baseBranch: 'release/2.0'
    })
    const [, params] = sendRequest.mock.calls[0] as [string, Record<string, unknown>]
    expect(params.ref).toBe('release/2.0')
  })

  // Why: creating against the SOURCE repo after a half-successful provision would put the
  // workspace on the Orca host while an environment sits booted and unreferenced.
  it('fails loudly when provisioning returns no target', async () => {
    const sendRequest = vi.fn(async () => ({ ok: true, result: {} }))
    await expect(
      provisionRecipeTarget({
        client: client(sendRequest),
        repoId: 'source',
        recipeId: 'r1',
        workspaceName: 'w'
      })
    ).rejects.toThrow(/workspace target/)
  })
})

describe('provisionRecipeTarget envelope handling', () => {
  // Why this test exists: the transport answers { ok, result }, and reading through the envelope
  // leaves the target undefined — which would silently send the workspace to the very host the
  // recipe was chosen to avoid.
  it('surfaces a transport-level failure instead of treating it as a missing target', async () => {
    const sendRequest = vi.fn(async () => ({ ok: false, error: { message: 'no such recipe' } }))
    await expect(
      provisionRecipeTarget({
        client: client(sendRequest),
        repoId: 'source',
        recipeId: 'nope',
        workspaceName: 'w'
      })
    ).rejects.toThrow('no such recipe')
  })
})

describe('attachRecipeRuntimeToWorkspace', () => {
  it('binds the runtime to the workspace it now backs', async () => {
    const sendRequest = vi.fn(async () => ({ ok: true, result: {} }))
    await attachRecipeRuntimeToWorkspace({
      client: client(sendRequest),
      provisioned: { repoId: 'r', runtimeId: 'rt-1' },
      workspaceId: 'ws-1'
    })
    expect(sendRequest).toHaveBeenCalledWith('vm.attachWorkspace', {
      runtimeId: 'rt-1',
      workspaceId: 'ws-1'
    })
  })

  // Why non-fatal: the workspace exists either way, and throwing here would strand it. The cost of
  // the failure is a container that outlives its workspace, so it warns rather than going quiet.
  it('warns instead of throwing when the bind fails', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('runtime gone')
    })
    const onWarning = vi.fn()
    await expect(
      attachRecipeRuntimeToWorkspace({
        client: client(sendRequest),
        provisioned: { repoId: 'r', runtimeId: 'rt-1' },
        workspaceId: 'ws-1',
        onWarning
      })
    ).resolves.toBeUndefined()
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('runtime gone'))
  })

  it('does nothing when there was no recipe, or no workspace to bind', async () => {
    const sendRequest = vi.fn(async () => ({ ok: true, result: {} }))
    await attachRecipeRuntimeToWorkspace({
      client: client(sendRequest),
      provisioned: null,
      workspaceId: 'ws-1'
    })
    await attachRecipeRuntimeToWorkspace({
      client: client(sendRequest),
      provisioned: { repoId: 'r', runtimeId: 'rt-1' },
      workspaceId: undefined
    })
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
