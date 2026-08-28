/**
 * The host-tree fiber registers its connection bridge here; the preset-fiber
 * tools half reads it at tool-execute time. UNBUNDLED on purpose: both build
 * outputs (lib/index.js and lib/tools.mjs) import it as an external so the
 * singleton is ONE module instance per process, whichever fiber loaded which
 * entry. Keep this file dependency-free plain JavaScript.
 */

/** The process-wide bridge slot (set by the host fiber at plugin load). */
export const hostBridge = { current: undefined }

/** Register a bridge (host fiber). Last registration wins. */
export function registerHostBridge(bridge) {
  hostBridge.current = bridge
}
