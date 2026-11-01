// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// SseParser 模糊测试（契约：docs/FUZZ-SSE-PARSER.md）。
// 固定种子的小批量 fuzz 进 CI；大批量用 CLI：node tools/fuzz/sse-parser-fuzz.mjs。
import test from 'node:test'
import assert from 'node:assert/strict'

import { SseParser } from '../src/lib/sse-parser.mjs'
import { generateInput } from '../tools/fuzz/sse-generators.mjs'
import {
  buildChunkStrategies,
  framesEqual,
  parseAll,
  parseByteChunks,
  parseChunks,
  referenceParse,
  serializeFrames,
} from '../tools/fuzz/sse-invariants.mjs'
import { XorShift128 } from '../tools/fuzz/sse-rng.mjs'
import { runPropertyTests, runSseParserFuzz } from '../tools/fuzz/sse-parser-fuzz.mjs'

const failureText = (result) => JSON.stringify(result.failures[0], null, 2)

test('fuzz properties：帧边界 / 多行 data / CRLF / flush / 超长行 / UTF-8 字节切分', () => {
  runPropertyTests()
})

test('fuzz 固定种子：分块等价 + 参考实现 + roundtrip + flush 不变量', () => {
  for (const seed of [1, 2, 3, 42, 1337, 0xdeadbeef]) {
    const result = runSseParserFuzz({ iterations: 25, seed, stopOnFirstFailure: true })
    assert.equal(result.failures.length, 0, `seed ${seed} failed:\n${failureText(result)}`)
    assert.equal(result.totalIterations, 25)
  }
})

test('fuzz 默认随机种子 smoke（不固定 seed 也能跑通）', () => {
  const result = runSseParserFuzz({ iterations: 15, stopOnFirstFailure: true })
  assert.equal(result.failures.length, 0, failureText(result))
  assert.ok(Number.isInteger(result.seed))
})

test('随机数可复现：同 seed → 同输入；同 seed → 同 fuzz 结果', () => {
  const rngA = new XorShift128(987654321)
  const rngB = new XorShift128(987654321)
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(generateInput(rngA), generateInput(rngB))
  }

  const first = runSseParserFuzz({ iterations: 10, seed: 20261101 })
  const second = runSseParserFuzz({ iterations: 10, seed: 20261101 })
  assert.equal(first.seed, second.seed)
  assert.equal(first.totalIterations, second.totalIterations)
  assert.equal(first.failures.length, second.failures.length)
})

test('已知边界：CRLF / 多行 data / 无 data 帧 / 参考实现一致', () => {
  const input = 'id: 1\r\nevent: adapter\r\ndata: {"a":1}\r\ndata: {"b":2}\r\n\r\n' +
    'id: 2\ndata: <html>\ndata: not a frame delimiter\n\ndata: plain\n\n' +
    'id: 3\nevent: extra\n\n'
  const expected = parseAll(input)
  const reference = referenceParse(input)
  assert.deepEqual(expected, reference)
  assert.equal(expected.length, 3)
  assert.equal(expected[0].id, '1')
  assert.equal(expected[0].event, 'adapter')
  assert.equal(expected[0].data, '{"a":1}\n{"b":2}')
  assert.equal(expected[1].data, '<html>\nnot a frame delimiter')
  assert.equal(expected[2].data, 'plain')
  assert.equal(expected[2].id, undefined, 'dispatch 后 id 重置，不会被后续帧继承')

  for (const strategy of buildChunkStrategies(input, new XorShift128(7))) {
    assert.deepEqual(parseChunks(strategy.chunks), expected, `strategy ${strategy.name}`)
  }
  assert.deepEqual(parseByteChunks(input, new XorShift128(9)), expected, 'byte chunking')
})

test('roundtrip：解析结果重新序列化后再次解析，帧序列一致', () => {
  const input = 'id: 5\nevent: adapter\ndata: line-1\ndata: line-2\n\ndata: tail\n\n'
  const frames = parseAll(input)
  const reparsed = parseAll(serializeFrames(frames))
  const cmp = framesEqual(frames, reparsed)
  assert.equal(cmp.equal, true, cmp.reason)
})

test('flush 丢弃残帧后解析器可继续使用（不泄漏状态）', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('id: 9\ndata: half'), [])
  assert.deepEqual(parser.flush(), [])
  assert.deepEqual(parser.flush(), [])
  const frames = parser.push('id: 10\ndata: full\n\n')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].id, '10')
  assert.equal(frames[0].data, 'full')
})
