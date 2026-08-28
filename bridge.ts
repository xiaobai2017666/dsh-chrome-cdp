/**
 * Typed facade over the runtime singleton in ./bridge.mjs — the .mjs file is
 * what both build outputs import (as an external); this module exists so
 * TypeScript sources get the same typed surface.
 *
 * @module dsh-chrome-cdp/bridge
 */

export { hostBridge, registerHostBridge } from './bridge.mjs'
