// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')

test('memory watchdog caches the full process table between ticks', () => {
  assert.match(orchestrator, /memoryProcessScanIntervalMs/)
  assert.match(orchestrator, /cacheMs: Math\.max\(10000, Number\(cfg\.memoryProcessScanIntervalMs\)/)
  assert.match(orchestrator, /const freshTable = table\.cached !== true/)
  assert.match(orchestrator, /if \(!freshTable\) return/)
})

test('browser watchdog skips CDP when the sample window has not elapsed', () => {
  assert.match(orchestrator, /browserCdpSampleIntervalMs/)
  assert.match(orchestrator, /const cdpDue = !cdpAt \|\| now - cdpAt >= cdpIntervalMs/)
  assert.match(orchestrator, /if \(!freshTable && !cdpDue\) continue/)
  assert.match(orchestrator, /cdpSampled: cdpDue && cdpOk/)
})

test('host memory is sampled every tick even when no fork or browser exists', () => {
  assert.doesNotMatch(orchestrator, /const active = \[\.\.\.tasks\.values\(\), \.\.\.runtimeBrowsers\.values\(\)\]\.some/)
  assert.match(orchestrator, /A DSH host can OOM without any child/)
  assert.match(orchestrator, /const memory = rememberMemory\(await readSystemMemory\(\)\)/)
})
