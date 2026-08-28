#!/usr/bin/env node
/**
 * Minimal CDP driver: evaluate JS in the tab targeting the throwaway host,
 * used to verify the plugin panel end-to-end (trigger presence, open panel,
 * read status, click actions).
 *
 * Usage: node scripts/cdp-probe.mjs <targetUrlSubstring> <jsExpression>
 */

const [, , urlSub, expression] = process.argv

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const tab = list.find(t => t.type === 'page' && t.url.includes(urlSub))
if (tab === undefined) {
  console.error(`no page matching ${JSON.stringify(urlSub)}; open:`)
  for (const t of list.filter(t => t.type === 'page')) console.error(` - ${t.url}`)
  process.exit(1)
}

const ws = new WebSocket(tab.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error !== undefined ? reject(new Error(msg.error.message)) : resolve(msg.result)
  }
}

await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

const ev = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
})
console.log(JSON.stringify(ev.result?.value ?? ev, null, 2))
ws.close()
process.exit(0)
