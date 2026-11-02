// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 — 结构化建议：滚动窗口、样本阈值、建议方向、快照不影响建议窗口。
import test from 'node:test'
import assert from 'node:assert/strict'

import { IdleAuditAggregator } from '../src/lib/idle-audit.mjs'

function makeEvent(over = {}) {
  return {
    at: 60_000, timeoutMs: 30_000, acquiredAt: 0, lastPokeAt: 30_000,
    idleAfterMs: 30_000, totalActiveMs: 60_000, activeConsumers: 1, ...over,
  }
}

function makeAggregator(options = {}) {
  const records = []
  const aggregator = new IdleAuditAggregator({
    record: (payload) => { records.push(payload) },
    minSamplesForRecommendation: 10,
    ...options,
  })
  return { aggregator, records }
}

test('recommendations: 样本不足返回空数组', () => {
  const { aggregator } = makeAggregator()
  for (let i = 0; i < 5; i += 1) aggregator.asSink()(makeEvent({ idleAfterMs: 3_000 }))
  assert.deepEqual(aggregator.getRecommendations(), [])
})

test('recommendations: 多数快速走开 → 建议 15s，字段与置信度正确', () => {
  const { aggregator } = makeAggregator()
  for (let i = 0; i < 10; i += 1) {
    aggregator.asSink()(makeEvent({ timeoutMs: 30_000, idleAfterMs: 5_000 }))
  }
  const recommendations = aggregator.getRecommendations()
  assert.equal(recommendations.length, 1)
  assert.equal(recommendations[0].fieldKey, 'activeIdleTimeoutMs')
  assert.equal(recommendations[0].suggestedValue, 15_000)
  assert.equal(recommendations[0].sampleCount, 10)
  assert.equal(recommendations[0].confidence, 1)
  assert.match(recommendations[0].text, /降到 15 秒/)
})

test('recommendations: 多数活跃到窗口末尾 → 建议 60s', () => {
  const { aggregator } = makeAggregator()
  for (let i = 0; i < 10; i += 1) {
    aggregator.asSink()(makeEvent({ timeoutMs: 30_000, idleAfterMs: 30_000 }))
  }
  const recommendations = aggregator.getRecommendations()
  assert.equal(recommendations[0].suggestedValue, 60_000)
  assert.match(recommendations[0].text, /提高到 60 秒/)
})

test('recommendations: 混合分布不产生建议', () => {
  const { aggregator } = makeAggregator()
  for (let i = 0; i < 5; i += 1) aggregator.asSink()(makeEvent({ idleAfterMs: 5_000 }))
  for (let i = 0; i < 5; i += 1) aggregator.asSink()(makeEvent({ idleAfterMs: 15_000 }))
  assert.deepEqual(aggregator.getRecommendations(), [])
  // summary 的便捷字段也为 null
  assert.equal(aggregator.computeSummary().recommendation, null)
})

test('recommendations: publishSnapshot 清空快照窗口，但不清滚动窗口', async () => {
  const { aggregator } = makeAggregator()
  for (let i = 0; i < 10; i += 1) aggregator.asSink()(makeEvent({ idleAfterMs: 5_000 }))
  const recommendations = aggregator.getRecommendations()
  assert.equal(recommendations.length, 1)

  await aggregator.publishSnapshot()
  assert.equal(aggregator.getRecommendations().length, 1)          // 滚动窗口保留
  assert.deepEqual(aggregator.computeSummary().recommendations, []) // 快照窗口已清空
})

test('recommendations: 滚动窗口按容量截断，sampleCount 反映保留条数', () => {
  const { aggregator } = makeAggregator({ rollingCapacity: 20 })
  for (let i = 0; i < 50; i += 1) aggregator.asSink()(makeEvent({ idleAfterMs: 5_000 }))
  const recommendations = aggregator.getRecommendations()
  assert.equal(recommendations.length, 1)
  assert.equal(recommendations[0].sampleCount, 20)
})

test('recommendations: computeSummary.recommendation 是 recommendations[0].text 的便捷字段', () => {
  const { aggregator } = makeAggregator()
  for (let i = 0; i < 10; i += 1) aggregator.asSink()(makeEvent({ idleAfterMs: 5_000 }))
  const summary = aggregator.computeSummary()
  assert.equal(summary.recommendations.length, 1)
  assert.equal(summary.recommendation, summary.recommendations[0].text)
})
