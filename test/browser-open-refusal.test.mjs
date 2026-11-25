// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

test('managed browser: disabling it is an error, not a silent external-browser path', () => {
  const orchestrator = read('src/plugins/orchestrator.mjs')
  assert.match(orchestrator, /if \(cfg\.managedBrowser !== true\) return \{ ok: false, error: 'managed-browser-disabled'/)
  assert.match(orchestrator, /fork-browser-open-refused/)
  assert.match(orchestrator, /return json\(res, 503, \{ ...out, ok: false, error, browserError: error, managed: false \}\)/)
  assert.doesNotMatch(orchestrator, /managed: false, browserError:.*\n.*return json\(res, 200/)
})

test('client: openTask refuses instead of window.open when managed browser fails', () => {
  const client = read('client.js')
  assert.doesNotMatch(client, /window\.open\(result\.body\.url/)
  assert.match(client, /托管浏览器不可用，已拒绝用外部浏览器打开/)
  assert.match(client, /if \(result\.body\?\.managed === true\)/)
  assert.match(client, /if \(retryDepth >= 1\)/)
  assert.doesNotMatch(client, /window\.open\(retry\.body\.url/)
  assert.doesNotMatch(client, /window\.open\(body\.url/)
  assert.doesNotMatch(client, /window\.open\(/)
  assert.match(client, /openEssenceRuntimeView/)
})

test('managed browser: essence runtime is a managed target, not an external window', () => {
  const orchestrator = read('src/plugins/orchestrator.mjs')
  assert.match(orchestrator, /const runtimeBrowsers = new Map\(\)/)
  assert.match(orchestrator, /openRuntimeManagedBrowser/)
  assert.match(orchestrator, /essence-runtime-browser-refused/)
  assert.ok(orchestrator.includes("route('GET', `${prefix}/api/essence/runtime/open`, async"))
  assert.match(orchestrator, /if \(browser\.ok !== true\)/)
  assert.match(orchestrator, /runtimeBrowsers\.values\(\)/)
})
