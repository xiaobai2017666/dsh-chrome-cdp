/**
 * Chrome CDP panel: sidebar footer trigger + anchored popover surface.
 *
 * The trigger lives in `sidebar.footer.action` and opens a fixed-position
 * popover (the sidebar clips overflow, so the surface is anchored by measured
 * offset, the same approach as the in-repo Cordis panel). It shows connection
 * status, connection parameters form, targets list, and connect/disconnect/
 * reconnect actions. All data flows through the injected face's hooks; the
 * component never touches the client context directly.
 *
 * @module dsh-chrome-cdp/client/CdpPanel
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { StateDot, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { CdpStatusState } from './stores.ts'
import type { CdpLocaleKey } from './locales.ts'
import type { CdpParams, CdpStatus } from '../types.ts'
import css from './CdpPanel.module.css'

/** The face this component receives through the slots runtime. */
export interface CdpPanelFace {
  readonly hooks: {
    /** Polled host status. */
    readonly status: SnapshotStore<CdpStatusState>
  }
  /** Ask the host to connect now. */
  readonly onConnect: () => Promise<{ ok: boolean; message?: string }>
  /** Ask the host to disconnect now. */
  readonly onDisconnect: () => Promise<{ ok: boolean; message?: string }>
  /** Ask the host to reconnect now (disconnect + connect). */
  readonly onReconnect: () => Promise<{ ok: boolean; message?: string }>
  /**
   * Panel action: detect a CDP endpoint and, when it is not answering, launch
   * a Chrome with a CDP port. Default mode leaves a running Chrome untouched
   * (a separate isolated instance is launched); pass { closeRunning: true }
   * to terminate the running browser first (the panel confirms before that).
   */
  readonly onEnsureChrome: (options?: { closeRunning?: boolean }) => Promise<{ ok: boolean; message?: string }>
  /** Submit edited params; host reconnects when the endpoint changed. */
  readonly onSetParams: (params: CdpParams) => Promise<{ ok: boolean; message?: string }>
  /** Refresh the targets list on the host side. */
  readonly onRefreshTargets: () => Promise<{ ok: boolean; message?: string }>
}

/** Full panel props composed by the sidebar footer-action slot. */
export type CdpPanelProps =
  & PropsRuntime<'sidebar.footer.action'>
  & InjectFace<CdpPanelFace>
  & PropsLocale<'chrome-cdp'>

/** Map the wire phase onto the StateDot four-color semantic. */
function dotStateOf(status: CdpStatus | undefined, rpcError: string | undefined): StateDotState {
  if (rpcError !== undefined) return 'error'
  switch (status?.phase) {
    case 'connected': return 'done'
    case 'connecting': return 'ongoing'
    case 'error': return 'error'
    case 'disconnected': return 'warning'
    default: return 'warning'
  }
}

/** Locale key for the current phase. */
function statusKeyOf(status: CdpStatus | undefined): CdpLocaleKey {
  switch (status?.phase) {
    case 'connected': return 'status.connected'
    case 'connecting': return 'status.connecting'
    case 'error': return 'status.error'
    case 'disconnected': return 'status.disconnected'
    default: return 'status.unknown'
  }
}

/** Form state for the params editor, seeded from the latest status. */
interface ParamsForm {
  readonly host: string
  readonly port: string
  readonly autoReconnect: boolean
  readonly reconnectDelaySeconds: string
}

function formOf(status: CdpStatus | undefined, params: CdpParams | undefined): ParamsForm {
  const host = status?.host ?? params?.host ?? '127.0.0.1'
  const port = status?.port ?? params?.port ?? 9222
  const autoReconnect = status?.autoReconnect ?? params?.autoReconnect ?? true
  const delay = params?.reconnectDelaySeconds ?? 5
  return {
    host,
    port: String(port),
    autoReconnect,
    reconnectDelaySeconds: String(delay),
  }
}

/** Parse the form into params; undefined when a numeric field is invalid. */
function parseForm(form: ParamsForm): CdpParams | undefined {
  const port = Number.parseInt(form.port, 10)
  const delay = Number.parseInt(form.reconnectDelaySeconds, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (!Number.isInteger(delay) || delay < 1 || delay > 600) return undefined
  if (form.host.trim() === '') return undefined
  return {
    host: form.host.trim(),
    port,
    autoReconnect: form.autoReconnect,
    reconnectDelaySeconds: delay,
  }
}

/** Render the panel and its sidebar footer trigger. */
export function CdpPanel({
  wide, useStatus, onConnect, onDisconnect, onReconnect, onEnsureChrome, onSetParams, onRefreshTargets, t,
}: CdpPanelProps) {
  const state = useStatus(snapshot => snapshot)
  const status = state.status
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [closeRunning, setCloseRunning] = useState(false)
  const [form, setForm] = useState<ParamsForm>(() => formOf(undefined, undefined))
  const rootRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>()

  // Seed the form once real status lands; keep user edits afterwards.
  const seeded = useRef(false)
  useEffect(() => {
    if (status === undefined || seeded.current) return
    seeded.current = true
    setForm(formOf(status, undefined))
  }, [status])

  // The panel is position: fixed (the sidebar clips overflow), so it hugs the
  // trigger through a measured offset instead of document flow.
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect !== undefined) {
        setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
      }
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  const dot = dotStateOf(status, state.rpcError)
  const statusLabel = state.rpcError !== undefined
    ? t('status.error')
    : t(statusKeyOf(status))

  // One generic action runner: busy flag, error surface, no re-entry.
  const runAction = async (id: string, action: () => Promise<{ ok: boolean; message?: string }>): Promise<void> => {
    if (busy !== undefined) return
    setBusy(id)
    setActionError(undefined)
    try {
      const result = await action()
      if (!result.ok) setActionError(result.message ?? 'operation failed')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  const parsed = parseForm(form)
  const formDirty = status !== undefined
    && (form.host.trim() !== status.host
      || Number.parseInt(form.port, 10) !== status.port
      || form.autoReconnect !== status.autoReconnect)

  return (
    <div ref={rootRef} className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && anchor !== undefined && (
        <section
          className={css.panel}
          style={anchor}
          data-cdp-panel
          aria-label={t('panel.title')}
        >
          <header className={css.header}>
            <span className={css.title}>{t('panel.title')}</span>
            <span className={css.statusChip} data-phase={status?.phase ?? 'unknown'}>
              <StateDot state={dot} />
              {statusLabel}
            </span>
          </header>
          <div className={css.body}>
            {state.rpcError !== undefined && (
              <p className={css.note} role="alert">{t('panel.rpcFailed', { message: state.rpcError })}</p>
            )}
            {state.rpcError === undefined && status === undefined && (
              <p className={css.note}>{t('panel.loading')}</p>
            )}
            {status !== undefined && (
              <>
                <dl className={css.facts}>
                  <div><dt>{t('info.browser')}</dt><dd>{status.browserVersion ?? '—'}</dd></div>
                  <div><dt>{t('info.targets')}</dt><dd>{String(status.targets.length)}</dd></div>
                  <div><dt>{t('info.attempts')}</dt><dd>{String(status.attempts)}</dd></div>
                  {status.connectedAt !== undefined && status.connectedAt !== null && (
                    <div><dt>{t('info.connectedAt')}</dt><dd>{new Date(status.connectedAt).toLocaleTimeString()}</dd></div>
                  )}
                </dl>
                {status.error !== null && (
                  <p className={css.error} role="alert">{t('error.label', { message: status.error })}</p>
                )}
                {status.targets.length > 0 && (
                  <section className={css.targets}>
                    <div className={css.targetsHead}>
                      <h3>{t('info.targets')}</h3>
                      <button
                        type="button"
                        className={css.linkButton}
                        disabled={busy !== undefined}
                        onClick={() => { void runAction('targets', onRefreshTargets) }}
                      >{t('targets.refresh')}</button>
                    </div>
                    <ul>
                      {status.targets.slice(0, 8).map(target => (
                        <li key={target.id} className={css.target} title={target.url}>
                          <span className={css.targetType}>{target.type}</span>
                          <span className={css.targetTitle}>{target.title || target.url}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <form
                  className={css.form}
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (parsed === undefined) return
                    void runAction('save', async () => {
                      const result = await onSetParams(parsed)
                      if (result.ok) {
                        setSaved(true)
                        window.setTimeout(() => { setSaved(false) }, 2000)
                      }
                      return result
                    })
                  }}
                >
                  <h3 className={css.formTitle}>{t('form.title')}</h3>
                  <label className={css.field}>
                    <span>{t('form.host')}</span>
                    <input
                      value={form.host}
                      spellCheck={false}
                      onChange={(event) => { setForm({ ...form, host: event.target.value }) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span>{t('form.port')}</span>
                    <input
                      value={form.port}
                      inputMode="numeric"
                      onChange={(event) => { setForm({ ...form, port: event.target.value }) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span>{t('form.reconnectDelay')}</span>
                    <input
                      value={form.reconnectDelaySeconds}
                      inputMode="numeric"
                      onChange={(event) => { setForm({ ...form, reconnectDelaySeconds: event.target.value }) }}
                    />
                  </label>
                  <label className={css.check}>
                    <input
                      type="checkbox"
                      checked={form.autoReconnect}
                      onChange={(event) => { setForm({ ...form, autoReconnect: event.target.checked }) }}
                    />
                    <span>{t('form.autoReconnect')}</span>
                  </label>
                  <div className={css.formActions}>
                    <button
                      type="submit"
                      className={css.primary}
                      disabled={parsed === undefined || busy !== undefined}
                    >{saved ? t('form.saved') : t('form.save')}</button>
                  </div>
                  {parsed === undefined && (
                    <p className={css.fieldError} role="alert">{t('panel.badPayload')}</p>
                  )}
                </form>
                <div className={css.actions}>
                  {status.phase === 'connected' ? (
                    <button
                      type="button"
                      className={css.primary}
                      disabled={busy !== undefined}
                      onClick={() => { void runAction('reconnect', onReconnect) }}
                    >{t('action.reconnect')}</button>
                  ) : (
                    <button
                      type="button"
                      className={css.primary}
                      disabled={busy !== undefined || status.phase === 'connecting'}
                      onClick={() => { void runAction('connect', onConnect) }}
                    >{t('action.connect')}</button>
                  )}
                  <button
                    type="button"
                    className={css.secondary}
                    disabled={busy !== undefined || status.phase === 'disconnected'}
                    onClick={() => { void runAction('disconnect', onDisconnect) }}
                  >{t('action.disconnect')}</button>
                </div>
                <div className={css.ensureGroup}>
                  <button
                    type="button"
                    className={css.primary}
                    disabled={busy !== undefined || status.phase === 'connected'}
                    title={t('action.ensureHint')}
                    onClick={() => {
                      // Default mode is non-destructive (a separate instance
                      // is launched); only closeRunning mode kills the user's
                      // browser and needs confirmation.
                      if (closeRunning && !window.confirm(t('action.ensureConfirm'))) return
                      void runAction('ensure', () => onEnsureChrome(closeRunning ? { closeRunning: true } : undefined))
                    }}
                  >{t('action.ensure')}</button>
                  <label className={css.ensureClose} title={t('action.ensureHint')}>
                    <input
                      type="checkbox"
                      checked={closeRunning}
                      onChange={(event) => { setCloseRunning(event.target.checked) }}
                    />
                    <span>{t('action.ensureCloseLabel')}</span>
                  </label>
                </div>
                {actionError !== undefined && (
                  <p className={css.error} role="alert">{t('action.error', { message: actionError })}</p>
                )}
              </>
            )}
          </div>
        </section>
      )}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          data-active={open || undefined}
          aria-label={t('panel.trigger')}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.triggerDot} data-state={dot}>
            <StateDot state={dot} size={wide ? 10 : 12} />
          </span>
          {wide && <span className={css.badgeLabel}>{t('panel.trigger')}</span>}
          {wide && <span className={css.badgeCount}>{statusLabel}</span>}
        </button>
      </div>
    </div>
  )
}

/** Overlay dot face: a persistent status pill in shell.overlay. */
export interface CdpOverlayFace {
  readonly hooks: {
    readonly status: SnapshotStore<CdpStatusState>
  }
}

export type CdpOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<CdpOverlayFace>
  & PropsLocale<'chrome-cdp'>

/** Persistent bottom-right status pill (click toggles nothing; display only). */
export function CdpOverlay({ useStatus, t }: CdpOverlayProps) {
  const state = useStatus(snapshot => snapshot)
  const dot = dotStateOf(state.status, state.rpcError)
  const label = state.rpcError !== undefined
    ? t('status.error')
    : t(statusKeyOf(state.status))
  return (
    <span className={css.overlay} data-cdp-overlay aria-label={t('overlay.label')}>
      <StateDot state={dot} />
      <span className={css.overlayLabel}>{label}</span>
    </span>
  )
}

/** Small helper re-exported for tests. */
export function cdpStatusChipLabel(status: CdpStatus | undefined, rpcError: string | undefined): ReactNode {
  return rpcError !== undefined ? 'error' : (status?.phase ?? 'unknown')
}
