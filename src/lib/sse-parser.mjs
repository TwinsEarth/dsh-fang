// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.6.5 — 增量 SSE 解析器（母体侧 SSE 传输的帧语法层）。
//
// 语义（与 docs/FUZZ-SSE-PARSER.md 的不变量一致）：
//   * 只按 `\n` 切行；行尾若有且仅有一个 `\r` 则裁掉（CRLF 支持，lone-CR 当作 data 字符）；
//   * 空行 = 帧边界：只有 dataLines 非空才产出帧（纯 id/event/注释帧被丢弃）；
//   * `:` 开头为注释（心跳），忽略；`id` / `event` / `data` 之外字段忽略（`retry` 也忽略）；
//   * 冒号后一个空格可选；多行 data 用 `\n` 拼接；dispatch 后重置 id/event/data；
//   * flush() 丢弃未完成的残帧（EOF 语义），不产出帧。
export class SseParser {
  constructor() {
    this.buffer = ''
    this.curId = undefined
    this.curEvent = undefined
    this.dataLines = []
  }

  /**
   * 喂入一段字符串，返回本次能解析出的完整帧。
   * @param {unknown} chunk
   * @returns {Array<{id?: string, event?: string, data: string}>}
   */
  push(chunk) {
    this.buffer += String(chunk ?? '')
    const frames = []
    let start = 0
    while (start < this.buffer.length) {
      const nl = this.buffer.indexOf('\n', start)
      if (nl === -1) break
      let line = this.buffer.slice(start, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      start = nl + 1
      const frame = this._processLine(line)
      if (frame) frames.push(frame)
    }
    this.buffer = this.buffer.slice(start)
    return frames
  }

  /**
   * 流结束：按 SSE 规范丢弃未完成的半帧（没有空行边界的 data 不 dispatch）。
   * @returns {[]}
   */
  flush() {
    this.buffer = ''
    this.curId = undefined
    this.curEvent = undefined
    this.dataLines = []
    return []
  }

  /** @private */
  _processLine(line) {
    if (line === '') {
      if (this.dataLines.length === 0) {
        this.curId = undefined
        this.curEvent = undefined
        return null
      }
      const frame = { data: this.dataLines.join('\n') }
      if (this.curId !== undefined) frame.id = this.curId
      if (this.curEvent !== undefined) frame.event = this.curEvent
      this.curId = undefined
      this.curEvent = undefined
      this.dataLines = []
      return frame
    }

    if (line.startsWith(':')) return null // 注释 / 心跳

    const colon = line.indexOf(':')
    let field = line
    let value = ''
    if (colon >= 0) {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
    }

    switch (field) {
      case 'id':
        this.curId = value
        break
      case 'event':
        this.curEvent = value
        break
      case 'data':
        this.dataLines.push(value)
        break
      default:
        break // retry / 未知字段：忽略
    }
    return null
  }
}

/** @param {object} [options] 保留参数位；返回新的 SseParser。 */
export function createSseParser(options = {}) {
  void options
  return new SseParser()
}
