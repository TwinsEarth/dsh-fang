// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v2.7.0 ForkSseClient 网络层模糊测试：
//   性质（401/409/410/心跳/断连无重复）+ 随机分块/断连等价性。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  runSseClientFuzz,
  runSseClientProperties,
} from '../tools/fuzz/sse-client-fuzz.mjs'
import { SSE_CLIENT_STRATEGIES } from '../tools/fuzz/sse-client-generators.mjs'

test('sse-client 性质：401 致命 / 409、410 resetCursor / 心跳无害 / 断连无重复且 since 正确', async () => {
  await runSseClientProperties()
})

test('sse-client 模糊：120 次随机分块+断连，0 failures 且四类策略均覆盖', async () => {
  const result = await runSseClientFuzz({ iterations: 120, seed: 20261110 })
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures.slice(0, 2)))
  assert.equal(result.totalIterations, 120)
  const total = Object.values(result.strategyCounts).reduce((sum, count) => sum + count, 0)
  assert.equal(total, 120)
  for (const strategy of SSE_CLIENT_STRATEGIES) {
    assert.ok(result.strategyCounts[strategy] > 0, `strategy not exercised: ${strategy}`)
  }
})

test('sse-client 模糊：同 seed 结果可复现（零失败）', async () => {
  const first = await runSseClientFuzz({ iterations: 8, seed: 987654321 })
  const second = await runSseClientFuzz({ iterations: 8, seed: 987654321 })
  assert.equal(first.failures.length, 0)
  assert.equal(second.failures.length, 0)
  assert.deepEqual(first.strategyCounts, second.strategyCounts)
})
