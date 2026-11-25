// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_METRIC_HISTORY_MAX, appendBrowserMetricHistory, browserMetricPoint, browserMetricSeries } from '../src/lib/browser-metrics.mjs'

test('CDP metric points keep only document/listener/layout counts', () => {
  const point = browserMetricPoint({ at: 123, documents: 3.9, listeners: '7', layoutCount: -1, nodes: 99 })
  assert.deepEqual(point, { at: 123, documents: 3, listeners: 7, layoutCount: 0 })
  assert.equal(browserMetricPoint({ at: 123, ok: false }), null)
  assert.equal(browserMetricPoint(null), null)
})

test('CDP metric history is bounded and de-duplicates the same timestamp', () => {
  let history = []
  for (let i = 0; i < 70; i += 1) history = appendBrowserMetricHistory(history, { at: i + 1, documents: i, listeners: i + 1, layoutCount: i + 2 })
  assert.equal(history.length, BROWSER_METRIC_HISTORY_MAX)
  assert.equal(history.at(-1).documents, 69)
  const deduped = appendBrowserMetricHistory(history, { at: 70, documents: 999, listeners: 999, layoutCount: 999 })
  assert.equal(deduped.length, BROWSER_METRIC_HISTORY_MAX)
  assert.equal(deduped.at(-1).documents, 69)
})

test('CDP metric series extracts chart-ready values', () => {
  const history = [{ at: 1, documents: 1, listeners: 2, layoutCount: 3 }, { at: 2, documents: 4 }]
  assert.deepEqual(browserMetricSeries(history, 'documents'), [1, 4])
  assert.deepEqual(browserMetricSeries(history, 'listeners'), [2, 0])
  assert.deepEqual(browserMetricSeries(history, 'layoutCount'), [3, 0])
})
