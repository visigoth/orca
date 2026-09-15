import { describe, expect, it } from 'vitest'

import {
  collectUnreachableRuntimeHostSessionIds,
  forgetHostWorkspaceSessions,
  runtimeHostIdsForSshTargets
} from './runtime-host-session-residue'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'

type Sessions = PersistedState['workspaceSessionsByHostId']

function sessionsFor(hostIds: readonly string[]): Sessions {
  return Object.fromEntries(
    hostIds.map((hostId) => [hostId, { tabsByWorktree: {} }])
  ) as unknown as Sessions
}

function stateWith(args: {
  hostIds: readonly string[]
  targetIds: readonly string[]
}): Pick<PersistedState, 'workspaceSessionsByHostId' | 'sshTargets'> {
  return {
    workspaceSessionsByHostId: sessionsFor(args.hostIds),
    sshTargets: args.targetIds.map((id) => ({ id })) as PersistedState['sshTargets']
  }
}

describe('forgetHostWorkspaceSessions', () => {
  it('drops the named buckets and leaves the rest untouched', () => {
    const sessions = sessionsFor(['local', 'ssh:runtime-ssh-orca-a', 'ssh:desk'])
    const result = forgetHostWorkspaceSessions(sessions, [
      'ssh:runtime-ssh-orca-a' as ExecutionHostId
    ])
    expect(Object.keys(result.sessions ?? {})).toEqual(['local', 'ssh:desk'])
    expect(result.removed).toEqual(['ssh:runtime-ssh-orca-a'])
  })

  it('returns the original object when nothing matched, so load does not schedule a write', () => {
    const sessions = sessionsFor(['local'])
    const result = forgetHostWorkspaceSessions(sessions, [
      'ssh:runtime-ssh-orca-a' as ExecutionHostId
    ])
    expect(result.sessions).toBe(sessions)
    expect(result.removed).toEqual([])
  })

  it('does not mutate the input', () => {
    const sessions = sessionsFor(['ssh:runtime-ssh-orca-a'])
    forgetHostWorkspaceSessions(sessions, ['ssh:runtime-ssh-orca-a' as ExecutionHostId])
    expect(Object.keys(sessions ?? {})).toEqual(['ssh:runtime-ssh-orca-a'])
  })
})

describe('runtimeHostIdsForSshTargets', () => {
  it('maps runtime-owned target ids to their execution host ids', () => {
    expect(runtimeHostIdsForSshTargets(['runtime-ssh-orca-a'])).toEqual(['ssh:runtime-ssh-orca-a'])
  })

  it('refuses a user-registered target, whose partition must survive being offline', () => {
    expect(runtimeHostIdsForSshTargets(['desk', ''])).toEqual([])
  })
})

describe('collectUnreachableRuntimeHostSessionIds', () => {
  it('reports a runtime host whose target is no longer registered', () => {
    const state = stateWith({ hostIds: ['ssh:runtime-ssh-orca-a'], targetIds: [] })
    expect(collectUnreachableRuntimeHostSessionIds(state)).toEqual(['ssh:runtime-ssh-orca-a'])
  })

  it('keeps a runtime host whose target is still registered', () => {
    const state = stateWith({
      hostIds: ['ssh:runtime-ssh-orca-a'],
      targetIds: ['runtime-ssh-orca-a']
    })
    expect(collectUnreachableRuntimeHostSessionIds(state)).toEqual([])
  })

  it('keeps an unregistered USER ssh target: offline is not gone', () => {
    const state = stateWith({ hostIds: ['ssh:desk'], targetIds: [] })
    expect(collectUnreachableRuntimeHostSessionIds(state)).toEqual([])
  })

  it('keeps local and runtime: hosts, which name no ssh target at all', () => {
    const state = stateWith({ hostIds: ['local', 'runtime:env-1'], targetIds: [] })
    expect(collectUnreachableRuntimeHostSessionIds(state)).toEqual([])
  })

  it('matches a percent-encoded host key against its decoded target id', () => {
    const state = stateWith({
      hostIds: ['ssh:runtime-ssh-orca%2Fa'],
      targetIds: ['runtime-ssh-orca/a']
    })
    expect(collectUnreachableRuntimeHostSessionIds(state)).toEqual([])
  })

  it('tolerates a state with neither map present', () => {
    expect(
      collectUnreachableRuntimeHostSessionIds(
        {} as Pick<PersistedState, 'workspaceSessionsByHostId' | 'sshTargets'>
      )
    ).toEqual([])
  })
})
