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

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { ChromeCdpService } from './cdp-connection.ts'
import { ensureChromeInstance } from './chrome-launcher.ts'
import { provisionAgentPreset } from './preset-provision.ts'
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
    /** Attachment store; optionality is owned by the Service Definition. */
    attachments: import('@deepseek-ai/dsh-attachment').AttachmentStore
  }
}

/** Settings namespace owned by this plugin (a plain lowercase identifier). */
export const CHROME_CDP_SETTINGS_NAMESPACE = 'chrome-cdp'

/** Connection params schema, used both as plugin Config and settings section. */
export const CdpParamsSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).step(1).default(9222),
  autoReconnect: z.boolean().default(true),
  reconnectDelaySeconds: z.number().min(1).max(600).step(1).default(5),
}) as z<CdpParams>

/** Live status vocabulary for the panel. */
export type { CdpStatus, CdpParams } from './types.ts'
export { ChromeCdpService }

/** Host services this plugin requires (the RPC channel registry). */
export const inject = ['connection']

/** Plugin entry: starts the service and its RPC/settings faces. */
export function apply(ctx: Context, config: CdpParams): void {
  const service = new ChromeCdpService(ctx, config)
  /** The settings provider while one is mounted (undefined otherwise). */
  const providerRef: { current: SettingsProvider | undefined } = { current: undefined }

  // Agent-preset provisioning: keep `~/.dsh/.agent-presets/chrome-cdp-tools`
  // current with this install (first boot copies it, later boots re-pin the
  // tools row; user-authored presets are left alone). Never fails the boot.
  provisionAgentPreset(ctx, thisPluginVersion())

  // Settings wiring is optional: while a settings service is mounted, the
  // user document's `chrome-cdp` section resolves over the composition base
  // and adopts into the live service without an immediate reconnect — a
  // settings save never tears down a working connection. Losing the settings
  // service falls back to the composed entry config (the provider contract's
  // `installSection` owns that attach/detach lifecycle).
  ctx.inject(['settings'], (sctx) => {
    providerRef.current = sctx.settings
    sctx.settings.installSection(ctx, CHROME_CDP_SETTINGS_NAMESPACE, CdpParamsSchema, config, {
      setSource: (current) => { service.setParams(current()) },
      onChange: () => { /* covered by setSource: params already adopted */ },
    })
    return () => { providerRef.current = undefined }
  })

  /** Persist params into the user settings document. */
  const persistParams = async (params: CdpParams): Promise<void> => {
    const provider = providerRef.current
    if (provider === undefined) throw new Error('settings service not available')
    await provider.update(CHROME_CDP_SETTINGS_NAMESPACE, {
      host: params.host,
      port: params.port,
      autoReconnect: params.autoReconnect,
      reconnectDelaySeconds: params.reconnectDelaySeconds,
    })
  }

  // Tools bridge: expose the connection to the preset-fiber tools half
  // through the module singleton (same Node module registry in-process).
  registerHostBridge(createServiceBridge(service, ctx))

  ctx.effect(() => ctx.connection.rpc.handle(
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
  persistParams: (params: CdpParams) => Promise<void>,
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
    case 'setParams':
      return { ok: true, value: await service.setParamsAndPersist(readParamsPayload(payload), persistParams) }
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
