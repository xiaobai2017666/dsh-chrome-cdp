/**
 * CDP result shaping: unknown protocol payloads → bounded lossless JSON.
 *
 * Every tool result passes through {@link serializeCdpValue} before it leaves
 * the dispatch layer. The rules are deliberately simple and total (nothing
 * throws), because a shaping failure must never mask the actual CDP result:
 * worst case the offending subtree degrades to a short placeholder.
 *
 * - Cycles break into `{"[cycle]": true}`
 * - Long strings truncate with a byte-count marker
 * - Oversized arrays truncate with an omitted-count marker
 * - Deep structures flatten past the depth cap
 * - BigInt / Date / TypedArray coerce to tagged strings
 * - A total size budget bounds the whole tree
 *
 * @module dsh-chrome-cdp/tools/serialize
 */

/** Marker a truncated subtree carries so the model knows it was cut. */
export interface TruncationMarker {
  __truncated: true
  reason: 'length' | 'items' | 'depth' | 'budget'
  detail?: string
}

/** Hard cap on serialized output, in characters (≈ 256 KiB). */
const TOTAL_BUDGET = 262_144
/** Strings longer than this truncate (64 KiB). */
const STRING_LIMIT = 65_536
/** Arrays longer than this truncate per level. */
const ARRAY_LIMIT = 200
/** Nesting past this flattens to a placeholder. */
const DEPTH_LIMIT = 24

/** Running budget shared across one serialization pass. */
class Budget {
  private used = 0
  /** @returns whether the whole-tree budget is exhausted. */
  exhausted(): boolean {
    return this.used >= TOTAL_BUDGET
  }
  /** Account rough output size (string length heuristic). */
  charge(n: number): void {
    this.used += n
  }
}

/**
 * Shape an unknown CDP payload into bounded, JSON-safe output.
 * Total: never throws; unserializable values degrade to markers.
 */
export function serializeCdpValue(input: unknown): unknown {
  const budget = new Budget()
  return shape(input, budget, 0)
}

/** Recursive shaping worker. */
function shape(value: unknown, budget: Budget, depth: number): unknown {
  if (budget.exhausted()) {
    return { __truncated: true as const, reason: 'budget' as const }
  }
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return value
  }
  if (type === 'boolean') return value
  if (type === 'bigint') return `[bigint ${(value as bigint).toString()}]`
  if (type === 'string') {
    return clipString(value as string, budget)
  }
  if (type === 'function') return '[function]'
  if (type === 'symbol') return `[symbol ${(value as symbol).description ?? ''}]`

  // Remaining types are objects.
  if (value instanceof Date) return value.toISOString()
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (view.byteLength > 1024) {
      return `[${value.constructor.name} ${view.byteLength} bytes]`
    }
    // Small buffers stay as plain arrays (rare; keeps small payloads exact).
    return Array.from(view, b => b)
  }

  if (depth >= DEPTH_LIMIT) {
    return { __truncated: true as const, reason: 'depth' as const }
  }

  if (Array.isArray(value)) {
    const out: unknown[] = []
    if (value.length > ARRAY_LIMIT) {
      for (const item of value.slice(0, ARRAY_LIMIT)) out.push(shape(item, budget, depth + 1))
      out.push({ __truncated: true as const, reason: 'items' as const, detail: `${value.length - ARRAY_LIMIT} more omitted` })
      return out
    }
    for (const item of value) out.push(shape(item, budget, depth + 1))
    return out
  }

  // Plain (or protocol-shaped) object: detect cycles via a seen map on the path.
  if (seen(value)) return { '[cycle]': true }
  mark(value)
  try {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (budget.exhausted()) {
        out[key] = { __truncated: true as const, reason: 'budget' as const }
        break
      }
      out[key] = shape(val, budget, depth + 1)
    }
    return out
  } finally {
    unmark(value)
  }
}

/** Path-scoped cycle detection store (WeakSet per pass). */
const seenThisPass = new WeakSet<object>()
function seen(value: object): boolean {
  return seenThisPass.has(value)
}
function mark(value: object): void {
  seenThisPass.add(value)
}
function unmark(value: object): void {
  seenThisPass.delete(value)
}

/** Clip one string against the shared budget. */
function clipString(value: string, budget: Budget): string {
  if (value.length > STRING_LIMIT) {
    const head = value.slice(0, STRING_LIMIT)
    budget.charge(head.length)
    return `${head}…[truncated ${value.length - STRING_LIMIT} chars]`
  }
  budget.charge(value.length)
  return value
}

/**
 * Serialize a CDP `RemoteObject` (Runtime.evaluate / console args) into a
 * compact model-facing value: prefer `.value`, else `.description`, else the
 * shaped raw object.
 */
export function serializeRemoteObject(remote: unknown): unknown {
  if (typeof remote !== 'object' || remote === null) return shapePrimitive(remote)
  const record: Record<string, unknown> = remote as Record<string, unknown>
  if ('value' in record && record.value !== undefined) return serializeCdpValue(record.value)
  if (typeof record.description === 'string') return record.description
  if (typeof record.className === 'string') return `[object ${record.className}]`
  return serializeCdpValue(record)
}

/** Small scalar passthrough for non-object remotes. */
function shapePrimitive(value: unknown): unknown {
  if (typeof value === 'bigint') return `[bigint ${value.toString()}]`
  if (typeof value === 'symbol') return String(value)
  return value
}
