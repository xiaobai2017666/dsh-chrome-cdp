#!/usr/bin/env node
/**
 * Normalize the client bundle banner.
 *
 * tsdown may hoist its `Object.defineProperty(exports, Symbol.toStringTag…)`
 * interop prelude above the wrapper intro; the loader parses the factory from
 * the first line, so the `window.__ModuleLoader__.load({ id …` handoff must
 * stay line 1. This script guarantees that, matching the in-repo pipeline.
 */

import { readFile, writeFile } from 'node:fs/promises'

const BUNDLE = new URL('../client/client.js', import.meta.url)
const HANDOFF = /window\.__ModuleLoader__\.load\(\{\s*$/

const raw = await readFile(BUNDLE, 'utf8')
const firstLineEnd = raw.indexOf('\n')
const firstLine = raw.slice(0, firstLineEnd)
if (HANDOFF.test(firstLine)) {
  process.exit(0)
}
const match = raw.match(HANDOFF)
if (match === null) {
  console.error('normalize-client-banner: no __ModuleLoader__ handoff found')
  process.exit(1)
}
// Move the handoff statement (up to and including its line) to the top.
const handoffStart = match.index ?? 0
const lineEnd = raw.indexOf('\n', handoffStart)
const handoff = raw.slice(handoffStart, lineEnd + 1)
const rest = (raw.slice(0, handoffStart) + raw.slice(lineEnd + 1)).replace(/^\n+/, '')
await writeFile(BUNDLE, handoff + rest, 'utf8')
console.log('normalize-client-banner: hoisted handoff to line 1')
