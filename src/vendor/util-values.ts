/**
 * Vendored shims for the two runtime helpers the vendored schema layer uses
 * from `@deepseek-ai/dsh-util-values` (`assertNever`, `isJsonValue`) and the
 * `JsonValue` type. Local copies; the harness packages are not dependencies
 * of this plugin (see harness-error.ts for why).
 */

/** JSON value as the harness models it (deeply readonly-friendly shape). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Exhaustiveness helper for never-typed values. */
export function assertNever(value: never, context?: string): never {
  const suffix = context === undefined ? '' : ` (${context})`
  throw new Error(`Unhandled case${suffix}: ${JSON.stringify(value)}`)
}

/** Runtime check mirroring the harness's structural JSON-value predicate. */
export function isJsonValue(value: unknown): boolean {
  switch (typeof value) {
    case 'string': case 'number': case 'boolean': return true
    case 'object': {
      if (value === null) return true
      if (Array.isArray(value)) return value.every(isJsonValue)
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return false
      return Object.values(value).every(isJsonValue)
    }
    default: return false
  }
}
