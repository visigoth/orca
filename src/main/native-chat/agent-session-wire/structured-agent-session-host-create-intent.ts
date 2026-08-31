import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionAttachResult,
  type AgentSessionMutationEnvelope,
  type AgentSessionMutationResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionCaller
} from './structured-agent-session-host-types'

export type StructuredAgentSessionCreateIntentContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  activeCreateIntents: Set<string>
  now: () => number
  attach: (
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams
  ) => Promise<AgentSessionMutationResult<AgentSessionAttachResult>>
}

export type StructuredAgentSessionCreateIntentSurface = {
  admitOrReplayCreateIntent: (
    caller: StructuredAgentSessionCaller,
    envelope: Parameters<typeof admitOrReplayCreateIntent>[2]
  ) => ReturnType<typeof admitOrReplayCreateIntent>
  settleCreateIntentRefusal: (
    caller: StructuredAgentSessionCaller,
    envelope: Parameters<typeof settleCreateIntentRefusal>[2],
    refusal: Parameters<typeof settleCreateIntentRefusal>[3]
  ) => ReturnType<typeof settleCreateIntentRefusal>
  releaseCreateIntentAdmission: (
    caller: StructuredAgentSessionCaller,
    envelope: Parameters<typeof releaseCreateIntentAdmission>[2]
  ) => void
}

export function createStructuredAgentSessionCreateIntentContext(
  deps: StructuredAgentSessionHostDeps,
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  activeCreateIntents: Set<string>,
  now: () => number,
  attach: StructuredAgentSessionCreateIntentContext['attach']
): StructuredAgentSessionCreateIntentContext {
  return { deps, sessions, activeCreateIntents, now, attach }
}

export function createStructuredAgentSessionCreateIntentSurface(
  context: () => StructuredAgentSessionCreateIntentContext
): StructuredAgentSessionCreateIntentSurface {
  return {
    admitOrReplayCreateIntent: (caller, envelope) =>
      admitOrReplayCreateIntent(context(), caller, envelope),
    settleCreateIntentRefusal: (caller, envelope, refusal) =>
      settleCreateIntentRefusal(context(), caller, envelope, refusal),
    releaseCreateIntentAdmission: (caller, envelope) =>
      releaseCreateIntentAdmission(context(), caller, envelope)
  }
}

export async function admitOrReplayCreateIntent(
  context: StructuredAgentSessionCreateIntentContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope
): Promise<AgentSessionMutationResult<AgentSessionAttachResult> | null> {
  const decision = await context.deps.store.admitOperation({
    callerKey: caller.callerKey,
    operationId: envelope.clientOperationId,
    fingerprint: envelope.payloadFingerprint,
    now: context.now()
  })
  if (decision.decision === 'refused') {
    return {
      ok: false,
      refusal: { code: decision.code, message: `Create intent refused: ${decision.code}.` }
    }
  }
  const key = agentSessionOperationKey(caller.callerKey, envelope.clientOperationId)
  if (decision.decision === 'admit') {
    context.activeCreateIntents.add(key)
    return null
  }
  const record = context.deps.store.getRecord(envelope.sessionId)
  if (decision.row.outcome.status === 'failed') {
    const code = (AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(
      decision.row.outcome.code
    )
      ? (decision.row.outcome.code as AgentSessionWireRefusal['code'])
      : 'agent_session_operation_invalid'
    return {
      ok: false,
      refusal: {
        code,
        message:
          decision.row.outcome.message ??
          `Create intent was already refused: ${decision.row.outcome.code}.`,
        ...(!record ? { acquisitionState: 'not-acquired' as const } : {})
      }
    }
  }
  if (decision.row.outcome.status === 'unknown') {
    return unknownCreateIntentRefusal()
  }
  if (!record) {
    if (context.activeCreateIntents.has(key)) {
      return unknownCreateIntentRefusal()
    }
    const refusal = {
      code: 'agent_session_operation_unknown' as const,
      message: 'The interrupted create intent never acquired a session owner.',
      acquisitionState: 'not-acquired' as const
    }
    await context.deps.store.recordOperationOutcome({
      callerKey: caller.callerKey,
      operationId: envelope.clientOperationId,
      outcome: { status: 'failed', code: refusal.code, message: refusal.message }
    })
    return { ok: false, refusal }
  }
  return context.attach(caller, replayCreateParams(context.sessions, record, envelope))
}

export async function settleCreateIntentRefusal(
  context: StructuredAgentSessionCreateIntentContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  refusal: AgentSessionWireRefusal
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  releaseCreateIntentAdmission(context, caller, envelope)
  await context.deps.store.recordOperationOutcome({
    callerKey: caller.callerKey,
    operationId: envelope.clientOperationId,
    outcome: { status: 'failed', code: refusal.code, message: refusal.message }
  })
  return {
    ok: false,
    refusal: {
      ...refusal,
      ...(!context.deps.store.getRecord(envelope.sessionId)
        ? { acquisitionState: 'not-acquired' as const }
        : {})
    }
  }
}

export function releaseCreateIntentAdmission(
  context: StructuredAgentSessionCreateIntentContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope
): void {
  context.activeCreateIntents.delete(
    agentSessionOperationKey(caller.callerKey, envelope.clientOperationId)
  )
}

function replayCreateParams(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  record: AgentSessionRecord,
  envelope: AgentSessionMutationEnvelope
): AgentSessionAttachParams {
  const retained = sessions.get(record.sessionId)?.params
  if (retained) {
    return { ...retained, operationFingerprint: envelope.payloadFingerprint }
  }
  const base: AgentSessionAttachParams = {
    envelope,
    location: record.location,
    provider: record.provider,
    agent: record.provider,
    accountHome: record.accountHome,
    runtimeKind: record.lease.runtimeKind,
    ...(record.options ? { initialOptions: record.options } : {}),
    operationFingerprint: envelope.payloadFingerprint
  }
  return {
    ...base,
    envelope: {
      ...envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: record.sessionId,
        fields: attachFingerprintFields(base)
      })
    }
  }
}

function unknownCreateIntentRefusal(): AgentSessionMutationResult<AgentSessionAttachResult> {
  return {
    ok: false,
    refusal: {
      code: 'agent_session_ownership_unknown',
      message: 'The create intent may still be acquiring a provider owner.'
    }
  }
}

export function requireStructuredSession(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  sessionId: string
): StructuredAgentSessionHostSession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
  }
  return session
}
