/**
 * Console & network event capture into per-target ring buffers.
 *
 * Domains are enabled lazily per session on first subscription, and buffers
 * survive reconnects (marked by generation) so a post-mortem is still possible
 * after the socket dropped mid-investigation.
 *
 * @module dsh-chrome-cdp/tools/capture
 */

import type { SessionClient } from './targets.ts'

/** One console entry as exposed to tools. */
export interface ConsoleEntry {
  seq: number
  time: string
  level: string
  text: string
  url: string | null
  line: number | null
  targetId: string
}

/** One network request record as exposed to tools. */
export interface NetworkRecord {
  seq: number
  requestId: string
  targetId: string
  url: string
  method: string
  resourceType: string | null
  status: number | null
  statusText: string | null
  mimeType: string | null
  /** Encoded data length when known. */
  size: number | null
  /** Milliseconds between request start and response finished. */
  durationMs: number | null
  fromCache: boolean
  redirectCount: number
  errorText: string | null
  startedAt: string
}

/** Ring buffer with monotonic seq; oldest entries fall out. */
class Ring<T extends { seq: number }> {
  private readonly items: T[] = []
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }
  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }
  /** Entries after `afterSeq` (exclusive), up to `limit`, optionally filtered. */
  read(afterSeq: number, limit: number, filter?: (item: T) => boolean): { items: T[]; nextCursor: number } {
    const matched = this.items.filter(item => item.seq > afterSeq && (filter === undefined || filter(item)))
    const page = matched.slice(0, limit)
    const nextCursor = page.length > 0 ? page[page.length - 1].seq : afterSeq
    return { items: page, nextCursor }
  }
  size(): number {
    return this.items.length
  }
}

/** Per-target capture state. */
interface TargetBuffers {
  console: Ring<ConsoleEntry>
  network: Ring<NetworkRecord>
  /** request lifecycle accumulators: requestId → record-in-progress. */
  pending: Map<string, NetworkRecord>
  enabled: Set<string>
}

/**
 * Event capture manager. One instance spans connection generations; buffers
 * persist across them.
 */
export class CaptureManager {
  private readonly perTarget = new Map<string, TargetBuffers>()
  private seq = 0
  private readonly consoleCapacity: number
  private readonly networkCapacity: number
  private readonly consoleEnabled: boolean
  private readonly networkEnabled: boolean

  constructor(options: {
    consoleCapacity?: number
    networkCapacity?: number
    consoleEnabled?: boolean
    networkEnabled?: boolean
  } = {}) {
    this.consoleCapacity = options.consoleCapacity ?? 300
    this.networkCapacity = options.networkCapacity ?? 500
    this.consoleEnabled = options.consoleEnabled !== false
    this.networkEnabled = options.networkEnabled !== false
  }

  /** Bind to a live client; routes domain events into buffers. */
  bind(client: SessionClient): void {
    const consoleOn = this.consoleEnabled
    const networkOn = this.networkEnabled
    if (consoleOn) {
      client.on('Runtime.consoleAPICalled', (params, sessionId) => {
        this.pushConsole(params, sessionId)
      })
      client.on('Log.entryAdded', (params, sessionId) => {
        this.pushLogEntry(params, sessionId)
      })
    }
    if (networkOn) {
      client.on('Network.requestWillBeSent', (params, sessionId) => this.onRequestSent(params, sessionId))
      client.on('Network.responseReceived', (params, sessionId) => this.onResponseReceived(params, sessionId))
      client.on('Network.loadingFinished', (params, sessionId) => this.onLoadingFinished(params, sessionId))
      client.on('Network.loadingFailed', (params, sessionId) => this.onLoadingFailed(params, sessionId))
    }
  }

  /**
   * Ensure capture domains are enabled for a session (lazy per session).
   * Called by dispatch on every pull and before navigations.
   */
  async ensureEnabled(sessionId: string, targetId: string, domains: readonly string[]): Promise<void> {
    const state = this.stateOf(targetId)
    for (const domain of domains) {
      if (state.enabled.has(domain)) continue
      await this.boundSend(sessionId, `${domain}.enable`)
      state.enabled.add(domain)
    }
  }

  /** Read console entries with cursor semantics. */
  readConsole(query: {
    targetId: string
    level?: string | undefined
    text?: string | undefined
    afterSeq: number
    limit: number
  }): { entries: ConsoleEntry[]; nextCursor: number } {
    const state = this.stateOf(query.targetId)
    const level = query.level?.toLowerCase()
    const text = query.text?.toLowerCase()
    const read = state.console.read(query.afterSeq, query.limit, (entry) =>
      (level === undefined || entry.level === level)
      && (text === undefined || entry.text.toLowerCase().includes(text)))
    return { entries: read.items, nextCursor: read.nextCursor }
  }

  /** Read network records with cursor semantics. */
  readNetwork(query: {
    targetId: string
    url?: string | undefined
    resourceType?: string | undefined
    minStatus?: number | undefined
    afterSeq: number
    limit: number
  }): { requests: NetworkRecord[]; nextCursor: number } {
    const state = this.stateOf(query.targetId)
    const url = query.url?.toLowerCase()
    const rtype = query.resourceType?.toLowerCase()
    const read = state.network.read(query.afterSeq, query.limit, (rec) =>
      (url === undefined || rec.url.toLowerCase().includes(url))
      && (rtype === undefined || (rec.resourceType ?? '').toLowerCase() === rtype)
      && (query.minStatus === undefined || (rec.status ?? 0) >= query.minStatus))
    return { requests: read.items, nextCursor: read.nextCursor }
  }

  /** Buffer occupancy, for diagnostics. */
  stats(): { targets: number; console: number; network: number } {
    let consoleCount = 0
    let networkCount = 0
    for (const state of this.perTarget.values()) {
      consoleCount += state.console.size()
      networkCount += state.network.size()
    }
    return { targets: this.perTarget.size, console: consoleCount, network: networkCount }
  }

  /** Clear buffers (never called automatically; exposed for future RPC). */
  clear(): void {
    this.perTarget.clear()
  }

  private stateOf(targetId: string): TargetBuffers {
    let state = this.perTarget.get(targetId)
    if (state === undefined) {
      state = {
        console: new Ring<ConsoleEntry>(this.consoleCapacity),
        network: new Ring<NetworkRecord>(this.networkCapacity),
        pending: new Map(),
        enabled: new Set<string>(),
      }
      this.perTarget.set(targetId, state)
    }
    return state
  }

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  /** Send on a bound session — set at bind() time via the client. */
  private boundClient: SessionClient | undefined
  private async boundSend(sessionId: string, method: string): Promise<void> {
    if (this.boundClient === undefined) return
    await this.boundClient.send(method, undefined, sessionId)
  }

  private pushConsole(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined) return
    const targetId = this.targetOf(sessionId)
    if (targetId === undefined) return
    const p = params as {
      type?: string
      args?: Array<{ value?: unknown; description?: string; className?: string }>
      stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> }
    }
    const text = (p.args ?? [])
      .map(arg => typeof arg.description === 'string'
        ? arg.description
        : typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value) ?? String(arg.value))
      .join(' ')
      .trim()
    const frame = p.stackTrace?.callFrames?.[0]
    this.stateOf(targetId).console.push({
      seq: this.nextSeq(),
      time: new Date().toISOString(),
      level: p.type ?? 'log',
      text,
      url: frame?.url ?? null,
      line: typeof frame?.lineNumber === 'number' ? frame.lineNumber : null,
      targetId,
    })
  }

  private pushLogEntry(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined) return
    const targetId = this.targetOf(sessionId)
    if (targetId === undefined) return
    const p = params as { entry?: { level?: string; text?: string; url?: string; lineNumber?: number } }
    const entry = p.entry ?? {}
    this.stateOf(targetId).console.push({
      seq: this.nextSeq(),
      time: new Date().toISOString(),
      level: entry.level ?? 'log',
      text: entry.text ?? '',
      url: entry.url ?? null,
      line: typeof entry.lineNumber === 'number' ? entry.lineNumber : null,
      targetId,
    })
  }

  private onRequestSent(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined) return
    const targetId = this.targetOf(sessionId)
    if (targetId === undefined) return
    const p = params as {
      requestId: string
      request?: { url?: string; method?: string }
      redirectResponse?: unknown
      type?: string
      timestamp?: number
    }
    const state = this.stateOf(targetId)
    const existing = state.pending.get(p.requestId)
    // Redirect chain: same requestId re-fires requestWillBeSent; count it and
    // keep the FINAL url by replacing the record.
    const redirectCount = existing !== undefined ? existing.redirectCount + 1 : 0
    state.pending.set(p.requestId, {
      seq: this.nextSeq(),
      requestId: p.requestId,
      targetId,
      url: p.request?.url ?? '',
      method: p.request?.method ?? 'GET',
      resourceType: p.type ?? null,
      status: null,
      statusText: null,
      mimeType: null,
      size: null,
      durationMs: null,
      fromCache: false,
      redirectCount,
      errorText: null,
      startedAt: new Date().toISOString(),
    })
  }

  private onResponseReceived(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined) return
    const targetId = this.targetOf(sessionId)
    if (targetId === undefined) return
    const p = params as {
      requestId: string
      response?: { status?: number; statusText?: string; mimeType?: string; fromDiskCache?: boolean; fromPrefetchCache?: boolean }
      type?: string
    }
    const state = this.stateOf(targetId)
    const rec = state.pending.get(p.requestId)
    if (rec === undefined) {
      // Response without a tracked request (capture started mid-flight).
      state.network.push({
        seq: this.nextSeq(),
        requestId: p.requestId,
        targetId,
        url: (p.response as { url?: string } | undefined)?.url ?? '',
        method: 'GET',
        resourceType: p.type ?? null,
        status: p.response?.status ?? null,
        statusText: p.response?.statusText ?? null,
        mimeType: p.response?.mimeType ?? null,
        size: null,
        deep: undefined,
        durationMs: null,
        fromCache: p.response?.fromDiskCache === true || p.response?.fromPrefetchCache === true,
        redirectCount: 0,
        errorText: null,
        startedAt: new Date().toISOString(),
      } as unknown as NetworkRecord)
      return
    }
    rec.status = p.response?.status ?? null
    rec.statusText = p.response?.statusText ?? null
    rec.mimeType = p.response?.mimeType ?? null
    rec.fromCache = p.response?.fromDiskCache === true || p.response?.fromPrefetchCache === true
    if (rec.resourceType === null) rec.resourceType = p.type ?? null
  }

  private onLoadingFinished(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined) return
    const targetId = this.targetOf(sessionId)
    if (targetId === undefined) return
    const p = params as { requestId: string; timestamp?: number; encodedDataLength?: number }
    const state = this.stateOf(targetId)
    const rec = state.pending.get(p.requestId)
    if (rec === undefined) return
    rec.size = typeof p.encodedDataLength === 'number' ? p.encodedDataLength : rec.size
    state.network.push(rec)
    state.pending.delete(p.requestId)
  }

  private onLoadingFailed(params: unknown, sessionId: string | undefined): void {
    if (sessionId === undefined) undefinedReturn()
    const targetId = this.targetOf(sessionId ?? '')
    if (targetId === undefined) return
    const p = params as { requestId: string; errorText?: string; canceled?: boolean }
    const state = this.perTarget.get(targetId)
    if (state === undefined) return
    const rec = state.pending.get(p.requestId)
    if (rec === undefined) return
    rec.errorText = p.canceled === true ? `canceled: ${p.errorText ?? ''}`.trim() : (p.errorText ?? 'failed')
    state.network.push(rec)
    state.pending.delete(p.requestId)
  }

  /** sessionId → targetId via the pending/target map; falls back to 'browser'. */
  private targetOf(sessionId: string): string | undefined {
    // The session manager routes events with sessionId; we learn targetId from
    // the capture ensureEnabled calls. Keep a dedicated reverse map instead.
    return this.sessionTargets.get(sessionId)
  }
  private readonly sessionTargets = new Map<string, string>()

  /** Called by dispatch when a session is acquired for a target. */
  associate(sessionId: string, targetId: string): void {
    this.sessionTargets.set(sessionId, targetId)
  }
}

/** Unreachable helper keeping the failed-path shape obvious. */
function undefinedReturn(): void { /* see onLoadingFailed guard */ }
