import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch,
  type CodexStructuredSessionAdapterDeps,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'

const THREAD_ID = 'thread-abc'

function identityFor(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
}

const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

type Route = (params: Record<string, unknown> | undefined) => unknown

// `closed` is readonly on the real connection; the fake flips it so a test can
// kill the child at a chosen moment.
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  launch: CodexAppServerLaunch
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number; message?: string }[]
  closeCount: number
}

/** Stands in for a live `codex app-server`: every RPC is answered from `routes`,
 *  and the test drives Codex's own traffic through `handlers`. */
function fakeCodex(routes: Record<string, Route> = {}): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        const route = routes[method]
        return route ? route(params) : {}
      },
      notify: () => {},
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code, message) => connection.replies.push({ id, code, message }),
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  routes['thread/start'] ??= () => ({
    thread: { id: THREAD_ID, path: '/rollouts/abc.jsonl' },
    model: 'gpt-live',
    reasoningEffort: 'medium'
  })
  routes['thread/resume'] ??= (params) => ({
    thread: { id: (params as { threadId: string }).threadId },
    model: 'gpt-live',
    reasoningEffort: 'medium'
  })
  return { connections, openConnection, routes }
}

function adapterFor(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = [],
  processControl: Partial<
    Pick<CodexStructuredSessionAdapterDeps, 'captureTurnProcesses' | 'terminateTurnProcesses'>
  > = {}
): CodexStructuredSessionAdapter {
  return new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null,
      ...launch
    }),
    onEvent: (event) => events.push(event),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    captureTurnProcesses: async () => ({ platform: 'win32', identities: new Map() }),
    terminateTurnProcesses: async () => true,
    now: () => 1_700_000_000_500,
    ...processControl
  })
}

async function acquired(
  codex: ReturnType<typeof fakeCodex>,
  launch: Partial<CodexStructuredLaunch> = {},
  events: CodexStructuredSessionEvent[] = []
): Promise<CodexStructuredSessionAdapter> {
  const adapter = adapterFor(codex, launch, events)
  await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
  return adapter
}

describe('CodexStructuredSessionAdapter.acquire', () => {
  it('starts a new thread and reports the process and link the lease will prove', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex, { codexHome: '/codex/home' })

    const acquisition = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].launch.env).toEqual({
      [CODEX_SPAWN_TOKEN_ENV]: 'spawn-9',
      CODEX_HOME: '/codex/home'
    })
    expect(codex.connections[0].launch.cwd).toBe('/work/repo')
    expect(codex.connections[0].calls[0]).toEqual({
      method: 'thread/start',
      params: { cwd: '/work/repo' }
    })
    expect(acquisition.process).toEqual({
      hostId: 'host-1',
      pid: 4321,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-9'
    })
    expect(acquisition.link).toEqual({
      linkId: `codex-7-${THREAD_ID}`,
      handle: { provider: 'codex', threadId: THREAD_ID },
      origin: 'created',
      mintedAtFence: 7,
      observedAt: 1_700_000_000_500
    })
  })

  it('resumes the thread the durable handle chain names, not the client one', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex, {
      resumeThreadId: 'thread-proven',
      resumePath: '/rollouts/thread-proven.jsonl'
    })

    const acquisition = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-9'
    })

    expect(codex.connections[0].calls[0]).toEqual({
      method: 'thread/resume',
      params: expect.objectContaining({
        threadId: 'thread-proven',
        cwd: '/work/repo',
        path: '/rollouts/thread-proven.jsonl'
      })
    })
    expect(acquisition.link.origin).toBe('resumed')
    expect(acquisition.link.handle).toEqual({ provider: 'codex', threadId: 'thread-proven' })
  })

  it('refuses a resume that lands on a different thread and reaps the child', async () => {
    const codex = fakeCodex({ 'thread/resume': () => ({ thread: { id: 'thread-other' } }) })
    const adapter = adapterFor(codex, { resumeThreadId: 'thread-proven' })

    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 9, spawnToken: 'spawn-9' })
    ).rejects.toThrow('resumed thread-other instead of thread-proven')
    expect(codex.connections[0].closeCount).toBe(1)
  })

  it('refuses a thread Codex never named', async () => {
    const codex = fakeCodex({ 'thread/start': () => ({}) })
    const adapter = adapterFor(codex)

    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 1, spawnToken: 'spawn-9' })
    ).rejects.toThrow('did not name the thread')
    expect(codex.connections[0].closeCount).toBe(1)
  })

  it('closes the previous child before re-acquiring at a new fence', async () => {
    const codex = fakeCodex()
    const adapter = await acquired(codex)

    await adapter.acquire({ identity: identityFor('session-1'), fence: 8, spawnToken: 'spawn-10' })

    expect(codex.connections).toHaveLength(2)
    expect(codex.connections[0].closeCount).toBe(1)
    expect(codex.connections[1].closeCount).toBe(0)
  })

  it('keeps the traffic Codex sends before the session is published', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    codex.routes['thread/start'] = () => {
      // Codex talks as soon as the child is up, which is before the adapter has
      // a thread id to publish the session under.
      codex.connections[0].handlers.onNotification?.('item/started', { threadId: THREAD_ID })
      codex.connections[0].handlers.onServerRequest?.({
        id: 5,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'codex-item-early', threadId: THREAD_ID, turnId: 'turn-1' }
      })
      return { thread: { id: THREAD_ID } }
    }

    const adapter = await acquired(codex, {}, events)

    expect(events.map((event) => event.type)).toEqual(['notification', 'prompt'])
    // The early approval is answerable, so Codex is not left blocked on a
    // request that arrived a moment too soon.
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'codex-item-early',
      kind: 'approval',
      optionId: 'accept',
      fence: 7
    })
    expect(codex.connections[0].replies).toEqual([{ id: 5, result: { decision: 'accept' } }])
  })

  it('refuses to publish a session whose child died while it was being acquired', async () => {
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection: codex.openConnection,
      // The child dies while the acquisition is still reading its identity.
      readProcessStartTime: async () => {
        codex.connections[0].closed = true
        return 1_700_000_000_000
      }
    })

    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow('exited while being acquired')
    expect(codex.connections[0].closeCount).toBe(1)
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('no live codex app-server')
  })

  it('classifies launch validation failure as pre-spawn without opening a child', async () => {
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => {
        throw new Error('workspace no longer exists')
      },
      openConnection: codex.openConnection
    })

    const error = await adapter
      .acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      name: 'AgentSessionPreSpawnError',
      message: 'workspace no longer exists'
    })
    expect(codex.connections).toHaveLength(0)
  })

  it('reports the rollout path Codex named, and null when it named none', async () => {
    const withPath = fakeCodex()
    const adapter = await acquired(withPath)
    expect(await adapter.historyFilePath({ identity: identityFor('session-1') })).toBe(
      '/rollouts/abc.jsonl'
    )

    const withoutPath = fakeCodex({ 'thread/start': () => ({ thread: { id: THREAD_ID } }) })
    const bare = await acquired(withoutPath)
    expect(await bare.historyFilePath({ identity: identityFor('session-1') })).toBeNull()
  })

  it('lets closeAll cancel and reap an acquisition still opening', async () => {
    const codex = fakeCodex()
    let releaseOpen = (): void => {}
    let markOpenEntered = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    const openEntered = new Promise<void>((resolve) => {
      markOpenEntered = resolve
    })
    const openConnection: typeof openCodexAppServerConnection = async (...args) => {
      markOpenEntered()
      await gate
      return codex.openConnection(...args)
    }
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const acquiring = adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })
    await openEntered

    const closing = adapter.closeAll()
    releaseOpen()

    await expect(acquiring).rejects.toThrow('superseded while being acquired')
    await closing
    expect(codex.connections[0]?.closeCount).toBe(1)
  })

  it('fences an acquisition while launch resolution is still pending', async () => {
    const launch = Promise.withResolvers<CodexStructuredLaunch>()
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: () => launch.promise,
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const acquiring = adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    const closing = adapter.closeAll()
    launch.resolve({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    })

    await expect(acquiring).rejects.toThrow('superseded while being acquired')
    await closing
    expect(codex.connections).toHaveLength(0)
  })

  it('keeps validation-owned acquisition visible to closeAll until publication', async () => {
    const validation = Promise.withResolvers<unknown>()
    const validationStarted = Promise.withResolvers<void>()
    const codex = fakeCodex({
      'model/list': () => {
        validationStarted.resolve()
        return validation.promise
      }
    })
    const adapter = adapterFor(codex)
    const acquiring = adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      validateOptions: true,
      options: { model: 'gpt-5.6-sol', effort: 'high' }
    })
    await validationStarted.promise

    const closing = adapter.closeAll()
    validation.resolve({
      data: [
        {
          id: 'gpt-5.6-sol',
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
        }
      ]
    })

    await expect(acquiring).rejects.toThrow('exited while being acquired')
    await closing
    expect(codex.connections[0]?.closeCount).toBe(1)
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('no live codex app-server')
  })

  it('does not let late option validation replace a concurrent acquisition owner', async () => {
    const firstValidation = Promise.withResolvers<unknown>()
    const firstValidationStarted = Promise.withResolvers<void>()
    let modelListCalls = 0
    const codex = fakeCodex({
      'model/list': () => {
        modelListCalls += 1
        if (modelListCalls === 1) {
          firstValidationStarted.resolve()
          return firstValidation.promise
        }
        return {
          data: [
            {
              id: 'gpt-5.6-sol',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
            }
          ]
        }
      }
    })
    const adapter = adapterFor(codex)
    const first = adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      validateOptions: true,
      options: { model: 'gpt-5.6-sol', effort: 'high' }
    })
    await firstValidationStarted.promise

    const second = adapter.acquire({
      identity: identityFor('session-1'),
      fence: 8,
      spawnToken: 'spawn-10',
      validateOptions: true,
      options: { model: 'gpt-5.6-sol', effort: 'high' }
    })
    firstValidation.resolve({
      data: [
        {
          id: 'gpt-5.6-sol',
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
        }
      ]
    })

    await expect(first).rejects.toThrow(/(exited|superseded) while being acquired/)
    await expect(second).resolves.toMatchObject({ link: { mintedAtFence: 8 } })
    await adapter.closeAll()
    expect(codex.connections.map((connection) => connection.closeCount)).toEqual([1, 1])
  })
})

describe('CodexStructuredSessionAdapter.dispatch', () => {
  it('accepts a turn Codex names in its response', async () => {
    const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'turn-1' } }) })
    const adapter = await acquired(codex)

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'ship it' },
          { type: 'image-ref', path: '/tmp/shot.png' },
          { type: 'image-ref', url: 'https://example.test/a.png' }
        ]
      },
      fence: 7
    })

    expect(outcome).toEqual({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD_ID, turnId: 'turn-1', ordinal: 0 }
    })
    expect(codex.connections[0].calls[1].params).toEqual({
      threadId: THREAD_ID,
      clientUserMessageId: 'client-1',
      input: [
        { type: 'text', text: 'ship it' },
        { type: 'localImage', path: '/tmp/shot.png' },
        { type: 'image', url: 'https://example.test/a.png' }
      ]
    })
  })

  it('accepts a turn named only by the notification that raced the ack', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    const adapter = await acquired(codex, {}, events)
    codex.routes['turn/start'] = () => {
      codex.connections[0].handlers.onNotification?.('turn/started', {
        threadId: THREAD_ID,
        turn: { id: 'turn-late' }
      })
      return {}
    }

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(outcome).toMatchObject({ state: 'accepted' })
    expect(outcome).toMatchObject({ providerIdentity: { turnId: 'turn-late' } })
    expect(events.at(-1)).toMatchObject({ type: 'notification', method: 'turn/started' })
  })

  it('does not let a child thread answer for the root thread', async () => {
    const codex = fakeCodex()
    const events: CodexStructuredSessionEvent[] = []
    codex.routes['turn/start'] = () => {
      // A subagent runs its own thread over the same connection, and its turn
      // starts first.
      const notify = codex.connections[0].handlers.onNotification
      notify?.('turn/started', { threadId: 'thread-child', turn: { id: 'turn-child' } })
      notify?.('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-root' } })
      return {}
    }
    const adapter = await acquired(codex, {}, events)

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(outcome).toEqual({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD_ID, turnId: 'turn-root', ordinal: 0 }
    })
    // Each event carries the thread it actually came from, so the journal can
    // keep a subagent's turn out of the root conversation.
    expect(events.map((event) => (event.type === 'notification' ? event.threadId : null))).toEqual([
      'thread-child',
      THREAD_ID
    ])
  })

  it('settles unknown rather than failed when Codex never names the turn', async () => {
    vi.useFakeTimers()
    try {
      const codex = fakeCodex()
      const adapter = await acquired(codex)

      const dispatching = adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(await dispatching).toEqual({
        state: 'unknown',
        reason: 'codex app-server started a turn it did not name in time'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects only when Codex answered and declined', async () => {
    const codex = fakeCodex({
      'turn/start': () => {
        throw new CodexAppServerRequestError('turn/start', -32602, 'turn already running')
      }
    })
    const adapter = await acquired(codex)

    expect(
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).toEqual({ state: 'rejected', reason: 'turn already running' })
  })

  it('rethrows a dead child so the wire settles the submission unknown', async () => {
    const codex = fakeCodex({
      'turn/start': () => {
        throw new Error('codex app-server connection ended')
      }
    })
    const adapter = await acquired(codex)

    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('connection ended')
  })

  it('applies an option change to the next turn only', async () => {
    const codex = fakeCodex({
      'model/list': () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
            defaultReasoningEffort: 'medium'
          },
          {
            model: 'gpt-5',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          }
        ],
        nextCursor: null
      }),
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    const adapter = await acquired(codex)

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'gpt-5', fence: 7 })
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'sandboxEscape', value: 'yes', fence: 7 })
    ).rejects.toThrow('no thread option named sandboxEscape')
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    const turnStart = codex.connections[0].calls.findLast((call) => call.method === 'turn/start')
    expect(turnStart?.params).toMatchObject({ model: 'gpt-5', effort: 'high' })
    expect(turnStart?.params).not.toHaveProperty('sandboxEscape')
  })
})
