// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// B-6：LSP 委托——已对齐官方能力缝口径（4 个只读操作；官方无 diagnostics/format/rename）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LSP_ACTION_TO_OPERATION,
  LSP_READ_ACTIONS,
  LSP_UNSUPPORTED_LEGACY_ACTIONS,
  LSP_WRITE_ACTIONS,
  classifyLspAction,
  validateToolInvoke,
} from '../src/lib/lsp-delegation.mjs'
import { DELEGATE_ERROR } from '../src/lib/contract-delegation.mjs'

test('B-6: read actions are exactly the official seam operations (read/approval-none)', () => {
  assert.deepEqual([...LSP_READ_ACTIONS], ['definition', 'references', 'implementation', 'hover'])
  assert.deepEqual(LSP_ACTION_TO_OPERATION, {
    definition: 'goToDefinition',
    references: 'findReferences',
    implementation: 'goToImplementation',
    hover: 'hover',
  })
  for (const action of LSP_READ_ACTIONS) {
    const out = classifyLspAction(action)
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'read')
    assert.equal(out.approval, 'none')
    assert.equal(out.operation, LSP_ACTION_TO_OPERATION[action])
  }
})

test('B-6: official seam is read-only (no write actions in the contract)', () => {
  assert.deepEqual([...LSP_WRITE_ACTIONS], [])
  assert.deepEqual([...LSP_UNSUPPORTED_LEGACY_ACTIONS], ['diagnostics', 'format', 'rename', 'codeAction', 'apply'])
})

test('B-6: legacy actions not provided by the official seam are rejected readably', () => {
  for (const action of LSP_UNSUPPORTED_LEGACY_ACTIONS) {
    const out = classifyLspAction(action)
    assert.equal(out.ok, false, action)
    assert.equal(out.error, DELEGATE_ERROR.UNSUPPORTED, action)
    assert.match(out.message, /official LSP seam is read-only/i, action)
  }
})

test('B-6: unknown action / unsupported tool / missing file / bad position are rejected', () => {
  assert.equal(classifyLspAction('nope').ok, false)
  assert.equal(classifyLspAction('nope').error, DELEGATE_ERROR.INVALID)
  assert.equal(classifyLspAction('').ok, false)
  const otherTool = validateToolInvoke({ tool: 'bash', action: 'definition', file: 'x' })
  assert.equal(otherTool.ok, false)
  assert.equal(otherTool.error, DELEGATE_ERROR.UNSUPPORTED)
  const noFile = validateToolInvoke({ tool: 'lsp', action: 'definition' })
  assert.equal(noFile.ok, false)
  assert.equal(noFile.error, DELEGATE_ERROR.INVALID)
  const noPosition = validateToolInvoke({ tool: 'lsp', action: 'hover', file: 'x.ts' })
  assert.equal(noPosition.ok, false)
  assert.match(noPosition.message, /positive 1-based line and character/)
})

test('B-6: valid lsp params carry action/operation/kind/1-based position', () => {
  const read = validateToolInvoke({ tool: 'lsp', action: 'definition', file: 'src/index.mjs', line: 12, character: 3 })
  assert.equal(read.ok, true)
  assert.equal(read.kind, 'read')
  assert.equal(read.operation, 'goToDefinition')
  assert.equal(read.file, 'src/index.mjs')
  assert.equal(read.line, 12)
  assert.equal(read.character, 3)
})
