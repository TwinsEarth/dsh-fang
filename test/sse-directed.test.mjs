// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v2.6.9 定向生成器测试：用例完整性、smoke、mutation 检出、混合策略、fuzz 分支覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'

import { XorShift128 } from '../tools/fuzz/sse-rng.mjs'
import { parseAll } from '../tools/fuzz/sse-invariants.mjs'
import {
  ALL_BRANCHES,
  DIRECTED_CASES,
  DIRECTED_CASE_COUNT,
  generateMixed,
  pickDirected,
  runDirectedSmokeTest,
} from '../tools/fuzz/sse-directed.mjs'
import { runSseParserFuzz } from '../tools/fuzz/sse-parser-fuzz.mjs'

test('directed: 9 个分支、每分支 ≥3 条、用例数固定且描述唯一', () => {
  assert.equal(ALL_BRANCHES.length, 9)
  for (const branch of ALL_BRANCHES) {
    assert.ok(DIRECTED_CASES[branch], `branch ${branch} missing`)
    assert.ok(DIRECTED_CASES[branch].length >= 3, `branch ${branch} needs at least 3 cases`)
  }
  assert.equal(DIRECTED_CASE_COUNT, 61)
  const descriptions = ALL_BRANCHES.flatMap((branch) => DIRECTED_CASES[branch].map((c) => `${branch}:${c.description}`))
  assert.equal(new Set(descriptions).size, descriptions.length, 'descriptions must be unique')
})

test('directed smoke: 全部用例一次性解析 + 6 种分块等价性通过', () => {
  const result = runDirectedSmokeTest()
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures.slice(0, 3)))
  assert.equal(result.passed, result.totalCases)
  assert.equal(result.totalCases, DIRECTED_CASE_COUNT)
  for (const branch of ALL_BRANCHES) assert.ok(result.branchCounts[branch] >= 3)
})

test('directed smoke: expectedFrames 覆盖关键分支（不只是分块等价性）', () => {
  const withExpected = ALL_BRANCHES.flatMap((branch) => DIRECTED_CASES[branch]).filter((c) => c.expectedFrames)
  assert.ok(withExpected.length >= 40, `expectedFrames cases: ${withExpected.length}`)
  // 每个分支至少有一条锁语义的 expectedFrames。
  for (const branch of ALL_BRANCHES) {
    assert.ok(DIRECTED_CASES[branch].some((c) => c.expectedFrames), `${branch} needs expectedFrames`)
  }
})

test('directed smoke: 错误实现（裁掉所有尾部 CR）会被定向用例抓到', () => {
  const naiveTrimAll = (input) => parseAll(input.replace(/\r+$/gm, ''))
  const result = runDirectedSmokeTest({ parseAll: naiveTrimAll })
  assert.ok(result.failures.length > 0, 'mutation must be detected')
  assert.ok(result.failures.some((f) => f.branch === 'cr-trimming'))
  assert.ok(result.failures.some((f) => /only one stripped/.test(f.description)))
})

test('directed mixed: 同 seed 确定性；prob=0 全随机；prob=1 全定向', () => {
  const a = generateMixed(new XorShift128(12345), { directedProb: 0.3 })
  const b = generateMixed(new XorShift128(12345), { directedProb: 0.3 })
  assert.deepEqual(a, b)

  for (let i = 0; i < 20; i += 1) {
    const random = generateMixed(new XorShift128(1000 + i), { directedProb: 0 })
    assert.equal(random.branch, undefined)
  }
  for (let i = 0; i < 20; i += 1) {
    const directed = generateMixed(new XorShift128(2000 + i), { directedProb: 1 })
    assert.ok(ALL_BRANCHES.includes(directed.branch))
  }
})

test('directed pick: 均匀抽样能覆盖全部 9 个分支', () => {
  const rng = new XorShift128(20261109)
  const seen = new Set()
  for (let i = 0; i < 900; i += 1) seen.add(pickDirected(rng).branch)
  assert.equal(seen.size, ALL_BRANCHES.length)
})

test('fuzz 集成: directedProb=1 时 900 次迭代全部为定向且每分支命中 >0', () => {
  const result = runSseParserFuzz({ iterations: 900, seed: 20261109, directedProb: 1 })
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures.slice(0, 2)))
  assert.equal(result.directedHits, 900)
  assert.equal(result.randomHits, 0)
  assert.equal(result.totalIterations, 900)
  for (const branch of ALL_BRANCHES) assert.ok(result.branchCounts[branch] > 0, `zero-hit branch: ${branch}`)
  const sum = ALL_BRANCHES.reduce((total, branch) => total + result.branchCounts[branch], 0)
  assert.equal(sum, 900)
})

test('fuzz 集成: directed=false 时全部随机（branchCounts 全 0）；同 seed 可复现', () => {
  const off = runSseParserFuzz({ iterations: 50, seed: 777, directed: false })
  assert.equal(off.directedHits, 0)
  assert.equal(off.randomHits, 50)
  for (const branch of ALL_BRANCHES) assert.equal(off.branchCounts[branch], 0)
  assert.equal(off.failures.length, 0)

  const first = runSseParserFuzz({ iterations: 30, seed: 999, directedProb: 0.5 })
  const second = runSseParserFuzz({ iterations: 30, seed: 999, directedProb: 0.5 })
  assert.deepEqual(first.failures, second.failures)
  assert.deepEqual(first.branchCounts, second.branchCounts)
  assert.equal(first.directedHits, second.directedHits)
})
