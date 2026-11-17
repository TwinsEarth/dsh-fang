// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// B-6：LSP 委托——只读/写类子命令分类与参数校验（审批门禁）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LSP_READ_ACTIONS,
  LSP_WRITE_ACTIONS,
  classifyLspAction,
  validateToolInvoke,
} from '../src/lib/lsp-delegation.mjs'
import { DELEGATE_ERROR } from '../src/lib/contract-delegation.mjs'

test('B-6: read actions are classified read/approval-none', () => {
  for (const action of LSP_READ_ACTIONS) {
    const out = classifyLspAction(action)
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'read')
    assert.equal(out.approval, undefined)
  }
  assert.ok(LSP_READ_ACTIONS.includes('diagnostics'))
})

test('B-6: write actions are classified write/approval-required', () => {
  for (const action of LSP_WRITE_ACTIONS) {
    const out = classifyLspAction(action)
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'write')
    assert.equal(out.approval, 'required')
  }
  assert.ok(LSP_WRITE_ACTIONS.includes('format'))
  assert.ok(LSP_WRITE_ACTIONS.includes('rename'))
})

test('B-6: unknown action / unsupported tool / missing file are rejected', () => {
  assert.equal(classifyLspAction('nope').ok, false)
  assert.equal(classifyLspAction('nope').error, DELEGATE_ERROR.INVALID)
  assert.equal(classifyLspAction('').ok, false)
  const otherTool = validateToolInvoke({ tool: 'bash', action: 'diagnostics', file: 'x' })
  assert.equal(otherTool.ok, false)
  assert.equal(otherTool.error, DELEGATE_ERROR.UNSUPPORTED)
  const noFile = validateToolInvoke({ tool: 'lsp', action: 'diagnostics' })
  assert.equal(noFile.ok, false)
  assert.equal(noFile.error, DELEGATE_ERROR.INVALID)
})

test('B-6: valid lsp params carry kind/approval/file', () => {
  const read = validateToolInvoke({ tool: 'lsp', action: 'diagnostics', file: 'src/index.mjs', line: 12, character: 3 })
  assert.equal(read.ok, true)
  assert.equal(read.kind, 'read')
  assert.equal(read.approval, 'none')
  assert.equal(read.file, 'src/index.mjs')
  assert.equal(read.line, 12)
  assert.equal(read.character, 3)
  const write = validateToolInvoke({ tool: 'lsp', action: 'format', file: 'src/index.mjs' })
  assert.equal(write.ok, true)
  assert.equal(write.kind, 'write')
  assert.equal(write.approval, 'required')
})
