// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 模糊测试的不变量层：
//   I1 分块等价性（任意切分 / 单 code point / 固定块 / 随机 / 换行边界 / 空块）
//   I1b 字节级切分等价性（TextDecoder streaming，模拟 res.setEncoding('utf8')）
//   I2 参考实现等价性（独立的“一次性”解析器 oracle）
//   I3 roundtrip：解析结果 → 重新序列化 → 再解析，帧序列一致
//   I4 帧边界：data 中的 \n 不切帧；只有空行才产出帧
//   I5 flush 丢弃残帧、不泄漏
//   I6 任意输入不抛错
import { SseParser } from '../../src/lib/sse-parser.mjs'

/** @param {string} input @returns {Array<{id?:string,event?:string,data:string}>} */
export function parseAll(input) {
  return new SseParser().push(input)
}

/** @param {string[]} chunks */
export function parseChunks(chunks) {
  const parser = new SseParser()
  const frames = []
  for (const chunk of chunks) frames.push(...parser.push(chunk))
  return frames
}

/**
 * 字节级切分：随机按字节切，用 TextDecoder（streaming）解码后再喂解析器。
 * 这覆盖“跨 chunk 的 UTF-8 多字节字符”——与真实 `res.setEncoding('utf8')` 行为一致。
 * @param {string} input
 * @param {{int:(max:number)=>number}} rng
 * @param {{minSize?:number,maxSize?:number}} [options]
 */
export function parseByteChunks(input, rng, { minSize = 1, maxSize = 9 } = {}) {
  const bytes = new TextEncoder().encode(input)
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const frames = []
  let offset = 0
  while (offset < bytes.length) {
    const size = minSize + rng.int(maxSize - minSize + 1)
    const slice = bytes.subarray(offset, offset + size)
    offset += size
    const text = decoder.decode(slice, { stream: true })
    if (text) frames.push(...parser.push(text))
  }
  const tail = decoder.decode()
  if (tail) frames.push(...parser.push(tail))
  return frames
}

/**
 * 独立的“一次性”参考实现（oracle）：只处理完整的行（以 \n 结尾）。
 * 语义必须与 SseParser 一致：只裁一个尾部 \r、空行 dispatch、无 data 丢弃、注释忽略。
 * @param {string} input
 */
export function referenceParse(input) {
  const text = String(input ?? '')
  // split 的最后一个元素是 EOF 处的未完成片段（或结尾 \n 后的空串），一律丢弃。
  const completeLines = text.split('\n').slice(0, -1)
  const frames = []
  let curId
  let curEvent
  let dataLines = []

  const dispatch = () => {
    if (dataLines.length > 0) {
      const frame = { data: dataLines.join('\n') }
      if (curId !== undefined) frame.id = curId
      if (curEvent !== undefined) frame.event = curEvent
      frames.push(frame)
    }
    curId = undefined
    curEvent = undefined
    dataLines = []
  }

  for (const rawLine of completeLines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      dispatch()
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') curId = value
    else if (field === 'event') curEvent = value
    else if (field === 'data') dataLines.push(value)
  }
  return frames
}

/**
 * @param {Array<{id?:string,event?:string,data:string}>} a
 * @param {Array<{id?:string,event?:string,data:string}>} b
 * @returns {{equal:boolean, reason?:string}}
 */
export function framesEqual(a, b) {
  if (a.length !== b.length) return { equal: false, reason: `length ${a.length} vs ${b.length}` }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].data !== b[i].data) {
      return { equal: false, reason: `frame[${i}].data: ${JSON.stringify(a[i].data)} vs ${JSON.stringify(b[i].data)}` }
    }
    if (a[i].id !== b[i].id) return { equal: false, reason: `frame[${i}].id: ${a[i].id} vs ${b[i].id}` }
    if (a[i].event !== b[i].event) return { equal: false, reason: `frame[${i}].event: ${a[i].event} vs ${b[i].event}` }
  }
  return { equal: true }
}

/** 把帧序列重新序列化成规范 SSE 文本（id/event 在前，data 多行拆分，空行结束）。 */
export function serializeFrames(frames) {
  let out = ''
  for (const frame of frames) {
    const lines = []
    if (frame.id !== undefined) lines.push(`id: ${frame.id}`)
    if (frame.event !== undefined) lines.push(`event: ${frame.event}`)
    for (const line of String(frame.data).split('\n')) lines.push(`data: ${line}`)
    out += `${lines.join('\n')}\n\n`
  }
  return out
}

/**
 * roundtrip 只在“可无损序列化”时检查：data 的某一行若以 \r 结尾，
 * 重新解析会被裁掉一个 \r（这是 SseParser 的既有语义），因此跳过该输入。
 */
export function roundtripSafe(frames) {
  for (const frame of frames) {
    if (frame.id !== undefined && frame.id.endsWith('\r')) return false
    if (frame.event !== undefined && frame.event.endsWith('\r')) return false
    for (const line of String(frame.data).split('\n')) {
      if (line.endsWith('\r')) return false
    }
  }
  return true
}

/** @param {string} input @returns {string[]} */
function chunkFixed(input, size) {
  const chunks = []
  for (let i = 0; i < input.length; i += size) chunks.push(input.slice(i, i + size))
  return chunks
}

/** @param {{int:(max:number)=>number}} rng @param {string} input */
function chunkRandom(rng, input) {
  const chunks = []
  let i = 0
  while (i < input.length) {
    const mode = rng.int(4)
    let size
    if (mode === 0) size = 1
    else if (mode === 1) size = 2 + rng.int(10)
    else if (mode === 2) {
      const nl = input.indexOf('\n', i)
      size = nl === -1 ? input.length - i : nl - i + 1
      if (size <= 0) size = 1
    } else size = input.length - i
    chunks.push(input.slice(i, i + size))
    i += size
  }
  return chunks
}

/** 在每个 \n 之后立即切块——最容易暴露“边界恰好落在换行后”的状态机 bug。 */
function chunkAtNewlines(input) {
  const chunks = []
  let start = 0
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '\n') {
      chunks.push(input.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < input.length) chunks.push(input.slice(start))
  return chunks
}

/** @param {{bool:(p?:number)=>boolean}} rng @param {string[]} chunks */
function injectEmpty(rng, chunks) {
  const out = []
  for (const chunk of chunks) {
    if (rng.bool(0.2)) out.push('')
    out.push(chunk)
    if (rng.bool(0.2)) out.push('')
  }
  return out
}

/**
 * 字符串级分块策略（字节级策略由 runner 单独用 parseByteChunks 执行）。
 * @param {string} input
 * @param {{int:(max:number)=>number, bool:(p?:number)=>boolean}} rng
 * @returns {Array<{name:string, chunks:string[]}>}
 */
export function buildChunkStrategies(input, rng) {
  return [
    { name: 'single-codepoint', chunks: Array.from(input) },
    { name: 'fixed-3', chunks: chunkFixed(input, 3) },
    { name: 'fixed-7', chunks: chunkFixed(input, 7) },
    { name: 'random', chunks: chunkRandom(rng, input) },
    { name: 'newline-boundary', chunks: chunkAtNewlines(input) },
    { name: 'with-empty-chunks', chunks: injectEmpty(rng, chunkRandom(rng, input)) },
  ]
}

/** @param {string} text @returns {string} */
export function toHex(text) {
  let out = ''
  for (let i = 0; i < text.length; i += 1) out += text.charCodeAt(i).toString(16).padStart(4, '0')
  return out
}
