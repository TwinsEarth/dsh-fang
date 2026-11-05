// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.6.9 — SseParser 定向生成器：为每个已知分支构造“边界恰好命中”的最小输入。
//
// 与随机生成器互补：
//   * sse-generators.mjs 随机覆盖广度（字段组合、chunk 形状、UTF-8、超长行）；
//   * 本文件定向覆盖深度（每个分支的精确边界，且带 expectedFrames 锁语义）；
//   * runDirectedSmokeTest() 在 CI 里先跑一遍全量定向用例（一次性解析 + 6 种分块等价性）；
//   * 随机模糊循环按 directedProb 混入定向输入，并统计分支命中（零命中可告警）。
import { XorShift128 } from './sse-rng.mjs'
import { generateInput } from './sse-generators.mjs'
import {
  buildChunkStrategies,
  framesEqual,
  parseAll,
  parseChunks,
} from './sse-invariants.mjs'

/** 九个分支（与 SseParser 的代码路径一一对应）。 */
export const ALL_BRANCHES = Object.freeze([
  'cr-trimming',
  'multi-line-data',
  'empty-data-dropped',
  'comment-ignored',
  'space-trimming',
  'field-override',
  'retry-and-unknown',
  'data-field-edge',
  'buffer-boundary',
])

/**
 * @typedef {object} DirectedCase
 * @property {string} input                     最小化输入
 * @property {string} description               命中的边界
 * @property {Array<{id?:string,event?:string,data:string}>} [expectedFrames] 预期帧（可选）
 */

/** @type {Record<string, DirectedCase[]>} */
export const DIRECTED_CASES = Object.freeze({
  // 分支 1：CR 裁剪（line.endsWith('\r') → slice(0,-1)）——只裁一个，中间的保留。
  'cr-trimming': [
    { input: 'data: x\r\n\n', description: 'one trailing CR stripped', expectedFrames: [{ data: 'x' }] },
    { input: 'data: x\r\r\n\n', description: 'two trailing CRs, only one stripped', expectedFrames: [{ data: 'x\r' }] },
    { input: 'data: x\r\r\r\n\n', description: 'three trailing CRs, only one stripped', expectedFrames: [{ data: 'x\r\r' }] },
    { input: 'data: x\rfoo\n\n', description: 'CR in middle preserved', expectedFrames: [{ data: 'x\rfoo' }] },
    { input: 'data: x\r\n\r\n', description: 'CRLF throughout', expectedFrames: [{ data: 'x' }] },
    { input: '\r\n\r\n', description: 'CRLF blank lines only', expectedFrames: [] },
    { input: 'data: \r\n\n', description: 'CR then empty value', expectedFrames: [{ data: '' }] },
    { input: 'data: x\n\r\n', description: 'CR on blank line after LF', expectedFrames: [{ data: 'x' }] },
  ],

  // 分支 2：多行 data 用 '\n' 拼接（空值也参与拼接）。
  'multi-line-data': [
    { input: 'data: a\ndata: b\n\n', description: 'two lines', expectedFrames: [{ data: 'a\nb' }] },
    { input: 'data: a\ndata: b\ndata: c\n\n', description: 'three lines', expectedFrames: [{ data: 'a\nb\nc' }] },
    { input: 'data:\ndata:\n\n', description: 'two empty lines', expectedFrames: [{ data: '\n' }] },
    { input: 'data: a\ndata:\ndata: c\n\n', description: 'middle line empty', expectedFrames: [{ data: 'a\n\nc' }] },
    { input: 'data:\ndata: a\n\n', description: 'first line empty', expectedFrames: [{ data: '\na' }] },
    { input: 'data: a\ndata:\n\n', description: 'last line empty', expectedFrames: [{ data: 'a\n' }] },
    { input: 'data: \ndata: \n\n', description: 'space-only lines become empty', expectedFrames: [{ data: '\n' }] },
  ],

  // 分支 3：空 data 帧丢弃（dataLines.length === 0 → null；id/event 同时被重置）。
  'empty-data-dropped': [
    { input: 'id: 1\n\n', description: 'id only', expectedFrames: [] },
    { input: 'event: x\n\n', description: 'event only', expectedFrames: [] },
    { input: 'id: 1\nevent: x\n\n', description: 'id+event without data', expectedFrames: [] },
    { input: '\n\n', description: 'pure blank line', expectedFrames: [] },
    { input: '\n\n\n\n', description: 'consecutive blank lines', expectedFrames: [] },
    { input: ': c\n\n', description: 'comment only', expectedFrames: [] },
    { input: 'retry: 100\n\n', description: 'retry only', expectedFrames: [] },
    { input: 'foo: bar\n\n', description: 'unknown field only', expectedFrames: [] },
    { input: 'id: 1\n\nid: 2\ndata: y\n\n', description: 'id reset by empty-data blank line', expectedFrames: [{ id: '2', data: 'y' }] },
  ],

  // 分支 4：注释忽略（line.startsWith(':')）——不产生帧、不改状态。
  'comment-ignored': [
    { input: ': c\n\n', description: 'single comment', expectedFrames: [] },
    { input: ': c\n: c2\n\n', description: 'two consecutive comments', expectedFrames: [] },
    { input: ':\n\n', description: 'empty comment', expectedFrames: [] },
    { input: ':\r\n\r\n', description: 'empty comment with CRLF', expectedFrames: [] },
    { input: 'data: a\n: c\ndata: b\n\n', description: 'comment between data lines', expectedFrames: [{ data: 'a\nb' }] },
    { input: ': c\ndata: a\n\n', description: 'comment before data', expectedFrames: [{ data: 'a' }] },
    { input: 'data: a\n: c\n\n', description: 'comment after data', expectedFrames: [{ data: 'a' }] },
    { input: ': data: x\n\n', description: 'comment that looks like a data field', expectedFrames: [] },
    { input: ': id: 1\n: event: x\n\n', description: 'comments with fake fields', expectedFrames: [] },
  ],

  // 分支 5：冒号后只裁一个空格（value.startsWith(' ') → slice(1)）。
  'space-trimming': [
    { input: 'data:x\n\n', description: 'no space after colon', expectedFrames: [{ data: 'x' }] },
    { input: 'data: x\n\n', description: 'one space stripped', expectedFrames: [{ data: 'x' }] },
    { input: 'data:  x\n\n', description: 'two spaces, only one stripped', expectedFrames: [{ data: ' x' }] },
    { input: 'data:   x\n\n', description: 'three spaces, only one stripped', expectedFrames: [{ data: '  x' }] },
    { input: 'data: \n\n', description: 'one space becomes empty', expectedFrames: [{ data: '' }] },
    { input: 'data:  \n\n', description: 'two spaces become one', expectedFrames: [{ data: ' ' }] },
    { input: 'data:\n\n', description: 'no space, empty value', expectedFrames: [{ data: '' }] },
  ],

  // 分支 6：id/event 最后写入者胜；data 累积。
  'field-override': [
    { input: 'id: 1\nid: 2\ndata: x\n\n', description: 'id override', expectedFrames: [{ id: '2', data: 'x' }] },
    { input: 'event: a\nevent: b\ndata: x\n\n', description: 'event override', expectedFrames: [{ event: 'b', data: 'x' }] },
    { input: 'id: 1\nevent: e\ndata: a\ndata: b\n\n', description: 'full mix', expectedFrames: [{ id: '1', event: 'e', data: 'a\nb' }] },
    { input: 'data: x\nid: 1\n\n', description: 'data before id', expectedFrames: [{ id: '1', data: 'x' }] },
    { input: 'event: e\ndata: x\n\n', description: 'event before data', expectedFrames: [{ event: 'e', data: 'x' }] },
    { input: 'id: 1\n\nid: 2\ndata: y\n\n', description: 'id reset between frames', expectedFrames: [{ id: '2', data: 'y' }] },
  ],

  // 分支 7：retry 与未知字段忽略（不产生帧、不改状态）。
  'retry-and-unknown': [
    { input: 'retry: 100\n\n', description: 'retry only', expectedFrames: [] },
    { input: 'retry: 100\ndata: x\n\n', description: 'retry with data', expectedFrames: [{ data: 'x' }] },
    { input: 'data: x\nretry: 100\n\n', description: 'retry after data', expectedFrames: [{ data: 'x' }] },
    { input: 'foo: bar\n\n', description: 'unknown only', expectedFrames: [] },
    { input: 'foo: bar\ndata: x\n\n', description: 'unknown with data', expectedFrames: [{ data: 'x' }] },
    { input: 'retry: 100\nfoo: bar\ndata: x\n\n', description: 'retry + unknown + data', expectedFrames: [{ data: 'x' }] },
  ],

  // 分支 8：data 无冒号（colon === -1 → field=line, value=''）——仍算一条 data 行。
  'data-field-edge': [
    { input: 'data\n\n', description: 'no colon, empty value', expectedFrames: [{ data: '' }] },
    { input: 'data\ndata\n\n', description: 'two colon-less data lines', expectedFrames: [{ data: '\n' }] },
    { input: 'data\nid: 1\n\n', description: 'colon-less data before id', expectedFrames: [{ id: '1', data: '' }] },
    { input: 'id: 1\ndata\n\n', description: 'colon-less data after id', expectedFrames: [{ id: '1', data: '' }] },
  ],

  // 分支 9：buffer 边界（行/帧未完成时不 dispatch；flush 丢弃残帧）。
  'buffer-boundary': [
    { input: 'data: x\n\n', description: 'complete frame', expectedFrames: [{ data: 'x' }] },
    { input: 'data: x\n', description: 'line complete but no blank line', expectedFrames: [] },
    { input: 'data: x', description: 'no line terminator', expectedFrames: [] },
    { input: '\n\n', description: 'blank lines only', expectedFrames: [] },
    { input: 'id: 1\ndata: x\n\nid: 2\ndata: y\n\n', description: 'two frames separated by blank line', expectedFrames: [{ id: '1', data: 'x' }, { id: '2', data: 'y' }] },
  ],
})

/** 定向用例总数（测试断言用）。 */
export const DIRECTED_CASE_COUNT = ALL_BRANCHES.reduce((sum, branch) => sum + DIRECTED_CASES[branch].length, 0)

/** @param {string} s @returns {number} */
function hash32(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 随机选一个定向用例。
 * @param {{int:(max:number)=>number, pick:<T>(arr:readonly T[])=>T}} rng
 * @returns {{input:string, description:string, branch:string}}
 */
export function pickDirected(rng) {
  const branch = rng.pick(ALL_BRANCHES)
  const testCase = rng.pick(DIRECTED_CASES[branch])
  return { input: testCase.input, description: `[${branch}] ${testCase.description}`, branch }
}

/**
 * 混合生成：以 directedProb 概率选定向用例，否则走随机生成器。
 * @param {object} rng
 * @param {{directedProb?:number, randomInput?:(rng:object)=>{input:string,description:string}}} [options]
 * @returns {{input:string, description:string, branch?:string}}
 */
export function generateMixed(rng, { directedProb = 0.3, randomInput = generateInput } = {}) {
  const p = Number.isFinite(Number(directedProb)) ? Math.min(1, Math.max(0, Number(directedProb))) : 0.3
  if (rng.float() < p) return pickDirected(rng)
  const generated = randomInput(rng)
  return { input: generated.input, description: generated.description }
}

/**
 * 定向 smoke test：每条用例验证
 *   1. 一次性解析不抛错；
 *   2. expectedFrames（若有）完全匹配；
 *   3. 6 种字符串分块策略各跑 3 个不同种子，结果与一次性解析等价。
 * 支持注入 parseAll/parseChunks（用于 mutation 测试：证明用例能抓到错误实现）。
 * @param {{parseAll?:(input:string)=>object[], parseChunks?:(chunks:string[])=>object[]}} [overrides]
 * @returns {{totalCases:number, passed:number, failures:object[], branchCounts:Record<string,number>}}
 */
export function runDirectedSmokeTest({ parseAll: parseOne = parseAll, parseChunks: parseChunked = parseChunks } = {}) {
  const branchCounts = Object.fromEntries(ALL_BRANCHES.map((branch) => [branch, 0]))
  const failures = []
  let totalCases = 0
  let passed = 0

  for (const branch of ALL_BRANCHES) {
    for (const testCase of DIRECTED_CASES[branch]) {
      totalCases += 1
      branchCounts[branch] += 1

      let actual
      try {
        actual = parseOne(testCase.input)
      } catch (e) {
        failures.push({
          branch,
          description: testCase.description,
          input: testCase.input,
          reason: `parse threw: ${String(e?.message ?? e)}`,
        })
        continue
      }

      if (testCase.expectedFrames) {
        const cmp = framesEqual(testCase.expectedFrames, actual)
        if (!cmp.equal) {
          failures.push({
            branch,
            description: testCase.description,
            input: testCase.input,
            reason: `expected mismatch: ${cmp.reason}`,
            expected: testCase.expectedFrames,
            actual,
          })
          continue
        }
      }

      let ok = true
      for (let trial = 0; trial < 3 && ok; trial += 1) {
        const rng = new XorShift128(hash32(testCase.input) ^ trial)
        for (const strategy of buildChunkStrategies(testCase.input, rng)) {
          let chunked
          try {
            chunked = parseChunked(strategy.chunks)
          } catch (e) {
            failures.push({
              branch,
              description: `${testCase.description} [${strategy.name}]`,
              input: testCase.input,
              reason: `chunked parse threw: ${String(e?.message ?? e)}`,
            })
            ok = false
            break
          }
          const cmp = framesEqual(actual, chunked)
          if (!cmp.equal) {
            failures.push({
              branch,
              description: `${testCase.description} [${strategy.name}]`,
              input: testCase.input,
              reason: `chunked mismatch: ${cmp.reason}`,
              expected: actual,
              actual: chunked,
            })
            ok = false
            break
          }
        }
      }
      if (ok) passed += 1
    }
  }

  return { totalCases, passed, failures, branchCounts }
}
