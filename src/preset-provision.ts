/**
 * Agent-preset provisioning: make the plugin's `chrome-cdp-tools` agent
 * preset appear in the harness-home user preset root
 * (`$DSH_HOME/.agent-presets/chrome-cdp-tools`) without a manual copy step.
 *
 * Why provisioning rewrites one row: the preset composition names the tools
 * half by package (`dsh-chrome-cdp/tools`), but a preset row naming a package
 * resolves from the INSTALLED HARNESS, not from the profile where this plugin
 * is installed (see `@deepseek-ai/dsh-agent-presets/specifier`). The shipped
 * composition therefore cannot name the package and stay portable, and a
 * hand-copied preset reads as healthy only while the package happens to sit
 * inside the harness tree. Provisioning pins the row to a `file:` URL of the
 * INSTALLED tools entry instead — a file URL names one file and no base, so
 * the preset mounts no matter where the plugin landed, and the next boot
 * rewrites the URL if the plugin later moves.
 *
 * Respect for humans, in three cases:
 * - absent directory  → provisioned from the package's `presets/` copy;
 * - stamped by us     → refreshed: the tools row URL re-pinned to the
 *   current install, `preset.yml` re-synced;
 * - unstamped         → left untouched EXCEPT a legacy composition naming the
 *   package gets exactly that row rewritten in place (the pre-provisioning
 *   manual-copy layout), so user edits to every other line survive.
 * Deleting the directory re-provisions on the next boot; that is the upgrade
 * path, not a bug.
 *
 * Provisioning never fails the boot: any error is contained and logged.
 * @module dsh-chrome-cdp/preset-provision
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** The user preset root the harness scans (matches `USER_PRESET_DIR`). */
const USER_PRESET_DIR = '.agent-presets'

/**
 * The harness home, mirroring `@deepseek-ai/dsh-home-paths`' precedence
 * (`$DSH_HOME` over `~/.dsh`) without adding a hard dependency: provisioning
 * must write where the roster's user root actually scans.
 */
function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(selected)
}

/** The preset directory name, which is also the preset id. */
const PRESET_ID = 'chrome-cdp-tools'

/** The legacy package row this plugin's compositions have always used. */
const LEGACY_TOOLS_ROW = "name: 'dsh-chrome-cdp/tools'"

/**
 * A malformed pin an early provisioner could write (double `name:`); its
 * output is repaired on the next boot.
 */
const MALFORMED_PIN_MARKER = "name: 'name: '"

/** Marker file separating our provisioning from a user-authored preset. */
const STAMP_FILENAME = '.dsh-provisioned.json'

interface Stamp {
  by: 'dsh-chrome-cdp'
  version: string
}

/**
 * The installed package root: two levels above this module's built file
 * (`lib/index.js` → package root; `src/*.ts` under tsx → package root too).
 */
function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * The `file:` URL of the installed tools entry the preset row must name.
 * A relative hop from this module keeps the answer inside the installed
 * package for both launch layouts.
 */
function toolsEntryUrl(): string {
  return pathToFileURL(join(packageRoot(), 'lib', 'tools.mjs')).href
}

/** The YAML row spelling for the pinned tools entry. */
function toolsRow(toolsUrl: string): string {
  return `name: '${toolsUrl}'`
}

/**
 * Provision (or refresh) the agent preset; never throws.
 * @param ctx - host context, for diagnostics.
 * @param version - the running plugin version, recorded in the stamp.
 * @param packageDir - the installed package root (for the tools entry hop).
 */
export function provisionAgentPreset(
  ctx: Context,
  version: string,
  packageDir: string = packageRoot(),
): void {
  try {
    const targetDir = join(dshHome(), USER_PRESET_DIR, PRESET_ID)
    const sourceDir = join(packageDir, 'presets', PRESET_ID)
    const compositionSource = join(sourceDir, 'agent.cordis.yml')
    if (!existsSync(compositionSource)) {
      ctx.logger.warn('chrome-cdp: preset provisioning skipped — shipped composition missing at %s', compositionSource)
      return
    }

    const targetComposition = join(targetDir, 'agent.cordis.yml')
    const toolsUrl = pathToFileURL(join(packageDir, 'lib', 'tools.mjs')).href
    const row = toolsRow(toolsUrl)
    let changed = false

    if (!existsSync(targetComposition)) {
      // First provisioning: copy the shipped composition and metadata whole,
      // with the tools row pinned to this install.
      const desired = readFileSync(compositionSource, 'utf8')
        .replaceAll(LEGACY_TOOLS_ROW, row)
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(targetComposition, desired)
      copyMetadata(sourceDir, targetDir)
      writeStamp(targetDir, version)
      ctx.logger.warn('chrome-cdp: agent preset provisioned at %s', targetDir)
      return
    }

    // Existing directory. Unstamped compositions that do not name the legacy
    // row (or a malformed pins from an older provisioner) are someone's own
    // preset — leave every byte alone.
    const stamp = readStamp(targetDir)
    const current = readFileSync(targetComposition, 'utf8')
    const hasLegacyRow = current.includes(LEGACY_TOOLS_ROW)
    const hasMalformedPin = current.includes(MALFORMED_PIN_MARKER)
    if (stamp === undefined && !hasLegacyRow && !hasMalformedPin) {
      ctx.logger.warn(
        'chrome-cdp: preset at %s was not provisioned by this plugin; left untouched',
        targetDir,
      )
      return
    }

    // Refresh: pin the tools row to the current install (the only line
    // provisioning owns) and re-sync metadata when it drifted.
    let desired = current
    if (hasLegacyRow) desired = desired.replaceAll(LEGACY_TOOLS_ROW, row)
    if (hasMalformedPin) desired = desired.replaceAll(MALFORMED_PIN_MARKER, row)
    if (desired !== current) {
      writeFileSync(targetComposition, desired)
      changed = true
    }
    if (syncMetadata(sourceDir, targetDir)) changed = true
    if (stamp?.version !== version) {
      writeStamp(targetDir, version)
      changed = true
    }
    if (changed) {
      ctx.logger.warn('chrome-cdp: agent preset refreshed at %s', targetDir)
    }
  } catch (error) {
    ctx.logger.warn('chrome-cdp: preset provisioning skipped: %s', messageOf(error))
  }
}

/** Copy `preset.yml` from the shipped copy; true when bytes changed. */
function copyMetadata(sourceDir: string, targetDir: string): boolean {
  const source = readFileSync(join(sourceDir, 'preset.yml'), 'utf8')
  const target = join(targetDir, 'preset.yml')
  if (existsSync(target) && readFileSync(target, 'utf8') === source) return false
  writeFileSync(target, source)
  return true
}

/** Alias of {@link copyMetadata} for the refresh path. */
function syncMetadata(sourceDir: string, targetDir: string): boolean {
  return copyMetadata(sourceDir, targetDir)
}

function writeStamp(targetDir: string, version: string): void {
  const stamp: Stamp = { by: 'dsh-chrome-cdp', version }
  writeFileSync(join(targetDir, STAMP_FILENAME), `${JSON.stringify(stamp, undefined, 2)}\n`)
}

function readStamp(targetDir: string): Stamp | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(targetDir, STAMP_FILENAME), 'utf8')) as Stamp
    return parsed?.by === 'dsh-chrome-cdp' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Best-effort human message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
