import z from "@deepseek-ai/schemastery";
import { Context, Volatile } from "@deepseek-ai/cordis";
import { PeerScope } from "@deepseek-ai/dsh-typert-protocol";
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
type CdpDisconnectReason = 'user' | 'socket' | 'shutdown';
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
//#endregion
//#region src/index.d.ts
/** Result of one `/cdp` RPC endpoint invocation, wire-ready. */
type CdpRpcResult = {
  ok: true;
  value: unknown;
} | {
  ok: false;
  error: {
    code: string;
    message: string;
    details: object;
  };
};
/** Handler shape accepted by `connection.rpc.handle()` (dsh ≥ 0.2.1-rc). */
type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => Promise<CdpRpcResult>;
/** Host Connection RPC registry, provided by `@deepseek-ai/dsh-client-connection`. */
interface HostConnectionRpcHandle {
  handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generic RPC channel registry from the client-connection host plugin. */
    connection: {
      rpc: HostConnectionRpcHandle;
    };
    /** Host web server (`dsh-host-webserver`); opaque to this plugin —
     * the shim hands it to `webServer.register()` unchanged. */
    webServer: {
      register(route: unknown): () => Promise<void>;
    };
    /** Attachment store; optionality is owned by the Service Definition. */
    attachments: import('@deepseek-ai/dsh-attachment').AttachmentStore;
    /** Schema-derived configuration forms (dsh ≥ 0.2.1-rc SettingsForms). */
    settings: import('@deepseek-ai/dsh-settings').SettingsForms;
  }
}
/** Settings namespace owned by this plugin (the loader entry id). */
declare const CHROME_CDP_SETTINGS_NAMESPACE = "chrome-cdp";
/** Connection params schema; every field is volatile (live-editable). */
declare const Config: z<CdpParamsConfig>;
/** Resolved plugin config as `apply()` receives it: volatile references. */
interface CdpParamsConfig {
  /** CDP endpoint host. */
  host: Volatile<string>;
  /** CDP endpoint port. */
  port: Volatile<number>;
  /** Retry automatically when the socket drops. */
  autoReconnect: Volatile<boolean>;
  /** Seconds between reconnect attempts. */
  reconnectDelaySeconds: Volatile<number>;
}
/** Back-compat alias for external consumers of the old name. */
declare const CdpParamsSchema: z<CdpParamsConfig>;
/** Host services this plugin requires: the RPC channel registry, the web
 * server, and the settings forms. Registering the `/cdp` channel routes
 * HTTP traffic through the web server; the fallback path in `rpc-shim.ts`
 * serves the `webServer` read from this plugin's own context; panel saves
 * go through `settings.update()`. `settings` rides on the same profile
 * availability as the web half (both are disabled outside a profile), so
 * requiring it here cannot strand a headless boot. */
declare const inject: string[];
/** Plugin entry: starts the service and its RPC/settings faces. */
declare function apply(ctx: Context, config: CdpParamsConfig): void;
//#endregion
export { CHROME_CDP_SETTINGS_NAMESPACE, type CdpParams, CdpParamsConfig, CdpParamsSchema, type CdpStatus, Config, ConnectionRpcHandler, apply, inject };
//# sourceMappingURL=index.d.ts.map