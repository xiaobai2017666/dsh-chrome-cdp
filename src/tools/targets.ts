/**
 * Target session management over the browser-level CRI client.
 *
 * CDP commands aimed at a page must ride a *flat session*: one WebSocket, one
 * `sessionId` per attached target. This module owns that mapping plus the
 * per-session domain-enable bookkeeping, so tool dispatch can ask for "the
 * session for this target (auto-attaching if needed)" and get a ready pipe.
 *
 * Lifecycle is driven by the owning connection: `reset()` on socket loss
 * drops every cached session; Target events keep the cache honest while the
 * socket lives (auto-attached sessions appear without an explicit attach).
 *
 * @module dsh-chrome-cdp/tools/targets
 */

/** Structural type for the CRI client surface this module uses. */
export interface SessionClient {
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>
  on(event: string, listener: (params: unknown, sessionId?: string) => void, sessionId?: string): unknown
  off(event: string, listener: (params: unknown, sessionId?: string) => void): unknown
}

/** One cached session. */
interface SessionEntry {
  sessionId: string
  /** Domains already enabled on this session. */
  enabled: Set<string>
  /** Detach disposer for explicitly-attached sessions. */
  detach?: () => Promise<void>
}

/** Events about session/target lifecycle this manager listens for. */
export interface SessionEvents {
  /** A flat session attached (explicitly or via auto-attach). */
  onSessionAttached(targetId: string, sessionId: string): void
  /** A session detached (target gone or socket lost). */
  onSessionDetached(targetId: string | undefined, sessionId: string): void
}

/**
 * Session cache keyed by targetId. Not a cordis Service: the dispatch layer
 * owns one instance per connection generation.
 */
export class TargetSessionManager {
  private readonly sessions = new Map<string, SessionEntry>()
  /** Reverse map: sessionId → targetId, for event routing. */
  private readonly bySessionId = new Map<string, string>()
  private readonly eventUnsubscribers: Array<() => void> =  []
  private closed = false
  private readonly client: SessionClient
  private readonly events: Partial<SessionEvents>

  constructor(client: SessionClient, events: Partial<SessionEvents> = {}) {
    this.client = client
    this.events = events
  }

  /**
   * Enable auto-attach so new targets get sessions without an explicit attach.
   * Must be called once after the browser-level connection is up.
   */
  async start(): Promise<void> {
    // Route flat-session lifecycle events into the cache.
    this.listen('Target.attachedToTarget', (params) => {
      const p = params as { targetInfo?: { targetId?: string }, sessionId?: string }
      const targetId = p.targetInfo?.targetId
      const sessionId = p.sessionId
      if (typeof targetId !== 'string' || typeof sessionId !== 'string') return
      this.remember(targetId, sessionId)
      this.events.onSessionAttached?.(targetId, sessionId)
    })
    this.listen('Target.detachedFromTarget', (params) => {
      const p = params as { targetId?: string, sessionId?: string }
      const sessionId = p.sessionId
      if (typeof sessionId !== 'string') return
      const targetId = p.targetId ?? this.bySessionId.get(sessionId)
      this.forget(sessionId)
      this.events.onSessionDetached?.(targetId, sessionId)
    })
    await this.client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
  }

  /**
   * Get (or create) the session for a target.
   * @returns the flat sessionId and a send helper bound to it.
   */
  async acquire(targetId: string): Promise<TargetSession> {
    this.assertLive()
    const existing = this.sessions.get(targetId)
    if (existing !== undefined) return this.sessionView(existing)
    const { sessionId } = await this.client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    }) as { sessionId: string }
    this.remember(targetId, sessionId)
    return this.sessionView(this.sessions.get(targetId)!)
  }

  /** Whether a session exists for the target already. */
  has(targetId: string): boolean {
    return this.sessions.has(targetId)
  }

  /** All currently cached sessions. */
  entries(): ReadonlyMap<string, { sessionId: string }> {
    return this.sessions
  }

  /**
   * Ensure a domain is enabled on a session (idempotent per session).
   * @param domain - e.g. `Runtime`, `Network`, `Page`, `Debugger`.
   */
  async ensureEnabled(domain: string, sessionId: string): Promise<void> {
    for (const entry of this.sessions.values()) {
      if (entry.sessionId !== sessionId) continue
      if (entry.enabled.has(domain)) return
      await this.client.send(`${domain}.enable`, undefined, sessionId)
      entry.enabled.add(domain)
      return
    }
    // Unknown session (raced detach): enable blind; Chrome tolerates it once.
    await this.client.send(`${domain}.enable`, undefined, sessionId)
  }

  /** Drop everything (socket lost / manager disposed). */
  reset(): void {
    this.closed = true
    this.sessions.clear()
    this.bySessionId.clear()
    for (const off of this.eventUnsubscribers.splice(0)) {
      try {
        off()
      } catch { /* listener already gone */ }
    }
  }

  /** Forget one session (detached). */
  private forget(sessionId: string): void {
    const targetId = this.bySessionId.get(sessionId)
    this.bySessionId.delete(sessionId)
    if (targetId !== undefined) {
      const entry = this.sessions.get(targetId)
      if (entry !== undefined && entry.sessionId === sessionId) this.sessions.delete(targetId)
    }
  }

  /** Cache a session either way (explicit attach or auto-attach event). */
  private remember(targetId: string, sessionId: string): void {
    const previous = this.sessions.get(targetId)
    if (previous !== undefined && previous.sessionId !== sessionId) {
      this.bySessionId.delete(previous.sessionId)
    }
    this.sessions.set(targetId, { sessionId, enabled: new Set<string>() })
    this.bySessionId.set(sessionId, targetId)
  }

  /** Bound send helper for one session. */
  private sessionView(entry: SessionEntry): TargetSession {
    return {
      sessionId: entry.sessionId,
      send: (method, params) => this.client.send(method, params, entry.sessionId),
      ensureEnabled: (domain) => this.ensureEnabled(domain, entry.sessionId),
    }
  }

  /** Subscribe with an unsubscriber that tolerates CRI's on() shape. */
  private listen(event: string, listener: (params: unknown, sessionId?: string) => void): void {
    // CRI's on() returns the client itself; its off() takes (event, listener).
    this.client.on(event, listener)
    this.eventUnsubscribers.push(() => {
      try {
        this.client.off(event, listener)
      } catch { /* listener already gone */ }
    })
  }

  private assertLive(): void {
    if (this.closed) throw new Error('target sessions were reset (connection lost)')
  }
}

/** A bound session the dispatch layer sends commands through. */
export interface TargetSession {
  readonly sessionId: string
  send(method: string, params?: unknown): Promise<unknown>
  ensureEnabled(domain: string): Promise<void>
}

/** Pick the default page target from a /json/list style array. */
export function pickDefaultTarget(
  targets: ReadonlyArray<{ id: string; type: string; url?: string }>,
): string | undefined {
  const pages = targets.filter(t => t.type === 'page')
  if (pages.length === 0) return undefined
  // Prefer a non-devtools, non-blank page; fall back to the first page.
  const preferred = pages.find(t =>
    !t.url?.startsWith('devtools://')
    && t.url !== 'about:blank'
    && t.url !== '')
  return (preferred ?? pages[0]).id
}
