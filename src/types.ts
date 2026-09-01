/**
 * Wire vocabulary of the Chrome CDP panel, shared by both plugin halves.
 *
 * The Host half owns every value here: it derives connection state from the
 * live chrome-remote-interface client and serves it over the `/cdp` RPC
 * channel. The browser half consumes these types only — its bundle inlines
 * them (wire layer with no runtime identity to share), exactly like the
 * in-repo inline-safe wire packages.
 *
 * @module dsh-chrome-cdp/types
 */

/** Connection lifecycle as the Host reports it. */
export type CdpConnectionPhase =
  | 'disconnected' /** no client and not trying */
  | 'connecting' /** a connect attempt is in flight */
  | 'connected' /** CDP WebSocket is up */
  | 'error' /** last attempt failed; see `error` */

/** Why the connection dropped, when it did. */
export type CdpDisconnectReason = 'user' | 'socket' | 'shutdown'

/** One CDP target as `/json/list` reports it. */
export interface CdpTargetInfo {
  /** Target id (hex string from Chrome). */
  id: string
  /** Target type: page, background_page, service_worker, … */
  type: string
  /** Page title or worker name. */
  title: string
  /** Page URL. */
  url: string
  /** True when the target can receive commands over its own session. */
  attachable: boolean
}

/** Complete connection snapshot; every field JSON-safe for the wire. */
export interface CdpStatus {
  /** Current lifecycle phase. */
  phase: CdpConnectionPhase
  /** Connection parameters in force for the current/last attempt. */
  host: string
  /** Port of the same attempt. */
  port: number
  /** Whether the Host retries automatically when the socket drops. */
  autoReconnect: boolean
  /** Human-readable failure of the last attempt; present only in `error`. */
  error: string | null
  /** Reason the previous connection ended, if one existed. */
  lastDisconnect: CdpDisconnectReason | null
  /** WebSocket debugger URL Chrome advertised, when connected. */
  webSocketDebuggerUrl: string | null
  /** Chrome version from `/json/version`, when connected. */
  browserVersion: string | null
  /** Attachable page targets, refreshed on connect and on demand. */
  targets: readonly CdpTargetInfo[]
  /** ISO timestamp of the moment the current connection was established. */
  connectedAt: string | null
  /** Monotonic counter of connect attempts, for cheap change detection. */
  attempts: number
}

/** Connection parameters the panel edits (also the settings section shape). */
export interface CdpParams {
  /** CDP endpoint host. */
  host: string
  /** CDP endpoint port. */
  port: number
  /** Retry automatically when the socket drops. */
  autoReconnect: boolean
  /** Seconds between reconnect attempts; 0 disables retry. */
  reconnectDelaySeconds: number
}

/** Reply of `ensure`: how the Host brought a CDP-capable Chrome up. */
export interface CdpEnsureResult {
  /** What happened: nothing / a running Chrome was restarted / one was started. */
  action: 'none' | 'restarted' | 'started'
  /** True when /json/version answered after everything settled. */
  endpointReady: boolean
  /** True when a running Chrome was left untouched (default mode). */
  existingUntouched?: boolean
  host: string
  port: number
  /** ISO timestamp of the settle moment. */
  checkedAt: string
  /** What was attempted, in order (shown by the panel). */
  steps: string[]
  error?: string
  hint?: string
}

/** Reply of `setParams`: what the Host did with the submitted values. */
export interface CdpSetParamsResult {
  /** Values the Host accepted and now uses. */
  params: CdpParams
  /** Whether the values were persisted into the user settings document. */
  persisted: boolean
  /** Why persistence was skipped, when it was (settings service absent). */
  persistenceNote?: string
}
