import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

function envelope(
  method: string,
  fields: Record<string, unknown>,
  overrides: Partial<AgentSessionMutationEnvelope> = {}
): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    }),
    ...overrides
  }
}

const attachParams = (
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams => hostTestAttachParams(null, overrides)

const ensureParams = (fence: number): AgentSessionAttachParams => hostTestAttachParams(fence)

function createIntentEnvelope(): AgentSessionMutationEnvelope {
  const fields = { worktree: 'id:workspace-1', agent: 'codex' as const }
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.create',
      sessionId: SESSION,
      fields
    })
  }
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let releaseAcquisition: Mock<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
let ordinal = 0

function accepted(): AgentSessionDispatchOutcome {
  ordinal += 1
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal }
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire,
    releaseAcquisition,
    dispatch,
    cancelTurn,
    answerPrompt,
    setOption
  }
}

async function attach(): Promise<AgentSessionRecord | null> {
  const result = await host.attach(CALLER, attachParams())
  expect(result.ok).toBe(true)
  return store.getRecord(SESSION)
}

/** Puts a pending approval in the journal BEFORE attach, which is the only way
 *  1d can stage one: the adapter that would emit it is phase 2's. */
async function seedApproval(optionId = 'allow'): Promise<{ itemId: string; revision: number }> {
  const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 99 }
  const journalDir = journalDirectoryFor(root, { workspaceId: 'workspace-1', sessionId: SESSION })
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir
  })
  const appended = await journal.appendItem(
    identity,
    {
      kind: 'approval',
      title: 'Run the command?',
      detail: null,
      options: [{ id: optionId, label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1 }
  )
  return { itemId: appended.itemId, revision: appended.revision }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-host-'))
  resetHostTestOperationIds()
  ordinal = 0
  acquire = vi.fn(async ({ fence }) => ({
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  releaseAcquisition = vi.fn(async () => true)
  dispatch = vi.fn(async () => accepted())
  cancelTurn = vi.fn(async () => ({ cancelled: true }))
  answerPrompt = vi.fn(async () => undefined)
  setOption = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('attach', () => {
  it('upgrades an admitted create intent and replays it without another acquisition', async () => {
    const intent = createIntentEnvelope()
    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toBeNull()
    const params = hostTestAttachParams(null, {
      envelope: intent,
      providerHandle: undefined,
      operationFingerprint: intent.payloadFingerprint
    })

    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true, replayed: false })
    host.releaseCreateIntentAdmission(CALLER, intent)
    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('never classifies an in-flight create admission as processless', async () => {
    const intent = createIntentEnvelope()
    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toBeNull()

    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    const replay = await host.admitOrReplayCreateIntent(CALLER, intent)
    if (replay?.ok !== false) {
      throw new Error('expected an in-flight ownership refusal')
    }
    expect(replay.refusal).not.toHaveProperty('acquisitionState')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('proves an orphaned pre-reservation create admission never acquired', async () => {
    const intent = createIntentEnvelope()
    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toBeNull()
    await host.flushAllStreamedEvents()
    host = new StructuredAgentSessionHost({
      store,
      adapter: adapter(),
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })

    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        acquisitionState: 'not-acquired'
      }
    })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('durably replays a true support refusal as not acquired', async () => {
    const intent = createIntentEnvelope()
    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toBeNull()
    await expect(
      host.settleCreateIntentRefusal(CALLER, intent, {
        code: 'structured_agent_session_unsupported',
        message: 'remote host does not support structured create'
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { acquisitionState: 'not-acquired' }
    })

    expect(await host.admitOrReplayCreateIntent(CALLER, intent)).toMatchObject({
      ok: false,
      refusal: {
        code: 'structured_agent_session_unsupported',
        acquisitionState: 'not-acquired'
      }
    })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('reserves the lease, spawns through the adapter, and opens the journal', async () => {
    const result = await host.attach(CALLER, attachParams())
    expect(result).toMatchObject({ ok: true, replayed: false })
    const record = store.getRecord(SESSION)
    expect(record?.lease.ownerProcess?.pid).toBe(4242)
    expect(record?.lease.handoffStage).toBeNull()
  })

  it('refuses a payload the client fingerprinted wrong', async () => {
    const params = attachParams()
    const result = await host.attach(CALLER, {
      ...params,
      envelope: { ...params.envelope, payloadFingerprint: 'a'.repeat(64) }
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_conflict' }
    })
  })

  it('refuses a provider handle that belongs to a different provider', async () => {
    const params = attachParams({
      providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
    })

    expect(await host.attach(CALLER, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(store.getRecord(SESSION)).toBeNull()
  })

  it('refuses a second create against a live session', async () => {
    await attach()
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: false })
  })

  it('replays a retried attach instead of reserving a second owner', async () => {
    const params = attachParams()
    await host.attach(CALLER, params)
    const retry = await host.attach(CALLER, params)
    expect(retry).toMatchObject({ ok: true, replayed: true })
  })

  it('retires a failed proved acquisition before admitting a fresh operation', async () => {
    const acquire = vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementationOnce(async ({ fence, spawnToken }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        link: {
          linkId: 'stale-link',
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence + 1,
          observedAt: NOW
        }
      }))
      .mockImplementation(async ({ fence, spawnToken }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }))
    host = new StructuredAgentSessionHost({
      store,
      adapter: { ...adapter(), acquire },
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    const params = attachParams()

    await expect(host.attach(CALLER, params)).rejects.toThrow(
      'agent_session_provider_handle_stale_fence'
    )
    expect(await host.attach(CALLER, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    expect(await host.attach(CALLER, ensureParams(releasedFence))).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(releaseAcquisition).toHaveBeenCalledWith({ sessionId: SESSION })
  })

  it('reaps an acquisition when process identity commit fails', async () => {
    vi.spyOn(store, 'commitProcessIdentity').mockRejectedValueOnce(new Error('commit failed'))

    await expect(host.attach(CALLER, attachParams())).rejects.toThrow('commit failed')

    expect(releaseAcquisition).toHaveBeenCalledWith({ sessionId: SESSION })
  })

  it('drains writes captured by the old journal before acquiring its replacement', async () => {
    const record = await attach()
    const events = acquire.mock.calls[0]?.[0].events
    const oldJournal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const appendGate = Promise.withResolvers<void>()
    const originalAppend = oldJournal.appendItem.bind(oldJournal)
    const append = vi.spyOn(oldJournal, 'appendItem').mockImplementationOnce(async (...args) => {
      await appendGate.promise
      return originalAppend(...args)
    })
    events?.appendItem(
      { provider: 'orca', clientMessageId: 'old-journal-write' },
      { kind: 'status', text: 'old journal write' }
    )
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
    const released = await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: record?.lease.runtimeFence ?? 1,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })

    const replacement = host.attach(CALLER, ensureParams(released.lease.runtimeFence))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(acquire).toHaveBeenCalledTimes(1)

    appendGate.resolve()
    await expect(replacement).resolves.toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
  })
})

describe('send', () => {
  it('writes the submission before dispatching and resolves it accepted', async () => {
    await attach()
    const body = hostTestMessage('add a retry')
    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    if (!result.ok) {
      throw new Error(`expected a send, got ${result.refusal.code}`)
    }
    expect(result.value.submission.dispatchState).toBe('accepted')
    expect(dispatch).toHaveBeenCalledTimes(1)
    const page = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.items).toHaveLength(1)
    expect(page.ok && page.page.fence).toBe(1)
    expect(page.providerSession).toEqual({ key: 'session_id', id: THREAD })
  })

  it('settles a thrown dispatch as unknown, never as a rejection', async () => {
    await attach()
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const body = hostTestMessage('add a retry')
    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body
    })
    expect(result).toMatchObject({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
  })

  it('replays a retried send from the journal without dispatching twice', async () => {
    await attach()
    const body = hostTestMessage('add a retry')
    const params = { envelope: envelope('agentSession.send', { body }), body }
    await host.send(CALLER, params)
    const retry = await host.send(CALLER, params)
    expect(retry).toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('redispatches an explicitly retried durable unknown without appending a second submission', async () => {
    await attach()
    dispatch
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockImplementationOnce(async () => accepted())
    const body = hostTestMessage('possibly delivered')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    const first = await host.send(CALLER, params)
    expect(first).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'unknown' } }
    })
    const retried = await host.send(CALLER, { ...params, retryUnknown: true })

    expect(retried).toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    const state = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(state.ok && state.page.submissions).toHaveLength(1)
  })

  it('advances an explicit retry after a ledger-unknown send is reconciled in the journal', async () => {
    await attach()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    vi.spyOn(journal, 'resolveDispatch').mockRejectedValueOnce(new Error('journal resolve failed'))
    const body = hostTestMessage('possibly delivered before persistence failed')
    const params = { envelope: envelope('agentSession.send', { body }), body }

    await expect(host.send(CALLER, params)).rejects.toThrow('journal resolve failed')
    expect(journal.submissions()).toMatchObject([
      { clientMessageId: params.envelope.clientOperationId, dispatchState: 'unknown' }
    ])
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
        ?.outcome
    ).toEqual({ status: 'unknown' })
    expect(dispatch).toHaveBeenCalledTimes(1)

    await journal.markPendingSubmissionsUnknown(store.getRecord(SESSION)?.lease.runtimeFence ?? 1)
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)

    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(journal.submissions()).toHaveLength(1)
  })

  it('refuses a stale fence and hands back the current one', async () => {
    const record = await attach()
    const body = hostTestMessage('add a retry')
    const result = await host.send(CALLER, {
      envelope: envelope(
        'agentSession.send',
        { body },
        { expectedRuntimeFence: (record?.lease.runtimeFence ?? 1) + 5 }
      ),
      body
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', currentFence: record?.lease.runtimeFence }
    })
  })

  it('does not let a refused call leave a ledger row that replays past the fence', async () => {
    const record = await attach()
    const body = hostTestMessage('add a retry')
    const params = {
      envelope: envelope(
        'agentSession.send',
        { body },
        { expectedRuntimeFence: (record?.lease.runtimeFence ?? 1) + 5 }
      ),
      body
    }
    await host.send(CALLER, params)
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses any mutation against a session this host has not attached', async () => {
    const body = hostTestMessage('add a retry')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_ownership_unknown' } })
  })
})

describe('cancel', () => {
  it('records the request acknowledgement as a status item keyed by the operation id', async () => {
    await attach()
    const result = await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
    expect(result).toMatchObject({ ok: true, value: { cancelled: true } })
    const page = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.items[0]?.body).toMatchObject({
      kind: 'status',
      text: 'Cancellation requested.'
    })
    expect(JSON.stringify(page.ok && page.page.items[0]?.body)).not.toContain('turn-1')
  })

  it('reports an unconfirmed cancellation rather than failing the call', async () => {
    await attach()
    cancelTurn.mockRejectedValueOnce(new Error('no answer'))
    const result = await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
    expect(result).toMatchObject({ ok: true, value: { cancelled: false } })
  })

  it('never interrupts twice on a replay', async () => {
    await attach()
    const params = {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    }
    await host.cancel(CALLER, params)
    expect(await host.cancel(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: false }
    })
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })
})

describe('respondToPrompt', () => {
  it('commits the answer before the provider callback', async () => {
    const prompt = await seedApproval()
    await attach()
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })
    expect(result).toMatchObject({
      ok: true,
      value: { resolution: { state: 'resolved', selectedOptionId: 'allow' } }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(1)
  })

  it('refuses a second answer to one prompt and says which answer won', async () => {
    const prompt = await seedApproval()
    await attach()
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
    await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })
    const loser = await host.respondToPrompt(
      { callerKey: 'client-2' },
      {
        envelope: envelope('agentSession.respondTo:approval', fields),
        kind: 'approval',
        ...fields
      }
    )
    expect(loser).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_item_revision_stale',
        resolution: { selectedOptionId: 'allow' }
      }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(1)
  })

  it('refuses an option the prompt does not offer', async () => {
    const prompt = await seedApproval()
    await attach()
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'deny' }
    expect(
      await host.respondToPrompt(CALLER, {
        envelope: envelope('agentSession.respondTo:approval', fields),
        kind: 'approval',
        ...fields
      })
    ).toMatchObject({ ok: false, refusal: { code: 'agent_session_operation_invalid' } })
    expect(answerPrompt).not.toHaveBeenCalled()
  })

  it("does not turn a recorded refusal into another client's successful answer", async () => {
    const prompt = await seedApproval()
    await attach()
    const rejectedFields = {
      itemId: prompt.itemId,
      expectedRevision: prompt.revision,
      optionId: 'deny'
    }
    const rejected = {
      envelope: envelope('agentSession.respondTo:approval', rejectedFields),
      kind: 'approval' as const,
      ...rejectedFields
    }
    await host.respondToPrompt(CALLER, rejected)

    const acceptedFields = { ...rejectedFields, optionId: 'allow' }
    await host.respondToPrompt(
      { callerKey: 'client-2' },
      {
        envelope: envelope('agentSession.respondTo:approval', acceptedFields),
        kind: 'approval',
        ...acceptedFields
      }
    )

    expect(await host.respondToPrompt(CALLER, rejected)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
  })

  it('keeps the answer and reports it undelivered when the provider callback throws', async () => {
    const prompt = await seedApproval()
    await attach()
    answerPrompt.mockRejectedValueOnce(new Error('pipe closed'))
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
    const result = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })
    expect(result.ok).toBe(true)
    const page = host.history({ sessionId: SESSION, direction: 'tail' })
    const statusId = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `${prompt.itemId}#delivery`
    })
    expect(page.ok && page.page.items.some((entry) => entry.itemId === statusId)).toBe(true)
  })
})

describe('setOption', () => {
  it('goes to the provider and writes nothing to the journal', async () => {
    await attach()
    setOption.mockResolvedValueOnce({ model: 'gpt-5', effort: 'high' })
    const fields = { key: 'model', value: 'gpt-5' }
    const params = {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    }
    const result = await host.setOption(CALLER, params)
    expect(result).toMatchObject({
      ok: true,
      value: { ...fields, options: { model: 'gpt-5', effort: 'high' } }
    })
    expect(await host.setOption(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { ...fields, options: { model: 'gpt-5', effort: 'high' } }
    })
    expect(setOption).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'gpt-5', effort: 'high' })
    const page = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.items).toHaveLength(0)
  })

  it('does not turn an unknown provider outcome into a successful replay', async () => {
    await attach()
    setOption.mockRejectedValueOnce(new Error('reply lost'))
    const fields = { key: 'model', value: 'gpt-5' }
    const params = {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    }

    await expect(host.setOption(CALLER, params)).rejects.toThrow('reply lost')
    expect(await host.setOption(CALLER, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(setOption).toHaveBeenCalledTimes(1)
  })
})
