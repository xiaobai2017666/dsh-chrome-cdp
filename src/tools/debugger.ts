/**
 * Debugger-domain state machine: breakpoints, pause tracking, frame eval.
 *
 * Chrome owns the breakpoints; this module tracks what Chrome reports so
 * `chrome_debug status` answers from host memory (no round-trip), and the
 * paused state gates interaction tools (a paused target queues plain
 * Runtime.evaluate and Input dispatch forever — the classic deadlock).
 *
 * Session discipline (the 2026-09 breakpoint-hang postmortem): every Debugger
 * command for a target MUST ride the one flat session the Debugger domain was
 * enabled on. A later auto-attach hands out a *second* session for the same
 * target whose domain state is empty — commands sent through it fail with
 * "Session with given id not found" while host-side state still says paused.
 * So: pause/breakpoint state is keyed by targetId, the working session is
 * pinned per target, CRI events are filtered by the sessionId they carry, and
 * resume tolerates the pause/unpause disagreement by re-syncing with Chrome.
 *
 * @module dsh-chrome-cdp/tools/debugger
 */

import type { SessionClient } from './targets.ts'

/** Compact call frame as exposed to tools. */
export interface DebugCallFrame {
  callFrameId: string
  functionName: string
  /** 0-based line/column in the reported script. */
  line: number
  column: number
  scriptId: string
  scriptUrl: string | null
}

/** Snapshot of one paused target. */
export interface PausedState {
  reason: string
  callFrames: DebugCallFrame[]
  hitBreakpoints: string[]
  /** ISO time the pause was observed. */
  at: string
}

/** One tracked breakpoint. */
export interface BreakpointInfo {
  breakpointId: string
  targetId: string
  url: string | null
  /** 0-based, as CDP reports. */
  line: number
  column: number | null
  condition: string | null
}

/** One parsed script registration. */
export interface ScriptInfo {
  scriptId: string
  url: string | null
  lineCount: number | null
}

/** Result of a resume that needed the pause+resume recovery. */
export interface ResumeResult {
  resumed: boolean
  /** True when Chrome disagreed with host state and pause+resume was applied. */
  recovered?: boolean
}

/** Per-target debugger state (keyed by targetId, never by session id). */
interface TargetDebugState {
  paused: PausedState | null
  scripts: Map<string, ScriptInfo>
  breakpoints: Map<string, BreakpointInfo>
  /** The flat session the Debugger domain is enabled on (identity anchor). */
  session: string | null
  /** Chrome reported a pause that no Debugger.resumed has cleared yet. */
  chromePaused: boolean
}

/** Listener record so session-scoped unsubscription stays possible. */
interface ListenerRecord {
  event: string
  fn: (params: unknown, sessionId?: string) => void
}

/**
 * Debugger state tracker. One instance spans connection generations (script
 * and breakpoint tables reset on socket loss — Chrome forgets them too).
 */
export class DebuggerManager {
  private readonly perTarget = new Map<string, TargetDebugState>()
  /** sessionId → targetId for event routing (mirrors state.session). */
  private readonly bySession = new Map<string, string>()
  private readonly client: SessionClient
  private readonly listeners: ListenerRecord[] = []

  constructor(client: SessionClient) {
    this.client = client
    // Subscribe ONCE per event and route by the sessionId CRI attaches to
    // every flat-session event. Per-attach subscriptions would fire for every
    // target's events (CRI's on() ignores the extra argument) and accumulate.
    this.listen('Debugger.scriptParsed', (params, sessionId) => {
      const targetId = this.targetOfEvent(sessionId)
      if (targetId === undefined) return
      const p = params as { scriptId?: string; url?: string; lineCount?: number }
      if (typeof p.scriptId !== 'string') return
      this.stateOf(targetId).scripts.set(p.scriptId, {
        scriptId: p.scriptId,
        url: p.url || null,
        lineCount: typeof p.lineCount === 'number' ? p.lineCount : null,
      })
    })
    this.listen('Debugger.paused', (params, sessionId) => {
      const targetId = this.targetOfEvent(sessionId)
      if (targetId === undefined) return
      const p = params as {
        reason?: string
        callFrames?: Array<Record<string, unknown>>
        hitBreakpoints?: string[]
      }
      const frames = (p.callFrames ?? []).slice(0, 10).map((frame) => {
        const location = (frame.location ?? {}) as { scriptId?: string; lineNumber?: number; columnNumber?: number }
        return {
          callFrameId: String(frame.callFrameId ?? ''),
          functionName: String(frame.functionName ?? ''),
          line: typeof location.lineNumber === 'number' ? location.lineNumber : 0,
          column: typeof location.columnNumber === 'number' ? location.columnNumber : 0,
          scriptId: String(location.scriptId ?? ''),
          scriptUrl: this.scriptUrlOf(targetId, String(location.scriptId ?? '')),
        }
      })
      const state = this.stateOf(targetId)
      state.paused = {
        reason: p.reason ?? 'other',
        callFrames: frames,
        hitBreakpoints: [...(p.hitBreakpoints ?? [])],
        at: new Date().toISOString(),
      }
      state.chromePaused = true
    })
    this.listen('Debugger.resumed', (_params, sessionId) => {
      const targetId = this.targetOfEvent(sessionId)
      if (targetId === undefined) return
      const state = this.stateOf(targetId)
      state.paused = null
      state.chromePaused = false
    })
  }

  /**
   * Pin the session a target's Debugger domain runs on (idempotent per
   * session; re-pins and clears stale pause state when the session changes).
   * Enables the Debugger domain exactly once per session.
   */
  async attachSession(sessionId: string, targetId: string): Promise<void> {
    const state = this.stateOf(targetId)
    if (state.session === sessionId) return
    // A replaced session means the old debugger pipe is gone: Chrome detached
    // it (auto-resuming any pause) and forgot its breakpoints.
    if (state.session !== null) {
      this.bySession.delete(state.session)
      state.paused = null
      state.chromePaused = false
      state.scripts.clear()
    }
    state.session = sessionId
    this.bySession.set(sessionId, targetId)
    await this.client.send('Debugger.enable', undefined, sessionId)
  }

  /** Current paused state of a target (or null). */
  pausedOf(targetId: string): PausedState | null {
    return this.stateOf(targetId).paused
  }

  /** The pinned Debugger session of a target (or null before first use). */
  sessionOf(targetId: string): string | null {
    return this.stateOf(targetId).session
  }

  /** All tracked scripts of a target. */
  scriptsOf(targetId: string): ScriptInfo[] {
    return [...this.stateOf(targetId).scripts.values()]
  }

  /** All tracked breakpoints of a target. */
  breakpointsOf(targetId: string): BreakpointInfo[] {
    return [...this.stateOf(targetId).breakpoints.values()]
  }

  /** URL of a script, when known. */
  scriptUrlOf(targetId: string, scriptId: string): string | null {
    return this.stateOf(targetId).scripts.get(scriptId)?.url ?? null
  }

  /** Set a breakpoint by URL substring; tracks it host-side. */
  async setBreakpoint(sessionId: string, targetId: string, spec: {
    url: string
    line: number
    column?: number | undefined
    condition?: string | undefined
  }): Promise<BreakpointInfo> {
    const params: Record<string, unknown> = {
      lineNumber: spec.line,
      urlRegex: escapeRegex(spec.url),
    }
    if (spec.column !== undefined) params.columnNumber = spec.column
    if (spec.condition !== undefined && spec.condition !== '') params.condition = spec.condition
    const result = await this.client.send('Debugger.setBreakpointByUrl', params, sessionId) as {
      breakpointId: string
      locations?: Array<{ scriptId?: string; lineNumber?: number; columnNumber?: number }>
    }
    const info: BreakpointInfo = {
      breakpointId: result.breakpointId,
      targetId,
      url: spec.url,
      line: result.locations?.[0]?.lineNumber ?? spec.line,
      column: (result as { columnNumber?: number }).columnNumber ?? null,
      condition: spec.condition ?? null,
    }
    this.stateOf(targetId).breakpoints.set(info.breakpointId, info)
    return info
  }

  /**
   * Remove a breakpoint. Returns true when the breakpoint is gone from
   * Chrome OR the host table — a stale/unknown id is a successful removal,
   * not a failure (the 2026-09 postmortem: `removed:false` made a live
   * breakpoint look undeletable and every later click re-hit it).
   * @throws only when the command failed for a reason other than "already gone".
   */
  async removeBreakpoint(sessionId: string, targetId: string, breakpointId: string): Promise<boolean> {
    const state = this.stateOf(targetId)
    try {
      await this.client.send('Debugger.removeBreakpoint', { breakpointId }, sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isAlreadyGone(message)) throw error
    }
    // Unknown/stale ids are successful removals: the breakpoint is gone from
    // the model's point of view either way.
    state.breakpoints.delete(breakpointId)
    return true
  }

  /**
   * Remove every tracked breakpoint of a target. Best effort: stale ids are
   * tolerated (see {@link removeBreakpoint}); returns the ids attempted.
   */
  async removeAllBreakpoints(sessionId: string, targetId: string): Promise<string[]> {
    const ids = [...this.stateOf(targetId).breakpoints.keys()]
    for (const id of ids) {
      try {
        await this.client.send('Debugger.removeBreakpoint', { breakpointId: id }, sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!isAlreadyGone(message)) throw error
      }
      this.stateOf(targetId).breakpoints.delete(id)
    }
    return ids
  }

  /** Evaluate on the top (or indexed) paused call frame. */
  async evaluateOnFrame(sessionId: string, targetId: string, expression: string, frameIndex = 0): Promise<unknown> {
    const paused = this.stateOf(targetId).paused
    if (paused === null) throw new Error('target is not paused; use chrome_debug pause first, or chrome_evaluate')
    const frame = paused.callFrames[frameIndex]
    if (frame === undefined) throw new Error(`no call frame ${frameIndex} (paused with ${paused.callFrames.length} frames)`)
    const result = await this.client.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression,
      returnByValue: true,
    }, sessionId) as { result?: unknown, exceptionDetails?: { text?: string } }
    if (result.exceptionDetails !== undefined) {
      throw new Error(`evaluation threw: ${result.exceptionDetails.text ?? 'unknown error'}`)
    }
    return result.result
  }

  /** Issue a stepping command on a paused target. */
  async step(sessionId: string, targetId: string, kind: 'into' | 'over' | 'out'): Promise<{ paused: boolean }> {
    this.assertPaused(targetId, 'stepping')
    const method = kind === 'into' ? 'Debugger.stepInto' : kind === 'over' ? 'Debugger.stepOver' : 'Debugger.stepOut'
    await this.client.send(method, undefined, sessionId)
    // Stepping re-pauses quickly; report paused-ness without waiting.
    return { paused: this.stateOf(targetId).paused !== null }
  }

  /** Explicit pause of a running target. */
  async pause(sessionId: string, targetId: string): Promise<void> {
    await this.client.send('Debugger.pause', undefined, sessionId)
  }

  /**
   * Resume a paused target.
   *
   * Chrome answers "Can only perform operation while paused" when ITS debugger
   * does not consider the target paused — e.g. host state went stale, or a
   * previous resume was lost. When we have any pause trace for the target,
   * re-sync with the postmortem-proven pause→resume combination instead of
   * failing; without a pause trace the error propagates (the target really
   * is not paused and inventing a pause would freeze it).
   */
  async resume(sessionId: string, targetId: string): Promise<ResumeResult> {
    const state = this.stateOf(targetId)
    try {
      await this.client.send('Debugger.resume', undefined, sessionId)
      state.paused = null
      state.chromePaused = false
      return { resumed: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const chromePaused = state.paused !== null || state.chromePaused
      if (chromePaused && isNotPausedMessage(message)) {
        await this.client.send('Debugger.pause', undefined, sessionId)
        await this.client.send('Debugger.resume', undefined, sessionId)
        state.paused = null
        state.chromePaused = false
        return { resumed: true, recovered: true }
      }
      if (isNotPausedMessage(message)) {
        throw new Error('target is not paused (resuming); pause or hit a breakpoint first')
      }
      throw error
    }
  }

  /** Reset all state (socket lost). */
  reset(): void {
    this.perTarget.clear()
    this.bySession.clear()
    for (const { event, fn } of this.listeners.splice(0)) {
      try {
        this.client.off(event, fn)
      } catch { /* listener already gone */ }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Resolve the target an event belongs to via its carrying session. */
  private targetOfEvent(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    return this.bySession.get(sessionId)
  }

  /** Subscribe a routed event listener, tracked for reset(). */
  private listen(event: string, handler: (params: unknown, sessionId?: string) => void): void {
    this.client.on(event, handler)
    this.listeners.push({ event, fn: handler })
  }

  private assertPaused(targetId: string, doing: string): void {
    if (this.stateOf(targetId).paused === null) {
      throw new Error(`target is not paused (${doing}); pause or hit a breakpoint first`)
    }
  }

  private stateOf(targetId: string): TargetDebugState {
    let state = this.perTarget.get(targetId)
    if (state === undefined) {
      state = { paused: null, scripts: new Map(), breakpoints: new Map(), session: null, chromePaused: false }
      this.perTarget.set(targetId, state)
    }
    return state
  }
}

/** Messages meaning the breakpoint/pause is already gone Chrome-side. */
function isAlreadyGone(message: string): boolean {
  return message.includes('Session with given id not found')
    || message.includes('Session not found')
    || message.includes('Target closed')
    || message.includes('Breakpoint at specified location not found')
    || message.includes('not found')
}

/** Messages meaning Chrome's debugger does not consider the target paused. */
function isNotPausedMessage(message: string): boolean {
  return message.includes('Can only perform operation while paused')
    || message.includes('not paused')
}

/** Escape a user URL substring into a safe regex source. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
