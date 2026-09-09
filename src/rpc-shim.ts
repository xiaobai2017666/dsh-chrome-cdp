/**
 * Call-site compatibility shim for `connection.rpc.handle()`.
 *
 * Why this exists: `HostConnectionService.get rpc()` resolves `webServer`
 * from a context derived from the **connection service's own** fiber
 * (`const owner = this.ctx` in `rpc-host.ts`), not from the calling
 * plugin's fiber. cordis refuses to resolve a sibling fiber's service, so
 * when the `client-connection` build's own `inject` predates the upstream
 * `['webServer', 'credentials']` fix, the first
 * `connection.rpc.handle()` call fails synchronously with
 * `cannot get property "webServer" without inject` — no caller-side
 * `inject` declaration can prevent it.
 *
 * What this shim does, entirely from the plugin side:
 *
 * 1. Healthy path first — `ctx.rpc.handle(...)`, the exact call form used
 *    before the shim, so on a fixed harness registration ownership and
 *    disposal semantics are byte-for-byte unchanged.
 * 2. Fallback, engaged only when that exact cordis diagnostic surfaces:
 *    call the same `register(owner, channel, handler)` prototype method
 *    the getter delegates to, passing `owner` = this plugin's context with
 *    `webServer` overlaid as an own property. The plugin already declares
 *    `webServer` in its `inject`, so the overlay read always succeeds;
 *    `owner.effect(...)` and everything else resolve on this plugin's
 *    fiber, so route lifetime matches the healthy path's.
 *
 * The fallback self-disarms on a fixed harness (path 1 simply succeeds)
 * and never masks any other error.
 */

/** Symbol cordis uses to expose the value behind traceable proxies. */
const ORIGINAL = Symbol.for('cordis.original')

/** The exact cordis diagnostics the fallback tolerates — nothing else. */
const INJECT_ERRORS = [
  'cannot get property "webServer" without inject',
  'cannot get required service "webServer" in inactive context',
]

/** Handler shape accepted by `connection.rpc.handle()`. */
export type RpcHandlerLike = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>

/** Options accepted by `connection.rpc.handle()`. */
export interface RpcOptions {
  authority: 'trusted-host' | 'loopback'
}

/** The `connection.rpc` registry surface used by the healthy path. */
export interface RpcChannel {
  handle(channel: string, handler: RpcHandlerLike, options: RpcOptions): () => Promise<void>
}

/** Minimal structural view of this plugin's context for the shim. */
export interface ShimContext {
  /** The host Connection service (injected by this plugin). */
  readonly connection: { readonly rpc: RpcChannel }
  /** The host web server (injected by this plugin). */
  readonly webServer: unknown
  /** Register a labeled effect on this plugin's fiber. */
  effect(execute: () => unknown, label?: string): unknown
}

/** Runtime shape of `HostConnectionService` used by the fallback path. */
interface RegisterableService {
  register(owner: object, channel: string, handler: RpcHandlerLike): () => Promise<void>
}

/**
 * Register `channel` on the host Connection registry, tolerating harness
 * builds whose `rpc` getter cannot resolve `webServer`.
 *
 * @param ctx - this plugin's context; must inject `connection` and
 *   `webServer` (the overlay in the fallback path reads `webServer` here).
 * @param channel - absolute RPC channel to register, e.g. `/cdp`.
 * @param handler - endpoint handler for the channel.
 * @param options - authority options forwarded to `rpc.handle()`.
 * @returns disposer removing the channel, same contract as `rpc.handle()`.
 */
export function handleRpcChannel(
  ctx: ShimContext,
  channel: string,
  handler: RpcHandlerLike,
  options: RpcOptions,
): () => Promise<void> {
  // Healthy path — identical to the pre-shim call form, including the
  // registration-ownership semantics of the mixin accessor.
  try {
    return ctx.connection.rpc.handle(channel, handler, options)
  } catch (error) {
    if (!isInjectError(error)) throw error
  }

  // Fallback: reach the raw service behind any traceable proxy layers and
  // invoke the public `register()` prototype method directly.
  const service = peelOriginal(ctx.connection) as Partial<RegisterableService> | null
  if (!isObject(service) || typeof service.register !== 'function') {
    throw new Error(
      `dsh-chrome-cdp: cannot register ${channel}: connection.rpc is unavailable `
      + `(${INJECT_ERRORS[0]}) and the connection service exposes no register()`,
    )
  }
  const webServer = ctx.webServer
  if (webServer === undefined || webServer === null) {
    throw new Error(
      `dsh-chrome-cdp: cannot register ${channel}: webServer is not resolvable from this plugin's context`
      + ` (add "webServer" to the plugin's inject)`,
    )
  }
  return service.register(makeOwner(ctx, webServer), channel, handler)
}

/**
 * Build the fallback `owner`: this plugin's context with `webServer`
 * overlaid as an own property. Reads of `owner.webServer` are served by
 * the overlay directly — cordis resolution (which cannot walk sideways
 * into the webServer sibling fiber) never runs for that key. Every other
 * read (`effect`, `fiber`, `logger`, …) goes through the real context, so
 * the route's registration effect — and therefore its disposal lifetime —
 * behaves exactly like the healthy path's.
 */
function makeOwner(base: ShimContext, webServer: unknown): object {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === 'webServer') return webServer
      const value = Reflect.get(base, prop)
      return typeof value === 'function' ? value.bind(base) : value
    },
    has(_target, prop) {
      return prop === 'webServer' || Reflect.has(base, prop)
    },
  })
}

/** Match — and only match — the known cordis inject diagnostics. */
function isInjectError(error: unknown): boolean {
  return error instanceof Error && INJECT_ERRORS.includes(error.message)
}

/** Peel traceable-proxy layers (bounded) to reach the raw service object. */
function peelOriginal(value: unknown): unknown {
  let current = value
  for (let depth = 0; depth < 4 && isObject(current); depth++) {
    // Probe with `has` — never with a property read: reading an unknown
    // property through a cordis traceable proxy can itself throw the very
    // inject error we are recovering from.
    if (!Reflect.has(current, ORIGINAL)) return current
    const inner = current[ORIGINAL]
    if (inner === undefined || inner === null) return current
    current = inner
  }
  return current
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
}
