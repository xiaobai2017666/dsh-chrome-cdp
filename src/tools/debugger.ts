/**
 * Debugger-domain state machine: breakpoints, pause tracking, frame eval.
 *
 * Chrome owns the breakpoints; this module tracks what Chrome reports so
 * `chrome_debug status` answers from host memory (no round-trip), and the
 * paused state gates regular evaluate (a paused target queues plain
 * Runtime.evaluate forever — the classic deadlock).
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

/** Per-target debugger state. */
interface TargetDebugState {
  paused: PausedState | null
  scripts: Map<string, ScriptInfo>
  breakpoints: Map<string, BreakpointInfo>
}

/**
 * Debugger state tracker. One instance spans connection generations (script
 * and breakpoint tables reset on socket loss — Chrome forgets them too).
 */
export class DebuggerManager {
  private readonly perTarget = new Map<string, TargetDebugState>()
  private enabledSessions = new Set<string>()
  private readonly client: SessionClient

  constructor(client: SessionClient) {
    this.client = client
  }

  /** Wire debugger event routing for a session (called once per session). */
  async attachSession(sessionId: string, targetId: string): Promise<void> {
    if (this.enabledSessions.has(sessionId)) return
    this.enabledSessions.add(sessionId)
    this.stateOf(targetId) // ensure bucket exists
    this.client.on('Debugger.scriptParsed', (params) => {
      const p = params as { scriptId?: string; url?: string; lineCount?: number }
      if (typeof p.scriptId !== 'string') return
      this.stateOf(targetId).scripts.set(p.scriptId, {
        scriptId: p.scriptId,
        url: p.url || null,
        lineCount: typeof p.lineCount === 'number' ? p.lineCount : null,
      })
    }, sessionId)
    this.client.on('Debugger.paused', (params) => {
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
      this.stateOf(targetId).paused = {
        reason: p.reason ?? 'other',
        callFrames: frames,
        hitBreakpoints: [...(p.hitBreakpoints ?? [])],
        at: new Date().toISOString(),
      }
    }, sessionId)
    this.client.on('Debugger.resumed', () => {
      this.stateOf(targetId).paused = null
    }, sessionId)
    await this.client.send('Debugger.enable', undefined, sessionId)
  }

  /** Current paused state of a target (or null). */
  pausedOf(targetId: string): PausedState | null {
    return this.stateOf(targetId).paused
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

  /** Remove a tracked breakpoint both sides. */
  async removeBreakpoint(sessionId: string, targetId: string, breakpointId: string): Promise<boolean> {
    await this.client.send('Debugger.removeBreakpoint', { breakpointId }, sessionId)
    return this.stateOf(targetId).breakpoints.delete(breakpointId)
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
    void kind
  }

  /** Explicit pause of a running target. */
  async pause(sessionId: string, targetId: string): Promise<void> {
    await this.client.send('Debugger.pause', undefined, sessionId)
  }

  /** Resume a paused target. */
  async resume(sessionId: string, targetId: string): Promise<void> {
    this.assertPaused(targetId, 'resuming')
    await this.client.send('Debugger.resume', undefined, sessionId)
  }

  /** Reset all state (socket lost). */
  reset(): void {
    this.perTarget.clear()
    this.enabledSessions = new Set()
  }

  private assertPaused(targetId: string, doing: string): void {
    if (this.stateOf(targetId).paused === null) {
      throw new Error(`target is not paused (${doing}); pause or hit a breakpoint first`)
    }
  }

  private stateOf(targetId: string): TargetDebugState {
    let state = this.perTarget.get(targetId)
    if (state === undefined) {
      state = { paused: null, scripts: new Map(), breakpoints: new Map() }
      this.perTarget.set(targetId, state)
    }
    return state
  }
}

/** Escape a user URL substring into a safe regex source. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
