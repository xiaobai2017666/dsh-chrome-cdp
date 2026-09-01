/**
 * tsdown config: the Host half (Node ESM under lib/) and the browser client
 * bundle (CJS factory under client/).
 *
 * The Host half keeps production dependencies (chrome-remote-interface) and
 * @deepseek-ai/* peers external — they resolve from the DSH profile install.
 *
 * The client bundle reproduces the DSH contract out-of-tree (the in-repo
 * preset is unpublished): a CJS factory handed to window.__ModuleLoader__.load,
 * with the platform baseline (react, cordis, ui-slots, ui-primitives,
 * dsh-client-runtime/client) staying require() externals and everything else
 * inlined. CSS Modules compile through lightningcss into an injected
 * <style data-plugin-css> tag plus a hashed class-map default export.
 */

import { readFile } from 'node:fs/promises'
import { resolve as resolvePath, dirname } from 'node:path'
import type { Plugin, UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** This package's name; stamped into the loader handoff and style tags. */
const PLUGIN_ID = 'dsh-chrome-cdp'

/** Module-table baseline every DSH web client bundle may require(). */
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/** The bridge singleton must never be bundled into either output. */
const isBridge = (specifier: string): boolean =>
  specifier === 'dsh-chrome-cdp/bridge'
  || specifier.endsWith('/bridge.mjs') || specifier.endsWith('/bridge.ts')

/** Host-half externals: production deps, @deepseek-ai peers, the bridge. */
const HOST_EXTERNALS = (specifier: string): boolean =>
  specifier === 'chrome-remote-interface'
  || specifier.startsWith('@deepseek-ai/')
  || isBridge(specifier)


/** Host half: Node ESM library. */
const hostConfig: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: { sourceEntry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  deps: {
    neverBundle: HOST_EXTERNALS,
    alwaysBundle: () => false,
  },
}

const toolsConfig: UserConfig = {
  name: `${PLUGIN_ID}/tools`,
  entry: { tools: 'src/tools/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: HOST_EXTERNALS,
    alwaysBundle: () => false,
  },
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
/** Suffix keeping the virtual id away from tsdown's own css guard (`.css` ids). */
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit the style injector module for one stylesheet. */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap: Record<string, string> | undefined,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${fileId.split('/').pop()}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Resolve a relative import against the physical sources. */
function sourceAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

const cssModulesPlugin: Plugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source, importer) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    return styleInjectionModule(PLUGIN_ID, fileId, code.toString(), classMap)
  },
}

const purityGatePlugin: Plugin = {
  name: 'dsh-client-bundle-purity',
  resolveId(source) {
    if (!source.startsWith('@deepseek-ai/')) return null
    if (CLIENT_EXTERNALS.has(source)) return null
    // Inline-safe wire layers (type-only imports never reach this gate).
    if (/^@deepseek-ai\/dsh-(host-apiproxy|session)(\/|$)/.test(source)) return null
    throw new Error(
      `client bundle purity: "${source}" is not in the client externals baseline — `
      + 'cross-plugin value imports are forbidden; use type-only imports or cordis services',
    )
  },
}

const clientConfig: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [purityGatePlugin, cssModulesPlugin],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [hostConfig, toolsConfig, clientConfig]
