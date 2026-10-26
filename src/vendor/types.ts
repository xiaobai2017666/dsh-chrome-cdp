/**
 * Local type mirrors of the harness tool contracts the vendored schema layer
 * references. Compile-time only (erased at build); shapes mirror
 * `@deepseek-ai/dsh-tools` src/index.ts + `@deepseek-ai/dsh-llm` types at
 * 0.2.1-rc. The plugin registers its definitions through the runtime's own
 * `ctx.tools.register()`, so structural compatibility is what matters.
 */

import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'

/** Registry-assigned execution identity. */
export interface ToolExecutionInput {
  readonly callId: ToolCallId
  readonly signal: AbortSignal
}

/** One accepted tool execution. */
export interface ToolExecution extends ToolExecutionInput {
  readonly rootCallId: ToolCallId
  readonly token: object
}

/** The canonical result handed to content finalizers. */
export interface ToolExecutionResult {
  readonly value: unknown
  readonly isError: boolean
}

/** The context handle `execute()` receives. */
export interface ToolRunContext extends ToolExecution {
  readonly [key: string]: unknown
}

/** Final model-facing result of one tool call. */
export interface ToolResult {
  content: ContentBlock[]
  isError: boolean
  value?: unknown
}

/** A registry-ready tool definition (structural mirror; extra properties
 * such as `name`/`description`/`parameters` ride on the index signature). */
export interface ToolDefinition {
  readonly output: {
    schema: unknown
    render(args: unknown, value: unknown): ContentBlock[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  readonly [key: string]: unknown
  timeoutMs?: number
  deferLoading?: boolean
  execute?(args: unknown, exec: ToolRunContext): Promise<unknown>
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: unknown): unknown
  isConcurrencySafe?(args: unknown): boolean
}

/** Display-only projection of one call. */
export type ToolCallView = unknown

/** Display-only projection of one result. */
export type ToolResultView = unknown
