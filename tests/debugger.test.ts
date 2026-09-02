/**
 * DebuggerManager unit tests — the heart of the 2026-09 breakpoint-hang
 * postmortem fixes. Runs against a FakeCdpClient; no Chrome, no DSH process.
 *
 * @module dsh-chrome-cdp/tests/debugger
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DebuggerManager } from '../src/tools/debugger.ts'
import { FakeCdpClient, settle } from './fake-client.ts'

/** Manager wired to a fresh fake client. */
function makeManager(): { manager: DebuggerManager, client: FakeCdpClient } {
  const client = new FakeCdpClient()
  return { manager: new DebuggerManager(client), client }
}

test('events are routed by sessionId — another session must not pollute a target state', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-A', 'target-A')

  // A pause event on session B (some OTHER target's flat session) must not
  // mark target-A paused — this is what poisoned `chrome_debug status` in the
  // postmortem when listeners were global.
  client.emit('Debugger.paused', { reason: 'other', callFrames: [] }, 'sess-B')
  assert.equal(manager.pausedOf('target-A'), null)
  assert.equal(manager.pausedOf('target-B'), null)

  // The correctly-routed event does register.
  client.emit('Debugger.paused', {
    reason: 'breakpoint',
    callFrames: [{ callFrameId: 'frame-0', functionName: 'onClick', location: { scriptId: 's1', lineNumber: 10, columnNumber: 2 } }],
    hitBreakpoints: ['bp-1'],
  }, 'sess-A')
  const paused = manager.pausedOf('target-A')
  assert.notEqual(paused, null)
  assert.equal(paused!.reason, 'breakpoint')
  assert.equal(paused!.callFrames[0]!.functionName, 'onClick')
  assert.equal(paused!.callFrames[0]!.line, 10)
  assert.deepEqual(paused!.hitBreakpoints, ['bp-1'])
})

test('attachSession pins the session and enables Debugger exactly once per session', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  await manager.attachSession('sess-1', 'target-1') // idempotent
  const enables = client.commandsOf('Debugger.enable')
  assert.equal(enables.length, 1)
  assert.equal(enables[0]!.sessionId, 'sess-1')
  assert.equal(manager.sessionOf('target-1'), 'sess-1')
})

test('re-pinning a NEW session clears stale pause state and re-enables', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  assert.notEqual(manager.pausedOf('target-1'), null)

  // Auto-attach replaces the session: the old debugger pipe is dead, Chrome
  // auto-resumed, so the host must forget the pause.
  await manager.attachSession('sess-2', 'target-1')
  assert.equal(manager.pausedOf('target-1'), null)
  assert.equal(manager.sessionOf('target-1'), 'sess-2')
  // Enable ran on both sessions.
  assert.deepEqual(client.commandsOf('Debugger.enable').map(c => c.sessionId), ['sess-1', 'sess-2'])

  // Old-session events no longer route (the bySession entry was dropped).
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  assert.equal(manager.pausedOf('target-1'), null)
})

test('scriptParsed routes per session and scriptUrlOf resolves frame URLs', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.emit('Debugger.scriptParsed', { scriptId: 's1', url: 'https://x.test/app.js', lineCount: 42 }, 'sess-1')
  // Same scriptId on ANOTHER session must not leak into target-1.
  await manager.attachSession('sess-2', 'target-2')
  client.emit('Debugger.scriptParsed', { scriptId: 's1', url: 'https://y.test/other.js' }, 'sess-2')

  assert.equal(manager.scriptUrlOf('target-1', 's1'), 'https://x.test/app.js')
  assert.equal(manager.scriptUrlOf('target-2', 's1'), 'https://y.test/other.js')
  assert.equal(manager.scriptsOf('target-1').length, 1)
})

test('setBreakpoint tracks host-side state from the Chrome reply', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.reply('Debugger.setBreakpointByUrl', {
    breakpointId: 'bp-9',
    locations: [{ scriptId: 's1', lineNumber: 30 }],
  })
  const info = await manager.setBreakpoint('sess-1', 'target-1', { url: 'app.js', line: 30 })
  assert.equal(info.breakpointId, 'bp-9')
  assert.equal(info.line, 30)
  assert.equal(info.url, 'app.js')
  const sent = client.commandsOf('Debugger.setBreakpointByUrl')[0]!
  assert.equal(sent.sessionId, 'sess-1')
  assert.deepEqual(sent.params, { lineNumber: 30, urlRegex: 'app\\.js' })
  assert.equal(manager.breakpointsOf('target-1').length, 1)
})

test('removeBreakpoint succeeds for a stale/unknown id (postmortem removed:false)', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  // Chrome lost the breakpoint (session replaced): command fails with the
  // exact postmortem error — removal must still report success.
  client.reply('Debugger.removeBreakpoint', new Error('Session with given id not found'), { sticky: true })
  const removed = await manager.removeBreakpoint('sess-1', 'target-1', 'bp-gone')
  assert.equal(removed, true)
})

test('removeBreakpoint still fails on unrelated command errors', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.reply('Debugger.removeBreakpoint', new Error('Protocol error: boom'), { sticky: true })
  await assert.rejects(
    () => manager.removeBreakpoint('sess-1', 'target-1', 'bp-1'),
    /boom/,
  )
})

test('removeAllBreakpoints tolerates stale ids and clears the table', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.reply('Debugger.setBreakpointByUrl', { breakpointId: 'bp-a', locations: [] })
  client.reply('Debugger.setBreakpointByUrl', { breakpointId: 'bp-b', locations: [] })
  await manager.setBreakpoint('sess-1', 'target-1', { url: 'app.js', line: 1 })
  await manager.setBreakpoint('sess-1', 'target-1', { url: 'app.js', line: 2 })
  // First removal hits a dead session; second succeeds.
  client.reply('Debugger.removeBreakpoint', new Error('Session with given id not found'), { sticky: true })
  const ids = await manager.removeAllBreakpoints('sess-1', 'target-1')
  assert.deepEqual(ids.sort(), ['bp-a', 'bp-b'])
  assert.equal(manager.breakpointsOf('target-1').length, 0)
})

test('resume succeeds when Chrome agrees the target is paused', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  const result = await manager.resume('sess-1', 'target-1')
  assert.deepEqual(result, { resumed: true })
  assert.equal(manager.pausedOf('target-1'), null)
})

test('resume applies pause→resume recovery when Chrome disagrees (postmortem combo)', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  // Host believes paused (event was seen) but Chrome answers "not paused".
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  client.reply('Debugger.resume', new Error('Can only perform operation while paused.'))
  const result = await manager.resume('sess-1', 'target-1')
  assert.equal(result.resumed, true)
  assert.equal(result.recovered, true)
  const methods = client.commands.map(c => c.method)
  const resumeIndex = methods.lastIndexOf('Debugger.resume')
  // The recovery pause must come AFTER the failed resume, before the next.
  assert.ok(methods.lastIndexOf('Debugger.pause') > methods.indexOf('Debugger.resume'))
  assert.ok(resumeIndex > methods.lastIndexOf('Debugger.pause'))
  assert.equal(manager.pausedOf('target-1'), null)
})

test('resume without any pause trace throws instead of inventing a pause', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.reply('Debugger.resume', new Error('Can only perform operation while paused.'))
  await assert.rejects(
    () => manager.resume('sess-1', 'target-1'),
    /not paused/,
  )
  // No pause must have been sent.
  assert.equal(client.commandsOf('Debugger.pause').length, 0)
})

test('evaluateOnFrame works on a paused frame and reports evaluation errors', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.emit('Debugger.paused', {
    reason: 'breakpoint',
    callFrames: [{ callFrameId: 'frame-0', functionName: 'f', location: { scriptId: 's1' } }],
  }, 'sess-1')

  client.reply('Debugger.evaluateOnCallFrame', { result: { type: 'number', value: 7 } })
  const value = await manager.evaluateOnFrame('sess-1', 'target-1', 'x + 1')
  assert.deepEqual(value, { type: 'number', value: 7 })
  const sent = client.commandsOf('Debugger.evaluateOnCallFrame')[0]!
  assert.equal(sent.sessionId, 'sess-1')
  assert.equal((sent.params as { callFrameId?: string }).callFrameId, 'frame-0')

  client.reply('Debugger.evaluateOnCallFrame', {
    result: {},
    exceptionDetails: { text: 'Uncaught ReferenceError: zz is not defined' },
  })
  await assert.rejects(() => manager.evaluateOnFrame('sess-1', 'target-1', 'zz'), /ReferenceError/)
})

test('evaluateOnFrame and step refuse a running target', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  await assert.rejects(() => manager.evaluateOnFrame('sess-1', 'target-1', '1'), /not paused/)
  await assert.rejects(() => manager.step('sess-1', 'target-1', 'over'), /not paused/)
  assert.equal(client.commandsOf('Debugger.evaluateOnCallFrame').length, 0)
  assert.equal(client.commandsOf('Debugger.stepOver').length, 0)
})

test('reset drops all state and unsubscribes listeners', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  manager.reset()
  assert.equal(manager.pausedOf('target-1'), null)
  assert.equal(manager.sessionOf('target-1'), null)
  // Events after reset must not resurrect state (listeners were removed).
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  assert.equal(manager.pausedOf('target-1'), null)
})

test('Debugger.resumed clears the paused state', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  assert.notEqual(manager.pausedOf('target-1'), null)
  client.emit('Debugger.resumed', {}, 'sess-1')
  assert.equal(manager.pausedOf('target-1'), null)
  // And chromePaused stays cleared through a resume-without-event recovery.
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  client.reply('Debugger.resume', new Error('Can only perform operation while paused.'))
  const result = await manager.resume('sess-1', 'target-1')
  assert.equal(result.recovered, true)
})

test('attachSession survives a failed enable without losing the pin (session replaced mid-flight)', async () => {
  const { manager, client } = makeManager()
  await manager.attachSession('sess-1', 'target-1')
  client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, 'sess-1')
  // New attach where Debugger.enable fails (e.g. session died between attach
  // and enable): the pin must still move so the NEXT command rides sess-2.
  client.reply('Debugger.enable', new Error('Target closed'), { sticky: true })
  await assert.rejects(() => manager.attachSession('sess-2', 'target-1'))
  assert.equal(manager.sessionOf('target-1'), 'sess-2')
})

test('event storm across many sessions routes each event to its own target', async () => {
  const { manager, client } = makeManager()
  for (let i = 0; i < 5; i++) {
    await manager.attachSession(`sess-${i}`, `target-${i}`)
  }
  for (let i = 0; i < 5; i++) {
    client.emit('Debugger.paused', { reason: 'breakpoint', callFrames: [] }, `sess-${i}`)
  }
  for (let i = 0; i < 5; i++) {
    assert.notEqual(manager.pausedOf(`target-${i}`), null, `target-${i} should be paused`)
  }
  // Resume target-2 only.
  client.emit('Debugger.resumed', {}, 'sess-2')
  assert.equal(manager.pausedOf('target-2'), null)
  for (const i of [0, 1, 3, 4]) {
    assert.notEqual(manager.pausedOf(`target-${i}`), null, `target-${i} must stay paused`)
  }
  await settle()
})
