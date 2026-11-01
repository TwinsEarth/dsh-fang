// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// SSE 模糊测试输入生成器：合法帧 / 多帧 / 帧+噪声 / 纯噪声 / 超长 data /
// id-event 无 data / 注释 / 换行符混合 / 截断残帧。
// 生成只使用 printable ASCII + 少量 Unicode 样本，避免不可打印字节把失败报告变得不可读；
// 纯随机字节流由 invariant 层的 TextDecoder 策略单独覆盖。
import { XorShift128 } from './sse-rng.mjs'

const UNICODE_SAMPLES = ['你好', 'こんにちは', '👋', '🌍', 'ünïcödé', 'a', 'x', 'Y', '0']
const EVENT_NAMES = ['message', 'adapter', 'command-progress', 'x-', 'frame']

/** @param {XorShift128} rng @param {number} max @returns {string} */
function printable(rng, max) {
  const n = rng.int(max + 1)
  let s = ''
  for (let i = 0; i < n; i += 1) s += String.fromCharCode(32 + rng.int(95))
  return s
}

/**
 * 生成一个“帧片段”（可能含 data，也可能只有 id/event；以空行结束）。
 * @param {XorShift128} rng
 * @returns {string}
 */
export function generateFrame(rng) {
  const parts = []
  if (rng.bool(0.4)) parts.push(`id: ${rng.int(100000)}`)
  if (rng.bool(0.5)) parts.push(`event: ${rng.pick(EVENT_NAMES)}${rng.bool(0.3) ? rng.int(100) : ''}`)

  const dataCount = rng.int(6)
  for (let i = 0; i < dataCount; i += 1) {
    let value
    if (rng.bool(0.1)) value = ''
    else if (rng.bool(0.2)) {
      const n = 1 + rng.int(3)
      value = Array.from({ length: n }, () => rng.pick(UNICODE_SAMPLES)).join('')
    } else value = printable(rng, 40)
    parts.push(`${rng.bool(0.3) ? 'data:' : 'data: '}${value}`)
  }
  if (rng.bool(0.2)) parts.unshift(`: comment ${rng.int(100)}`)

  const nl = rng.pick(['\n', '\r\n'])
  if (parts.length === 0) return nl
  return parts.join(nl) + nl + nl
}

/** @param {XorShift128} rng @param {number} maxLen @returns {string} */
function randomNoise(rng, maxLen) {
  const n = rng.int(maxLen)
  let s = ''
  for (let i = 0; i < n; i += 1) {
    if (rng.bool(0.06)) s += rng.pick(['\n', '\r', '\r\n'])
    else s += String.fromCharCode(32 + rng.int(95))
  }
  return s
}

/** @param {XorShift128} rng @param {number} min @param {number} max @returns {string} */
function longData(rng, min, max) {
  const len = min + rng.int(max - min + 1)
  let s = ''
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(32 + rng.int(95))
  return `data: ${s}\n\n`
}

/**
 * 生成一份完整输入。
 * @param {XorShift128} rng
 * @returns {{input: string, description: string}}
 */
export function generateInput(rng) {
  const mode = rng.int(9)
  switch (mode) {
    case 0:
      return { input: generateFrame(rng), description: 'single-frame' }
    case 1: {
      const n = 1 + rng.int(5)
      return { input: Array.from({ length: n }, () => generateFrame(rng)).join(''), description: 'multi-frame' }
    }
    case 2:
      return { input: generateFrame(rng) + randomNoise(rng, 40), description: 'frame+noise' }
    case 3:
      return { input: randomNoise(rng, 120), description: 'noise-only' }
    case 4:
      return { input: longData(rng, 400, 4000), description: 'long-data' }
    case 5: {
      // 只有 id/event，没有 data：解析器必须丢弃
      const lines = []
      if (rng.bool(0.5)) lines.push(`id: ${rng.int(1000)}`)
      if (rng.bool(0.5)) lines.push(`event: ${rng.pick(EVENT_NAMES)}`)
      return { input: lines.join('\n') + '\n\n', description: 'no-data-frame' }
    }
    case 6: {
      // 注释风暴 + 一个合法帧
      const comments = Array.from({ length: 1 + rng.int(5) }, (_, i) => `: hb ${i}`).join('\n')
      return { input: `${comments}\n\n${generateFrame(rng)}`, description: 'comments+frame' }
    }
    case 7: {
      // 截断在任意位置（没有空行边界 → 不产出帧）
      const frame = generateFrame(rng)
      let cut = rng.int(Math.max(1, frame.length))
      if (cut < 1) cut = 1
      return { input: frame.slice(0, cut), description: 'truncated-frame' }
    }
    default: {
      // 混合换行：\r\n 与 \n 交替
      const a = `id: ${rng.int(10)}\r\nevent: adapter\r\ndata: ${printable(rng, 20)}\r\n\r\n`
      const b = `data: ${printable(rng, 20)}\ndata: ${printable(rng, 20)}\n\n`
      return { input: a + b, description: 'crlf-mix' }
    }
  }
}
