/**
 * TargetSessionManager unit tests: explicit/auto attach, event routing,
 * domain-enable bookkeeping, detach, reset.
 *
 * @module dsh-chrome-cdp/tests/targets
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { TargetSessionManager } from '../src/tools/targets.ts'
import { FakeCdpClient } from './fake-client.ts'

/** Manager wired to a fresh fake client (start() included). */
async function makeManager(events: {
  attached?: (targetId: string, sessionId: string) => void
  detached?: (targetId: string | undefined, sessionId: string) => void
} = {}) {
  const client = new FakeCdpClient()
  const manager = new TargetSessionManager(client, {
    onSessionAttached: events.attached,
    onSessionDetached: events.detached,
  })
  await manager.start()
  return { manager, client }
}

test('acquire explicitly attaches and caches the session', async () => {
  const { manager, client } = await makeManager()
  client.reply('Target.attachToTarget', { sessionId: 'flat-1' })
  const session = await manager.acquire('target-1')
  assert.equal(session.sessionId, 'flat-1')
  const attach = client.commandsOf('Target.attachToTarget')[0]!
  assert.deepEqual(attach.params, { targetId: 'target-1', flatten: true })

  // Cached: no second attach.
  const again = await manager.acquire('target-1')
  assert.equal(again.sessionId, 'flat-1')
  assert.equal(client.commandsOf('Target.attachToTarget').length, 1)

  // Sends ride the flat session.
  await session.send('Page.navigate', { url: 'https://x.test' })
  assert.equal(client.commandsOf('Page.navigate')[0]!.sessionId, 'flat-1')
})

test('auto-attach events cache the session (targetInfo targetId)', async () => {
  const { manager } = await makeManager()
  manager['client'].emit('Target.attachedToTarget', {
    sessionId: 'auto-1',
    targetInfo: { targetId: 'target-9' },
  })
  assert.equal(manager.sessionIdOf('target-9'), 'auto-1')
  assert.ok(manager.has('target-9'))
})

test('attachedToTarget without targetInfo resolves via the explicit-attach reverse map', async () => {
  const { manager, client } = await makeManager()
  client.reply('Target.attachToTarget', { sessionId: 'flat-2' })
  await manager.acquire('target-5')
  // Some flows emit the event without targetInfo; the reverse map answers.
  client.emit('Target.attachedToTarget', { sessionId: 'flat-2' })
  assert.equal(manager.sessionIdOf('target-5'), 'flat-2')
})

test('session replacement drops the old reverse-map entry', async () => {
  const { manager, client } = await makeManager()
  client.reply('Target.attachToTarget', { sessionId: 'flat-old' })
  await manager.acquire('target-1')
  // Chrome hands out a NEW session for the same target.
  client.emit('Target.attachedToTarget', { sessionId: 'flat-new', targetInfo: { targetId: 'target-1' } })
  assert.equal(manager.sessionIdOf('target-1'), 'flat-new')

  const stale = new FakeCdpClient()
  void stale
  // The old session id must no longer resolve to any target…
  client.emit('Target.detachedFromTarget', { sessionId: 'flat-old' })
  assert.equal(manager.sessionIdOf('target-1'), 'flat-new')
})

test('detachedFromTarget drops the session and notifies the owner', async () => {
  let detached: { targetId?: string, sessionId: string } | undefined
  const { manager, client } = await makeManager({
    detached: (targetId, sessionId) => { detached = { targetId, sessionId } },
  })
  client.reply('Target.attachToTarget', { sessionId: 'flat-1' })
  await manager.acquire('target-1')
  client.emit('Target.detachedFromTarget', { sessionId: 'flat-1', targetId: 'target-1' })
  assert.equal(manager.has('target-1'), false)
  assert.notEqual(detached, undefined)
  assert.equal(detached!.sessionId, 'flat-1')
})

test('ensureEnabled sends the domain enable once per session', async () => {
  const { manager, client } = await makeManager()
  client.reply('Target.attachToTarget', { sessionId: 'flat-1' })
  const session = await manager.acquire('target-1')
  await session.ensureEnabled('Page')
  await session.ensureEnabled('Page')
  await session.ensureEnabled('Runtime')
  const enables = client.commands.filter(c => c.method === 'Page.enable')
  assert.equal(enables.length, 1)
  assert.equal(enables[0]!.sessionId, 'flat-1')
  assert.equal(client.commands.filter(c => c.method === 'Runtime.enable').length, 1)
})

test('markEnabled records an enable sent outside the manager (Debugger pinning)', async () => {
  const { manager, client } = await makeManager()
  client.reply('Target.attachToTarget', { sessionId: 'flat-1' })
  const session = await manager.acquire('target-1')
  manager.markEnabled('Debugger', 'flat-1')
  await session.ensureEnabled('Debugger')
  assert.equal(client.commandsOf('Debugger.enable').length, 0)
})

test('reset clears the cache, rejects later acquires, and unsubscribes events', async () => {
  const { manager, client } = await makeManager()
  client.reply('Target.attachToTarget', { sessionId: 'flat-1' })
  await manager.acquire('target-1')
  manager.reset()
  assert.equal(manager.has('target-1'), false)
  await assert.rejects(() => manager.acquire('target-1'), /reset/)
  // Events after reset must not repopulate.
  client.emit('Target.attachedToTarget', { sessionId: 'late', targetInfo: { targetId: 't' } })
  assert.equal(manager.sessionIdOf('t'), undefined)
})

test('pickDefaultTarget prefers real pages over devtools/blank', async () => {
  const { pickDefaultTarget } = await import('../src/tools/targets.ts')
  assert.equal(
    pickDefaultTarget([
      { id: 'd', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
      { id: 'b', type: 'page', url: 'about:blank' },
      { id: 'r', type: 'page', url: 'https://real.test/' },
    ]),
    'r',
  )
  assert.equal(
    pickDefaultTarget([
      { id: 'd', type: 'page', url: 'devtools://x' },
      { id: 'b', type: 'page', url: 'about:blank' },
    ]),
    'd',
  )
  assert.equal(pickDefaultTarget([{ id: 'w', type: 'service_worker', url: 'https://x/sw.js' }]), undefined)
})
