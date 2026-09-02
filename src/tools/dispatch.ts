/**
 * Tool dispatch: route the 11 tool invocations onto the CDP session layer.
 *
 * The dispatcher is connection-aware: it resolves the *current* connection
 * from the host bridge (module singleton), lazily builds the session manager
 * + capture + debugger per connection generation, and refuses with a
 * structured `not-connected` result when no socket is up.
 *
 * @module dsh-chrome-cdp/tools/dispatch
 */

import type { CdpStatus, CdpTargetInfo } from '../types.ts'
import { serializeCdpValue, serializeRemoteObject } from './serialize.ts'
import { CaptureManager } from './capture.ts'
import { DebuggerManager } from './debugger.ts'
import type { ResumeResult } from './debugger.ts'
import { TargetSessionManager, pickDefaultTarget } from './targets.ts'
import type { SessionClient, TargetSession } from './targets.ts'

/** The bridge contract the host half registers into. */
export interface HostBridge {
  /** Current status snapshot. */
  getStatus(): CdpStatus
  /** The live CRI client (browser-level), when connected. */
  getClient(): SessionClient | undefined
  /** Attachable targets as /json/list reports them. */
  listTargets(): Promise<readonly CdpTargetInfo[]>
  /** Persist a screenshot as an attachment; returns its id. */
  persistImage(data: Uint8Array, mediaType: string): Promise<{ attachmentId: string; width: number; height: number } | undefined>
  /** Optional attachments availability. */
  attachmentsAvailable(): boolean
}

/** One connection generation's derived managers. */
interface Generation {
  sessions: TargetSessionManager
  capture: CaptureManager
  debugger: DebuggerManager
}

/** Errors as structured results, not throws, so tools stay composable. */
interface ToolError {
  error: string
  hint?: string
}

/** Dispatch result: value or structured error. */
type DispatchOutcome = Record<string, unknown> | ToolError

/**
 * Per-call CDP wait budgets. Named so tests can shrink them (a real deadlock
 * must surface in milliseconds, not after a 30s wall); production uses the
 * defaults. Always below the tool-level `timeoutMs` backstop.
 */
export const WAIT_BUDGETS = {
  /** Input dispatch (click/type) — the tools that deadlock on a pause. */
  input: 10_000,
  /** Runtime.evaluate — queueable forever on a paused target. */
  evaluate: 15_000,
  /** Page.navigate send (the load wait is separately bounded). */
  navigate: 10_000,
  /** Screenshot capture. */
  screenshot: 10_000,
  /** Debugger/breakpoint commands (fast protocol round-trips). */
  debug: 10_000,
  /** chrome_cdp raw pass-through. */
  raw: 30_000,
} as const

/** Per-call dispatch options threaded from the tool execute() context. */
export interface DispatchOptions {
  /** Caller cancellation; bounded waits observe it and settle early. */
  signal?: AbortSignal
}

/** Per-connection state, rebuilt on socket loss. */
export class ToolDispatcher {
  private generation: Generation | undefined
  private defaultTargetId: string | undefined
  private lastTargetUsed: string | undefined
  private readonly bridge: HostBridge

  constructor(bridge: HostBridge) {
    this.bridge = bridge
  }

  /** Reset derived state (connection dropped). */
  reset(): void {
    if (this.generation !== undefined) {
      this.generation.sessions.reset()
      this.generation.debugger.reset()
    }
    this.generation = undefined
    this.defaultTargetId = undefined
  }

  /** Entry point for every tool execute(). */
  async dispatch(name: string, args: unknown, options: DispatchOptions = {}): Promise<DispatchOutcome> {
    if (name !== 'chrome_list_targets' && !this.connected()) {
      return notConnected()
    }
    try {
      return await this.route(name, args, options.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('not-connected')) return notConnected()
      // A dropped socket surfaces as CDP errors; reset the generation so the
      // next call rebuilds instead of hammering a dead session cache.
      if (isSocketDeath(message)) this.reset()
      return { error: message }
    }
  }

  // ── routing ───────────────────────────────────────────────────────────────

  private async route(name: string, args: unknown, signal?: AbortSignal): Promise<DispatchOutcome> {
    switch (name) {
      case 'chrome_list_targets': return this.listTargets()
      case 'chrome_navigate': return this.navigate(argsOf(args), signal)
      case 'chrome_evaluate': return this.evaluate(argsOf(args), signal)
      case 'chrome_console': return this.console(argsOf(args))
      case 'chrome_network': return this.network(argsOf(args))
      case 'chrome_debug': return this.debug(argsOf(args), signal)
      case 'chrome_breakpoint': return this.breakpoint(argsOf(args), signal)
      case 'chrome_screenshot': return this.screenshot(argsOf(args), signal)
      case 'chrome_click': return this.click(argsOf(args), signal)
      case 'chrome_type': return this.type(argsOf(args), signal)
      case 'chrome_cdp': return this.rawCdp(argsOf(args), signal)
      default: return { error: `unknown tool ${name}` }
    }
  }

  // ── navigation group ──────────────────────────────────────────────────────

  private async listTargets(): Promise<DispatchOutcome> {
    if (!this.connected()) return notConnected()
    const targets = await this.bridge.listTargets()
    const paused = new Set<string>()
    const gen = this.ensureGeneration()
    for (const targetId of gen.sessions.entries().keys()) paused.add(targetId)
    const dbgPaused = new Set<string>()
    // DebuggerManager tracks paused targets; surface them per target.
    for (const t of targets) {
      if (gen.debugger.pausedOf(t.id) !== null) dbgPaused.add(t.id)
    }
    const fallback = this.defaultTargetId ?? pickDefaultTarget(targets)
    const defaultId = await this.resolveTargetId(undefined) ?? fallback
    return {
      targets: targets.map(t => ({
        id: t.id,
        type: t.type,
        title: t.title,
        url: t.url,
        isDefault: t.id === defaultId,
        paused: dbgPaused.has(t.id),
      })),
    }
  }

  private async navigate(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const url = readString(args.url)
    if (url === undefined) return { error: 'url is required' }
    const session = await this.sessionFor(args, { wantPage: true })
    await session.ensureEnabled('Page')
    const gen = this.ensureGeneration()
    gen.capture.ensureEnabled(session.sessionId, this.lastTargetUsed ?? '', []).catch(() => {})
    const nav = await waitBounded(
      (signal) => session.send('Page.navigate', { url }),
      readInt(args.waitMs) ?? WAIT_BUDGETS.navigate,
      signal,
      'chrome_navigate',
    ) as {
      frameId?: string
      loaderId?: string
      errorText?: string
    }
    // Bounded load wait: listen for load event once.
    let loaded = nav.errorText === undefined
    if (nav.errorText === undefined) {
      loaded = await waitLoadEvent(session, readInt(args.waitMs) ?? 10_000)
    }
    return {
      frameId: nav.frameId ?? '',
      loaderId: nav.loaderId ?? null,
      errorText: nav.errorText ?? null,
      loaded,
    }
  }

  private async evaluate(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const expression = readString(args.expression)
    if (expression === undefined) return { error: 'expression is required' }
    const targetId = await this.resolveTargetId(readString(args.targetId))
    if (targetId === undefined) return { error: 'no page target available; pass targetId from chrome_list_targets' }
    // Paused guard: plain evaluate on a paused target queues forever.
    const gen = this.ensureGeneration()
    if (gen.debugger.pausedOf(targetId) !== null) {
      return { error: 'target is paused at a breakpoint', hint: 'use chrome_debug eval instead' }
    }
    const session = await this.sessionFor(args, { wantPage: true })
    await session.ensureEnabled('Runtime')
    const result = await waitBounded(
      (signal) => session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: readBool(args.awaitPromise) ?? true,
      }),
      WAIT_BUDGETS.evaluate,
      signal,
      'chrome_evaluate',
    ) as {
      result?: { type?: string; className?: string; value?: unknown; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'evaluation threw'
      return { type: 'error', value: null, className: null, exceptionDetails: text }
    }
    const remote = result.result ?? {}
    return {
      type: remote.type ?? 'undefined',
      value: serializeRemoteObject(remote),
      className: remote.className ?? null,
      exceptionDetails: null,
    }
  }

  // ── diagnostics group ─────────────────────────────────────────────────────

  private async console(args: Record<string, unknown>): Promise<DispatchOutcome> {
    const targetId = await this.resolveTargetId(readString(args.targetId))
    if (targetId === undefined) return { error: 'no page target available' }
    const session = await this.sessionFor(args, { wantPage: true })
    const gen = this.ensureGeneration()
    gen.capture.associate(session.sessionId, targetId)
    await gen.capture.ensureEnabled(session.sessionId, targetId, ['Runtime', 'Log'])
    const read = gen.capture.readConsole({
      targetId,
      level: readString(args.level) ?? undefined,
      text: readString(args.text) ?? undefined,
      afterSeq: readInt(args.cursor) ?? 0,
      limit: clampInt(readInt(args.limit), 1, 300, 50),
    })
    return { entries: read.entries, nextCursor: read.nextCursor }
  }

  private async network(args: Record<string, unknown>): Promise<DispatchOutcome> {
    const targetId = await this.resolveTargetId(readString(args.targetId))
    if (targetId === undefined) return { error: 'no page target available' }
    const session = await this.sessionFor(args, { wantPage: true })
    const gen = this.ensureGeneration()
    gen.capture.associate(session.sessionId, targetId)
    await gen.capture.ensureEnabled(session.sessionId, targetId, ['Network'])
    const read = gen.capture.readNetwork({
      targetId,
      url: readString(args.url) ?? undefined,
      resourceType: readString(args.resourceType) ?? undefined,
      minStatus: readInt(args.minStatus) ?? undefined,
      afterSeq: readInt(args.cursor) ?? 0,
      limit: clampInt(readInt(args.limit), 1, 500, 50),
    })
    return { requests: read.requests, nextCursor: read.nextCursor }
  }

  // ── debug group ───────────────────────────────────────────────────────────

  private async debug(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const action = readString(args.action)
    const targetId = await this.resolveTargetId(readString(args.targetId))
    if (targetId === undefined) return { error: 'no page target available' }
    const gen = this.ensureGeneration()
    // The Debugger domain lives on ONE pinned session per target. Sending
    // pause/resume/eval to whichever session sessionFor() hands out breaks
    // the moment auto-attach replaces the cache entry (the postmortem's
    // "Session with given id not found").
    let sessionId = gen.debugger.sessionOf(targetId)
    if (sessionId === null) {
      const session = await this.sessionFor(args, { wantPage: true })
      await gen.debugger.attachSession(session.sessionId, targetId)
      gen.sessions.markEnabled('Debugger', session.sessionId)
      sessionId = session.sessionId
    }
    switch (action) {
      case 'status': {
        const paused = gen.debugger.pausedOf(targetId)
        return paused === null
          ? { paused: false, reason: null, callFrames: [], hitBreakpoints: [] }
          : { paused: true, ...paused }
      }
      case 'pause':
        await waitBounded(
          () => this.client().send('Debugger.pause', undefined, sessionId),
          WAIT_BUDGETS.debug,
          signal,
          'chrome_debug pause',
        )
        return { paused: true, hint: 'pause requested; poll chrome_debug status until callFrames appear' }
      case 'resume': {
        const result: ResumeResult = await gen.debugger.resume(sessionId, targetId)
        return { paused: false, resumed: result.resumed, recovered: result.recovered ?? false }
      }
      case 'step_into':
      case 'step_over':
      case 'step_out': {
        const kind = action === 'step_into' ? 'into' : action === 'step_over' ? 'over' : 'out'
        await gen.debugger.step(sessionId, targetId, kind)
        return { paused: true, hint: 'step issued; poll chrome_debug status for the new top frame' }
      }
      case 'eval': {
        const expression = readString(args.expression)
        if (expression === undefined) return { error: 'expression is required for eval' }
        const frameIndex = readInt(args.frame) ?? 0
        const value = await gen.debugger.evaluateOnFrame(sessionId, targetId, expression, frameIndex)
        return { value: serializeRemoteObject(value) }
      }
      default:
        return { error: `unknown action ${String(action)}` }
    }
  }

  private async breakpoint(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const action = readString(args.action)
    const targetId = await this.resolveTargetId(readString(args.targetId))
    if (targetId === undefined) return { error: 'no page target available' }
    const gen = this.ensureGeneration()
    // Same session discipline as chrome_debug: commands must ride the pinned
    // Debugger session or Chrome answers "Session with given id not found".
    let sessionId = gen.debugger.sessionOf(targetId)
    if (sessionId === null) {
      const session = await this.sessionFor(args, { wantPage: true })
      await gen.debugger.attachSession(session.sessionId, targetId)
      gen.sessions.markEnabled('Debugger', session.sessionId)
      sessionId = session.sessionId
    }
    const pinned = sessionId
    switch (action) {
      case 'set': {
        const url = readString(args.url)
        const line = readInt(args.line)
        if (url === undefined || line === undefined) return { error: 'url and line are required for set' }
        const info = await waitBounded(
          () => gen.debugger.setBreakpoint(pinned, targetId, {
            url,
            line,
            column: readInt(args.column) ?? undefined,
            condition: readString(args.condition) ?? undefined,
          }),
          WAIT_BUDGETS.debug,
          signal,
          'chrome_breakpoint set',
        )
        return { breakpoint: info }
      }
      case 'list':
        return { breakpoints: gen.debugger.breakpointsOf(targetId) }
      case 'remove': {
        const id = readString(args.id)
        if (id === undefined) return { error: 'id is required for remove' }
        const removed = await waitBounded(
          () => gen.debugger.removeBreakpoint(pinned, targetId, id),
          WAIT_BUDGETS.debug,
          signal,
          'chrome_breakpoint remove',
        )
        return { removed }
      }
      case 'clear': {
        try {
          const ids = await waitBounded(
            () => gen.debugger.removeAllBreakpoints(pinned, targetId),
            WAIT_BUDGETS.debug,
            signal,
            'chrome_breakpoint clear',
          )
          return { cleared: true, removed: ids }
        } catch (error) {
          return { cleared: false, error: messageOf(error) }
        }
      }
      case 'scripts':
        return { scripts: gen.debugger.scriptsOf(targetId) }
      default:
        return { error: `unknown action ${String(action)}` }
    }
  }

  // ── interaction group ─────────────────────────────────────────────────────

  private async screenshot(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const format = readString(args.format) === 'jpeg' ? 'jpeg' : 'png'
    const persist = readBool(args.persist) ?? this.bridge.attachmentsAvailable()
    const session = await this.sessionFor(args, { wantPage: true })
    await session.ensureEnabled('Page')
    const params: Record<string, unknown> = { format }
    if (format === 'jpeg') params.quality = clampInt(readInt(args.quality), 0, 100, 80)
    const shot = await waitBounded(
      () => session.send('Page.captureScreenshot', params),
      WAIT_BUDGETS.screenshot,
      signal,
      'chrome_screenshot',
    ) as { data?: string }
    if (typeof shot.data !== 'string') return { error: 'screenshot returned no data' }
    if (!persist) {
      return { format, persisted: false, base64Bytes: shot.data.length, data: clipBase64(shot.data) }
    }
    const bytes = Buffer.from(shot.data, 'base64')
    const ref = await this.bridge.persistImage(new Uint8Array(bytes), `image/${format}`)
    if (ref === undefined) {
      return { format, persisted: false, base64Bytes: shot.data.length, data: clipBase64(shot.data) }
    }
    return {
      format,
      persisted: true,
      attachment: { attachmentId: ref.attachmentId, width: ref.width, height: ref.height },
    }
  }

  private async click(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const selector = readString(args.selector)
    const x = readInt(args.x)
    const y = readInt(args.y)
    // A breakpoint parked on a synchronous mouse handler makes the input
    // dispatch never answer — refuse up front with the recovery path instead
    // of hanging until the harness aborts the tool call.
    const gen = this.ensureGeneration()
    const targetId = await this.resolveTargetId(readString(args.targetId))
    if (targetId !== undefined && gen.debugger.pausedOf(targetId) !== null) {
      return {
        error: 'target is paused at a breakpoint; a click would hang until the handler resumes',
        hint: 'run chrome_debug resume first (or remove the breakpoint), then retry the click',
      }
    }
    const session = await this.sessionFor(args, { wantPage: true })
    await session.ensureEnabled('DOM')
    let point = { x: 0, y: 0 }
    let element: { tag: string; id: string | null; classes: string | null } | undefined
    if (selector !== undefined) {
      const located = await locateSelector(session, selector)
      if (typeof located === 'string') return { error: located }
      point = located.point
      element = located.element
    } else if (x !== undefined && y !== undefined) {
      point = { x, y }
    } else {
      return { error: 'selector or x/y coordinates are required' }
    }
    // Bounded so a mid-call pause (breakpoint hit between the check above and
    // the dispatch) surfaces as an error with recovery guidance, not a hang.
    await dispatchMouseBounded(session, point, signal)
    return {
      clicked: true,
      x: point.x,
      y: point.y,
      tag: element?.tag ?? null,
      id: element?.id ?? null,
      classes: element?.classes ?? null,
    }
  }

  private async type(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const text = readString(args.text)
    if (text === undefined) return { error: 'text is required' }
    const gen = this.ensureGeneration()
    const targetId = await this.resolveTargetId(readString(args.targetId))
    if (targetId !== undefined && gen.debugger.pausedOf(targetId) !== null) {
      return {
        error: 'target is paused at a breakpoint; typing would hang until the handler resumes',
        hint: 'run chrome_debug resume first (or remove the breakpoint), then retry',
      }
    }
    const session = await this.sessionFor(args, { wantPage: true })
    const selector = readString(args.selector)
    if (selector !== undefined) {
      const located = await locateSelector(session, selector)
      if (typeof located === 'string') return { error: located }
      await session.send('Input.insertText', { text: '' }).catch(() => {})
      // Click focuses; insertText commits the value through the input pipeline.
      await dispatchMouseBounded(session, located.point, signal)
    }
    await typeText(session, text)
    return { typed: true, length: text.length }
  }

  // ── raw group ─────────────────────────────────────────────────────────────

  private async rawCdp(args: Record<string, unknown>, signal?: AbortSignal): Promise<DispatchOutcome> {
    const method = readString(args.method)
    if (method === undefined) return { error: 'method is required' }
    if (!/^[A-Z][A-Za-z]+\.[a-zA-Z][A-Za-z0-9]*$/.test(method)) {
      return { error: `invalid CDP method ${method}; expected Domain.method` }
    }
    const explicitSession = readString(args.sessionId)
    if (explicitSession !== undefined) {
      const result = await waitBounded(
        () => this.client().send(method, args.params, explicitSession),
        WAIT_BUDGETS.raw,
        signal,
        `chrome_cdp ${method}`,
      )
      return { result: serializeCdpValue(result) }
    }
    const targetId = readString(args.targetId)
    if (targetId === undefined) {
      // Browser-level command.
      const result = await waitBounded(
        () => this.client().send(method, args.params),
        WAIT_BUDGETS.raw,
        signal,
        `chrome_cdp ${method}`,
      )
      return { result: serializeCdpValue(result) }
    }
    const session = await this.sessionFor(args, { wantPage: false })
    const result = await waitBounded(
      () => session.send(method, args.params),
      WAIT_BUDGETS.raw,
      signal,
      `chrome_cdp ${method}`,
    )
    return { result: serializeCdpValue(result) }
  }

  // ── shared plumbing ───────────────────────────────────────────────────────

  private connected(): boolean {
    return this.bridge.getClient() !== undefined && this.bridge.getStatus().phase === 'connected'
  }

  private client(): SessionClient {
    const client = this.bridge.getClient()
    if (client === undefined) throw new Error('not-connected')
    return client
  }

  private ensureGeneration(): Generation {
    if (this.generation !== undefined) return this.generation
    const client = this.client()
    const capture = new CaptureManager({})
    const sessions = new TargetSessionManager(client, {})
    const debuggerManager = new DebuggerManager(client)
    capture.bind(client)
    void sessions.start().catch(() => { /* auto-attach best effort */ })
    this.generation = { sessions, capture, debugger: debuggerManager }
    return this.generation
  }

  /** Resolve (and remember) the target a call operates on. */
  private async resolveTargetId(explicit: string | undefined): Promise<string | undefined> {
    if (explicit !== undefined) {
      this.lastTargetUsed = explicit
      return explicit
    }
    if (this.defaultTargetId !== undefined) return this.defaultTargetId
    // Lazy async resolution: /json/list decides (devtools:// and about:blank
    // pages lose to a real page).
    const targets = await this.bridge.listTargets()
    this.defaultTargetId = pickDefaultTarget(targets)
    return this.defaultTargetId ?? this.lastTargetUsed
  }

  /** Acquire the session for the call's target (or the default). */
  private async sessionFor(args: Record<string, unknown>, options: { wantPage: boolean }): Promise<TargetSession> {
    const requested = readString(args.targetId)
    let targetId = requested
    if (targetId === undefined) {
      // Resolve the default asynchronously (can't in resolveTargetId).
      if (this.defaultTargetId === undefined) {
        const targets = await this.bridge.listTargets()
        this.defaultTargetId = pickDefaultTarget(targets)
      }
      targetId = this.defaultTargetId
      if (targetId === undefined) throw new Error('no page target available; pass targetId from chrome_list_targets')
    }
    this.lastTargetUsed = targetId
    const gen = this.ensureGeneration()
    const session = await gen.sessions.acquire(targetId)
    gen.capture.associate(session.sessionId, targetId)
    return session
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Structured not-connected reply shared by every tool. */
function notConnected(): ToolError {
  return {
    error: 'not-connected',
    hint: 'open the Chrome CDP connection from the panel, or ask the user to start Chrome with --remote-debugging-port',
  }
}

/** Detect messages that mean the CDP socket died (or its flat session did). */
function isSocketDeath(message: string): boolean {
  return message.includes('WebSocket')
    || message.includes('socket')
    || message.includes('Session with given id not found')
    || message.includes('Session not found')
    || message.includes('Target closed')
}

/** Narrow an unknown arg into a Record (never throws). */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function readBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Wait for the frame's load event (bounded). */
async function waitLoadEvent(session: TargetSession, budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, budgetMs)
    timer.unref?.()
    // Poll document.readyState — simpler and session-safe vs event subscribe
    // races on freshly attached sessions.
    const poll = setInterval(() => {
      void session.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }).then((result) => {
        const ready = (result as { result?: { value?: unknown } }).result?.value
        if (ready === 'complete' && !settled) {
          settled = true
          clearInterval(poll)
          clearTimeout(timer)
          resolve(true)
        }
      }).catch(() => { /* mid-navigation evaluate races are expected */ })
    }, 150)
    poll.unref?.()
  })
}

/** Locate a selector: point + element descriptor, or an error string. */
async function locateSelector(
  session: TargetSession,
  selector: string,
): Promise<{ point: { x: number; y: number }, element: { tag: string; id: string | null; classes: string | null } } | string> {
  const { root } = await session.send('DOM.getDocument', { depth: 0 }) as { root?: { nodeId?: number } }
  const nodeId = root?.nodeId
  if (nodeId === undefined) return 'DOM.getDocument returned no root'
  const found = await session.send('DOM.querySelector', {
    nodeId,
    selector,
  }) as { nodeId?: number }
  if (found.nodeId === undefined || found.nodeId === 0) return `selector matched nothing: ${selector}`
  const box = await session.send('DOM.getBoxModel', { nodeId: found.nodeId }) as {
    model?: { content?: number[] }
  }
  const content = box.model?.content
  if (content === undefined || content.length < 4) return `no box model for selector: ${selector}`
  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4] — center of the quad.
  const xs = [content[0], content[2], content[4], content[6]]
  const ys = [content[1], content[3], content[5], content[7]]
  const point = {
    x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
  }
  const node = await session.send('DOM.describeNode', { nodeId: found.nodeId, depth: 0 }) as {
    node?: { nodeName?: string; attributes?: string[] }
  }
  const attributes = node.node?.attributes ?? []
  const id = readAttribute(attributes, 'id')
  const classes = readAttribute(attributes, 'class')
  return {
    point,
    element: { tag: (node.node?.nodeName ?? '').toLowerCase(), id, classes },
  }
}

/** Read one attr from CDP's flat [name, value, ...] attribute array. */
function readAttribute(attributes: readonly string[], name: string): string | null {
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] === name) return attributes[i + 1]
  }
  return null
}

/** Dispatch a trusted mouse click at a viewport point (unbounded). */
async function dispatchMouse(session: TargetSession, point: { x: number; y: number }): Promise<void> {
  const params = { x: point.x, y: point.y, button: 'none', clickCount: 1 }
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params, button: 'left' })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params, button: 'left' })
}

/**
 * Dispatch a trusted mouse click under a hard time budget.
 *
 * The press/release pair rides the page's event loop: a Debugger breakpoint
 * parked inside a synchronous mouse handler suspends that loop and the CDP
 * reply never arrives (the 2026-09 hang). Bounding the wait turns that freeze
 * into a structured error with the recovery path, instead of a tool call that
 * hangs until the harness aborts it.
 */
async function dispatchMouseBounded(
  session: TargetSession,
  point: { x: number; y: number },
  signal?: AbortSignal,
  budgetMs: number = WAIT_BUDGETS.input,
): Promise<void> {
  const params = { x: point.x, y: point.y, button: 'none', clickCount: 1 }
  await waitBounded(
    () => session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params, button: 'left' }),
    budgetMs,
    signal,
    'mouse press',
  )
  await waitBounded(
    () => session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params, button: 'left' }),
    budgetMs,
    signal,
    'mouse release',
  )
}

/**
 * Run one CDP send under a hard time budget, mapping a budget expiry onto a
 * descriptive error (and honoring the caller's abort signal, which wins even
 * if the send later settles). The underlying promise is NOT abortable at the
 * protocol layer — this only stops *waiting* on it, which is exactly the
 * deadlock the interaction tools must escape.
 */
async function waitBounded<T>(
  send: (signal: AbortSignal | undefined) => Promise<T>,
  budgetMs: number,
  signal: AbortSignal | undefined,
  what: string,
): Promise<T> {
  if (signal?.aborted) throw new AbortedError(what)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new TimeoutError(what, budgetMs)) }, budgetMs)
    timer.unref?.()
    if (signal !== undefined) {
      onAbort = () => { reject(new AbortedError(what)) }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([send(signal), budget])
  } finally {
    clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Error when the per-call wait budget expired (the page stopped answering). */
class TimeoutError extends Error {
  constructor(what: string, budgetMs: number) {
    super(
      `${what} did not complete within ${budgetMs}ms — the page's main loop is likely suspended `
      + '(breakpoint pause). Run chrome_debug resume, then retry.',
    )
    this.name = 'ChromeCdpTimeout'
  }
}

/** Error when the harness cancelled the tool call while waiting. */
class AbortedError extends Error {
  constructor(what: string) {
    super(`${what} aborted: the tool call was cancelled while waiting for Chrome`)
    this.name = 'ChromeCdpAborted'
  }
}

/** Best-effort human message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Type text through key events; falls back to insertText for non-ASCII. */
async function typeText(session: TargetSession, text: string): Promise<void> {
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7E]*$/.test(text)
  if (!ascii) {
    await session.send('Input.insertText', { text })
    return
  }
  for (const char of text) {
    const keyCode = char.charCodeAt(0)
    const definition = keyDefinitions[char]
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: char,
      text: char,
      nativeVirtualKeyCode: keyCode,
      windowsVirtualKeyCode: keyCode,
      ...definition,
    })
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
      nativeVirtualKeyCode: keyCode,
      windowsVirtualKeyCode: keyCode,
      ...definition,
    })
  }
}

/** Minimal key definitions for special characters typing needs. */
const keyDefinitions: Record<string, Record<string, unknown>> = {
  '\n': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  '\t': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
}

/** Clip a base64 payload for inline (non-persisted) screenshot results. */
function clipBase64(data: string, limit = 65_536): string {
  if (data.length <= limit) return data
  return `${data.slice(0, limit)}…[truncated ${data.length - limit} chars]`
}
