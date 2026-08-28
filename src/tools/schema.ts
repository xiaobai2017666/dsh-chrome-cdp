/**
 * Tool schemas: the 11 model-facing tool definitions (parameters + output).
 *
 * Pure data: schemas + render functions only, no behavior — the preset fiber
 * and any host-side registration consume the same definitions.
 *
 * @module dsh-chrome-cdp/tools/schema
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Author-facing parameter spec (dsh-tools value schema DSL). */
export interface ParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  items?: ParamSpec
  properties?: Record<string, ParamSpec>
  additionalProperties?: boolean
  enum?: readonly string[]
  default?: unknown
}

/** A tool definition skeleton the registering fiber turns into a ToolDefinition. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, ParamSpec>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  /** Tool group for config gating; also the concurrency bucket. */
  group: 'navigation' | 'diagnostics' | 'debug' | 'interaction' | 'raw'
}

/** Render helper: JSON text block. */
function asText(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

// ── JSON Schema helpers (output schemas) ────────────────────────────────────

function obj(props: Record<string, unknown>): Record<string, unknown> {
  // Every tool may fail into { error, hint }; declaring them keeps the
  // additionalProperties:false gate from rejecting structured failures.
  const merged: Record<string, unknown> = {
    error: { type: 'string' },
    hint: { type: 'string' },
    ...props,
  }
  return { type: 'object', properties: merged, additionalProperties: false }
}
function arr(items: Record<string, unknown>): Record<string, unknown> {
  return { type: 'array', items }
}
const str = { type: 'string' }
const int = { type: 'integer' }
const bool = { type: 'boolean' }
const nullableStr = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const nullableNum = { oneOf: [{ type: 'number' }, { type: 'null' }] }
const looseObj = { type: 'object', additionalProperties: true }

const TARGET_PARAM: ParamSpec = {
  type: 'string',
  description: 'Target id from chrome_list_targets; defaults to the active page.',
}

/** The 11 tool specs, grouped. */
export const TOOL_SPECS: readonly ToolSpec[] = [

  // ── navigation group ──────────────────────────────────────────────────────
  {
    name: 'chrome_list_targets',
    description: 'List Chrome targets (tabs/windows/workers) reachable over CDP. Start here to find the targetId of the page you want to operate on; every other tool accepts that targetId.',
    parameters: {},
    group: 'navigation',
    output: {
      schema: obj({
        targets: arr(obj({
          id: str, type: str, title: str, url: str, isDefault: bool, paused: bool,
        })),
      }),
      render: (_a, v) => asText(v),
    },
  },
  {
    name: 'chrome_navigate',
    description: 'Navigate a Chrome page to a URL. Waits for the frame to commit and the load event to fire (bounded wait). Default target: the active page.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL to navigate to.' },
      waitMs: { type: 'integer', description: 'Load-event wait budget in ms (default 10000).' },
      ...targetParam(),
    },
    group: 'navigation',
    output: {
      schema: obj({
        frameId: str,
        loaderId: nullableStr,
        errorText: nullableStr,
        loaded: bool,
      }),
      render: (_a, v) => asText(v),
    },
  },
  {
    name: 'chrome_evaluate',
    description: 'Evaluate JavaScript in a Chrome page and return the result. Supports awaited promises. While the target is paused at a breakpoint, this tool is blocked — use chrome_debug eval instead.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate.' },
      awaitPromise: { type: 'boolean', description: 'Await a returned Promise (default true).' },
      ...targetParam(),
    },
    group: 'navigation',
    output: {
      schema: obj({
        type: str,
        value: { type: 'json' },
        className: nullableStr,
        exceptionDetails: nullableStr,
      }),
      render: (_a, v) => asText(v),
    },
  },

  // ── diagnostics group ─────────────────────────────────────────────────────
  {
    name: 'chrome_console',
    description: 'Read console messages captured from a Chrome page (console.* and browser-level Log entries), newest last, with cursor-based pagination.',
    parameters: {
      level: { type: 'string', enum: ['log', 'info', 'warning', 'error', 'debug'], description: 'Filter by level.' },
      text: { type: 'string', description: 'Filter by substring (case-insensitive).' },
      cursor: { type: 'integer', description: 'Resume after this seq (from nextCursor of a previous call).' },
      limit: { type: 'integer', description: 'Max entries (default 50, cap 300).' },
      ...targetParam(),
    },
    group: 'diagnostics',
    output: {
      schema: obj({
        entries: arr(obj({
          seq: int, time: str, level: str, text: str,
          url: nullableStr, line: nullableNum, targetId: str,
        })),
        nextCursor: int,
      }),
      render: (_a, v) => asText(v),
    },
  },
  {
    name: 'chrome_network',
    description: 'Read network requests captured from a Chrome page: lifecycle events merged per request (status, size, duration, redirects, errors), cursor-paginated. Use chrome_cdp with Network.getResponseBody + requestId to fetch a response body.',
    parameters: {
      url: { type: 'string', description: 'Filter by URL substring (case-insensitive).' },
      resourceType: { type: 'string', description: 'Filter by resource type (document, xhr, fetch, script, stylesheet, image, ...).' },
      minStatus: { type: 'integer', description: 'Filter: status >= this (e.g. 400 for failures).' },
      cursor: { type: 'integer', description: 'Resume after this seq.' },
      limit: { type: 'integer', description: 'Max records (default 50, cap 500).' },
      ...targetParam(),
    },
    group: 'diagnostics',
    output: {
      schema: obj({
        requests: arr(obj({
          seq: int, requestId: str, targetId: str, url: str, method: str,
          resourceType: nullableStr, status: nullableNum, statusText: nullableStr, mimeType: nullableStr,
          size: nullableNum, durationMs: nullableNum, fromCache: bool, redirectCount: int, errorText: nullableStr, startedAt: str,
        })),
        nextCursor: int,
      }),
      render: (_a, v) => asText(v),
    },
  },

  // ── debug group ───────────────────────────────────────────────────────────
  {
    name: 'chrome_debug',
    description: 'Control the Debugger on a Chrome page: pause/resume/step, and evaluate expressions on the paused call frames (inspect locals). While paused, chrome_evaluate is blocked — use this tool\'s eval action.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'pause', 'resume', 'step_into', 'step_over', 'step_out', 'eval'],
        description: 'Debugger control action.',
      },
      expression: { type: 'string', description: 'eval action: expression evaluated on the call frame.' },
      frame: { type: 'integer', description: 'eval action: call-frame index (default 0 = topmost).' },
      ...targetParam(),
    },
    group: 'debug',
    output: {
      schema: looseObj,
      render: (_a, v) => asText(v),
    },
  },
  {
    name: 'chrome_breakpoint',
    description: 'Manage breakpoints on a Chrome page: set by URL+line (optional condition), list, remove, and list parsed scripts to locate lines.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['set', 'list', 'remove', 'scripts'],
        description: 'Breakpoint management action.',
      },
      url: { type: 'string', description: 'set: script URL or substring to match.' },
      line: { type: 'integer', description: 'set: 0-based line number.' },
      column: { type: 'integer', description: 'set: 0-based column (optional).' },
      condition: { type: 'string', description: 'set: break only when this expression is truthy.' },
      id: { type: 'string', description: 'remove: breakpointId from list.' },
      ...targetParam(),
    },
    group: 'debug',
    output: {
      schema: looseObj,
      render: (_a, v) => asText(v),
    },
  },

  // ── interaction group ─────────────────────────────────────────────────────
  {
    name: 'chrome_screenshot',
    description: 'Capture a screenshot of a Chrome page. With persist=true the image is stored as a durable attachment visible to multimodal models; otherwise the base64 payload is returned inline (bounded).',
    parameters: {
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png).' },
      quality: { type: 'integer', description: 'jpeg quality 0-100 (default 80).' },
      persist: { type: 'boolean', description: 'Store as attachment (default true when the attachments service is available).' },
      ...targetParam(),
    },
    group: 'interaction',
    output: {
      schema: looseObj,
      render: (_a, v) => asText(v),
    },
  },
  {
    name: 'chrome_click',
    description: 'Click an element in a Chrome page: by CSS selector, or at viewport coordinates. Uses trusted input dispatch (not synthetic DOM events).',
    parameters: {
      selector: { type: 'string', description: 'CSS selector of the element to click.' },
      x: { type: 'integer', description: 'Viewport x coordinate (alternative to selector).' },
      y: { type: 'integer', description: 'Viewport y coordinate (alternative to selector).' },
      ...targetParam(),
    },
    group: 'interaction',
    output: {
      schema: looseObj,
      render: (_a, v) => asText(v),
    },
  },
  {
    name: 'chrome_type',
    description: 'Type text into a focused element in a Chrome page. For non-ASCII text (e.g. Chinese) use chrome_evaluate to set the value instead.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type (ASCII + common control keys).' },
      selector: { type: 'string', description: 'CSS selector to focus first; skips focus when omitted.' },
      ...targetParam(),
    },
    group: 'interaction',
    output: {
      schema: looseObj,
      render: (_a, v) => asText(v),
    },
  },

  // ── raw group ─────────────────────────────────────────────────────────────
  {
    name: 'chrome_cdp',
    description: 'Send any raw CDP command (Domain.method) over the connection. Escape hatch for everything not wrapped by a dedicated tool: Network.getResponseBody, Debugger.getScriptSource, Emulation, CSS, Fetch, Storage...',
    parameters: {
      method: { type: 'string', required: true, description: 'CDP method, e.g. "Network.getResponseBody".' },
      params: { type: 'json', description: 'CDP command params object.' },
      sessionId: { type: 'string', description: 'Explicit flat session id (advanced; usually use targetId).' },
      ...targetParam(),
    },
    group: 'raw',
    output: {
      schema: looseObj,
      render: (_a, v) => asText(v),
    },
  },
]

/** Spread helper keeping the targetId param declaration DRY. */
function targetParam(): { targetId: ParamSpec } {
  return { targetId: TARGET_PARAM }
}
