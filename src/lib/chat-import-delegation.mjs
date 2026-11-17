// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// B-7：chat.import 委托。
// dryRun（默认 true）返回确定性预览：同输入两次调用结果必须逐字节一致；
// 真正导入（dryRun=false）必须走瓮城审批——委托层返回 contract-approval-required 且不产生副作用。
import crypto from 'node:crypto'

export const CHAT_IMPORT_SOURCES = Object.freeze(['deepseek'])

/** Pure: validate delegated chat.import params. */
export function validateChatImport(params) {
  const input = params && typeof params === 'object' ? params : {}
  const source = String(input.source ?? '').trim().toLowerCase()
  if (!CHAT_IMPORT_SOURCES.includes(source)) {
    return { ok: false, error: 'contract-invalid-request', message: `unsupported import source: ${source || '(empty)'}` }
  }
  const sessionId = String(input.sessionId ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,120}$/.test(sessionId)) {
    return { ok: false, error: 'contract-invalid-request', message: 'invalid sessionId' }
  }
  return {
    ok: true,
    source,
    sessionId,
    dryRun: input.dryRun !== false,
  }
}

/**
 * Pure, deterministic dry-run preview for a chat import.
 * `found` is whether the mother session catalog can see the session; the digest
 * lets the caller verify two dry runs agree without moving payload bytes.
 */
export function buildChatImportDryRun({ source = '', sessionId = '', found = false, reason = null } = {}) {
  const digest = crypto.createHash('sha256').update(`${source}\u0000${sessionId}`).digest('hex').slice(0, 16)
  return {
    source,
    sessionId,
    dryRun: true,
    found: found === true,
    wouldImport: found === true,
    approvalRequired: true,
    digest,
    skipped: found === true ? [] : [reason ?? 'session-not-found'],
  }
}
