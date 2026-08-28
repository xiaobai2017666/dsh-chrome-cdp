/**
 * Chrome CDP connection panel — Host entry.
 *
 * Wires three concerns together on one fiber:
 *
 * 1. the {@link ChromeCdpService} owning the chrome-remote-interface client;
 * 2. the `/cdp` RPC channel (trusted-host authority) serving the browser
 *    panel: `status`, `targets`, `connect`, `disconnect`, `setParams`;
 * 3. a settings section (`chrome-cdp` namespace) persisting the connection
 *    parameters into the user settings document, with a commit path back
 *    into the live connection (endpoint change ⇒ reconnect).
 *
 * The plugin injects only `connection`; the settings wiring is optional —
 * `installSettingsSection` degrades gracefully when no settings service is
 * mounted, and the entry config keeps working as the composed base.
 *
 * @module dsh-chrome-cdp
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import { ChromeCdpService } from './cdp-connection.ts'
import { ensureChromeInstance } from './chrome-launcher.ts'
import { registerHostBridge } from 'dsh-chrome-cdp/bridge'
import type { HostBridge } from './tools/dispatch.ts'
import type { CdpParams, CdpStatus } from './types.ts'

/** Host Connection RPC registry, provided by `@deepseek-ai/dsh-client-connection`. */
interface HostConnectionRpcHandle {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>,
    options: { authority: 'trusted-host' | 'loopback' },
  ): () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generic RPC channel registry from the client-connection host plugin. */
    connection: { rpc: HostConnectionRpcHandle }
  }
}

/** Settings namespace owned by this plugin. */
export const CHROME_CDP_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('chrome-cdp')

/** Connection params schema, used both as plugin Config and settings section. */
export const CdpParamsSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).step(1).default(9222),
  autoReconnect: z.boolean().default(true),
  reconnectDelaySeconds: z.number().min(1).max(600).step(1).default(5),
})

/** Live status vocabulary for the panel. */
export type { CdpStatus, CdpParams } from './types.ts'
export { ChromeCdpService }

/** Host services this plugin requires (the RPC channel registry). */
export const inject = ['connection']

/** Plugin entry: starts the service and its RPC/settings faces. */
export function apply(ctx: Context, config: CdpParams): void {
  const service = new ChromeCdpService(ctx, config)
  installSettingsSection(ctx, CHROME_CDP_SETTINGS_NAMESPACE, CdpParamsSchema, config, {
    // Settings commits adopt resolved params without an immediate reconnect;
    // the live endpoint keeps serving until the panel asks to reconnect. This
    // avoids a settings-document save tearing down a working connection.
    setSource: (current) => { service.setParams(current(), false) },
    onChange: () => { /* covered by setSource: params already adopted */ },
  })

  // Tools bridge: expose the connection to the preset-fiber tools half
  // through the module singleton (same Node module registry in-process).
  registerHostBridge(createServiceBridge(service, ctx))

  ctx.effect(() => ctx.connection.rpc.handle(
    '/cdp',
    async (endpoint, payload) => {
      try {
        return await dispatchCdpRpc(service, endpoint, payload)
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
    { authority: 'trusted-host' },
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
): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }> {
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
      // Panel action: probe the endpoint, (re)start Chrome with CDP flags
      // when it does not answer, then connect. Killing the user's Chrome is
      // a side effect the panel confirms before calling here.
      const snapshot = service.getSnapshot()
      const result = await ensureChromeInstance(snapshot.host, snapshot.port)
      if (result.endpointReady) await service.connect()
      return { ok: true, value: result }
    }
    case 'disconnect':
      service.disconnect('user')
      return { ok: true, value: service.getSnapshot() }
    case 'setParams':
      return { ok: true, value: service.setParams(readParamsPayload(payload), true) }
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

/** Best-effort human message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
