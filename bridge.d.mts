/**
 * Type declarations for the runtime singleton in ./bridge.mjs — the .mjs file
 * is what both build outputs import (as an external); this ambient module
 * declaration gives TypeScript sources the typed surface.
 *
 * The `current` slot is structurally typed: the host fiber stores its bridge
 * (see src/tools/dispatch.ts HostBridge), the preset fiber reads it.
 */

declare module 'dsh-chrome-cdp/bridge' {
  /** Structural shape stored by the host fiber (HostBridge). */
  interface BridgeSlot {
    current: unknown
  }
  /** The process-wide bridge slot. */
  export const hostBridge: BridgeSlot
  /** Register a bridge (host fiber). Last registration wins. */
  export function registerHostBridge(bridge: unknown): void
}

declare module './bridge.mjs' {
  export const hostBridge: { current: unknown }
  export function registerHostBridge(bridge: unknown): void
}
