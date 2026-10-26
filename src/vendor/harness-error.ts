/**
 * Vendored copy of `@deepseek-ai/dsh-llm`'s error base (`src/error.ts`, the
 * `HarnessError` class only) so the tool-definition layer below is
 * self-contained: the plugin must not depend on the harness's `dsh-tools`
 * package (its dependency pins resolve a different rc than the runtime's,
 * which shadow-matches against the runtime copy and gets the tools row
 * denied by the compatibility gate).
 *
 * `instanceof` compatibility: the runtime's `ToolRuntime` catches
 * `ToolArgsError` by contract, not by identity — any error carrying
 * `code`/`name` behaves the same. `Object.setPrototypeOf` keeps
 * `error instanceof HarnessError` (the vendored one) working through the
 * ES5-class extends chain.
 */

/** Base class for all harness-style errors: stable `code` + `cause` chain. */
export class HarnessError extends Error {
  /** Stable machine-routable failure class (e.g. `TOOL_ARGS`); route on this, never by parsing `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
