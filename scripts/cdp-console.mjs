#!/usr/bin/env node
/**
 * CDP page-session driver: attach to the page matching a URL substring,
 * enable Runtime/Console/Log, reload, collect messages for N ms, print them.
 *
 * Usage: node scripts/cdp-console.mjs <urlSub> <collectMs>
 */

const [, , urlSub, collectMsArg = '6000'] = process.argv
const collectMs = Number(collectMsArg)

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const tab = list.find(t => t.type === 'page' && t.url.includes(urlSub))
if (tab === undefined) {
  console.error(`no page matching ${JSON.stringify(urlSub)}`)
  process.exit(1)
}

const browser = await (await fetch('http://127.0.0.1:9222/json/version')).json()
const ws = new WebSocket(browser.webSocketDebuggerUrl)
let seq = 0
const events = []

function send(method, params = {}, sessionId) {
  const id = ++seq
  return new Promise((resolve) => {
    const frame = { id, method, params }
    if (sessionId !== undefined) frame.sessionId = sessionId
    const onMessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage)
        resolve(msg)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify(frame))
  })
}

await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

const attach = await send('Target.attachToTarget', { targetId: tab.id, flatten: true })
const sessionId = attach.result.sessionId

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.sessionId !== sessionId) return
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
    events.push(`[console.${msg.params.type}] ${text}`)
  } else if (msg.method === 'Log.entryAdded') {
    events.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`)
  } else if (msg.method === 'Runtime.exceptionThrown') {
    events.push(`[exception] ${JSON.stringify(msg.params.exceptionDetails).slice(0, 500)}`)
  }
})

await send('Runtime.enable', {}, sessionId)
await send('Log.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Page.reload', {}, sessionId)

await new Promise(resolve => setTimeout(resolve, collectMs))

for (const line of events) console.log(line)
ws.close()
process.exit(0)
