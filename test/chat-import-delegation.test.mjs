// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// B-7：chat.import 委托——参数校验 + 确定性 dryRun 预览（同输入两次结果一致）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChatImportDryRun, validateChatImport } from '../src/lib/chat-import-delegation.mjs'

test('B-7: valid import params default to dryRun=true', () => {
  const out = validateChatImport({ source: 'deepseek', sessionId: 'session-a6b0ed16-c58c-430d-a911-e4fe9577fc56' })
  assert.equal(out.ok, true)
  assert.equal(out.source, 'deepseek')
  assert.equal(out.dryRun, true)
  assert.equal(validateChatImport({ source: 'DEEPSEEK', sessionId: 'session-abc' }).source, 'deepseek')
})

test('B-7: invalid source / sessionId / explicit dryRun=false', () => {
  assert.equal(validateChatImport({ source: 'other', sessionId: 'session-abc' }).ok, false)
  assert.equal(validateChatImport({ source: 'deepseek', sessionId: '../escape' }).ok, false)
  assert.equal(validateChatImport({ source: 'deepseek', sessionId: '' }).ok, false)
  const real = validateChatImport({ source: 'deepseek', sessionId: 'session-abc', dryRun: false })
  assert.equal(real.ok, true)
  assert.equal(real.dryRun, false)
})

test('B-7: dryRun preview is deterministic (two runs byte-identical)', () => {
  const input = { source: 'deepseek', sessionId: 'session-a6b0ed16-c58c-430d-a911-e4fe9577fc56', found: true }
  const first = buildChatImportDryRun(input)
  const second = buildChatImportDryRun(input)
  assert.deepEqual(first, second)
  assert.equal(first.dryRun, true)
  assert.equal(first.wouldImport, true)
  assert.equal(first.approvalRequired, true)
  assert.match(first.digest, /^[0-9a-f]{16}$/)
  assert.deepEqual(first.skipped, [])
})

test('B-7: dryRun preview reports why an import would be skipped', () => {
  const missing = buildChatImportDryRun({ source: 'deepseek', sessionId: 'session-x', found: false, reason: 'session-catalog-unavailable' })
  assert.equal(missing.wouldImport, false)
  assert.deepEqual(missing.skipped, ['session-catalog-unavailable'])
  // 结果只由输入决定：同样输入同样输出
  assert.deepEqual(missing, buildChatImportDryRun({ source: 'deepseek', sessionId: 'session-x', found: false, reason: 'session-catalog-unavailable' }))
})
