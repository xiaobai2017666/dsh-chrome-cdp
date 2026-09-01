/**
 * Client stores: one polled observable over the `/cdp` RPC channel.
 *
 * The Host pushes nothing (custom host→client events are not forwarded to
 * out-of-tree plugins), so the panel polls `status` on an interval, after
 * every action, and on `connection/reset`. A generation counter discards
 * stale replies that arrive after a newer refresh started.
 *
 * @module dsh-chrome-cdp/client/stores
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CdpStatus } from '../types.ts'

/** Unwrapped RPC outcome as the stores consume it. */
export type CdpCallResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** What the panel needs from the runtime to reach the Host. */
export interface CdpPanelRuntime {
  /** Bound RPC caller for the `/cdp` channel, envelope already unwrapped. */
  call: <T>(endpoint: string, payload?: unknown) => Promise<CdpCallResult<T>>
  /** Notified whenever the underlying connection to the Host resets. */
  onReset: (listener: () => void) => () => void
}

/** Internal view state of the status store. */
export interface CdpStatusState {
  /** Latest Host snapshot; undefined until the first reply lands. */
  readonly status: CdpStatus | undefined
  /** Set when the last RPC itself failed (host down, channel gone). */
  readonly rpcError: string | undefined
  /** Bumped on every accepted refresh; actions compare against it. */
  readonly generation: number
}

const INITIAL_STATUS_STATE: CdpStatusState = {
  status: undefined,
  rpcError: undefined,
  generation: 0,
}

/**
 * The polled status store backing both the sidebar panel and the overlay dot.
 * @param runtime - RPC caller plus reset signal.
 * @returns the snapshot store and its `refresh` action.
 */
export function createCdpStatusStore(runtime: CdpPanelRuntime): {
  store: SnapshotStore<CdpStatusState>
  refresh: () => Promise<void>
} {
  const store = createSnapshotStore(INITIAL_STATUS_STATE)
  let generation = 0
  let inFlight: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight
    const mine = ++generation
    inFlight = (async () => {
      const result = await runtime.call<CdpStatus>('status')
      if (mine !== generation) return
      if (result.ok) {
        if (isCdpStatus(result.value)) {
          store.set({ status: result.value, rpcError: undefined, generation: mine })
        } else {
          store.set({ status: undefined, rpcError: 'unexpected status payload', generation: mine })
        }
      } else {
        store.set({ status: undefined, rpcError: result.error, generation: mine })
      }
      inFlight = undefined
    })().catch(() => {
      // transport-level failure is surfaced through rpcError on next poll
      if (mine === generation) inFlight = undefined
    })
    return inFlight
  }
  return { store, refresh }
}

/** Structural check for a Host status reply. */
function isCdpStatus(value: unknown): value is CdpStatus {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return typeof raw.phase === 'string'
    && typeof raw.host === 'string'
    && typeof raw.port === 'number'
    && Array.isArray(raw.targets)
}

/** Extract the runtime handle from a client context in one call site. */
export function runtimeOf(ctx: ClientContext): CdpPanelRuntime {
  const connection = ctx.get('connection')
  return {
    call: async <T>(endpoint: string, payload?: unknown): Promise<CdpCallResult<T>> => {
      const result = await connection.rpc.call('/cdp', endpoint, payload ?? null)
      return result.ok ? { ok: true, value: result.value as T } : { ok: false, error: result.error.message }
    },
    onReset: (listener) => ctx.on('connection/reset', listener),
  }
}
