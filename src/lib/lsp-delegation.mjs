// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// B-6：LSP 委托（fang.tool.invoke: lsp）。
// 只读子命令（diagnostics/hover/definition/references）自动放行；
// 写类子命令（format/rename/codeAction/apply）必须走瓮城审批，委托层直接拒绝执行。
// 执行提供方可由母体侧注册（当前：e2e 测试缝；生产待接入母体 LSP 工具提供方）。

export const LSP_READ_ACTIONS = Object.freeze(['diagnostics', 'hover', 'definition', 'references'])
export const LSP_WRITE_ACTIONS = Object.freeze(['format', 'rename', 'codeAction', 'apply'])
export const LSP_ACTIONS = Object.freeze([...LSP_READ_ACTIONS, ...LSP_WRITE_ACTIONS])

/** Pure: classify an lsp action for approval gating. */
export function classifyLspAction(action) {
  const text = String(action ?? '').trim()
  if (LSP_READ_ACTIONS.includes(text)) return { ok: true, action: text, kind: 'read' }
  if (LSP_WRITE_ACTIONS.includes(text)) return { ok: true, action: text, kind: 'write', approval: 'required' }
  return { ok: false, error: 'contract-invalid-request', message: `unknown lsp action: ${text || '(empty)'}` }
}

/** Pure: validate the delegated tool.invoke params for the first batch (tool=lsp only). */
export function validateToolInvoke(params) {
  const input = params && typeof params === 'object' ? params : {}
  const tool = String(input.tool ?? '').trim()
  if (tool !== 'lsp') return { ok: false, error: 'contract-unsupported', message: `tool not supported in first batch: ${tool || '(empty)'}` }
  const classified = classifyLspAction(input.action)
  if (!classified.ok) return classified
  const file = String(input.file ?? '').trim()
  if (!file) return { ok: false, error: 'contract-invalid-request', message: 'lsp action requires a file' }
  return {
    ok: true,
    tool: 'lsp',
    action: classified.action,
    kind: classified.kind,
    approval: classified.kind === 'write' ? 'required' : 'none',
    file,
    line: Number.isFinite(Number(input.line)) ? Number(input.line) : null,
    character: Number.isFinite(Number(input.character)) ? Number(input.character) : null,
  }
}
