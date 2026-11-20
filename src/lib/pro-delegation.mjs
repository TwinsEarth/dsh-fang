// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// B-8 专业版（Pro）能力激活链：① 专业版开关（默认 false）→ ② 该项显式 allow →
// ③ 每次调用审批票（一次性/TTL/绑定能力与参数摘要）→ ④ 全程审计 + 资源限额。
// 缺任一环即拒绝，拒绝路径显式可读（错误码 + stage + reason），不静默降级。
import crypto from 'node:crypto'

import { DELEGATE_ERROR } from './contract-delegation.mjs'

export const PRO_CAPABILITY = 'fang.code.run'
export const PRO_CAPABILITIES = Object.freeze([PRO_CAPABILITY])

export const PRO_STAGE = Object.freeze({
  DISABLED: 'pro-disabled',
  NOT_ALLOWED: 'pro-not-allowed',
  APPROVAL_REQUIRED: 'approval-required',
  APPROVAL_INVALID: 'approval-invalid',
  RATE_LIMITED: 'pro-rate-limited',
  LIMIT_EXCEEDED: 'pro-limit-exceeded',
  PROVIDER_MISSING: 'provider-missing',
})

export const PRO_DEFAULTS = Object.freeze({
  enabled: false,
  allow: Object.freeze([]),
  approvalTtlMs: 120000,
  maxConcurrent: 1,
  timeoutMs: 30000,
  maxOutputBytes: 64 * 1024,
})

/** Normalize the `contract.delegate.pro` config block (default off, per-item allow). */
export function normalizeProConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const allow = Array.isArray(raw.allow) ? [...new Set(raw.allow.map((item) => String(item ?? '').trim()).filter((item) => PRO_CAPABILITIES.includes(item)))] : [...PRO_DEFAULTS.allow]
  return {
    enabled: raw.enabled === true,
    allow,
    approvalTtlMs: Number.isFinite(Number(raw.approvalTtlMs)) && Number(raw.approvalTtlMs) >= 1000
      ? Math.min(3600000, Math.round(Number(raw.approvalTtlMs))) : PRO_DEFAULTS.approvalTtlMs,
    maxConcurrent: Number.isFinite(Number(raw.maxConcurrent)) && Number(raw.maxConcurrent) >= 1
      ? Math.min(8, Math.round(Number(raw.maxConcurrent))) : PRO_DEFAULTS.maxConcurrent,
    timeoutMs: Number.isFinite(Number(raw.timeoutMs)) && Number(raw.timeoutMs) >= 100
      ? Math.min(600000, Math.round(Number(raw.timeoutMs))) : PRO_DEFAULTS.timeoutMs,
    maxOutputBytes: Number.isFinite(Number(raw.maxOutputBytes)) && Number(raw.maxOutputBytes) >= 1024
      ? Math.min(1024 * 1024, Math.round(Number(raw.maxOutputBytes))) : PRO_DEFAULTS.maxOutputBytes,
  }
}

/** Stable digest of delegated params for approval binding (never logs the raw params). */
export function paramsDigest(params) {
  let text = ''
  try { text = JSON.stringify(params ?? null) } catch { text = 'unserializable' }
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Approval-bound params digest. The one-time ticket id is itself part of the call params
 * (`approvalTicket`), so it must be excluded — otherwise nothing could ever match the
 * digest computed at issue time. Returns the digest of the remaining payload.
 */
export function proParamsDigest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return paramsDigest(params ?? null)
  const { approvalTicket: _ticket, ...rest } = params
  return paramsDigest(rest)
}

const digestTicket = (ticketId) => crypto.createHash('sha256').update(String(ticketId ?? '')).digest('hex').slice(0, 12)

/**
 * One-time approval tickets for pro capabilities: issue (operator action), consume (per call).
 * TTL + capability + params digest binding; consumed tickets cannot be replayed.
 */
export function createProApprovalStore({ now = () => Date.now(), idFactory } = {}) {
  const tickets = new Map()
  const makeId = idFactory ?? (() => `pro_${crypto.randomBytes(12).toString('hex')}`)
  const prune = () => {
    const at = now()
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= at) tickets.delete(id)
  }
  return {
    issue({ capability, source = '', digest = '', ttlMs } = {}) {
      if (!PRO_CAPABILITIES.includes(String(capability))) return { ok: false, reason: 'unsupported-capability' }
      prune()
      const id = makeId()
      const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(1000, Math.round(Number(ttlMs))) : PRO_DEFAULTS.approvalTtlMs
      const ticket = { id, capability: String(capability), source: String(source ?? '').slice(0, 120), digest: String(digest ?? ''), issuedAt: now(), expiresAt: now() + ttl, consumedAt: null }
      tickets.set(id, ticket)
      return { ok: true, ticket: { ...ticket } }
    },
    consume({ id, capability, source = '', digest = '' } = {}) {
      const ticket = tickets.get(String(id ?? ''))
      if (!ticket) return { ok: false, reason: 'unknown-ticket', stage: PRO_STAGE.APPROVAL_INVALID }
      if (ticket.consumedAt !== null) return { ok: false, reason: 'ticket-consumed', stage: PRO_STAGE.APPROVAL_INVALID }
      if (ticket.expiresAt <= now()) { tickets.delete(ticket.id); return { ok: false, reason: 'ticket-expired', stage: PRO_STAGE.APPROVAL_INVALID } }
      if (ticket.capability !== String(capability ?? '')) return { ok: false, reason: 'capability-mismatch', stage: PRO_STAGE.APPROVAL_INVALID }
      // v3.5.5（安全）：参数摘要必须绑定且在消费时强制校验；旧的无摘要票一律失效（fail-closed）。
      if (!ticket.digest) return { ok: false, reason: 'params-unbound', stage: PRO_STAGE.APPROVAL_INVALID }
      if (ticket.digest !== String(digest ?? '')) return { ok: false, reason: 'params-mismatch', stage: PRO_STAGE.APPROVAL_INVALID }
      if (ticket.source && ticket.source !== String(source ?? '')) return { ok: false, reason: 'source-mismatch', stage: PRO_STAGE.APPROVAL_INVALID }
      ticket.consumedAt = now()
      return { ok: true, ticket: { ...ticket } }
    },
    pendingCount() { prune(); return tickets.size },
    snapshot() { prune(); return [...tickets.values()].map((ticket) => ({ ...ticket })) },
  }
}

/**
 * The activation chain gate: returns an explicit rejection (code + stage + readable message)
 * until every stage passes; never silently downgrades.
 */
export function checkProGate({ method, config, ticketId, source, params } = {}) {
  const pro = normalizeProConfig(config)
  if (!PRO_CAPABILITIES.includes(String(method ?? ''))) {
    return { ok: false, code: DELEGATE_ERROR.UNSUPPORTED, stage: 'not-pro', message: `not a pro capability: ${method}` }
  }
  if (!pro.enabled) {
    return { ok: false, code: DELEGATE_ERROR.UNSUPPORTED, stage: PRO_STAGE.DISABLED, message: 'pro capability disabled (default off): enable contract.delegate.pro.enabled first' }
  }
  if (!pro.allow.includes(method)) {
    return { ok: false, code: DELEGATE_ERROR.UNSUPPORTED, stage: PRO_STAGE.NOT_ALLOWED, message: `pro capability not activated: add '${method}' to contract.delegate.pro.allow` }
  }
  if (!ticketId) {
    return { ok: false, code: DELEGATE_ERROR.APPROVAL_REQUIRED, stage: PRO_STAGE.APPROVAL_REQUIRED, message: 'per-call approval ticket required: issue one via POST /fang/api/contract/pro/approval and pass params.approvalTicket', digest: paramsDigest(params) }
  }
  return { ok: true, pro, stage: 'approval-verified', digest: proParamsDigest(params), ticketDigest: digestTicket(ticketId) }
}

/** Audit record for every pro attempt (stage/outcome/limits; ticket id is hashed, not logged). */
export function proAuditRecord({ method, source = '', outcome, stage, ticketId, error = null, latencyMs = 0, limits = {} } = {}) {
  return {
    capability: String(method ?? ''),
    source: String(source ?? '').slice(0, 120),
    outcome: String(outcome ?? 'unknown'),
    stage: String(stage ?? ''),
    error: error ?? null,
    approval: ticketId ? digestTicket(ticketId) : null,
    latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
    limits: {
      timeoutMs: Number(limits.timeoutMs) || null,
      maxConcurrent: Number(limits.maxConcurrent) || null,
      maxOutputBytes: Number(limits.maxOutputBytes) || null,
    },
  }
}

/**
 * Run a pro capability behind the resource limits: concurrency gate, timeout, output cap.
 * Providers are injected; the current build has no code-runtime provider and returns
 * provider-missing explicitly instead of pretending success.
 */
export async function runProCapability({ execute, timeoutMs, maxOutputBytes, gate } = {}) {
  const slot = gate?.tryAcquire ? gate.tryAcquire() : { ok: true }
  if (slot.ok !== true) return { ok: false, stage: PRO_STAGE.RATE_LIMITED, code: DELEGATE_ERROR.RATE_LIMITED, message: 'pro capability concurrency limit reached' }
  const started = Date.now()
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => execute()),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, stage: PRO_STAGE.LIMIT_EXCEEDED, code: DELEGATE_ERROR.TIMEOUT, message: `pro capability timed out after ${timeoutMs}ms` }), Math.max(1, Number(timeoutMs) || PRO_DEFAULTS.timeoutMs))),
    ])
    if (!result || typeof result !== 'object') return { ok: false, stage: PRO_STAGE.LIMIT_EXCEEDED, code: DELEGATE_ERROR.UNAVAILABLE, message: 'pro capability returned no result' }
    if (result.ok === true) {
      let bytes = 0
      try { bytes = Buffer.byteLength(JSON.stringify(result.value ?? null), 'utf8') } catch { bytes = Number.MAX_SAFE_INTEGER }
      if (bytes > (Number(maxOutputBytes) || PRO_DEFAULTS.maxOutputBytes)) {
        return { ok: false, stage: PRO_STAGE.LIMIT_EXCEEDED, code: DELEGATE_ERROR.INVALID, message: `pro capability output exceeds maxOutputBytes (${bytes} > ${maxOutputBytes})` }
      }
    }
    return { ...result, latencyMs: Date.now() - started }
  } finally {
    try { gate?.release?.() } catch { /* ignore */ }
  }
}

/** Default pro executor: no code-runtime provider is installed on this build (explicit, no side effect). */
export function providerMissingResult(method) {
  return {
    ok: false,
    stage: PRO_STAGE.PROVIDER_MISSING,
    code: DELEGATE_ERROR.UNAVAILABLE,
    message: `activation chain verified, but no provider installed for '${method}' (code-runtime absent); execution refused without side effects`,
  }
}
