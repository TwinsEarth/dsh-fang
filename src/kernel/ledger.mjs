// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 链式审计账本（共享模块）
// 每条记录携带 prevHash 与 hash = sha256(prevHash + canonical(record))。
// 能发现：改字段、改 hash、删中间行、换行序、追加伪造。
import fs from 'node:fs'
import { createHash } from 'node:crypto'

export const GENESIS = 'GENESIS'

/** 规范化：**递归**按键排序 + 去掉 hash/prevHash 自身
 *  （TS 规范 audit.canonicalJson 是递归排序；只排顶层会让嵌套键序影响 hash） */
export function canonical(record) {
  const walk = (x) => {
    if (x === null || typeof x !== 'object') return x
    if (Array.isArray(x)) return x.map(walk)
    const o = {}
    for (const k of Object.keys(x).sort()) o[k] = walk(x[k])
    return o
  }
  const { hash, prevHash, ...rest } = record ?? {}
  return JSON.stringify(walk(rest))
}

/** 与 TS 规范 chainHash 完全一致：sha256(canonicalJson(entry) + prev) */
export function hashOf(record, prevHash) {
  return createHash('sha256').update(canonical(record) + String(prevHash), 'utf8').digest('hex')
}

function readLines(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  return raw.split('\n').filter(l => l.trim().length > 0)
}

export function lastHash(file) {
  const lines = readLines(file)
  if (!lines.length) return GENESIS
  try { return JSON.parse(lines[lines.length - 1]).hash ?? GENESIS } catch { return null }
}

/** 追加一条链式记录，返回 { hash, prevHash, seq } */
export function appendChained(file, record, opts = {}) {
  const prevHash = lastHash(file)
  if (prevHash === null) {
    // 上一行不可解析 → 不静默续写（否则等于帮着掩盖篡改）
    throw new Error(`ledger tail unparsable: ${file}`)
  }
  const seq = opts.seq ?? readLines(file).length
  const body = { ...record, seq, prevHash }
  const hash = hashOf(body, prevHash)
  const line = JSON.stringify({ ...body, hash }) + '\n'
  fs.appendFileSync(file, line, 'utf8')
  return { hash, prevHash, seq }
}

/**
 * 全链校验：不只看最后一条 head，而是逐条重算 + 检查 prevHash 链接。
 * 返回 { ok, count, reason, badIndex, expected, actual }
 */
export function verifyChain(file) {
  const lines = readLines(file)
  if (!lines.length) return { ok: true, count: 0, reason: 'empty' }
  let prev = GENESIS
  for (let i = 0; i < lines.length; i++) {
    let rec
    try { rec = JSON.parse(lines[i]) } catch (e) {
      return { ok: false, count: lines.length, badIndex: i, reason: 'unparsable', error: String(e?.message ?? e) }
    }
    if (rec.prevHash !== prev) {
      return { ok: false, count: lines.length, badIndex: i, reason: 'broken-link', expected: prev, actual: rec.prevHash }
    }
    const recomputed = hashOf(rec, rec.prevHash)
    if (recomputed !== rec.hash) {
      return { ok: false, count: lines.length, badIndex: i, reason: 'hash-mismatch', expected: recomputed, actual: rec.hash }
    }
    prev = rec.hash
  }
  return { ok: true, count: lines.length, head: prev }
}

/** 启动自检 + 追加 boot 记录（corrupt 时不续写）
 *  注意：与 TS 规范 audit.bootAudit **同名不同义** —— 那个是 sink+marker 的中断检测；
 *  这里只是"校验全链后追加一条 boot 记录"，故命名为 verifyAndAppendBoot。 */
export function verifyAndAppendBoot(file, extra = {}) {
  const v = verifyChain(file)
  if (!v.ok) return { ...v, action: 'refused-write' }     // 账本可疑：不往上写
  try {
    const r = appendChained(file, { kind: 'boot-verify', ok: true, count: v.count, ...extra })
    return { ...v, action: 'appended', bootHash: r.hash }
  } catch (e) {
    return { ...v, ok: false, reason: 'append-failed', error: String(e?.message ?? e) }
  }
}
