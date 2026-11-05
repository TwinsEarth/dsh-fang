// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser bundle contract guards: client.js is not imported by unit tests, so these
// source-level assertions lock the two regressions that caused real 401s:
//   1. options.headers replacing the default auth headers;
//   2. api() accepting an absolute URL (token exfiltration).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(import.meta.dirname, '..', 'client.js')
const source = fs.readFileSync(file, 'utf8')

test('client.js: api() rejects absolute / scheme-relative URLs', () => {
  const start = source.indexOf('async function api(path, options)')
  assert.ok(start >= 0, 'api() must exist')
  const end = source.indexOf('function resolveMotherOrigin', start)
  assert.ok(end > start, 'api() boundary must be findable')
  const body = source.slice(start, end)
  assert.match(body, /if \(!url\.startsWith\('\/'\) \|\| url\.startsWith\('\/\/'\)\)/)
  assert.match(body, /invalid-api-path/)
})

test('client.js: api() merges caller headers before writing x-fang-auth', () => {
  const start = source.indexOf('async function api(path, options)')
  const end = source.indexOf('function resolveMotherOrigin', start)
  const body = source.slice(start, end)
  const mergeAt = body.indexOf('...(request.headers ?? {})')
  const tokenAt = body.indexOf("'x-fang-auth': token")
  assert.ok(mergeAt >= 0, 'caller headers must be merged')
  assert.ok(tokenAt > mergeAt, 'auth header must be written after caller headers')
})

test('client.js: Electron portal opens the upstream origin, not the proxy', () => {
  assert.match(source, /window\.__fangDesktopUpstream/)
  assert.match(source, /desktopInfo\?\.\(\)\.then/)
})
