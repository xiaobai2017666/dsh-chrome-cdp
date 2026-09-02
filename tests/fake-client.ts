/**
 * Fake CRI client for unit tests: records every command, serves scripted
 * replies (value or thrown Error), and lets tests emit CDP events to the
 * registered listeners with an explicit sessionId — exactly how CRI delivers
 * flat-session events (2nd arg).
 *
 * @module dsh-chrome-cdp/tests/fake-client
 */

/** One recorded command. */
export interface RecordedCommand {
  method: string
  params: unknown
  sessionId?: string
}

interface ScriptRule {
  method: string
  sessionId?: string
  reply: (params: unknown, sessionId?: string) => unknown
  sticky: boolean
}

type EventListener = (params: unknown, sessionId?: string) => void

/**
 * The fake client. `send` resolves via the last matching script rule
 * (method + optional sessionId match; rules are consumed once unless sticky).
 */
export class FakeCdpClient {
  readonly commands: RecordedCommand[] = []
  private readonly handlers = new Map<string, EventListener[]>()
  private scripts: ScriptRule[] = []

  /**
   * Script a reply: a plain value resolves, an Error rejects.
   * Consumed on first matching send unless `{ sticky: true }`.
   */
  reply(
    method: string,
    reply: unknown | ((params: unknown, sessionId?: string) => unknown),
    options: { sessionId?: string; sticky?: boolean } = {},
  ): this {
    this.scripts.push({
      method,
      sessionId: options.sessionId,
      reply: typeof reply === 'function'
        ? reply as (params: unknown, sessionId?: string) => unknown
        : () => reply,
      sticky: options.sticky ?? false,
    })
    return this
  }

  /** Commands recorded so far for one method (newest last). */
  commandsOf(method: string): RecordedCommand[] {
    return this.commands.filter((command) => command.method === method)
  }

  /** Emit a CDP event to registered listeners (params, sessionId). */
  emit(event: string, params: unknown, sessionId?: string): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(params, sessionId)
    }
  }

  /** SessionClient.send */
  async send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    this.commands.push({ method, params, sessionId })
    const index = this.scripts.findIndex(
      (rule) => rule.method === method && (rule.sessionId === undefined || rule.sessionId === sessionId),
    )
    if (index >= 0) {
      const rule = this.scripts[index]!
      if (!rule.sticky) this.scripts.splice(index, 1)
      const value = await rule.reply(params, sessionId)
      // Scripted errors (and errors returned by reply functions) reject, the
      // way CRI rejects failed commands.
      if (value instanceof Error) throw value
      return value
    }
    // Unscripted commands resolve with an empty object (enough for most flows).
    return {}
  }

  /** SessionClient.on */
  on(event: string, listener: EventListener, _sessionId?: string): unknown {
    const list = this.handlers.get(event)
    if (list === undefined) this.handlers.set(event, [listener])
    else list.push(listener)
    return this
  }

  /** SessionClient.off */
  off(event: string, listener: EventListener): unknown {
    const list = this.handlers.get(event)
    if (list === undefined) return this
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
    return this
  }
}

/** Wait for the event loop to turn (microtasks + timers). */
export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}
