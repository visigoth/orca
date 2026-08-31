import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  classifyStructuredAgentSessionSendFailure,
  createStructuredAgentSessionOutboxEntry,
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  appendStructuredAgentSessionOutboxEntry,
  mutateStructuredAgentSessionOutboxEntry,
  structuredSessionOperationId
} from '@/lib/structured-agent-session-outbox-storage'

const UNCONFIRMED_PROBE_BASE_DELAY_MS = 1_000
/** No attempt ceiling: a transport outage outlives any fixed budget, and giving up
 *  restores the wedge this fixes. Growth caps the rate at one status query per 16s.
 *  A refusal that blocks the head still ends probing until a fence change or a manual
 *  Retry, because the entry leaves `unconfirmed` -- pre-existing, not closed here. */
const UNCONFIRMED_PROBE_MAX_DELAY_MS = 16_000

function isDesktopDeliveryUnknown(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  return /timeout|disconnect|connection|closed|unavailable|cutover/i.test(text)
}

export function useStructuredAgentSessionOutboxDispatch(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  setOutbox: (entries: StructuredAgentSessionOutboxEntry[]) => void
}) {
  const { fence, outbox, sessionId, setOutbox, submissions, target } = args
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)
  const dispatchingRef = useRef(false)
  const dispatchGenerationRef = useRef(0)
  const blockedIdRef = useRef<string | null>(null)
  const probeAttemptsRef = useRef({ id: null as string | null, attempts: 0 })
  const [error, setError] = useState<string | null>(null)
  const [errorSession, setErrorSession] = useState(sessionId)

  if (errorSession !== sessionId) {
    setErrorSession(sessionId)
    setError(null)
  }

  useEffect(() => {
    outboxRef.current = outbox
  }, [outbox])

  useEffect(() => {
    outboxSessionRef.current = sessionId
  }, [sessionId])

  useLayoutEffect(() => {
    dispatchGenerationRef.current += 1
    dispatchingRef.current = false
    blockedIdRef.current = null
    probeAttemptsRef.current = { id: null, attempts: 0 }
  }, [fence, sessionId, targetKey])

  const updateOutbox = useCallback(
    (entries: StructuredAgentSessionOutboxEntry[]): void => {
      outboxRef.current = entries
      setOutbox(entries)
    },
    [setOutbox]
  )

  useEffect(() => {
    const next = outbox[0]
    if (
      !next ||
      next.sessionId !== sessionId ||
      next.state !== 'queued' ||
      fence === null ||
      dispatchingRef.current ||
      blockedIdRef.current === next.clientMessageId
    ) {
      return
    }
    dispatchingRef.current = true
    const dispatchGeneration = dispatchGenerationRef.current
    void mutateStructuredAgentSessionOutboxEntry(sessionId, next.clientMessageId, (current) => ({
      ...current,
      state: 'dispatching',
      lastAttemptAt: Date.now()
    }))
      .then(async (staged) => {
        if (!staged.saved || !staged.matched) {
          dispatchingRef.current = false
          blockedIdRef.current = next.clientMessageId
          setError('Message could not be saved to the outbox')
          return null
        }
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return null
        }
        updateOutbox(staged.entries)
        return callStructuredAgentSession<AgentSessionMutationResult<AgentSessionSendResult>>(
          target,
          'agentSession.send',
          structuredAgentSessionSendRequest(next, fence)
        )
      })
      .then(async (result) => {
        if (result === null) {
          return
        }
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        if (!result.ok) {
          setError(result.refusal.message)
          const updated = await mutateStructuredAgentSessionOutboxEntry(
            sessionId,
            next.clientMessageId,
            (entry) =>
              requeueStructuredAgentSessionSendRefusal(
                entry,
                result.refusal.code,
                structuredSessionOperationId
              )
          )
          blockedIdRef.current = updated.entries[0]?.clientMessageId ?? null
          updateOutbox(updated.entries)
          return
        }
        const submission = result.value.submission
        if (submission.dispatchState === 'rejected') {
          blockedIdRef.current = next.clientMessageId
          setError(submission.reason ?? 'Message was not accepted')
        } else {
          setError(null)
        }
        const updated = await mutateStructuredAgentSessionOutboxEntry(
          sessionId,
          next.clientMessageId,
          (entry) =>
            submission.dispatchState === 'accepted'
              ? null
              : {
                  ...entry,
                  state:
                    submission.dispatchState === 'unknown' || submission.dispatchState === 'pending'
                      ? ('unconfirmed' as const)
                      : ('queued' as const)
                }
        )
        updateOutbox(updated.entries)
      })
      .catch(async (caught) => {
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        const failure = classifyStructuredAgentSessionSendFailure(caught, isDesktopDeliveryUnknown)
        if (failure === 'failed') {
          blockedIdRef.current = next.clientMessageId
        }
        const updated = await mutateStructuredAgentSessionOutboxEntry(
          sessionId,
          next.clientMessageId,
          (entry) => ({
            ...entry,
            state: failure === 'delivery-unknown' ? ('unconfirmed' as const) : ('queued' as const)
          })
        )
        setError(
          failure === 'delivery-unknown' ? 'Message delivery is unconfirmed' : String(caught)
        )
        updateOutbox(updated.entries)
      })
      .finally(() => {
        if (dispatchGenerationRef.current === dispatchGeneration) {
          dispatchingRef.current = false
        }
      })
  }, [fence, outbox, sessionId, target, updateOutbox])

  const head = outbox[0]
  const probeId =
    head &&
    head.sessionId === sessionId &&
    head.state === 'unconfirmed' &&
    head.retryAfterUnknownSubmittedAt === null
      ? head.clientMessageId
      : null
  const probeSettled =
    probeId !== null && submissions.some((submission) => submission.clientMessageId === probeId)
  useEffect(() => {
    if (probeId === null || probeSettled || fence === null) {
      return
    }
    const attempts = probeAttemptsRef.current.id === probeId ? probeAttemptsRef.current.attempts : 0
    const timer = setTimeout(
      () => {
        probeAttemptsRef.current = { id: probeId, attempts: attempts + 1 }
        void mutateStructuredAgentSessionOutboxEntry(sessionId, probeId, (entry) =>
          entry.state === 'unconfirmed' && entry.retryAfterUnknownSubmittedAt === null
            ? { ...entry, state: 'queued' as const }
            : entry
        ).then((result) => {
          if (outboxSessionRef.current !== sessionId || !result.saved || !result.matched) {
            return
          }
          updateOutbox(result.entries)
        })
      },
      Math.min(UNCONFIRMED_PROBE_BASE_DELAY_MS * 2 ** attempts, UNCONFIRMED_PROBE_MAX_DELAY_MS)
    )
    return () => {
      clearTimeout(timer)
    }
  }, [fence, probeId, probeSettled, sessionId, targetKey, updateOutbox])

  const send = useCallback(
    async (text: string, attachments: readonly { path: string; previewUri: string }[] = []) => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      const entry = createStructuredAgentSessionOutboxEntry({
        clientMessageId: structuredSessionOperationId(),
        sessionId,
        text,
        attachments,
        queuedAt: Date.now()
      })
      const appended = await appendStructuredAgentSessionOutboxEntry(sessionId, entry)
      if (!appended.saved) {
        setError('Message could not be saved to the outbox')
        return false
      }
      updateOutbox(appended.entries)
      setError(null)
      return true
    },
    [sessionId, updateOutbox]
  )

  const retry = useCallback(
    async (clientMessageId: string): Promise<void> => {
      blockedIdRef.current = null
      setError(null)
      const submission = submissions.find(
        (item) => item.clientMessageId === clientMessageId && item.dispatchState === 'rejected'
      )
      const current = outbox.find((entry) => entry.clientMessageId === clientMessageId)
      // Why: the provider may have already settled or rejected the operation by the time Retry
      // is pressed. Reusing that operation id only replays the settled rejection forever, so rotate
      // the id for a safe resend.
      if (current && submission?.dispatchState === 'rejected') {
        const rotated = await mutateStructuredAgentSessionOutboxEntry(
          sessionId,
          clientMessageId,
          (entry) => ({
            ...entry,
            clientMessageId: structuredSessionOperationId(),
            state: 'queued',
            retryAfterUnknownSubmittedAt: null
          })
        )
        if (!rotated.saved || !rotated.matched) {
          setError('Message could not be saved to the outbox')
          return
        }
        updateOutbox(rotated.entries)
        return
      }
      const retryAfterUnknownSubmittedAt =
        current?.state === 'queued'
          ? current.retryAfterUnknownSubmittedAt
          : current?.state === 'unconfirmed'
            ? -1
            : null
      const next = await mutateStructuredAgentSessionOutboxEntry(
        sessionId,
        clientMessageId,
        (entry) => ({
          ...entry,
          state: 'queued',
          retryAfterUnknownSubmittedAt
        })
      )
      if (!next.saved || !next.matched) {
        setError('Message could not be saved to the outbox')
        return
      }
      updateOutbox(next.entries)
    },
    [outbox, sessionId, submissions, updateOutbox]
  )

  return { error, blockedClientMessageId: blockedIdRef.current, send, retry }
}
