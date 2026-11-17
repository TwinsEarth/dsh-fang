// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// B 契约委托：加速分身 → 母体 的无头能力委托层（白名单 / 分会话鉴权 / 错误码 / 超时 / 审计）。
// 仅处理委托调用（envelope.meta.delegate === true）；未带该标记的旧调用方保持既有语义。
// 设计：默认拒绝（fail-closed）；未登记能力返回 contract-unsupported；委托层关闭返回 contract-unavailable。

// 这些错误码属于 fang 委托层（vendored contract SDK 保持 1.1.0 不改，避免破坏 vendored 契约逐字节校验）。
export const DELEGATE_ERROR = Object.freeze({
  UNAVAILABLE: 'contract-unavailable',
  UNAUTHORIZED: 'contract-unauthorized',
  UNSUPPORTED: 'contract-unsupported',
  TIMEOUT: 'contract-timeout',
  INVALID: 'contract-invalid-request',
  APPROVAL_REQUIRED: 'contract-approval-required',
})

export const DELEGATE_KIND = Object.freeze({ READ: 'read', WRITE: 'write' })

/**
 * 能力目录（首批只读；写能力需显式加入 allow 且走审批——当前不注册写能力）。
 * @typedef {{method:string, kind:'read'|'write', approval:'none'|'required', since:string, summary:string}} CapabilityDescriptor
 */
export const CAPABILITY_CATALOG = Object.freeze([
  { method: 'fang.capability.list', kind: 'read', approval: 'none', since: '1.1', summary: '列出已放行的委托能力（引导方法，总是可用）' },
  { method: 'fang.orchestrator.status', kind: 'read', approval: 'none', since: '1.0', summary: '母体 orchestrator 状态' },
  { method: 'fang.session.list', kind: 'read', approval: 'none', since: '1.0', summary: '母体会话目录（只读）' },
  { method: 'fang.session.events', kind: 'read', approval: 'none', since: '1.1', summary: '母体会话有界头读（只读；<200 行）' },
  { method: 'fang.decision.list', kind: 'read', approval: 'none', since: '1.1', summary: '母体决策中心快照（只读）' },
  { method: 'fang.approvals.list', kind: 'read', approval: 'none', since: '1.1', summary: '母体审批队列（只读）' },
  { method: 'fang.tool.invoke', kind: 'write', approval: 'required', since: '1.1', summary: '工具委托（首批 lsp：只读子命令放行，写类需审批；默认不在白名单）' },
])

export const DEFAULT_READ_ALLOW = Object.freeze([
  'fang.capability.list',
  'fang.orchestrator.status',
  'fang.session.list',
  'fang.session.events',
  'fang.decision.list',
  'fang.approvals.list',
])

export const DELEGATE_DEFAULTS = Object.freeze({
  enabled: true,
  allow: [...DEFAULT_READ_ALLOW],
  maxPayloadBytes: 64 * 1024,
  readTimeoutMs: 5000,
  writeTimeoutMs: 30000,
})

/** Pure: normalise the `contract.delegate` config block. */
export function normalizeDelegationConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const allow = Array.isArray(input.allow)
    ? input.allow.map((method) => String(method ?? '').trim()).filter(Boolean)
    : [...DELEGATE_DEFAULTS.allow]
  return {
    enabled: input.enabled === undefined ? DELEGATE_DEFAULTS.enabled : input.enabled !== false,
    allow: [...new Set(allow)],
    maxPayloadBytes: Number.isFinite(Number(input.maxPayloadBytes)) && Number(input.maxPayloadBytes) > 0
      ? Math.round(Number(input.maxPayloadBytes)) : DELEGATE_DEFAULTS.maxPayloadBytes,
    readTimeoutMs: Number.isFinite(Number(input.readTimeoutMs)) && Number(input.readTimeoutMs) >= 100
      ? Math.round(Number(input.readTimeoutMs)) : DELEGATE_DEFAULTS.readTimeoutMs,
    writeTimeoutMs: Number.isFinite(Number(input.writeTimeoutMs)) && Number(input.writeTimeoutMs) >= 100
      ? Math.round(Number(input.writeTimeoutMs)) : DELEGATE_DEFAULTS.writeTimeoutMs,
  }
}

/** Pure: descriptors visible to a caller under the current allowlist. */
export function capabilityCatalog(allow = DEFAULT_READ_ALLOW) {
  const allowed = new Set(Array.isArray(allow) ? allow.map(String) : [])
  return CAPABILITY_CATALOG.filter((item) => allowed.has(item.method)).map((item) => ({ ...item }))
}

/**
 * Pure: decide whether a delegated call may run.
 * @returns {{ok:true, descriptor?:object} | {ok:false, error:string, message?:string}}
 */
export function checkDelegation({ method, allow, config } = {}) {
  const cfg = normalizeDelegationConfig(config)
  if (cfg.enabled !== true) return { ok: false, error: DELEGATE_ERROR.UNAVAILABLE, message: 'contract delegation is disabled' }
  const name = String(method ?? '')
  if (name === 'fang.capability.list') return { ok: true, descriptor: CAPABILITY_CATALOG[0] }
  if (!cfg.allow.includes(name)) return { ok: false, error: DELEGATE_ERROR.UNSUPPORTED, message: `capability not allowed: ${name}` }
  const descriptor = CAPABILITY_CATALOG.find((item) => item.method === name) ?? null
  // allowlist 是权威白名单；目录仅用于 hello/能力自述（允许无描述的运维/测试缝能力被显式放行）。
  return { ok: true, descriptor }
}

/** Pure: reject oversized payloads before touching the handler. */
export function exceedPayloadLimit(params, maxPayloadBytes = DELEGATE_DEFAULTS.maxPayloadBytes) {
  let size = 0
  try { size = Buffer.byteLength(JSON.stringify(params ?? null), 'utf8') } catch { return true }
  return size > Number(maxPayloadBytes)
}

/** Run `fn` with a timeout; never throws. */
export async function runDelegated(fn, { timeoutMs = DELEGATE_DEFAULTS.readTimeoutMs } = {}) {
  const startedAt = Date.now()
  let timer = null
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('contract delegation timed out'), { code: DELEGATE_ERROR.TIMEOUT })), Math.max(1, Number(timeoutMs) || DELEGATE_DEFAULTS.readTimeoutMs))
      }),
    ])
    return { ok: true, value, latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.code ?? 'contract-error'),
      message: String(error?.message ?? error),
      latencyMs: Date.now() - startedAt,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Pure: audit record for one delegated call (capability/source/outcome/latency). */
export function delegationAuditRecord({ method, source = '', outcome = 'ok', error = null, latencyMs = 0 } = {}) {
  return { capability: String(method ?? ''), source: String(source ?? '').slice(0, 120), outcome: String(outcome), error: error ? String(error).slice(0, 120) : null, latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)) }
}
