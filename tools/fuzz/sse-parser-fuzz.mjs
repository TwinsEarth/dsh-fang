// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// SSE 解析器模糊测试 runner + 性质断言 + CLI。
//
// 用法：
//   node tools/fuzz/sse-parser-fuzz.mjs                          # 5000 iters，随机 seed
//   node tools/fuzz/sse-parser-fuzz.mjs --iterations 20000       # 指定次数
//   node tools/fuzz/sse-parser-fuzz.mjs --iterations 1 --seed 123 # 复现单条
//   node tools/fuzz/sse-parser-fuzz.mjs --stop-on-first          # 遇到第一条失败立即停
//
// 失败报告包含 iterationSeed / iteration / inputHex / chunks，可直接用 seed 重放。
import { pathToFileURL } from 'node:url'
import { SseParser } from '../../src/lib/sse-parser.mjs'
import { XorShift128 } from './sse-rng.mjs'
import { generateInput } from './sse-generators.mjs'
import { ALL_BRANCHES, generateMixed, runDirectedSmokeTest } from './sse-directed.mjs'
import {
  buildChunkStrategies,
  framesEqual,
  parseAll,
  parseByteChunks,
  parseChunks,
  referenceParse,
  roundtripSafe,
  serializeFrames,
  toHex,
} from './sse-invariants.mjs'

const msgOf = (e) => String(e && e.message !== undefined ? e.message : e)

/**
 * @typedef {object} FuzzFailure
 * @property {number} seed          该 iteration 的独立种子（可直接重放）
 * @property {number} iteration
 * @property {string} description
 * @property {string} kind          baseline-threw / reference-mismatch / chunk-mismatch / byte-chunk-mismatch / roundtrip-mismatch / flush-leak
 * @property {string} reason
 * @property {string} input
 * @property {string} inputHex
 * @property {string[]} chunks
 * @property {object[]} expected
 * @property {object[]} actual
 */

/**
 * 主模糊循环：输入 → 基准解析（一次性）→ 参考实现 oracle → 6 种字符串分块 →
 * 字节级分块 → roundtrip → flush 不变量。
 *
 * @param {{iterations?:number, seed?:number, stopOnFirstFailure?:boolean,
 *          directedProb?:number, directed?:boolean}} [options]
 * @returns {{seed:number, totalIterations:number, failures:FuzzFailure[],
 *           branchCounts:Record<string,number>, directedHits:number, randomHits:number}}
 */
export function runSseParserFuzz({
  iterations = 5000,
  seed,
  stopOnFirstFailure = false,
  directedProb = 0.3,
  directed = true,
} = {}) {
  const requested = Math.floor(Number(iterations))
  const total = Number.isFinite(requested) && requested > 0 ? requested : 0
  const baseSeed = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : (Date.now() & 0x7fffffff)
  const failures = []
  const branchCounts = Object.fromEntries(ALL_BRANCHES.map((branch) => [branch, 0]))
  let directedHits = 0
  let randomHits = 0
  let completed = 0
  const summary = () => ({ seed: baseSeed, totalIterations: completed, failures, branchCounts, directedHits, randomHits })

  for (let i = 0; i < total; i += 1) {
    const iterationSeed = (baseSeed + Math.imul(i, 0x9e3779b1)) >>> 0
    const rng = new XorShift128(iterationSeed)
    const generated = directed
      ? generateMixed(rng, { directedProb })
      : { ...generateInput(rng) }
    const { input, description, branch } = generated
    if (branch) {
      branchCounts[branch] += 1
      directedHits += 1
    } else {
      randomHits += 1
    }
    const record = (kind, reason, chunks, expected, actual) => {
      failures.push({
        seed: iterationSeed,
        iteration: i,
        description,
        branch: branch ?? null,
        kind,
        reason,
        input,
        inputHex: toHex(input),
        chunks,
        expected,
        actual,
      })
    }

    let expected
    try {
      expected = parseAll(input)
    } catch (e) {
      record('baseline-threw', `baseline threw: ${msgOf(e)}`, [], [], [])
      completed += 1
      if (stopOnFirstFailure) return summary()
      continue
    }

    // I2：参考实现 oracle（独立的一次性解析器）
    try {
      const reference = referenceParse(input)
      const cmp = framesEqual(expected, reference)
      if (!cmp.equal) record('reference-mismatch', cmp.reason, [], expected, reference)
    } catch (e) {
      record('reference-threw', `reference threw: ${msgOf(e)}`, [], expected, [])
    }

    // I1：字符串分块等价性
    let strategiesOk = true
    for (const strategy of buildChunkStrategies(input, rng)) {
      let actual
      try {
        actual = parseChunks(strategy.chunks)
      } catch (e) {
        record('strategy-threw', `${strategy.name} threw: ${msgOf(e)}`, strategy.chunks, expected, [])
        strategiesOk = false
        break
      }
      const cmp = framesEqual(expected, actual)
      if (!cmp.equal) {
        record('chunk-mismatch', `${strategy.name}: ${cmp.reason}`, strategy.chunks, expected, actual)
        strategiesOk = false
        break
      }
    }

    // I1b：字节级切分（TextDecoder streaming，模拟 res.setEncoding('utf8')）
    if (strategiesOk) {
      try {
        const actual = parseByteChunks(input, rng)
        const cmp = framesEqual(expected, actual)
        if (!cmp.equal) record('byte-chunk-mismatch', cmp.reason, [], expected, actual)
      } catch (e) {
        record('byte-chunk-threw', `byte chunks threw: ${msgOf(e)}`, [], expected, [])
      }
    }

    // I3：roundtrip（可无损序列化时）
    if (strategiesOk && roundtripSafe(expected)) {
      try {
        const reparsed = parseAll(serializeFrames(expected))
        const cmp = framesEqual(expected, reparsed)
        if (!cmp.equal) record('roundtrip-mismatch', cmp.reason, [], expected, reparsed)
      } catch (e) {
        record('roundtrip-threw', `roundtrip threw: ${msgOf(e)}`, [], expected, [])
      }
    }

    // I5：flush 必须丢弃残帧，不得泄漏
    try {
      const parser = new SseParser()
      parser.push(input)
      const flushed = [...parser.flush(), ...parser.flush()]
      if (flushed.length !== 0) record('flush-leak', 'flush must discard partial frames', [], expected, flushed)
    } catch (e) {
      record('flush-threw', `flush threw: ${msgOf(e)}`, [], expected, [])
    }

    completed += 1
    if (stopOnFirstFailure && failures.length > 0) {
      return summary()
    }
  }

  return summary()
}

function check(condition, label) {
  if (!condition) throw new Error(`[property] ${label}`)
}

/**
 * 性质断言（不依赖随机循环，每次运行都执行，覆盖 I2–I6 的确定性边界）。
 * @returns {void}
 */
export function runPropertyTests() {
  // 空输入 / 纯空行 / 纯注释
  check(parseAll('').length === 0, 'empty input must not produce frames')
  check(parseAll('\n\n').length === 0, 'blank lines only')
  check(parseAll('\n').length === 0, 'single LF')
  check(parseAll(': comment\n\n').length === 0, 'single comment')
  check(parseAll(': a\n: b\n\n').length === 0, 'multi comment')

  // 帧边界：data 中的 \n 不切帧，只有空行切帧
  const two = parseAll('data: a\n\ndata: b\n\n')
  check(two.length === 2, 'two frames')
  check(two[0].data === 'a' && two[1].data === 'b', 'frame boundary data')

  // 多行 data 用 \n 拼接
  const multi = parseAll('data: a\ndata: b\ndata: c\n\n')
  check(multi.length === 1, 'multi-line single frame')
  check(multi[0].data === 'a\nb\nc', 'multi-line joined by LF')

  // 行尾：LF / CRLF / CRLF+多一个 CR（只裁一个尾部 \r）
  const lf = parseAll('data: x\n\n')
  check(lf.length === 1 && lf[0].data === 'x', 'LF frame')
  const crlf = parseAll('data: x\r\n\r\n')
  check(crlf.length === 1 && crlf[0].data === 'x', 'CRLF strips trailing CR')
  const mixed = parseAll('data: x\r\r\n\r\n\r\n')
  check(mixed.length === 1 && mixed[0].data === 'x\r', 'only one trailing CR stripped')

  // 无 data 的帧必须丢弃；未知字段 / retry 忽略
  check(parseAll('id: 1\nevent: x\n\n').length === 0, 'id/event without data')
  check(parseAll('retry: 2000\ndata: ok\n\n')[0].data === 'ok', 'retry ignored, data kept')
  check(parseAll('foo: bar\ndata: ok\n\n')[0].data === 'ok', 'unknown field ignored')

  // 超长单行不崩溃
  const long = 'x'.repeat(1_000_000)
  const longFrame = parseAll(`data: ${long}\n\n`)
  check(longFrame.length === 1 && longFrame[0].data === long, 'long line content')

  // flush：丢弃残帧、幂等，且重置后可以继续正常工作
  const parser = new SseParser()
  parser.push('data: partial')
  check(parser.flush().length === 0, 'flush discards partial frame')
  check(parser.flush().length === 0, 'flush idempotent')
  const afterFlush = parser.push('data: fresh\n\n')
  check(afterFlush.length === 1 && afterFlush[0].data === 'fresh', 'parser usable after flush')

  // 字节级：跨 chunk 的 UTF-8 多字节字符
  const unicode = 'data: 你好🌍\n\n'
  const bytes = new TextEncoder().encode(unicode)
  const decoder = new TextDecoder()
  const byteParser = new SseParser()
  const byteFrames = []
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const text = decoder.decode(bytes.subarray(offset, offset + 2), { stream: true })
    if (text) byteFrames.push(...byteParser.push(text))
  }
  const tail = decoder.decode()
  if (tail) byteFrames.push(...byteParser.push(tail))
  check(byteFrames.length === 1 && byteFrames[0].data === '你好🌍', 'UTF-8 across byte chunks')
}

function formatFailure(failure) {
  return [
    '=== FAILURE ===',
    `iterationSeed: ${failure.seed}`,
    `iteration: ${failure.iteration}`,
    `description: ${failure.description}`,
    `branch: ${failure.branch ?? 'random'}`,
    `kind: ${failure.kind}`,
    `reason: ${failure.reason}`,
    `input: ${JSON.stringify(failure.input)}`,
    `inputHex: ${failure.inputHex.slice(0, 400)}${failure.inputHex.length > 400 ? '…' : ''}`,
    `chunks: ${failure.chunks.slice(0, 8).map((c) => JSON.stringify(c)).join(' | ')}`,
    `expected: ${JSON.stringify(failure.expected)}`,
    `actual:   ${JSON.stringify(failure.actual)}`,
  ].join('\n')
}

/**
 * CLI 入口。
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const at = argv.indexOf(name)
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
  }
  const iterations = Number(getArg('--iterations', '5000'))
  const seedArg = getArg('--seed', '')
  const stopOnFirstFailure = argv.includes('--stop-on-first')
  const directed = !argv.includes('--no-directed')
  const directedProbRaw = Number(getArg('--directed-prob', '0.3'))
  const directedProb = Number.isFinite(directedProbRaw) ? Math.min(1, Math.max(0, directedProbRaw)) : 0.3

  try {
    runPropertyTests()
    console.log('[properties] all passed')
  } catch (e) {
    console.error(`[properties] FAILED: ${msgOf(e)}`)
    return 2
  }

  // 定向 smoke：每个已知分支的最小输入 + expectedFrames + 6 种分块等价性。
  const smoke = runDirectedSmokeTest()
  if (smoke.failures.length > 0) {
    console.error(`[directed] ${smoke.failures.length} failure(s) / ${smoke.totalCases} cases`)
    for (const failure of smoke.failures.slice(0, 5)) {
      console.error(`  ${failure.branch} | ${failure.description}`)
      console.error(`    input:  ${JSON.stringify(failure.input)}`)
      console.error(`    reason: ${failure.reason}`)
    }
    return 3
  }
  console.log(`[directed] ${smoke.passed}/${smoke.totalCases} cases passed`)
  console.log(`[directed] branches: ${ALL_BRANCHES.length} (${Object.entries(smoke.branchCounts).map(([b, n]) => `${b}=${n}`).join(', ')})`)

  const result = runSseParserFuzz({
    iterations,
    seed: seedArg === '' ? undefined : Number(seedArg),
    stopOnFirstFailure,
    directedProb,
    directed,
  })
  console.log(
    `[fuzz] seed=${result.seed} iterations=${result.totalIterations} failures=${result.failures.length} ` +
      `directed=${result.directedHits} random=${result.randomHits}`,
  )
  if (directed) {
    console.log('[fuzz] branch coverage:')
    for (const branch of ALL_BRANCHES) {
      const n = result.branchCounts[branch]
      const pct = result.directedHits > 0 ? ((n / result.directedHits) * 100).toFixed(1) : '0.0'
      console.log(`  ${branch}: ${n} (${pct}%)`)
    }
    if (result.directedHits > 100) {
      const zeroHits = ALL_BRANCHES.filter((branch) => result.branchCounts[branch] === 0)
      if (zeroHits.length > 0) console.warn(`[fuzz] WARN: zero-hit branches: ${zeroHits.join(', ')}`)
    }
  }
  if (result.failures.length === 0) return 0

  for (const failure of result.failures.slice(0, 5)) console.error(`\n${formatFailure(failure)}`)
  console.error(`\nReproduce: node tools/fuzz/sse-parser-fuzz.mjs --iterations 1 --seed ${result.failures[0].seed}`)
  return 1
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) process.exitCode = main()
