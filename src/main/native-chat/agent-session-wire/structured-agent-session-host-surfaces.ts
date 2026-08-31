import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult,
  AgentSessionHandoffStatus
} from '../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { AgentSessionSubscribeInput } from './structured-agent-session-subscribers'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import {
  refreshRecoverableStructuredHandoffStatus,
  type StructuredAgentSessionHostHandoff
} from './structured-agent-session-host-handoff'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

export type StructuredAgentSessionHostSurfaceContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  handoffs: StructuredAgentSessionHostHandoff
  subscribers: AgentSessionSubscribers
  tasks: StructuredAgentSessionTaskQueue
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  requireSession: (sessionId: string) => StructuredAgentSessionHostSession
  now: () => number
}

export function createStructuredAgentSessionHostSurfaceContext(input: {
  deps: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  handoffs: StructuredAgentSessionHostHandoff
  subscribers: AgentSessionSubscribers
  tasks: StructuredAgentSessionTaskQueue
  serialize: StructuredAgentSessionHostSurfaceContext['serialize']
  requireSession: StructuredAgentSessionHostSurfaceContext['requireSession']
  now: () => number
}): StructuredAgentSessionHostSurfaceContext {
  return input
}

export function executionLocationForSession(
  ctx: StructuredAgentSessionHostSurfaceContext,
  sessionId: string
): AgentSessionExecutionLocation | null {
  return ctx.deps.store.getRecord(sessionId)?.location ?? null
}

export function handoffStatus(
  ctx: StructuredAgentSessionHostSurfaceContext,
  sessionId: string
): Promise<AgentSessionHandoffStatus> {
  ctx.requireSession(sessionId)
  return ctx.serialize(sessionId, () =>
    refreshRecoverableStructuredHandoffStatus(ctx.handoffs, ctx.deps.store, sessionId)
  )
}

export function history(
  ctx: StructuredAgentSessionHostSurfaceContext,
  request: AgentSessionHistoryRequest
): AgentSessionHistoryResult {
  return readStructuredAgentSessionHistoryResult({
    journal: ctx.requireSession(request.sessionId).journal,
    record: ctx.deps.store.getRecord(request.sessionId),
    request
  })
}

export function subscribe(
  ctx: StructuredAgentSessionHostSurfaceContext,
  input: AgentSessionSubscribeInput
): () => void {
  const session = ctx.requireSession(input.sessionId)
  const fence = ctx.deps.store.getRecord(input.sessionId)?.lease.runtimeFence ?? 0
  return ctx.subscribers.open({
    ...input,
    journal: session.journal,
    fence,
    handoff: ctx.handoffs.status(input.sessionId)
  })
}
