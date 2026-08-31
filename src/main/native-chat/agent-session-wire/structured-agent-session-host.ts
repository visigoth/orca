// Structured agent-session host: where the lease, journal, and provider adapter meet.
// Mutations share one durable admission path and serialize per session.

import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult,
  AgentSessionHandoffStatus,
  AgentSessionOptionsResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import {
  AgentSessionSubscribers,
  type AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import * as providerSupport from './structured-agent-session-provider-support'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import {
  createStructuredAgentSessionHostHandoff,
  refreshRecoverableStructuredHandoffStatus,
  type StructuredAgentSessionHostHandoff
} from './structured-agent-session-host-handoff'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import {
  createStructuredAgentSessionHolds,
  createStructuredAgentSessionLifetimeContext,
  evictHeldStructuredAgentSession
} from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionHolds,
  StructuredAgentSessionHoldOptions
} from './structured-agent-session-holds'
import { resumeHeldStructuredAgentSession } from './structured-agent-session-hold-resume'
import {
  createStructuredAgentSessionAttachContext,
  type StructuredAgentSessionAttachContext
} from './structured-agent-session-attach-context'
import { listStructuredAgentSessionTabs } from './structured-agent-session-host-tabs'
import {
  cancelStructuredAgentSessionTurn,
  readStructuredAgentSessionOptions,
  respondToStructuredAgentSessionPrompt,
  sendStructuredAgentSessionTurn,
  setStructuredAgentSessionOption,
  createStructuredAgentSessionMutationContext,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  createStructuredAgentSessionCreateIntentContext,
  createStructuredAgentSessionCreateIntentSurface,
  requireStructuredSession
} from './structured-agent-session-host-create-intent'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import {
  executionLocationForSession as readExecutionLocationForSession,
  createStructuredAgentSessionHostSurfaceContext,
  handoffStatus as readHandoffStatus,
  history as readHistory,
  subscribe as openSubscription,
  type StructuredAgentSessionHostSurfaceContext
} from './structured-agent-session-host-surfaces'
import { retryPendingStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
export type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
export class StructuredAgentSessionHost {
  private readonly sessions = new Map<string, StructuredAgentSessionHostSession>()
  private readonly subscribers = new AgentSessionSubscribers()
  private readonly tasks = new StructuredAgentSessionTaskQueue()
  private readonly runtimeState: StructuredAgentSessionHostRuntimeState
  private readonly reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  private readonly handoffs: StructuredAgentSessionHostHandoff
  private readonly readableRestorer: StructuredAgentSessionReadableRestorer
  private readonly restartRestore = new StructuredAgentSessionRestartRestoreGate()
  private readonly holds: StructuredAgentSessionHolds
  private readonly activeCreateIntents = new Set<string>()
  private readonly eventRecovery: StructuredAgentSessionEventRecovery
  private readonly createIntentSurface = createStructuredAgentSessionCreateIntentSurface(() =>
    createStructuredAgentSessionCreateIntentContext(
      this.deps,
      this.sessions,
      this.activeCreateIntents,
      this.now,
      (caller, params) => this.attach(caller, params)
    )
  )

  constructor(readonly deps: StructuredAgentSessionHostDeps) {
    this.runtimeState = new StructuredAgentSessionHostRuntimeState(
      deps,
      (record) => this.restoreRenewedHandoff(record.sessionId),
      (record, probe) =>
        this.sessions.has(record.sessionId)
          ? this.serialize(record.sessionId, () =>
              this.handoffs.recoverDeadTuiOwner(record.sessionId, record.lease.runtimeFence, probe)
            )
          : Promise.resolve(),
      (sessionId, error) => this.eventRecovery.recoverAfterSinkFailure(sessionId, error)
    )
    this.reconcileLeases = createRestartReconciler({
      store: deps.store,
      probe: (record) => this.runtimeState.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => this.now()
    })
    this.handoffs = createStructuredAgentSessionHostHandoff(deps, {
      session: (sessionId) => this.requireSession(sessionId),
      eventSink: (sessionId) => this.runtimeState.eventSinkFor(sessionId),
      flush: (sessionId) => this.flushStreamedEvents(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      subscribers: this.subscribers,
      now: this.now
    })
    this.holds = createStructuredAgentSessionHolds(this.lifetimeContext(), {
      resume: (sessionId) => this.resumeForHold(sessionId),
      evict: (sessionId) => this.close(sessionId)
    })
    this.readableRestorer = new StructuredAgentSessionReadableRestorer({
      store: deps.store,
      journalRoot: deps.journalRoot,
      supportsRecord: (record) => providerSupport.adapterSupportsRecord(deps.adapter, record),
      reconcile: this.reconcileLeases,
      resolveRecovery: (sessionId) => this.runtimeState.resolveRecovery(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      hasSession: (sessionId) => this.sessions.has(sessionId),
      onReadable: (sessionId, restored) => this.sessions.set(sessionId, restored),
      restoreHandoff: (sessionId) => this.handoffs.restore(sessionId)
    })
    this.eventRecovery = new StructuredAgentSessionEventRecovery({
      deps,
      store: deps.store,
      sessions: this.sessions,
      flushLifecycle: (sessionId) => this.runtimeState.lifecycleBarrier(sessionId),
      publishFence: (sessionId, session) =>
        this.subscribers.snapshot(sessionId, session.journal, session.fence),
      hasResumeCapableHolder: (sessionId) => this.holds.hasResumeCapableHolder(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now(),
      attachContext: () => this.attachContext(),
      onBarrierError: (sessionId, error) => deps.onEventSinkError?.({ sessionId, error })
    })
    this.runtimeState.startLeaseRenewal()
  }

  private now = (): number => this.deps.now?.() ?? Date.now()

  hasSession = (sessionId: string): boolean => this.sessions.has(sessionId)
  isHeld = (sessionId: string): boolean => this.holds.isHeld(sessionId)

  executionLocationForSession = (sessionId: string): AgentSessionExecutionLocation | null =>
    readExecutionLocationForSession(this.surfaceContext(), sessionId)

  /** A surface bound to this session and wants it live. The FIRST hold on a session with no
   *  provider child is what resumes one; a retained hold (a subscription) only keeps it. */
  hold = (
    sessionId: string,
    holderId: string,
    options?: StructuredAgentSessionHoldOptions
  ): Promise<void> => this.holds.hold(sessionId, holderId, options)

  /** That surface is gone. The child outlives it by the release grace, and by any running turn. */
  release = (sessionId: string, holderId: string): void => this.holds.release(sessionId, holderId)

  private async resumeForHold(sessionId: string): Promise<void> {
    const unreconciled = await this.reconcileLeases(sessionId)
    if (unreconciled) {
      throw new Error(unreconciled.code)
    }
    await this.runtimeState.resolveRecovery(sessionId)
    await resumeHeldStructuredAgentSession({
      sessionId,
      deps: this.deps,
      now: () => this.now(),
      attach: (params) => this.attach({ callerKey: 'trusted-local:surface-hold' }, params)
    })
  }

  handleAdapterEvent = (event: Parameters<StructuredAgentSessionEventRecovery['handle']>[0]) =>
    this.eventRecovery.handle(event)

  private lifetimeContext = () =>
    createStructuredAgentSessionLifetimeContext(this.deps, this.runtimeState, this.sessions, () =>
      this.now()
    )

  /** The host's half of attaching, named so it cannot grow dependencies unnoticed. */
  private attachContext = (): StructuredAgentSessionAttachContext =>
    createStructuredAgentSessionAttachContext(
      this.deps,
      this.runtimeState,
      this.sessions,
      this.subscribers,
      this.tasks,
      (sessionId) => this.reconcileLeases(sessionId),
      (sessionId, params) =>
        retryPendingStructuredAgentSessionSettlement({
          deps: this.deps,
          sessions: this.sessions,
          sessionId,
          params,
          now: () => this.now()
        }),
      (sessionId, task) => this.serialize(sessionId, task),
      () => this.now()
    )
  /** Releases a session's resources without ending the conversation: the record and journal stay
   *  on disk, so the same session can be attached again. */
  close(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      await this.handoffs.closeRetainedTuiOwner(sessionId)
      await evictHeldStructuredAgentSession(this.lifetimeContext(), sessionId)
      // Whoever asked for the close, the surfaces that were holding this session are looking at a
      // session that no longer exists. A failed eviction throws above and keeps them.
      this.holds.forget(sessionId)
    })
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean =>
    providerSupport.adapterSupportsCreate(this.deps.adapter, location, agent)

  listSessionTabs = () => listStructuredAgentSessionTabs(this.sessions)

  getPersistedVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } =>
    this.deps.store.getVisibleSessionTabIndex()

  setSessionTabVisibility = (sessionId: string, visible: boolean) =>
    this.deps.store.setSessionTabVisibility(sessionId, visible)

  reconcileRestartLeases = async (): Promise<void> => {
    const refusal = await this.reconcileLeases('startup')
    if (refusal) {
      throw new Error(refusal.code)
    }
  }

  restoreReadableSessions = (sessionIds?: readonly string[]): Promise<void> =>
    this.restartRestore.run(() => this.readableRestorer.restore(sessionIds))

  private serialize = <T>(sessionId: string, task: () => Promise<T>): Promise<T> =>
    this.tasks.serialize(sessionId, task)

  private restoreRenewedHandoff(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      if (this.sessions.has(sessionId)) {
        await refreshRecoverableStructuredHandoffStatus(this.handoffs, this.deps.store, sessionId)
      }
    })
  }

  attach = (caller: StructuredAgentSessionCaller, params: AgentSessionAttachParams) =>
    attachStructuredAgentSession(this.attachContext(), caller.callerKey, params)

  admitOrReplayCreateIntent = this.createIntentSurface.admitOrReplayCreateIntent
  settleCreateIntentRefusal = this.createIntentSurface.settleCreateIntentRefusal
  releaseCreateIntentAdmission = this.createIntentSurface.releaseCreateIntentAdmission

  flushStreamedEvents = (sessionId: string): Promise<void> =>
    this.runtimeState.flushEventSink(sessionId)

  async flushAllStreamedEvents(): Promise<void> {
    this.holds.dispose()
    this.runtimeState.stopLeaseRenewal()
    this.handoffs.stopTuiHistoryCatchup()
    await this.tasks.drainAttaches()
    await this.runtimeState.flushAllEventSinks()
  }

  private mutationContext(): StructuredAgentSessionMutationContext {
    return createStructuredAgentSessionMutationContext({
      deps: this.deps,
      sessions: this.sessions,
      publish: (sessionId, journal) => this.subscribers.publish(sessionId, journal),
      requireSession: (sessionId) => this.requireSession(sessionId),
      serialize: (sessionId, task) => this.serialize(sessionId, task),
      now: () => this.now()
    })
  }

  send = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ) => sendStructuredAgentSessionTurn(this.mutationContext(), caller, params)

  cancel = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof cancelStructuredAgentSessionTurn>[2]
  ) => cancelStructuredAgentSessionTurn(this.mutationContext(), caller, params)

  respondToPrompt = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof respondToStructuredAgentSessionPrompt>[2]
  ) => respondToStructuredAgentSessionPrompt(this.mutationContext(), caller, params)

  setOption = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof setStructuredAgentSessionOption>[2]
  ) => setStructuredAgentSessionOption(this.mutationContext(), caller, params)

  readOptions = (sessionId: string): Promise<AgentSessionOptionsResult> =>
    readStructuredAgentSessionOptions(this.mutationContext(), sessionId)

  handoffStatus = (sessionId: string): Promise<AgentSessionHandoffStatus> =>
    readHandoffStatus(this.surfaceContext(), sessionId)

  history = (request: AgentSessionHistoryRequest): AgentSessionHistoryResult =>
    readHistory(this.surfaceContext(), request)

  subscribe = (input: AgentSessionSubscribeInput): (() => void) =>
    openSubscription(this.surfaceContext(), input)
  unsubscribe = (sessionId: string, id: string): void => this.subscribers.close(sessionId, id)

  private requireSession(sessionId: string): StructuredAgentSessionHostSession {
    return requireStructuredSession(this.sessions, sessionId)
  }

  private surfaceContext = (): StructuredAgentSessionHostSurfaceContext =>
    createStructuredAgentSessionHostSurfaceContext({
      deps: this.deps,
      sessions: this.sessions,
      handoffs: this.handoffs,
      subscribers: this.subscribers,
      tasks: this.tasks,
      serialize: this.serialize,
      requireSession: this.requireSession,
      now: this.now
    })
}
