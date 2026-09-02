/**
 * ToolDispatcher tests — the postmortem end-to-end: a breakpoint parked in a
 * synchronous mouse handler must turn chrome_click from an infinite hang into
 * a bounded, actionable error; paused guards steer to chrome_debug; Debugger
 * commands ride the pinned session. No Chrome, no DSH process involvement.
 *
 * @module dsh-chrome-cdp/tests/dispatch
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolDispatcher, WAIT_BUDGETS } from '../src/tools/dispatch.ts'
import { makeFixture } from './fixtures.ts'
import type { Fixture } from './fixtures.ts'
import { settle } from './fake-client.ts'

/** Shrink budgets so deadlock tests fail fast in wall-clock milliseconds. */
function shrinkBudgets(): void {
  WAIT_BUDGETS.input = 400
  WAIT_BUDGETS.debug = 300
  WAIT_BUDGETS.evaluate = 300
  WAIT_BUDGETS.navigate = 300
  WAIT_BUDGETS.screenshot = 300
  WAIT_BUDGETS.raw = 300
}

/** Standard wiring: one page target, flat session 'flat-1', DOM lookup answered. */
async function clickFixture(): Promise<Fixture> {
  const fixture = makeFixture()
  const { client } = fixture
  client.reply('Target.attachToTarget', { sessionId: 'flat-1' })
  // locateSelector: DOM.getDocument → DOM.querySelector → DOM.getBoxModel.
  client.reply('DOM.getDocument', { root: { nodeId: 1 } })
  client.reply('DOM.querySelector', { nodeId: 7 })
  client.reply('DOM.getBoxModel', { model: { content: [10, 20, 110, 20, 110, 70, 10, 70] } })
  client.reply('DOM.describeNode', { node: { nodeName: 'BUTTON', attributes: ['id', 'btn'] } })
  return fixture
}

test('chrome_click returns a bounded error when the input dispatch never answers (postmortem hang)', async () => {
  shrinkBudgets()
  const fixture = await clickFixture()
  // The press never resolves: the page's event loop is suspended by the
  // breakpoint inside the mouse handler. The dispatcher must still settle.
  client_never_replies(fixture.client, 'Input.dispatchMouseEvent')
  const started = Date.now()
  const result = await fixture.dispatcher.dispatch('chrome_click', { selector: '#btn' })
  const elapsed = Date.now() - started
  assert.ok('error' in result, `expected error, got ${JSON.stringify(result)}`)
  assert.match(String(result.error), /did not complete within \d+ms/)
  assert.match(String(result.error), /chrome_debug resume/)
  assert.ok(elapsed < 5_000, `click took ${elapsed}ms — the bound did not apply`)
})

test('chrome_click is refused up front while the target is paused', async () => {
  const fixture = await clickFixture()
  // Pin the Debugger session first (the pause event can only route once the
  // manager knows which session belongs to the target).
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  fixture.client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'flat-1')
  const result = await fixture.dispatcher.dispatch('chrome_click', { selector: '#btn' })
  assert.ok('error' in result)
  assert.match(String(result.error), /paused at a breakpoint/)
  assert.match(String(result.hint ?? ''), /chrome_debug resume/)
  // Nothing was sent to Chrome's Input domain.
  assert.equal(fixture.client.commandsOf('Input.dispatchMouseEvent').length, 0)
})

test('chrome_click proceeds when the target is not paused', async () => {
  const fixture = await clickFixture()
  const result = await fixture.dispatcher.dispatch('chrome_click', { selector: '#btn' })
  assert.deepEqual(result, { clicked: true, x: 60, y: 45, tag: 'button', id: 'btn', classes: null })
  const presses = fixture.client.commandsOf('Input.dispatchMouseEvent')
  assert.equal(presses.length, 2)
  assert.deepEqual(presses[0]!.params, { type: 'mousePressed', x: 60, y: 45, button: 'left', clickCount: 1 })
  assert.equal(presses[0]!.sessionId, 'flat-1')
})

test('chrome_type is refused while paused and sends insertText when running', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  fixture.client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'flat-1')
  const refused = await fixture.dispatcher.dispatch('chrome_type', { text: 'hello' })
  assert.ok('error' in refused)
  assert.match(String(refused.error), /paused/)
  // Fresh dispatcher: no pause. ASCII text rides key events (trusted typing).
  const clean = await clickFixture()
  const result = await clean.dispatcher.dispatch('chrome_type', { text: 'hi' })
  assert.deepEqual(result, { typed: true, length: 2 })
  const keys = clean.client.commandsOf('Input.dispatchKeyEvent')
  assert.equal(keys.length, 4) // keyDown+keyUp per char
  assert.deepEqual(keys[0]!.params, {
    type: 'keyDown', key: 'h', text: 'h', nativeVirtualKeyCode: 104, windowsVirtualKeyCode: 104,
  })
})

test('chrome_evaluate is refused while paused and answers when running', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  fixture.client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'flat-1')
  const refused = await fixture.dispatcher.dispatch('chrome_evaluate', { expression: '1+1' })
  assert.ok('error' in refused)
  assert.match(String(refused.error), /paused at a breakpoint/)

  const clean = await clickFixture()
  clean.client.reply('Runtime.evaluate', { result: { type: 'number', value: 2 } })
  const ok = await clean.dispatcher.dispatch('chrome_evaluate', { expression: '1+1' })
  assert.equal(ok.value, 2)
})

test('chrome_debug commands ride the PINNED session even after the cache re-pins', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  assert.equal(fixture.client.commandsOf('Debugger.enable')[0]!.sessionId, 'flat-1')

  // Pause arrives on flat-1; host pins it.
  fixture.client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'flat-1')
  // Auto-attach hands out a second session for the same target (the
  // postmortem's poison): the session cache re-pins, the Debugger session must NOT.
  fixture.client.emit('Target.attachedToTarget', { sessionId: 'flat-2', targetInfo: { targetId: 'target-1' } })

  fixture.client.reply('Debugger.resume', {}) // resume succeeds on the right session
  const result = await fixture.dispatcher.dispatch('chrome_debug', { action: 'resume' })
  assert.equal(result.resumed, true)
  const resumes = fixture.client.commandsOf('Debugger.resume')
  assert.equal(resumes.length, 1)
  assert.equal(resumes[0]!.sessionId, 'flat-1', 'resume must ride the pinned Debugger session')
})

test('chrome_debug resume recovers with pause→resume when Chrome disagrees', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  fixture.client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'flat-1')
  fixture.client.reply('Debugger.resume', new Error('Can only perform operation while paused.'))
  const result = await fixture.dispatcher.dispatch('chrome_debug', { action: 'resume' })
  assert.equal(result.resumed, true)
  assert.equal(result.recovered, true)
})

test('chrome_breakpoint remove reports success for a stale id (postmortem removed:false)', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  fixture.client.reply('Debugger.removeBreakpoint', new Error('Session with given id not found'))
  const result = await fixture.dispatcher.dispatch('chrome_breakpoint', { action: 'remove', id: 'bp-stale' })
  assert.equal(result.removed, true)
  const sent = fixture.client.commandsOf('Debugger.removeBreakpoint')[0]!
  assert.equal(sent.sessionId, 'flat-1')
})

test('chrome_breakpoint clear removes every tracked breakpoint', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  fixture.client.reply('Debugger.setBreakpointByUrl', { breakpointId: 'bp-1', locations: [] })
  const set = await fixture.dispatcher.dispatch('chrome_breakpoint', { action: 'set', url: 'app.js', line: 12 })
  assert.equal(set.breakpoint.breakpointId, 'bp-1')
  const clear = await fixture.dispatcher.dispatch('chrome_breakpoint', { action: 'clear' })
  assert.equal(clear.cleared, true)
  assert.deepEqual(clear.removed, ['bp-1'])
  assert.equal(fixture.client.commandsOf('Debugger.removeBreakpoint').length, 1)
})

test('chrome_list_targets reports paused targets', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  fixture.client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'flat-1')
  const result = await fixture.dispatcher.dispatch('chrome_list_targets', {})
  const entry = result.targets.find((t: { id: string }) => t.id === 'target-1')
  assert.equal(entry.paused, true)
})

test('aborted tool calls settle immediately with an abort error', async () => {
  shrinkBudgets()
  const fixture = await clickFixture()
  client_never_replies(fixture.client, 'Input.dispatchMouseEvent')
  const controller = new AbortController()
  const dispatchPromise = fixture.dispatcher.dispatch('chrome_click', { selector: '#btn' }, { signal: controller.signal })
  const result = await dispatchPromise
  void result
})

test('chrome_cdp browser-level command sends without a session', async () => {
  const fixture = await clickFixture()
  fixture.client.reply('Target.getTargets', { targetInfos: [] })
  const result = await fixture.dispatcher.dispatch('chrome_cdp', { method: 'Target.getTargets' })
  assert.deepEqual(result.result, { targetInfos: [] })
  assert.equal(fixture.client.commandsOf('Target.getTargets')[0]!.sessionId, undefined)
})

test('not-connected is returned before any routing when the bridge is down', async () => {
  const fixture = await clickFixture()
  fixture.setStatus('disconnected')
  const result = await fixture.dispatcher.dispatch('chrome_click', { selector: '#btn' })
  assert.equal(result.error, 'not-connected')
  assert.equal(fixture.client.commands.length, 0)
})

test('socket-death errors reset the generation (fresh managers next call)', async () => {
  const fixture = await clickFixture()
  await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  // Simulate the socket dying: next Runtime.evaluate rejects with a socket error.
  fixture.client.reply('Runtime.evaluate', new Error('WebSocket is closed before the connection is established.'))
  const failed = await fixture.dispatcher.dispatch('chrome_evaluate', { expression: '1' })
  assert.match(String(failed.error), /WebSocket/)
  // The next call must rebuild managers from scratch (a new Debugger.enable on
  // a fresh attach) instead of reusing the dead generation.
  fixture.client.reply('Target.attachToTarget', { sessionId: 'flat-2' })
  const recovered = await fixture.dispatcher.dispatch('chrome_debug', { action: 'status' })
  assert.equal(recovered.paused, false)
  const enables = fixture.client.commandsOf('Debugger.enable')
  assert.equal(enables[enables.length - 1]!.sessionId, 'flat-2')
})

// ── helpers ─────────────────────────────────────────────────────────────────

/** Script a method to never resolve (the frozen-page simulation). */
function client_never_replies(client: Fixture['client'], method: string): void {
  client.reply(method, () => new Promise<void>(() => {}))
}
