/**
 * Chrome instance detection + relaunch for CDP, Host half.
 *
 * One entry point, {@link ensureChromeInstance}: probe the configured CDP
 * endpoint first; when it already answers, nothing is touched. Otherwise
 * scan for a running Chrome, terminate it, and (re)start one Chrome with
 * `--remote-debugging-port` on an isolated user-data-dir — the only
 * invocation shape modern Chrome accepts for CDP (Chrome 136+ ignores the
 * flag on the default profile, and the newer settings-page "Remote
 * debugging" toggle serves a different, discovery-less protocol).
 *
 * Platform notes:
 * - WSL2 (`/mnt/c` + `WSL_DISTRO_NAME`): drives the Windows Chrome via the
 *   full PowerShell path; mirrored networking makes 127.0.0.1:<port> on the
 *   Windows side reachable from inside WSL.
 * - Linux: `google-chrome`/`chromium`/`chromium-browser` binaries; killed by
 *   `pkill -f` on the binary name, started detached.
 * - macOS: `/Applications/Google Chrome.app/...`, killed by `pkill -f`.
 *
 * Never throws — every failure lands in the structured result.
 *
 * @module dsh-chrome-cdp/chrome-launcher
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** What {@link ensureChromeInstance} did, in order of preference. */
export type EnsureAction =
  | 'none' /** endpoint already answered; Chrome untouched */
  | 'restarted' /** a running Chrome was terminated and relaunched with CDP */
  | 'started' /** no Chrome was running; one was launched with CDP */

/** Structured outcome — the wire shape of the chrome_ensure tool. */
export interface EnsureResult {
  action: EnsureAction
  /** True when /json/version answered after everything settled. */
  endpointReady: boolean
  host: string
  port: number
  /** ISO timestamp of the settle moment. */
  checkedAt: string
  /** Human-readable trace of what was attempted (for the tool result). */
  steps: string[]
  error?: string
  hint?: string
}

/** Where a Chrome executable was found and how to stop it. */
interface ChromeInstallation {
  /** Display name for steps/error messages. */
  label: string
  /** Absolute executable path (Windows path when under WSL). */
  executable: string
  /** Terminate every running instance, best-effort. */
  stop(): Promise<void>
  /** Launch a fresh instance with the CDP flags, detached. */
  start(port: number): Promise<void>
}

/** Probe the HTTP discovery endpoint once; true = CDP-capable Chrome there. */
async function endpointAnswers(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** True when running inside WSL (any version) with a Windows side present. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME !== undefined) return true
  return existsSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
}

/** PowerShell entry point reachable from WSL. */
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** Windows Chrome candidate locations, most likely first. */
const WINDOWS_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  String.raw`C:\Users\Default\AppData\Local\Google\Chrome\Application\chrome.exe`,
]

/** Linux/macOS candidate binaries/classes, most likely first. */
const UNIX_CHROME_CANDIDATES = ['google-chrome', 'chromium', 'chromium-browser']

/** Wildcards for pgrep -f when hunting a running instance on unix. */
const UNIX_PGREP_PATTERNS = ['Google Chrome', 'google-chrome', 'chromium']

/** Detect the platform's Chrome installation; undefined = not found. */
async function findChrome(): Promise<ChromeInstallation | undefined> {
  if (isWsl()) {
    for (const exe of WINDOWS_CHROME_PATHS) {
      const windowsPath = exe.startsWith(String.raw`C:\Users\Default`)
        ? exe
        : exe
      const probe = await run(POWERSHELL, [
        '-NoProfile', '-Command',
        `if (Test-Path '${windowsPath.replace(/\\/g, '\\\\')}') { 'yes' } else { 'no' }`,
      ]).then(r => r.stdout.trim() === 'yes').catch(() => false)
      if (probe) {
        return windowsInstallation(windowsPath)
      }
    }
    return undefined
  }

  if (process.platform === 'win32') {
    for (const exe of WINDOWS_CHROME_PATHS) {
      if (existsSync(exe)) return windowsInstallation(exe)
    }
    return undefined
  }

  // darwin / linux
  const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (process.platform === 'darwin' && existsSync(macPath)) {
    return unixInstallation('Google Chrome (macOS)', macPath, ['Google Chrome'])
  }
  for (const bin of UNIX_CHROME_CANDIDATES) {
    const hit = await run('sh', ['-c', `command -v ${bin}`]).then(r => r.stdout.trim()).catch(() => '')
    if (hit !== '') return unixInstallation(bin, hit, UNIX_PGREP_PATTERNS)
  }
  return undefined
}

/** Windows/WSL installation: lifecycle through PowerShell. */
function windowsInstallation(executable: string): ChromeInstallation {
  const label = `Windows Chrome (${executable})`
  return {
    label,
    executable,
    stop: async () => {
      await run(POWERSHELL, ['-NoProfile', '-Command',
        'Stop-Process -Name chrome -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2'],
      ).catch(() => { /* already gone */ })
    },
    start: async (port) => {
      // Isolated profile dir: mandatory on Chrome 136+ (default profile makes
      // Chrome silently ignore --remote-debugging-port).
      const profile = 'C:\\temp\\chrome-cdp-profile'
      await run(POWERSHELL, ['-NoProfile', '-Command',
        `Start-Process '${executable}' -ArgumentList '--remote-debugging-port=${String(port)}', '--user-data-dir=${profile}', '--no-first-run', '--no-default-browser-check'`],
      )
    },
  }
}

/** Unix installation: lifecycle through pkill and a detached spawn. */
function unixInstallation(label: string, executable: string, patterns: readonly string[]): ChromeInstallation {
  return {
    label,
    executable,
    stop: async () => {
      for (const pattern of patterns) {
        await run('pkill', ['-f', pattern]).catch(() => { /* not running */ })
      }
      await new Promise(resolve => setTimeout(resolve, 1500))
    },
    start: async (port) => {
      const profile = join(tmpdir(), 'chrome-cdp-profile')
      const child = spawnDetached(executable, [
        `--remote-debugging-port=${String(port)}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--headless=new',
      ])
      child.on('error', () => { /* surfaced through the endpoint poll */ })
    },
  }
}

/** Spawn fully detached so the Chrome outlives the host process. */
import { spawn } from 'node:child_process'
function spawnDetached(command: string, args: string[]): ReturnType<typeof spawn> {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

/**
 * Guarantee a CDP-reachable Chrome at host:port.
 *
 * Steps: probe endpoint → (answer: done) → find Chrome → stop any running
 * instance → start one with CDP flags → poll /json/version until it answers
 * (bounded) → report.
 */
export async function ensureChromeInstance(
  host: string,
  port: number,
  options: { timeoutMs?: number } = {},
): Promise<EnsureResult> {
  const timeoutMs = options.timeoutMs ?? 30000
  const steps: string[] = []
  const base = { host, port, checkedAt: new Date().toISOString() }

  if (await endpointAnswers(host, port)) {
    return {
      ...base,
      action: 'none',
      endpointReady: true,
      steps: [`endpoint http://${host}:${port}/json/version already answers; Chrome untouched`],
    }
  }
  steps.push(`endpoint http://${host}:${port}/json/version not answering`)

  const chrome = await findChrome()
  if (chrome === undefined) {
    return {
      ...base,
      action: 'none',
      endpointReady: false,
      steps: [...steps, 'no Chrome installation found on this platform'],
      error: 'no Chrome installation found',
      hint: 'install Google Chrome (or Chromium) and retry, or start one manually with --remote-debugging-port',
    }
  }
  steps.push(`found ${chrome.label}`)

  // Was a Chrome already running? Detection BEFORE stop, so the action name
  // can distinguish 'restarted' from 'started'.
  const running = await detectRunning(chrome)
  steps.push(running
    ? 'a Chrome instance is running — terminating it'
    : 'no running Chrome instance — starting a fresh one')
  if (running) await chrome.stop()

  try {
    await chrome.start(port)
  } catch (error) {
    return {
      ...base,
      action: running ? 'restarted' : 'started',
      endpointReady: false,
      steps: [...steps, `launch failed: ${messageOf(error)}`],
      error: `launch failed: ${messageOf(error)}`,
      hint: 'check the Chrome executable path and try launching it manually',
    }
  }
  steps.push(`launched with --remote-debugging-port=${String(port)} (isolated user-data-dir)`)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await endpointAnswers(host, port, 1000)) {
      steps.push(`endpoint ready after ${String(timeoutMs - (deadline - Date.now()))}ms`)
      return {
        ...base,
        action: running ? 'restarted' : 'started',
        endpointReady: true,
        steps,
      }
    }
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  return {
    ...base,
    action: running ? 'restarted' : 'started',
    endpointReady: false,
    steps: [...steps, `endpoint did not answer within ${String(timeoutMs)}ms`],
    error: 'Chrome launched but the CDP endpoint never became ready',
    hint: 'older Chrome builds ignore --remote-debugging-port on the default profile; the isolated user-data-dir flag is required and was passed — check whether another Chrome process raced the launch',
  }
}

/** Whether any instance of this installation appears to be running. */
async function detectRunning(chrome: ChromeInstallation): Promise<boolean> {
  if (isWsl() || process.platform === 'win32') {
    const out = await run(POWERSHELL, ['-NoProfile', '-Command',
      '@(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count'],
    ).then(r => Number.parseInt(r.stdout.trim(), 10)).catch(() => 0)
    return out > 0
  }
  for (const pattern of UNIX_PGREP_PATTERNS) {
    const hit = await run('pgrep', ['-f', pattern]).then(() => true).catch(() => false)
    if (hit) return true
  }
  return false
}

/** Best-effort message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
