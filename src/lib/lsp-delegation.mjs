// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// B-6：LSP 委托（fang.tool.invoke: lsp）——已按官方能力缝口径对齐。
// 官方 DSH LSP 能力缝（ctx.lsp）只提供 4 个只读操作：
//   goToDefinition / findReferences / goToImplementation / hover，
// 契约侧动作名统一为 definition / references / implementation / hover。
// 官方能力缝刻意不提供 diagnostics / format / rename / symbols / 通用 JSON-RPC：
//   - diagnostics 只允许 e2e 测试缝（FANG_CONTRACT_TEST_HOOKS=1），不对外 advertise；
//   - format/rename 等写类动作对官方 provider 一律 contract-unsupported，审批门禁保留给未来自定义 provider。
// 接真实 provider 时按“实提供能力”advertise（见 lsp-provider.advertisedActionsFromSeam）。
// 执行提供方：母体 LSP provider（路线 A，优先）；加速分身本地 provider（路线 B，增强）。

export const LSP_READ_ACTIONS = Object.freeze(['definition', 'references', 'implementation', 'hover'])
/** 官方能力缝只读；保留空数组让未来自定义 provider 显式登记写类动作。 */
export const LSP_WRITE_ACTIONS = Object.freeze([])
/** 仅 e2e 测试缝可用的动作（不进入能力目录、不对外 advertise）。 */
export const LSP_TEST_ACTIONS = Object.freeze(['diagnostics'])
export const LSP_ACTIONS = Object.freeze([...LSP_READ_ACTIONS, ...LSP_WRITE_ACTIONS, ...LSP_TEST_ACTIONS])

/** 契约动作 → 官方 seam 操作名。 */
export const LSP_ACTION_TO_OPERATION = Object.freeze({
  definition: 'goToDefinition',
  references: 'findReferences',
  implementation: 'goToImplementation',
  hover: 'hover',
})

/** 历史设计里出现过、但官方能力缝明确不提供的动作（用于可读拒绝）。 */
export const LSP_UNSUPPORTED_LEGACY_ACTIONS = Object.freeze(['format', 'rename', 'codeAction', 'apply'])

/** Pure: classify an lsp action (official seam is read-only; diagnostics is test-only). */
export function classifyLspAction(action) {
  const text = String(action ?? '').trim()
  if (LSP_READ_ACTIONS.includes(text)) return { ok: true, action: text, kind: 'read', approval: 'none', operation: LSP_ACTION_TO_OPERATION[text] }
  if (LSP_WRITE_ACTIONS.includes(text)) return { ok: true, action: text, kind: 'write', approval: 'required' }
  if (LSP_TEST_ACTIONS.includes(text)) return { ok: true, action: text, kind: 'test-only', approval: 'none' }
  if (LSP_UNSUPPORTED_LEGACY_ACTIONS.includes(text)) {
    return { ok: false, error: 'contract-unsupported', message: `official LSP seam is read-only; action '${text}' is not provided (no format/rename/codeAction/apply)` }
  }
  return { ok: false, error: 'contract-invalid-request', message: `unknown lsp action: ${text || '(empty)'}` }
}

/** Pure: validate the delegated tool.invoke params for the first batch (tool=lsp only).
 *  Position口径：line/character 是 **0-based 非负整数**（官方 seam 原生坐标，直接透传）；
 *  结果归一化时再转成 1-based 展示（locations: {path,line,character}）。 */
export function validateToolInvoke(params) {
  const input = params && typeof params === 'object' ? params : {}
  const tool = String(input.tool ?? '').trim()
  if (tool !== 'lsp') return { ok: false, error: 'contract-unsupported', message: `tool not supported in first batch: ${tool || '(empty)'}` }
  const classified = classifyLspAction(input.action)
  if (!classified.ok) return classified
  const file = String(input.file ?? '').trim()
  if (!file) return { ok: false, error: 'contract-invalid-request', message: 'lsp action requires a file' }
  const line = Number(input.line)
  const character = Number(input.character)
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    return { ok: false, error: 'contract-invalid-request', message: 'lsp action requires non-negative 0-based line and character' }
  }
  return {
    ok: true,
    tool: 'lsp',
    action: classified.action,
    kind: classified.kind,
    approval: classified.approval,
    operation: classified.operation ?? null,
    file,
    line,
    character,
  }
}
