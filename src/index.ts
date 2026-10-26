/**
 * Chrome CDP connection panel — Host entry.
 *
 * Wires three concerns together on one fiber:
 *
 * 1. the {@link ChromeCdpService} owning the chrome-remote-interface client;
 * 2. the `/cdp` RPC channel serving the browser panel: `status`, `targets`,
 *    `connect`, `disconnect`, `setParams`;
 * 3. the volatile `Config` schema whose fields surface in the settings UI;
 *    panel saves go through `ctx.settings.update()`, the loader commits the
 *    validated values into the running fiber's volatile references, and the
 *    service reads its effective parameters through those references — a
 *    save never remounts the fiber, so a working connection survives.
 *
 * The plugin injects `connection`, `webServer`, and `settings`: the RPC
 * channel rides on the connection/web-server pair, and panel saves persist
 * through the settings forms service.
 *
 * @module dsh-chrome-cdp
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { ChromeCdpService } from './cdp-connection.ts'
import { ensureChromeInstance } from './chrome-launcher.ts'
import { provisionAgentPreset } from './preset-provision.ts'
import { handleRpcChannel } from './rpc-shim.ts'
import { registerHostBridge } from 'dsh-chrome-cdp/bridge'
import type { HostBridge } from './tools/dispatch.ts'
import type { CdpParams, CdpStatus } from './types.ts'

/** Result of one `/cdp` RPC endpoint invocation, wire-ready. */
type CdpRpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }

/** Handler shape accepted by `connection.rpc.handle()` (dsh ≥ 0.2.1-rc). */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: PeerScope,
) => Promise<CdpRpcResult>

/** Host Connection RPC registry, provided by `@deepseek-ai/dsh-client-connection`. */
interface HostConnectionRpcHandle {
  handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generic RPC channel registry from the client-connection host plugin. */
    connection: { rpc: HostConnectionRpcHandle }
    /** Host web server (`dsh-host-webserver`); opaque to this plugin —
     * the shim hands it to `webServer.register()` unchanged. */
    webServer: { register(route: unknown): () => Promise<void> }
    /** Attachment store; optionality is owned by the Service Definition. */
    attachments: import('@deepseek-ai/dsh-attachment').AttachmentStore
    /** Schema-derived configuration forms (dsh ≥ 0.2.1-rc SettingsForms). */
    settings: import('@deepseek-ai/dsh-settings').SettingsForms
  }
}

/** Settings namespace owned by this plugin (the loader entry id). */
export const CHROME_CDP_SETTINGS_NAMESPACE = 'chrome-cdp'

/** Connection params schema; every field is volatile (live-editable). */
export const Config = z.object({
  host: z.string().default('127.0.0.1').volatile(),
  port: z.number().min(1).max(65535).step(1).default(9222).volatile(),
  autoReconnect: z.boolean().default(true).volatile(),
  reconnectDelaySeconds: z.number().min(1).max(600).step(1).default(5).volatile(),
}) as z<CdpParamsConfig>

/** Resolved plugin config as `apply()` receives it: volatile references. */
export interface CdpParamsConfig {
  /** CDP endpoint host. */
  host: Volatile<string>
  /** CDP endpoint port. */
  port: Volatile<number>
  /** Retry automatically when the socket drops. */
  autoReconnect: Volatile<boolean>
  /** Seconds between reconnect attempts. */
  reconnectDelaySeconds: Volatile<number>
}

/** Back-compat alias for external consumers of the old name. */
export const CdpParamsSchema = Config

/** Live status vocabulary for the panel. */
export type { CdpStatus, CdpParams } from './types.ts'
/** Host services this plugin requires: the RPC channel registry, the web
 * server, and the settings forms. Registering the `/cdp` channel routes
 * HTTP traffic through the web server; the fallback path in `rpc-shim.ts`
 * serves the `webServer` read from this plugin's own context; panel saves
 * go through `settings.update()`. `settings` rides on the same profile
 * availability as the web half (both are disabled outside a profile), so
 * requiring it here cannot strand a headless boot. */
export const inject = ['connection', 'webServer', 'settings']

/** Plugin entry: starts the service and its RPC/settings faces. */
export function apply(ctx: Context, config: CdpParamsConfig): void {
  // The volatile references stay stable for the fiber's lifetime and the
  // loader commits settings-save values into them in place (no remount, no
  // dropped socket); the service therefore reads its effective parameters
  // through these references, so an adopted value is visible to reconnects.
  const readParams = (): CdpParams => ({
    host: config.host.get(),
    port: config.port.get(),
    autoReconnect: config.autoReconnect.get(),
    reconnectDelaySeconds: config.reconnectDelaySeconds.get(),
  })
  const service = new ChromeCdpService(ctx, readParams)

  // Agent-preset provisioning: keep `~/.dsh/.agent-presets/chrome-cdp-tools`
  // current with this install (first boot copies it, later boots re-pin the
  // tools row; user-authored presets are left alone). Never fails the boot.
  provisionAgentPreset(ctx, thisPluginVersion())

  /** Persist params into the user settings document (profile patch). */
  const persistParams = async (params: CdpParams): Promise<void> => {
    await ctx.settings.update(CHROME_CDP_SETTINGS_NAMESPACE, {
      host: params.host,
      port: params.port,
      autoReconnect: params.autoReconnect,
      reconnectDelaySeconds: params.reconnectDelaySeconds,
    })
  }

  // Tools bridge: expose the connection to the preset-fiber tools half
  // through the module singleton (same Node module registry in-process).
  registerHostBridge(createServiceBridge(service, ctx))

  // `/cdp` RPC channel. handleRpcChannel() tries the plain
  // `connection.rpc.handle()` path first; on harness builds whose
  // client-connection predates the upstream `webServer` inject fix it
  // falls back to a caller-side owner overlay so the channel still
  // registers (see rpc-shim.ts for the full rationale).
  ctx.effect(() => handleRpcChannel(
    ctx,
    '/cdp',
    async (endpoint, payload) => {
      try {
        return await dispatchCdpRpc(service, endpoint, payload, persistParams)
      } catch (error) {
        // Never answer ok:false on this channel: the client response-envelope
        // schema whitelists error codes, and a custom code fails its zod
        // union (surfacing as an invalid_union tree in the panel). Failures
        // travel inside the ok:true value as { error } and the panel's face
        // wrappers map them onto action outcomes.
        ctx.logger.warn(`chrome-cdp: rpc ${endpoint} failed: ${messageOf(error)}`)
        return { ok: true as const, value: { error: messageOf(error) } }
      }
    },
  ), 'chrome-cdp: /cdp rpc channel')
}

/** Bridge the service + attachments service into the tools dispatcher. */
function createServiceBridge(service: ChromeCdpService, ctx: Context): HostBridge {
  return {
    getStatus: () => service.getSnapshot(),
    getClient: () => {
      const status = service.getSnapshot()
      if (status.phase !== 'connected') return undefined
      return service.rawClient()
    },
    listTargets: () => service.targets(),
    attachmentsAvailable: () => ctx.attachments !== undefined,
    persistImage: async (data, mediaType) => {
      const attachments = ctx.attachments
      if (attachments === undefined) return undefined
      const [ref] = await attachments.saveImages([{ data, mediaType: mediaType as 'image/png' }])
      return ref === undefined ? undefined : {
        attachmentId: ref.attachmentId as string,
        width: ref.width as number,
        height: ref.height as number,
      }
    },
  }
}

/** Route one RPC endpoint invocation onto the service. */
async function dispatchCdpRpc(
  service: ChromeCdpService,
  endpoint: string,
  payload: unknown,
  persistParams: (params: CdpParams) => Promise<void>,
): Promise<CdpRpcResult> {
  switch (endpoint) {
    case 'status':
      return { ok: true, value: service.getSnapshot() }
    case 'targets':
      return { ok: true, value: await service.targets() }
    case 'connect': {
      const up = await service.connect()
      return { ok: true, value: up }
    }
    case 'ensure': {
      // Panel action: probe the endpoint, launch Chrome with CDP flags when
      // it does not answer, then connect. By default a running Chrome is
      // LEFT UNTOUCHED (the isolated user-data-dir makes the new instance a
      // separate process); only when the client asks closeRunning=true is the
      // running browser terminated first, which the panel confirms.
      const snapshot = service.getSnapshot()
      const closeRunning = readEnsurePayload(payload)
      const result = await ensureChromeInstance(snapshot.host, snapshot.port, { closeRunning })
      if (result.endpointReady) await service.connect()
      return { ok: true, value: result }
    }
    case 'disconnect':
      service.disconnect('user')
      return { ok: true, value: service.getSnapshot() }
    case 'setParams': {
      // Adopt locally first (the panel hears "applied"), then persist. The
      // settings write re-parses the profile patch and the loader commits
      // the validated values into the volatile refs — the refs then agree
      // with the adopted values, so a later `readParams()` matches.
      const accepted = await service.setParamsAndPersist(readParamsPayload(payload), persistParams)
      return { ok: true, value: accepted }
    }
    default:
      // The client's response-envelope schema whitelists error codes; a
      // custom code here would fail its zod union and surface as an
      // unreadable invalid_union tree in the panel. Encode unknown endpoints
      // into the ok:true value instead — the panel's runAction reads
      // message from structured results.
      return { ok: true, value: { error: `unknown endpoint ${endpoint}` } }
  }
}

/** Narrow an untrusted payload into params fields without throwing. */
function readParamsPayload(payload: unknown): Partial<CdpParams> {
  if (typeof payload !== 'object' || payload === null) return {}
  const raw = payload as Record<string, unknown>
  const out: Partial<CdpParams> = {}
  if (typeof raw.host === 'string') out.host = raw.host
  if (typeof raw.port === 'number') out.port = raw.port
  if (typeof raw.autoReconnect === 'boolean') out.autoReconnect = raw.autoReconnect
  if (typeof raw.reconnectDelaySeconds === 'number') out.reconnectDelaySeconds = raw.reconnectDelaySeconds
  return out
}

/** Narrow an untrusted `ensure` payload into the closeRunning flag. */
function readEnsurePayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const raw = payload as Record<string, unknown>
  return raw.closeRunning === true
}

/** Best-effort human message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** This package's manifest version (resolved from the installed package root). */
function thisPluginVersion(): string {
  try {
    const root = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'))['version'] as string
  } catch {
    return '0.0.0'
  }
}
