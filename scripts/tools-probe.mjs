/**
 * Integration probe: drive the tools dispatcher against the live Chrome CDP
 * endpoint, without dsh. Exercises every P0/P1 tool path end to end.
 *
 * Usage: node scripts/tools-probe.mjs
 */
import CDP from 'chrome-remote-interface'
import { ToolDispatcher } from '../lib/tools.mjs'

// Minimal bridge over a bare CRI client (mirrors the host-half bridge).
const client = await CDP({ host: '127.0.0.1', port: 9222 })
const bridge = {
  getStatus: () => ({ phase: 'connected' }),
  getClient: () => client,
  listTargets: async () => {
    const { targetInfos } = await client.send('Target.getTargets')
    return targetInfos
      .filter(t => t.type === 'page')
      .map(t => ({ id: t.targetId, type: t.type, title: t.url, url: t.url, attachable: true }))
  },
  attachmentsAvailable: () => false,
  persistImage: async () => undefined,
}
const dispatcher = new ToolDispatcher(bridge)

const results = []
async function call(name, args, expectOk = true) {
  const started = Date.now()
  const result = await dispatcher.dispatch(name, args)
  const ok = expectOk ? result.error === undefined : result.error !== undefined
  results.push({ name, ok, ms: Date.now() - started })
  const label = ok ? 'PASS' : 'FAIL'
  console.log(`[${label}] ${name} (${Date.now() - started}ms)`)
  if (!ok || process.env.VERBOSE) {
    console.log(JSON.stringify(result, null, 2).slice(0, 2000))
  }
  return result
}

// ── navigation group ────────────────────────────────────────────────────────
const listResult = await call('chrome_list_targets', {})
const targetId = listResult?.targets?.[0]?.id

await call('chrome_navigate', { url: 'data:text/html,<h1>probe</h1><script>console.log("hello-probe")</script>' })
await call('chrome_evaluate', { expression: 'document.querySelector("h1").textContent' })
await call('chrome_evaluate', { expression: '1 + 1' })

// ── diagnostics group ───────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 500))
await call('chrome_console', { text: 'hello-probe' })
await call('chrome_network', { limit: 5 })

// ── debug group ─────────────────────────────────────────────────────────────
await call('chrome_debug', { action: 'status' })
await call('chrome_breakpoint', { action: 'scripts' })
// Navigate to a page with a real function; breakpoint its call site line.
await call('chrome_navigate', { url: 'data:text/html,<script>function add(a,b){\nreturn a+b}\nwindow.out = add(6,7)\nconsole.log("bp-done", window.out)</script>' })
// allow scriptParsed events to land
await new Promise(r => setTimeout(r, 600))
const bpSet = await call('chrome_breakpoint', { action: 'set', url: 'data:', line: 3 })
// re-navigate: script re-runs, breakpoint at line 3 (0-based) hits
await call('chrome_navigate', { url: 'data:text/html,<script>function add(a,b){\nreturn a+b}\nwindow.out = add(6,7)\nconsole.log("bp-done", window.out)</script>' })
// wait for pause to land
await new Promise(r => setTimeout(r, 800))
const status = await call('chrome_debug', { action: 'status' })
const paused = status?.paused === true
console.log('paused after re-navigate:', paused, '| frames:', status?.callFrames?.length ?? 0)
if (paused) {
  await call('chrome_evaluate', { expression: '1 + 1' }, false) // must be blocked while paused

  await call('chrome_debug', { action: 'step_over' })
  await new Promise(r => setTimeout(r, 400))
  await call('chrome_debug', { action: 'status' })
}
await call('chrome_debug', { action: 'resume' })
await call('chrome_debug', { action: 'status' })

// ── interaction group ───────────────────────────────────────────────────────
await call('chrome_navigate', { url: 'data:text/html,<button id="b" onclick="this.textContent=\'clicked\'">go</button>' })
await call('chrome_click', { selector: '#b' })
await call('chrome_evaluate', { expression: 'document.querySelector("#b").textContent' })
await call('chrome_type', { text: 'hi', selector: '#b' })

// ── raw group ───────────────────────────────────────────────────────────────
await call('chrome_cdp', { method: 'Browser.getVersion' })
await call('chrome_cdp', { method: 'Target.getTargets' })
await call('chrome_cdp', { method: 'NotA.domain', params: {} }, false)

// ── not-connected path ──────────────────────────────────────────────────────
bridge.getStatus = () => ({ phase: 'disconnected' })
await call('chrome_evaluate', { expression: '1' }, false)
bridge.getStatus = () => ({ phase: 'connected' })

// ── summary ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length > 0 ? '; FAILED: ' + failed.map(f => f.name).join(', ') : ''}`)
client.close()
process.exit(failed.length > 0 ? 1 : 0)
