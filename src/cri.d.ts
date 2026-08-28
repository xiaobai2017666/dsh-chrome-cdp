/**
 * Structural typings for chrome-remote-interface@0.34, which ships no .d.ts.
 * Only the surface this plugin uses is declared.
 */

declare module 'chrome-remote-interface' {
  /** One target as `/json/list` reports it. */
  export interface TargetInfo {
    id: string
    type: string
    title: string
    url: string
    webSocketDebuggerUrl?: string
  }

  /** Options accepted by the default factory. */
  export interface ConnectOptions {
    host?: string
    port?: number
    secure?: boolean
    target?: string | TargetInfo | ((targets: TargetInfo[]) => number | TargetInfo)
  }

  /** A connected CDP client. */
  export interface Client {
    readonly webSocketUrl: string | undefined
    /** Raw protocol send; with sessionId rides a flat session. */
    send(method: string, params?: unknown, sessionId?: string): Promise<unknown>
    /** Subscribe to a protocol event (optionally session-scoped). */
    on(event: string, listener: (params: never, sessionId?: string) => void, sessionId?: string): Client
    /** Unsubscribe. */
    off(event: string, listener: (params: never, sessionId?: string) => void): Client
    on(event: 'disconnect', listener: () => void): Client
    on(event: 'error', listener: (error: Error) => void): Client
    close(callback?: () => void): void | Promise<void>
    /** Protocol domains are attached dynamically by CRI. */
    readonly [domain: string]: unknown
  }

  /** The CDP module. */
  const CDP: {
    (options?: ConnectOptions): Promise<Client>
    List(options?: { host?: string; port?: number }): Promise<TargetInfo[]>
    Version(options?: { host?: string; port?: number }): Promise<{
      Browser: string
      'Protocol-Version': string
      'User-Agent': string
      'V8-Version': string
      'WebKit-Version': string
      webSocketDebuggerUrl: string
    }>
    New(options?: { host?: string; port?: number; url?: string }): Promise<TargetInfo>
    Activate(options?: { host?: string; port?: number; id?: string }): Promise<void>
    Close(options?: { host?: string; port?: number; id?: string }): Promise<void>
  }

  export default CDP
}
