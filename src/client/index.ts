/**
 * Chrome CDP panel — browser entry.
 *
 * One polled status store backs two surfaces: the sidebar footer panel
 * (trigger + popover with status, params form, targets, actions) and the
 * persistent shell.overlay status pill. Faces are exposed through slot
 * registrations; the components never touch the client context directly.
 *
 * @module dsh-chrome-cdp/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { CdpOverlay, CdpPanel } from './CdpPanel.tsx'
import type { CdpOverlayFace, CdpPanelFace } from './CdpPanel.tsx'
import { CDP_LOCALES } from './locales.ts'
import { createCdpStatusStore, runtimeOf } from './stores.ts'
import type { CdpEnsureResult, CdpParams } from '../types.ts'

/** Locale namespace this plugin owns. */
const NS = 'chrome-cdp'

/** Shared busy/error outcome for panel actions. */
type ActionOutcome = { ok: boolean; message?: string }

/** Shape of the setParams reply used by the client action wrapper. */
interface CdpSetParamsLike {
  params: CdpParams
  reconnected: boolean
}

/** Client services this plugin consumes (cordis fiber inject). */
export const inject = ['connection', 'locale', 'slots']

/** How often the idle poll re-checks host status. */
const POLL_INTERVAL_MS = 2000

export function apply(ctx: ClientContext): void {
  ctx.locale.register(NS, {
    en: CDP_LOCALES.en,
    zh: CDP_LOCALES.zh,
  })

  const runtime = runtimeOf(ctx)
  const { store, refresh } = createCdpStatusStore(runtime)
  const t = ctx.locale.bind(NS)

  // Initial read plus steady polling; connection resets re-read immediately.
  void refresh()
  const poll = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
  ctx.effect(() => () => { clearInterval(poll) }, 'chrome-cdp: status poll timer')
  ctx.on('connection/reset', () => { void refresh() })

  /** Run an RPC action, mapping the envelope into the panel outcome. */
  const runAction = async (
    endpoint: string,
    payload?: unknown,
    pick?: (value: never) => ActionOutcome,
  ): Promise<ActionOutcome> => {
    const result = await runtime.call(endpoint, payload)
    if (!result.ok) return { ok: false, message: result.error }
    // The /cdp channel encodes every failure inside the ok:true value as
    // { error } (the client envelope schema whitelists error codes, so the
    // host must never answer ok:false with a custom code).
    const value = result.value as { error?: string } | undefined
    if (value !== undefined && typeof value.error === 'string') {
      return { ok: false, message: value.error }
    }
    if (pick !== undefined) return pick(result.value as never)
    return { ok: true }
  }

  const face: CdpPanelFace & CdpOverlayFace = {
    hooks: { status: store },
    onConnect: async () => runAction('connect'),
    onDisconnect: async () => {
      const outcome = await runAction('disconnect')
      void refresh()
      return outcome
    },
    onReconnect: async () => {
      await runtime.call('disconnect')
      return runAction('connect')
    },
    onEnsureChrome: async (options?: { closeRunning?: boolean }) => runAction('ensure', options ?? undefined, (raw) => {
      const value = raw as unknown as CdpEnsureResult
      if (!value.endpointReady) {
        return { ok: false, message: value.error ?? value.hint ?? 'endpoint did not become ready' }
      }
      const key = value.action === 'none'
        ? 'action.ensureNone'
        : value.action === 'started'
          ? (value.existingUntouched ? 'action.ensureStartedUntouched' : 'action.ensureStarted')
          : 'action.ensureRestarted'
      return { ok: true, message: t(key) }
    }),
    onSetParams: async (params: CdpParams) => runAction('setParams', params),
    onRefreshTargets: async () => {
      const outcome = await runAction('targets')
      void refresh()
      return outcome
    },
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'chrome-cdp-panel',
    order: 15,
    locale: NS,
    inject: (): CdpPanelFace => face,
  }, CdpPanel))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'chrome-cdp-overlay',
    order: 90,
    locale: NS,
    inject: (): CdpOverlayFace => ({ hooks: { status: store } }),
  }, CdpOverlay))
}
