/**
 * Chrome CDP connection manager, Host half.
 *
 * Owns one chrome-remote-interface client at a time. All state transitions
 * publish through a JSON-safe {@link CdpStatus} snapshot; the `/cdp` RPC
 * channel serves it to the browser half, and a settings section
 * (`chrome-cdp` namespace) persists the connection parameters.
 *
 * Failure posture: a lost CDP socket never throws into the host tree. It
 * flips the published phase and, when `autoReconnect` is on, schedules the
 * next attempt through a timer that plugin teardown cancels.
 *
 * @module dsh-chrome-cdp/cdp-connection
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import CDP from 'chrome-remote-interface'
import type {
  CdpDisconnectReason, CdpParams, CdpSetParamsResult, CdpStatus, CdpTargetInfo,
} from './types.ts'

/** Minimal structural type for the CRI default export; it ships no .d.ts. */
interface CdpFactory {
  (options?: { host?: string; port?: number; secure?: boolean }): Promise<unknown>
  Version(options?: { host?: string; port?: number }): Promise<{ Browser?: string }>
  List(options?: { host?: string; port?: number }): Promise<Array<{
    id?: string
    type?: string
    title?: string
    url?: string
    webSocketDebuggerUrl?: string
  }>>
}

/** Minimal structural type for a connected CRI client. */
interface CdpClientShape {
  webSocketUrl?: string
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>
  on(event: string, listener: (params: never, sessionId?: string) => void, sessionId?: string): unknown
  off(event: string, listener: (params: never, sessionId?: string) => void): unknown
  close(callback?: () => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
}

/** The CRI module value narrowed to the surface this service uses. */
const CDP_API = CDP as unknown as CdpFactory

const DEFAULT_PARAMS: Readonly<CdpParams> = {
  host: '127.0.0.1',
  port: 9222,
  autoReconnect: true,
  reconnectDelaySeconds: 5,
}

/** Reject impossible parameters before any socket is opened. */
function resolveParams(input: Partial<CdpParams> | undefined, base: Readonly<CdpParams>): CdpParams {
  const host = typeof input?.host === 'string' && input.host.trim() !== ''
    ? input.host.trim()
    : base.host
  const portRaw = typeof input?.port === 'number' ? input.port : base.port
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error('port must be an integer between 1 and 65535')
  }
  const delayRaw = typeof input?.reconnectDelaySeconds === 'number'
    ? input.reconnectDelaySeconds
    : base.reconnectDelaySeconds
  if (!Number.isInteger(delayRaw) || delayRaw < 1 || delayRaw > 600) {
    throw new Error('reconnectDelaySeconds must be an integer between 1 and 600')
  }
  return {
    host,
    port: portRaw,
    autoReconnect: typeof input?.autoReconnect === 'boolean' ? input.autoReconnect : base.autoReconnect,
    reconnectDelaySeconds: delayRaw,
  }
}

/** Map an unknown failure onto a short message safe for the wire. */
export function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The `chromeCdp` service: one managed CDP connection plus its RPC face.
 */
export class ChromeCdpService extends Service {
  /** The RPC channel service is required; settings wiring stays optional. */
  static inject = ['connection']

  private params: CdpParams
  private client: CdpClientShape | undefined
  private status: CdpStatus
  private connectInFlight: Promise<boolean> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  private closed = false

  constructor(ctx: Context, entryConfig: Partial<CdpParams> = {}) {
    super(ctx, 'chromeCdp')
    this.params = resolveParams(entryConfig, DEFAULT_PARAMS)
    this.status = {
      phase: 'disconnected',
      host: this.params.host,
      port: this.params.port,
      autoReconnect: this.params.autoReconnect,
      error: null,
      lastDisconnect: null,
      webSocketDebuggerUrl: null,
      browserVersion: null,
      targets: [],
      connectedAt: null,
      attempts: 0,
    }

    // Cancelling the fiber must tear the socket and pending timers down with
    // it; nothing here may outlive the plugin that owns the connection.
    ctx.effect(() => () => { this.shutdown('shutdown') }, 'chrome-cdp: connection teardown')
  }

  /** @returns the current JSON-safe status snapshot. */
  getSnapshot(): CdpStatus {
    return this.status
  }

  /** Observe status replacements. @returns the unsubscriber. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns the connection parameters currently in force. */
  currentParams(): CdpParams {
    return this.params
  }

  /**
   * The live CRI client for tools dispatch, when connected.
   * Exposed raw: the tools layer owns its own session/event bookkeeping.
   */
  rawClient(): CdpClientShape | undefined {
    return this.client
  }

  /**
   * Adopt new parameters (from the settings section or the panel).
   *
   * Saving is local: the live connection is never torn down here — the panel
   * saves the form and connects explicitly, so a save cannot interrupt a
   * working connection. Endpoint params are adopted for the *next* attempt;
   * behavior params (auto-reconnect) apply to the running cycle immediately.
   *
   * @param next - fields to replace; omitted fields keep their value.
   * @returns the accepted params.
   */
  setParams(next: Partial<CdpParams>): CdpParams {
    const resolved = resolveParams(next, this.params)
    this.params = resolved
    this.publish({
      host: resolved.host,
      port: resolved.port,
      autoReconnect: resolved.autoReconnect,
    })
    if (!resolved.autoReconnect) this.cancelReconnect()
    return resolved
  }

  /**
   * Save-only variant used by the panel's RPC `setParams` endpoint: adopt the
   * values, then persist them into the user settings document when a settings
   * service is mounted. Asynchronous by nature (the document write is awaited)
   * and never reconnects — connecting stays an explicit button.
   *
   * @param next - fields to replace; omitted fields keep their value.
   * @param persist - called to store the resolved params; skipped when absent.
   * @returns accepted params plus whether persistence ran.
   */
  async setParamsAndPersist(
    next: Partial<CdpParams>,
    persist?: (params: CdpParams) => Promise<void>,
  ): Promise<CdpSetParamsResult> {
    const params = this.setParams(next)
    if (persist === undefined) {
      return { params, persisted: false, persistenceNote: 'settings service not available' }
    }
    try {
      await persist(params)
      return { params, persisted: true }
    } catch (error) {
      // The values are already live for the next attempt; only the durable
      // copy failed and the panel must hear about it.
      throw new Error(`params applied but not saved: ${failureMessage(error)}`)
    }
  }

  /**
   * Open (or replace) the CDP connection.
   * @returns whether the connection is up when the attempt settles.
   */
  async connect(): Promise<boolean> {
    if (this.closed) return false
    if (this.connectInFlight !== undefined) return this.connectInFlight
    this.cancelReconnect()
    const attempt = this.status.attempts + 1
    this.publish({
      phase: 'connecting',
      attempts: attempt,
      host: this.params.host,
      port: this.params.port,
      error: null,
    })
    this.connectInFlight = this.attempt().then((up) => {
      this.connectInFlight = undefined
      if (!up) this.scheduleReconnect()
      return up
    })
    return this.connectInFlight
  }

  /**
   * Close the connection (or cancel a pending attempt) on purpose.
   * @param reason - who asked for the close.
   */
  disconnect(reason: CdpDisconnectReason = 'user'): void {
    this.cancelReconnect()
    const had = this.client !== undefined || this.status.phase === 'connecting'
    const settling = this.client
    this.client = undefined
    this.publish({
      phase: 'disconnected',
      error: null,
      lastDisconnect: had ? reason : this.status.lastDisconnect,
      webSocketDebuggerUrl: null,
      browserVersion: null,
      targets: [],
      connectedAt: null,
    })
    if (settling !== undefined) {
      try {
        // CRI suppresses its 'disconnect' event on user-initiated close, so
        // this cannot re-enter through onSocketClosed.
        settling.close()
      } catch { /* close on an already-dead socket */ }
    }
  }

  /** @returns attachable targets as the endpoint currently reports them. */
  async targets(): Promise<readonly CdpTargetInfo[]> {
    try {
      const list = await CDP_API.List({ host: this.params.host, port: this.params.port })
      return (list ?? [])
        .filter(entry => typeof entry.webSocketDebuggerUrl === 'string')
        .map(entry => ({
          id: entry.id ?? '',
          type: entry.type ?? 'page',
          title: entry.title ?? '',
          url: entry.url ?? '',
          attachable: true,
        }))
    } catch { return [] }
  }

  /** Refresh and publish the target list; a dead endpoint reports empty. */
  private async refreshTargets(): Promise<void> {
    this.publish({ targets: await this.targets() })
  }

  /** One connect attempt; never throws — failures publish as `error`. */
  private async attempt(): Promise<boolean> {
    try {
      const client = await CDP_API({ host: this.params.host, port: this.params.port })
      if (this.closed) {
        try {
          (client as CdpClientShape).close()
        } catch { /* teardown race */ }
        return false
      }
      this.adopt(client as CdpClientShape)
      return true
    } catch (error) {
      this.publish({ phase: 'error', error: failureMessage(error) })
      return false
    }
  }

  /** Start managing a freshly connected client. */
  private adopt(client: CdpClientShape): void {
    const previous = this.client
    this.client = client
    client.on('disconnect', () => { this.onSocketClosed() })
    this.publish({
      phase: 'connected',
      error: null,
      lastDisconnect: null,
      webSocketDebuggerUrl: client.webSocketUrl ?? null,
      targets: [],
      connectedAt: new Date().toISOString(),
    })
    if (previous !== undefined && previous !== client) {
      try {
        previous.close()
      } catch { /* replaced socket */ }
    }
    void this.refreshTargets()
    void this.readBrowserVersion()
  }

  /** Read `/json/version` and publish the browser product string. */
  private async readBrowserVersion(): Promise<void> {
    try {
      const version = await CDP_API.Version({ host: this.params.host, port: this.params.port })
      if (this.client !== undefined && typeof version.Browser === 'string') {
        this.publish({ browserVersion: version.Browser })
      }
    } catch { /* version is decorative; keep the panel usable */ }
  }

  /** Socket-level drop: flip to error and maybe retry. */
  private onSocketClosed(): void {
    if (this.client === undefined) return
    this.client = undefined
    this.publish({
      phase: 'error',
      error: "connection lost",
      lastDisconnect: 'socket',
      webSocketDebuggerUrl: null,
      browserVersion: null,
      targets: [],
      connectedAt: null,
    })
    this.scheduleReconnect()
  }

  /** Queue the next automatic attempt when retries are enabled. */
  private scheduleReconnect(): void {
    if (this.closed || !this.params.autoReconnect) return
    if (this.reconnectTimer !== undefined || this.connectInFlight !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, this.params.reconnectDelaySeconds * 1000)
    // Never hold the host process open just for a pending retry.
    this.reconnectTimer.unref?.()
  }

  /** Drop any queued automatic attempt. */
  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  /** Final teardown used by plugin unload. */
  shutdown(reason: CdpDisconnectReason): void {
    this.closed = true
    this.cancelReconnect()
    this.disconnect(reason)
  }

  /** Merge a patch into the published status and notify observers. */
  private publish(patch: Partial<CdpStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

/** Fold an unknown thrown value into the RPC wire error branch. */
export function cdpRpcFailure(error: unknown): {
  ok: false
  error: { code: string; message: string }
} {
  return { ok: false, error: { code: 'cdp-error', message: failureMessage(error) } }
}
