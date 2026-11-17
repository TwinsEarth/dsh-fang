// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// B 契约委托：加速分身 → 母体 的无头能力委托层（白名单 / 分会话鉴权 / 错误码 / 超时 / 审计）。
// 仅处理委托调用（envelope.meta.delegate === true）；未带该标记的旧调用方保持既有语义。
// 设计：默认拒绝（fail-closed）；未登记能力返回 contract-unsupported；委托层关闭返回 contract-unavailable。

import { ERROR_CODES } from '../contract/constants.js'

// B 委托错误码统一来自 contract SDK 1.2（append-only 注册表）。
export const DELEGATE_ERROR = Object.freeze({
  UNAVAILABLE: ERROR_CODES.CONTRACT_UNAVAILABLE,
  UNAUTHORIZED: ERROR_CODES.CONTRACT_UNAUTHORIZED,
  UNSUPPORTED: ERROR_CODES.CONTRACT_UNSUPPORTED,
  TIMEOUT: ERROR_CODES.CONTRACT_TIMEOUT,
  INVALID: ERROR_CODES.CONTRACT_INVALID_REQUEST,
  APPROVAL_REQUIRED: ERROR_CODES.CONTRACT_APPROVAL_REQUIRED,
  RATE_LIMITED: ERROR_CODES.CONTRACT_RATE_LIMITED,
})

export const DELEGATE_KIND = Object.freeze({ READ: 'read', WRITE: 'write' })

/**
 * 能力目录（首批只读；写能力需显式加入 allow 且走审批——当前不注册写能力）。
 * @typedef {{method:string, kind:'read'|'write', approval:'none'|'required', since:string, summary:string}} CapabilityDescriptor
 */
export const CAPABILITY_CATALOG = Object.freeze([
  { method: 'fang.capability.list', kind: 'read', approval: 'none', since: '1.2', summary: '列出已放行的委托能力（引导方法，总是可用）' },
  { method: 'fang.orchestrator.status', kind: 'read', approval: 'none', since: '1.0', summary: '母体 orchestrator 状态' },
  { method: 'fang.session.list', kind: 'read', approval: 'none', since: '1.0', summary: '母体会话目录（只读）' },
  { method: 'fang.session.events', kind: 'read', approval: 'none', since: '1.2', summary: '母体会话有界头读（只读；<200 行）' },
  { method: 'fang.decision.list', kind: 'read', approval: 'none', since: '1.2', summary: '母体决策中心快照（只读）' },
  { method: 'fang.approvals.list', kind: 'read', approval: 'none', since: '1.2', summary: '母体审批队列（只读）' },
  { method: 'fang.tool.invoke', kind: 'write', approval: 'required', since: '1.2', summary: '工具委托（官方 LSP 只读：definition/references/implementation/hover；母体 ctx.lsp provider 优先，fork-local 增强；默认不在白名单）' },
  { method: 'fang.chat.import', kind: 'write', approval: 'required', since: '1.2', summary: '官方会话导入（默认 dryRun；真实导入需审批；默认不在白名单）' },
])

export const DEFAULT_READ_ALLOW = Object.freeze([
  'fang.capability.list',
  'fang.orchestrator.status',
  'fang.session.list',
  'fang.session.events',
  'fang.decision.list',
  'fang.approvals.list',
])

/**
 * 专业版（Pro）专属能力：默认**不开启**，不进能力目录、不在默认白名单，
 * 需要“单独专业版 + 每项手动授权激活（配置级 + 每次调用审批）”后才可由上层注册 handler。
 * 当前仅登记决策，不注册任何 handler；请求即返回 contract-unsupported。
 */
export const PRO_ONLY_CAPABILITIES = Object.freeze([
  { method: 'fang.code.run', kind: 'write', approval: 'required', since: 'pro-1', summary: '代码执行（run_code / code-runtime；专业版，默认关闭，需每项手动授权激活 + 独立安全评审）' },
])

export const DELEGATE_DEFAULTS = Object.freeze({
  enabled: true,
  allow: [...DEFAULT_READ_ALLOW],
  maxPayloadBytes: 64 * 1024,
  readTimeoutMs: 5000,
  writeTimeoutMs: 30000,
  maxConcurrent: 4,
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
    maxConcurrent: Number.isFinite(Number(input.maxConcurrent)) && Number(input.maxConcurrent) >= 1
      ? Math.min(64, Math.round(Number(input.maxConcurrent))) : DELEGATE_DEFAULTS.maxConcurrent,
  }
}

/**
 * 并发闸门：超过上限立即拒绝（fail-closed），不排队、不静默降级。
 * @returns {{tryAcquire:()=>({ok:true,active:number}|{ok:false,error:string,active:number}), release:()=>void, snapshot:()=>({active:number,maxConcurrent:number})}}
 */
export function createDelegationGate({ maxConcurrent = DELEGATE_DEFAULTS.maxConcurrent } = {}) {
  const limit = Math.max(1, Math.round(Number(maxConcurrent) || DELEGATE_DEFAULTS.maxConcurrent))
  let active = 0
  return {
    tryAcquire() {
      if (active >= limit) return { ok: false, error: DELEGATE_ERROR.RATE_LIMITED, active }
      active += 1
      return { ok: true, active }
    },
    release() { active = Math.max(0, active - 1) },
    snapshot() { return { active, maxConcurrent: limit } },
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
  if (PRO_ONLY_CAPABILITIES.some((item) => item.method === name)) {
    return { ok: false, error: DELEGATE_ERROR.UNSUPPORTED, message: `pro capability requires separate authorization activation (default off): ${name}` }
  }
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
