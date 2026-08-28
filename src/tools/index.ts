/**
 * Tools entry: registers the 11 chrome_* tools on the fiber that loads this
 * module, bridging to the host-tree connection through a module singleton.
 *
 * Two loading modes:
 *
 * 1. **Preset fiber** (the normal mode): `~/.dsh/.agent-presets/<name>/`
 *    mounts `dsh-chrome-cdp/tools`; `apply` registers the tools. The CDP
 *    connection lives in the HOST tree; the bridge singleton (registered by
 *    the host fiber from `lib/index.js`) is the same module instance because
 *    both fibers share the Node module registry.
 *
 * 2. **Host fiber** (fallback): when loaded by the host tree (e.g. someone
 *    adds a `tools.enable: true` config to the host row), it only verifies
 *    the bridge is registered — registration happens through the same code
 *    path but against the host's own tools registry.
 *
 * @module dsh-chrome-cdp/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TOOL_SPECS } from './schema.ts'
import type { ParamSpec } from './schema.ts'
import { ToolDispatcher } from './dispatch.ts'
import * as bridgeModule from 'dsh-chrome-cdp/bridge'
import type { HostBridge } from './dispatch.ts'

/** Config for the tools half, authored in the preset row. */
export interface ToolsConfig {
  /** Group gates; defaults all true. */
  groups?: {
    navigation?: boolean
    diagnostics?: boolean
    debug?: boolean
    interaction?: boolean
    raw?: boolean
  }
}

/** Services the tools fiber requires. */
export const inject = ['tools']

// ── module-singleton bridge ─────────────────────────────────────────────────

// The bridge singleton lives in the unbundled package-root bridge module so
// lib/index.js (host fiber) and lib/tools.mjs (preset fiber) share ONE
// instance per process. Re-exported for convenience.
export { hostBridge, registerHostBridge } from 'dsh-chrome-cdp/bridge'

// Execution layer re-exports (probe/integration entry points).
export { ToolDispatcher } from './dispatch.ts'

// ── spec → defineTool ───────────────────────────────────────────────────────

/** Convert one ParamSpec tree into the dsh-tools value-schema DSL object. */
function specToParameters(specs: Record<string, ParamSpec>): Record<string, never> {
  // The DSL validates shape at runtime; the cast keeps author-side ergonomics.
  return specs as unknown as Record<string, never>
}

/** Build the ToolDefinition for one spec. */
function buildTool(spec: (typeof TOOL_SPECS)[number]): ToolDefinition {
  // The dsh-tools DSL generics are erased at runtime; one cast keeps the
  // author-side spec tree readable while the registry sees its expected shape.
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: specToParameters(spec.parameters),
    output: {
      schema: spec.output.schema as never,
      render: (args: unknown, value: unknown) => spec.output.render(args, value),
    },
    execute: async (args: unknown): Promise<unknown> => {
      const bridge = bridgeModule.hostBridge.current
      if (bridge === undefined) {
        return { error: 'chrome-cdp host half not loaded', hint: 'ensure the dsh-chrome-cdp row is enabled in the host tree' }
      }
      const dispatcher = ensureDispatcher(bridge)
      return await dispatcher.dispatch(spec.name, args)
    },
  } as never) as ToolDefinition
}

/** One dispatcher per bridge identity; rebuilt when the host re-registers. */
let dispatcherFor: { bridge: HostBridge; dispatcher: ToolDispatcher } | undefined

function ensureDispatcher(bridge: HostBridge): ToolDispatcher {
  if (dispatcherFor !== undefined && dispatcherFor.bridge === bridge) return dispatcherFor.dispatcher
  const dispatcher = new ToolDispatcher(bridge)
  dispatcherFor = { bridge, dispatcher }
  return dispatcher
}

// ── entry ───────────────────────────────────────────────────────────────────

/** Tools plugin entry: register every non-gated tool on this fiber. */
export function apply(ctx: Context, config: ToolsConfig = {}): void {
  const groups: Record<string, boolean | undefined> = config.groups ?? {}
  const gate = (group: string): boolean => groups[group] !== false
  for (const spec of TOOL_SPECS) {
    if (!gate(spec.group)) continue
    ctx.effect(() => {
      const dispose = ctx.tools.register(buildTool(spec))
      return () => { dispose() }
    }, `chrome-cdp tools: ${spec.name}`)
  }
}
