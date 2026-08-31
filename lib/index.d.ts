import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { Context, Service } from "@deepseek-ai/cordis";
//#region src/types.d.ts
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
type CdpConnectionPhase = 'disconnected' | /** no client and not trying */ 'connecting' | /** a connect attempt is in flight */ 'connected' | /** CDP WebSocket is up */ 'error'; /** last attempt failed; see `error` */
/** Why the connection dropped, when it did. */
type CdpDisconnectReason = 'user' | 'socket' | 'params-changed' | 'shutdown';
/** One CDP target as `/json/list` reports it. */
interface CdpTargetInfo {
  /** Target id (hex string from Chrome). */
  id: string;
  /** Target type: page, background_page, service_worker, … */
  type: string;
  /** Page title or worker name. */
  title: string;
  /** Page URL. */
  url: string;
  /** True when the target can receive commands over its own session. */
  attachable: boolean;
}
/** Complete connection snapshot; every field JSON-safe for the wire. */
interface CdpStatus {
  /** Current lifecycle phase. */
  phase: CdpConnectionPhase;
  /** Connection parameters in force for the current/last attempt. */
  host: string;
  /** Port of the same attempt. */
  port: number;
  /** Whether the Host retries automatically when the socket drops. */
  autoReconnect: boolean;
  /** Human-readable failure of the last attempt; present only in `error`. */
  error: string | null;
  /** Reason the previous connection ended, if one existed. */
  lastDisconnect: CdpDisconnectReason | null;
  /** WebSocket debugger URL Chrome advertised, when connected. */
  webSocketDebuggerUrl: string | null;
  /** Chrome version from `/json/version`, when connected. */
  browserVersion: string | null;
  /** Attachable page targets, refreshed on connect and on demand. */
  targets: readonly CdpTargetInfo[];
  /** ISO timestamp of the moment the current connection was established. */
  connectedAt: string | null;
  /** Monotonic counter of connect attempts, for cheap change detection. */
  attempts: number;
}
/** Connection parameters the panel edits (also the settings section shape). */
interface CdpParams {
  /** CDP endpoint host. */
  host: string;
  /** CDP endpoint port. */
  port: number;
  /** Retry automatically when the socket drops. */
  autoReconnect: boolean;
  /** Seconds between reconnect attempts; 0 disables retry. */
  reconnectDelaySeconds: number;
}
/** Reply of `setParams`: what the Host did with the submitted values. */
interface CdpSetParamsResult {
  /** Values the Host accepted and now uses. */
  params: CdpParams;
  /** A reconnect was started because live params changed. */
  reconnected: boolean;
}
//#endregion
//#region src/cdp-connection.d.ts
/** Minimal structural type for a connected CRI client. */
interface CdpClientShape {
  webSocketUrl?: string;
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  on(event: string, listener: (params: never, sessionId?: string) => void, sessionId?: string): unknown;
  off(event: string, listener: (params: never, sessionId?: string) => void): unknown;
  close(callback?: () => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
}
/**
 * The `chromeCdp` service: one managed CDP connection plus its RPC face.
 */
declare class ChromeCdpService extends Service {
  /** The RPC channel service is required; settings wiring stays optional. */
  static inject: string[];
  private params;
  private client;
  private status;
  private connectInFlight;
  private reconnectTimer;
  private readonly listeners;
  private closed;
  constructor(ctx: Context, entryConfig?: Partial<CdpParams>);
  /** @returns the current JSON-safe status snapshot. */
  getSnapshot(): CdpStatus;
  /** Observe status replacements. @returns the unsubscriber. */
  subscribe(listener: () => void): () => void;
  /** @returns the connection parameters currently in force. */
  currentParams(): CdpParams;
  /**
   * The live CRI client for tools dispatch, when connected.
   * Exposed raw: the tools layer owns its own session/event bookkeeping.
   */
  rawClient(): CdpClientShape | undefined;
  /**
   * Adopt new parameters (from the settings section or the panel), optionally
   * reconnecting when the live endpoint changed.
   * @param next - fields to replace; omitted fields keep their value.
   * @param reconnect - close and reopen when endpoint params changed.
   * @returns accepted params and whether a reconnect was started.
   */
  setParams(next: Partial<CdpParams>, reconnect: boolean): CdpSetParamsResult;
  /**
   * Open (or replace) the CDP connection.
   * @returns whether the connection is up when the attempt settles.
   */
  connect(): Promise<boolean>;
  /**
   * Close the connection (or cancel a pending attempt) on purpose.
   * @param reason - who asked for the close.
   */
  disconnect(reason?: CdpDisconnectReason): void;
  /** @returns attachable targets as the endpoint currently reports them. */
  targets(): Promise<readonly CdpTargetInfo[]>;
  /** Refresh and publish the target list; a dead endpoint reports empty. */
  private refreshTargets;
  /** One connect attempt; never throws — failures publish as `error`. */
  private attempt;
  /** Start managing a freshly connected client. */
  private adopt;
  /** Read `/json/version` and publish the browser product string. */
  private readBrowserVersion;
  /** Socket-level drop: flip to error and maybe retry. */
  private onSocketClosed;
  /** Queue the next automatic attempt when retries are enabled. */
  private scheduleReconnect;
  /** Drop any queued automatic attempt. */
  private cancelReconnect;
  /** Final teardown used by plugin unload. */
  shutdown(reason: CdpDisconnectReason): void;
  /** Merge a patch into the published status and notify observers. */
  private publish;
}
//#endregion
//#region src/index.d.ts
/** Host Connection RPC registry, provided by `@deepseek-ai/dsh-client-connection`. */
interface HostConnectionRpcHandle {
  handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{
    ok: true;
    value: unknown;
  } | {
    ok: false;
    error: {
      code: string;
      message: string;
    };
  }>, options: {
    authority: 'trusted-host' | 'loopback';
  }): () => Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generic RPC channel registry from the client-connection host plugin. */
    connection: {
      rpc: HostConnectionRpcHandle;
    };
  }
}
/** Settings namespace owned by this plugin. */
declare const CHROME_CDP_SETTINGS_NAMESPACE: SettingsNamespace;
/** Connection params schema, used both as plugin Config and settings section. */
declare const CdpParamsSchema: z<Schemastery.ObjectS<{
  host: z<string, string>;
  port: z<number, number>;
  autoReconnect: z<boolean, boolean>;
  reconnectDelaySeconds: z<number, number>;
}>, Schemastery.ObjectT<{
  host: z<string, string>;
  port: z<number, number>;
  autoReconnect: z<boolean, boolean>;
  reconnectDelaySeconds: z<number, number>;
}>>;
/** Host services this plugin requires (the RPC channel registry). */
declare const inject: string[];
/** Plugin entry: starts the service and its RPC/settings faces. */
declare function apply(ctx: Context, config: CdpParams): void;
//#endregion
export { CHROME_CDP_SETTINGS_NAMESPACE, type CdpParams, CdpParamsSchema, type CdpStatus, ChromeCdpService, apply, inject };
//# sourceMappingURL=index.d.ts.map