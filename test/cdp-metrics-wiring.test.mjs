// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const orchestrator = fs.readFileSync(path.join(root, 'src/plugins/orchestrator.mjs'), 'utf8')
const browserGuard = fs.readFileSync(path.join(root, 'src/lib/browser-guard.mjs'), 'utf8')

test('orchestrator records and exposes the three CDP trend metrics', () => {
  assert.match(browserGuard, /layoutCount: Number\(metrics\.LayoutCount/)
  assert.match(orchestrator, /appendBrowserMetricHistory/)
  assert.match(orchestrator, /layoutCount = Number\(sample\.layoutCount\) \|\| 0/)
  assert.match(orchestrator, /browser\.metricsHistory = appendBrowserMetricHistory/)
  assert.match(orchestrator, /metrics: t\.browser\.last \? \{/)
  assert.match(orchestrator, /history: Array\.isArray\(t\.browser\.metricsHistory\)/)
  assert.match(orchestrator, /documents: Number\(t\.browser\.last\.documents\) \|\| 0/)
  assert.match(orchestrator, /listeners: Number\(t\.browser\.last\.listeners\) \|\| 0/)
  assert.match(orchestrator, /layoutCount: Number\(t\.browser\.last\.layoutCount\) \|\| 0/)
  assert.match(orchestrator, /metricsHistory: undefined/)
  assert.match(orchestrator, /browser-metrics\.mjs/)
})
