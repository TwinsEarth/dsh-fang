// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// B-6 执行提供方（路线 A 优先）：母体 LSP provider 适配。
// 官方能力缝 ctx.lsp.query({operation, filePath, position, workspaceRoot}) 不需要 Agent Session，
// 因此母体 fang 插件可把委托请求直接映射到真实语言服务器查询。
// 路线 B（fork-local）作为增强：同一契约动作可在加速分身本地 provider 上执行，能力目录按 provider 区分。
import fs from 'node:fs'
import path from 'node:path'

import { DELEGATE_ERROR } from './contract-delegation.mjs'
import { LSP_ACTION_TO_OPERATION, LSP_READ_ACTIONS } from './lsp-delegation.mjs'

export const LSP_PROVIDER_MOTHER = 'mother-lsp'
export const LSP_PROVIDER_FORK = 'fork-local'
export const LSP_PROVIDER_TEST = 'test-hook'

/**
 * Derive the *actually provided* actions from a live seam. The official seam provides the four
 * read operations; a custom provider may expose `supportedOperations`/`capabilities`, in which
 * case we advertise only the intersection (never claim an action the provider cannot serve).
 */
export function advertisedActionsFromSeam(lspService) {
  if (!lspService || typeof lspService.query !== 'function') return []
  const declared = Array.isArray(lspService.supportedOperations)
    ? lspService.supportedOperations
    : (Array.isArray(lspService.capabilities) ? lspService.capabilities : null)
  if (!declared) return [...LSP_READ_ACTIONS]
  const operations = new Set(declared.map((item) => String(item)))
  const actions = LSP_READ_ACTIONS.filter((action) => operations.has(LSP_ACTION_TO_OPERATION[action]))
  return actions
}

/** Resolve a provider descriptor from the live host context (no side effects). */
export function describeLspProvider({ lspService = null, hooksEnabled = false, forkLocal = false, supportedActions = null } = {}) {
  const services = {
    [LSP_PROVIDER_MOTHER]: Boolean(lspService && typeof lspService.query === 'function'),
    [LSP_PROVIDER_FORK]: Boolean(forkLocal),
    [LSP_PROVIDER_TEST]: Boolean(hooksEnabled),
  }
  const available = Object.entries(services).filter(([, value]) => value).map(([name]) => name)
  const declared = Array.isArray(supportedActions) ? supportedActions.filter((action) => LSP_READ_ACTIONS.includes(action)) : null
  // Advertise real capabilities only: a missing provider (or a test-only hook) advertises no actions.
  const actions = services[LSP_PROVIDER_MOTHER] ? [...(declared ?? LSP_READ_ACTIONS)] : []
  return {
    available: available.length > 0,
    default: services[LSP_PROVIDER_MOTHER] ? LSP_PROVIDER_MOTHER : (services[LSP_PROVIDER_TEST] ? LSP_PROVIDER_TEST : (services[LSP_PROVIDER_FORK] ? LSP_PROVIDER_FORK : null)),
    services,
    // 契约口径：测试缝只用于 e2e/内部验证，绝不作为生产能力对外宣称。
    nonProduction: services[LSP_PROVIDER_TEST] ? [LSP_PROVIDER_TEST] : [],
    actions,
  }
}

/**
 * Collect the workspace roots of every fork task from its `storages/workspace.json`.
 * "母体根 + 所有 fork 工作区根（显式登记）" — the task registry is the explicit registration.
 */
export function collectForkWorkspaceRoots(taskHomes = [], { readFileSync = fs.readFileSync } = {}) {
  const roots = new Set()
  for (const home of Array.isArray(taskHomes) ? taskHomes : []) {
    const homeDir = String(home ?? '').trim()
    if (!homeDir) continue
    try {
      const doc = JSON.parse(String(readFileSync(path.join(homeDir, 'storages', 'workspace.json'), 'utf8')))
      const ids = Array.isArray(doc?.global?.workspaceIds) ? doc.global.workspaceIds : []
      const tables = doc?.tables?.workspaces ?? {}
      for (const id of ids) {
        const workspacePath = String(tables?.[id]?.path ?? '').trim()
        if (workspacePath) roots.add(path.resolve(workspacePath))
      }
    } catch { /* a fork without a workspace index contributes nothing */ }
  }
  return [...roots]
}

/** Merge configured roots with (optionally) every fork workspace root; dedupe, keep order. */
export function resolveLspAllowedRoots({ configuredRoots = [], forkRoots = [], includeForkWorktrees = true } = {}) {
  const roots = new Set()
  for (const root of Array.isArray(configuredRoots) ? configuredRoots : []) {
    const text = String(root ?? '').trim()
    if (text) roots.add(text)
  }
  if (includeForkWorktrees) {
    for (const root of Array.isArray(forkRoots) ? forkRoots : []) {
      const text = String(root ?? '').trim()
      if (text) roots.add(text)
    }
  }
  return [...roots]
}

/** Audit record for one LSP delegation attempt (workspace root recorded for the allowlist trail). */
export function lspAuditRecord({ action = '', provider = LSP_PROVIDER_MOTHER, workspaceRoot = null, outcome = 'error', error = null, latencyMs = 0 } = {}) {
  return {
    capability: 'fang.tool.invoke',
    tool: 'lsp',
    action: String(action ?? ''),
    provider: String(provider ?? ''),
    workspaceRoot: workspaceRoot ? String(workspaceRoot) : null,
    outcome: String(outcome ?? 'error'),
    error: error ?? null,
    latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
  }
}

/** Canonicalise a path for allowlist comparison (best effort; missing paths still normalise). */
function canonical(pathValue) {
  const resolved = path.resolve(String(pathValue ?? ''))
  try { return fs.realpathSync.native(resolved) } catch { return resolved }
}

/**
 * Workspace-root policy: delegated LSP may only read inside an explicitly allowed root, and the
 * source file must live inside that root. Empty allowlist = deny (fail-closed), never "allow all".
 */
export function checkWorkspaceRoot({ workspaceRoot = '', file = '', allowedRoots = [] } = {}) {
  if (!String(workspaceRoot ?? '').trim()) {
    return { ok: false, code: DELEGATE_ERROR.INVALID, reason: 'workspace-root-missing', message: 'lsp delegation requires workspaceRoot (explicitly allowed root)' }
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return { ok: false, code: DELEGATE_ERROR.UNAUTHORIZED, reason: 'allowlist-empty', message: 'lsp delegation has no allowed workspace roots; configure contract.delegate.lsp.allowedRoots' }
  }
  const root = canonical(workspaceRoot)
  const inside = allowedRoots.some((allowed) => {
    const prefix = canonical(allowed)
    return root === prefix || root.startsWith(prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`)
  })
  if (!inside) return { ok: false, code: DELEGATE_ERROR.UNAUTHORIZED, reason: 'root-not-allowed', message: `workspaceRoot is not in contract.delegate.lsp.allowedRoots: ${root}` }
  const source = canonical(path.isAbsolute(file) ? file : path.join(root, file))
  if (!(source === root || source.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`))) {
    return { ok: false, code: DELEGATE_ERROR.INVALID, reason: 'file-outside-root', message: `lsp file escapes workspaceRoot: ${source}` }
  }
  return { ok: true, workspaceRoot: root, file: source }
}

const CODE_MAP = {
  LSP_UNAVAILABLE: DELEGATE_ERROR.UNAVAILABLE,
  LSP_INVALID_PROVIDER: DELEGATE_ERROR.INVALID,
  LSP_CONFLICT: DELEGATE_ERROR.INVALID,
  LSP_FILE_OUTSIDE_WORKSPACE: DELEGATE_ERROR.INVALID,
  LSP_MALFORMED_RESPONSE: DELEGATE_ERROR.UNAVAILABLE,
  LSP_SERVER_ERROR: DELEGATE_ERROR.UNAVAILABLE,
  LSP_SPAWN_FAILED: DELEGATE_ERROR.UNAVAILABLE,
  LSP_SERVER_EXITED: DELEGATE_ERROR.UNAVAILABLE,
  LSP_PROTOCOL_ERROR: DELEGATE_ERROR.UNAVAILABLE,
  LSP_MESSAGE_TOO_LARGE: DELEGATE_ERROR.INVALID,
  LSP_DISPOSED: DELEGATE_ERROR.UNAVAILABLE,
  LSP_UNSUPPORTED_OPERATION: DELEGATE_ERROR.UNSUPPORTED,
}

/** Map an LSP seam failure to a delegation error code + readable detail. */
export function mapLspError(error) {
  const name = String(error?.code ?? error?.name ?? '')
  const code = CODE_MAP[name] ?? DELEGATE_ERROR.UNAVAILABLE
  const message = `lsp provider error: ${name || String(error?.message ?? 'unknown')}${error?.message ? ` — ${String(error.message).slice(0, 300)}` : ''}`
  return { code, message, detail: { lspCode: name || null, serverMessage: String(error?.message ?? '').slice(0, 500) || null } }
}

/** Normalise the seam's closed-union result into the contract payload (JSON-safe). */
export function normalizeLspResult(result, { action, operation, provider = LSP_PROVIDER_MOTHER } = {}) {
  const base = { provider, action: action ?? null, operation: operation ?? null }
  if (!result || typeof result !== 'object') return { ...base, kind: 'unknown', value: null }
  if (result.kind === 'locations') {
    return {
      ...base,
      kind: 'locations',
      resolvedWorkspaceUri: String(result.resolvedWorkspaceUri ?? ''),
      locations: (Array.isArray(result.locations) ? result.locations : []).map((location) => ({
        uri: String(location?.uri ?? ''),
        range: {
          start: { line: Number(location?.range?.start?.line ?? 0), character: Number(location?.range?.start?.character ?? 0) },
          end: { line: Number(location?.range?.end?.line ?? 0), character: Number(location?.range?.end?.character ?? 0) },
        },
      })),
    }
  }
  if (result.kind === 'hover') {
    const hover = result.hover
    return {
      ...base,
      kind: 'hover',
      hover: hover ? {
        contents: String(hover.contents ?? ''),
        ...(hover.range ? { range: hover.range } : {}),
      } : null,
    }
  }
  return { ...base, kind: String(result.kind ?? 'unknown'), value: null }
}

/**
 * Run one contract LSP action through a live `ctx.lsp` seam.
 * @returns {Promise<{ok:true, result:object} | {ok:false, code:string, message:string, detail?:object}>}
 */
export async function queryMotherLsp({ lspService, invoke, workspaceRoot, signal } = {}) {
  if (!lspService || typeof lspService.query !== 'function') {
    return { ok: false, code: DELEGATE_ERROR.UNAVAILABLE, message: 'lsp provider unavailable on mother (ctx.lsp seam not installed)', detail: { provider: LSP_PROVIDER_MOTHER } }
  }
  const operation = LSP_ACTION_TO_OPERATION[String(invoke?.action ?? '')]
  if (!operation) return { ok: false, code: DELEGATE_ERROR.UNSUPPORTED, message: `lsp action not supported by official seam: ${invoke?.action ?? '(empty)'}` }
  const request = {
    operation,
    filePath: String(invoke.file ?? ''),
    position: { line: Math.max(0, Number(invoke.line) - 1), character: Math.max(0, Number(invoke.character) - 1) },
    workspaceRoot: String(workspaceRoot ?? ''),
  }
  try {
    const value = await lspService.query(request, signal)
    return { ok: true, result: normalizeLspResult(value, { action: invoke.action, operation, provider: LSP_PROVIDER_MOTHER }) }
  } catch (error) {
    return { ok: false, ...mapLspError(error) }
  }
}
