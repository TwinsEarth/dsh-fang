// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// restart-contract — 「重启守卫 ↔ 外部 supervisor」两阶段契约（纯函数 + 只读磁盘辅助）。
//
// 为什么要有契约：restart-guard 在默认配置下是决策层，**不退出**进程；只有三重门禁
// （mode=enforce ∧ allowProcessRestart=true ∧ supervisor 在位）齐了，它才会在批准后
// exit(75) 把执行权交出去。supervisor 不能只看一个 bus 事件（事件不落盘、重启后丢失），
// 也不能只凭进程退出码（任何人都能 exit(75)）。所以守卫在批准时写一份 durable 的
// **授权清单**，supervisor 只按清单执行，执行完再写一份 **执行回执**。
//
//   阶段 1  授权清单（守卫写）  <dataDir>/restart/approved/<id>.json
//           execution.executed === false  // 守卫没有执行，执行权仍在 supervisor
//   阶段 2  执行回执（supervisor 写） <dataDir>/restart/executed/<id>.json
//           execution.executed === true   // 只有真的完成了重启才允许写
//
// 硬规则：
//   * 「已经执行」只认回执里的 `execution.executed === true`；授权清单里的 executed
//     恒为 false。把 false 当成「已执行」或「可以不再执行」都是违约。
//   * supervisor 只有在清单 digest 匹配、未过期、execution.executed 为 false、
//     decisionOnly 为 true、清单已武装（guard.mode=enforce ∧ allowProcessRestart=true）、
//     且没有已存在的回执时才允许执行。
//   * digest 只提供**完整性**（防截断/手滑改坏/字段被换序影响），不提供**真实性**：
//     能在本机写这个目录的人也能写一份假清单。信任边界是本机文件系统 ACL，不是
//     digest。签名/HMAC 是后续加固项，当前版本没有。
import fs from 'node:fs'
import path from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { EXIT, RISK_RANK } from '../kernel/core.mjs'
import { sha256 } from '../kernel/fsx.mjs'
import { canonical } from '../kernel/ledger.mjs'

export const CONTRACT_VERSION = 1
export const APPROVAL_KIND = 'fang-restart-approval'
export const EXECUTION_KIND = 'fang-restart-execution'
export const LATEST_KIND = 'fang-restart-approval-latest'
export const PLANNED_EXIT_CODE = EXIT.RESTART
export const APPROVAL_DIRNAME = 'approved'
export const EXECUTION_DIRNAME = 'executed'
export const LATEST_FILENAME = 'latest.json'

export const DEFAULT_MANIFEST_TTL_MS = 60_000
export const MIN_MANIFEST_TTL_MS = 1_000
export const MAX_MANIFEST_TTL_MS = 900_000

const OUTCOMES = new Set(['approved', 'auto-allow'])
const MANIFEST_ID = /^rst_[A-Za-z0-9_-]{1,80}$/
const NONCE = /^[0-9a-f]{64}$/

export const isManifestId = (id) => typeof id === 'string' && MANIFEST_ID.test(id)
export const isNonce = (nonce) => typeof nonce === 'string' && NONCE.test(nonce)
export const isRisk = (risk) => typeof risk === 'string' && Object.prototype.hasOwnProperty.call(RISK_RANK, risk)

/** TTL 夹到 [1s, 15min]；非数字/负数回默认值。清单永远有有限有效期。 */
export function normalizeManifestTtl(ttlMs, fallback = DEFAULT_MANIFEST_TTL_MS) {
  const n = Number(ttlMs)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_MANIFEST_TTL_MS, Math.max(MIN_MANIFEST_TTL_MS, Math.floor(n)))
}

/**
 * 记录 digest = sha256(canonical(去掉 digest 的 body))。
 * canonical() 递归排序键，跨平台/跨格式化稳定。
 */
export function digestOf(record) {
  const { digest: _ignored, ...body } = record ?? {}
  return 'sha256:' + sha256(canonical(body))
}

/** 32 字节随机 nonce（64 hex）。作用是把回执绑定到这一次授权，防跨授权复用。 */
export function newNonce() {
  return randomBytes(32).toString('hex')
}

/** 重新计算并比对记录自带 digest；返回 { ok, expected }。 */
export function checkDigest(record) {
  const expected = digestOf(record)
  return { ok: record?.digest === expected, expected }
}

// ───────────────────────── 清单签名（HMAC-SHA256） ─────────────────────────
// digest 只防手滑/截断；HMAC 才有「谁签的」真实性（前提：key 不落到写清单的人手里）。
// key 优先 env `FANG_RESTART_HMAC_SECRET`，否则 <stateDir>/restart-hmac.key（0600，自动生成）。
export const HMAC_KEY_FILENAME = 'restart-hmac.key'
const MIN_HMAC_SECRET_LENGTH = 32

const signatureBody = (record) => {
  const { digest: _digest, signature: _signature, ...body } = record ?? {}
  return body
}
export function hmacOf(record, secret) {
  return createHmac('sha256', String(secret)).update(canonical(signatureBody(record))).digest('hex')
}
export function signRecord(record, secret) {
  const body = signatureBody(record)
  return { ...body, signature: { alg: 'hmac-sha256', value: hmacOf(record, secret) } }
}
export function verifyRecordSignature(record, secret) {
  const signature = record?.signature
  if (!signature || signature.alg !== 'hmac-sha256' || typeof signature.value !== 'string') {
    return { ok: false, reason: 'missing-signature' }
  }
  const expected = hmacOf(record, secret)
  const provided = signature.value
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  const ok = a.length === b.length && timingSafeEqual(a, b)
  return { ok, reason: ok ? null : 'signature-mismatch', expected }
}

/** 只读已存在的 key（env 或 stateDir 文件），不生成；supervisor/watchdog 用。 */
export function readHmacSecret(stateDir, { env = process.env } = {}) {
  const fromEnv = String(env?.FANG_RESTART_HMAC_SECRET ?? '').trim()
  if (fromEnv.length >= MIN_HMAC_SECRET_LENGTH) return { ok: true, secret: fromEnv, source: 'env' }
  const file = path.join(String(stateDir), HMAC_KEY_FILENAME)
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (stored.length >= MIN_HMAC_SECRET_LENGTH) return { ok: true, secret: stored, source: 'file', file }
  } catch { /* absent */ }
  return { ok: false, reason: 'hmac-key-absent' }
}

/** 守卫用：env 优先；否则读取/生成 stateDir key 文件（0600）。 */
export function resolveHmacSecret(stateDir, { env = process.env } = {}) {
  const existing = readHmacSecret(stateDir, { env })
  if (existing.ok) return existing
  const file = path.join(String(stateDir), HMAC_KEY_FILENAME)
  try {
    fs.mkdirSync(String(stateDir), { recursive: true })
    const secret = randomBytes(32).toString('hex')
    fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* windows */ }
    return { ok: true, secret, source: 'generated', file }
  } catch (error) {
    return { ok: false, reason: 'hmac-key-unavailable', detail: String(error?.message ?? error) }
  }
}

// ───────────────────────────── 阶段 1：授权清单 ─────────────────────────────

/**
 * 构造授权清单（守卫在 outcome=approved|auto-allow 时写盘）。
 * 只做形状/取值校验，不读盘、不写盘。
 *
 * @param {object} input
 * @param {string} input.id                  restart request id (`rst_...`)
 * @param {'blue'|'yellow'|'red'} input.risk
 * @param {'approved'|'auto-allow'} input.outcome
 * @param {string|null} [input.approvalId]   auto-allow 可为 null
 * @param {string|null} [input.approvedBy]
 * @param {string} [input.reason]
 * @param {string} [input.scope]
 * @param {string} [input.origin]
 * @param {string[]} [input.digests]
 * @param {'caller'|'service'|null} [input.impactSource]
 * @param {number} [input.requestedAt]
 * @param {number} [input.approvedAt]
 * @param {number} [input.ttlMs]
 * @param {{mode?:string,authMode?:string,strictRedLine?:boolean,allowProcessRestart?:boolean,pid?:number,instanceId?:string}} [input.guard]
 * @returns {object} manifest（含 digest 与 execution.executed=false）
 */
export function buildApprovalManifest(input = {}) {
  const id = String(input.id ?? '')
  if (!isManifestId(id)) throw new TypeError(`invalid restart request id: ${id || '(empty)'}`)
  if (!isRisk(input.risk)) throw new TypeError(`invalid risk: ${String(input.risk)}`)

  const outcome = String(input.outcome ?? '')
  if (!OUTCOMES.has(outcome)) throw new TypeError(`invalid outcome: ${outcome || '(empty)'}`)
  const approvalId = input.approvalId === undefined || input.approvalId === null ? null : String(input.approvalId)
  if (outcome === 'approved' && !approvalId) throw new TypeError('approved manifest requires approvalId')
  const approvedBy = input.approvedBy === undefined || input.approvedBy === null ? null : String(input.approvedBy)

  const requestedAt = Number.isFinite(input.requestedAt) ? Math.floor(input.requestedAt) : Date.now()
  const approvedAt = Number.isFinite(input.approvedAt) ? Math.floor(input.approvedAt) : Date.now()
  const ttlMs = normalizeManifestTtl(input.ttlMs)
  const guard = input.guard && typeof input.guard === 'object' ? input.guard : {}
  const impactSource = input.impactSource === 'caller' || input.impactSource === 'service' ? input.impactSource : null

  const body = {
    version: CONTRACT_VERSION,
    kind: APPROVAL_KIND,
    id,
    nonce: isNonce(input.nonce) ? input.nonce : newNonce(),
    risk: input.risk,
    outcome,
    approvalId,
    approvedBy,
    reason: String(input.reason ?? 'unspecified'),
    scope: String(input.scope ?? 'mother'),
    origin: String(input.origin ?? 'unknown'),
    digests: Array.isArray(input.digests) ? input.digests.map(String) : [],
    impactSource,
    requestedAt,
    approvedAt,
    expiresAt: approvedAt + ttlMs,
    guard: {
      mode: String(guard.mode ?? 'observe'),
      authMode: String(guard.authMode ?? 'manual'),
      strictRedLine: guard.strictRedLine !== false,
      allowProcessRestart: guard.allowProcessRestart === true,
      decisionOnly: true,
      pid: Number.isFinite(guard.pid) ? Math.floor(guard.pid) : null,
      instanceId: guard.instanceId ? String(guard.instanceId) : null,
    },
    // 守卫是决策层：executed=false 是事实，不是占位符。
    execution: {
      executed: false,
      decisionOnly: true,
      plannedExitCode: PLANNED_EXIT_CODE,
      executedBy: null,
    },
  }
  let record = { ...body }
  if (input.hmacSecret) record = signRecord(record, input.hmacSecret)
  return { ...record, digest: digestOf(record) }
}

const fail = (reason, extra = {}) => ({ ok: false, reason, expired: false, digestValid: false, remainingMs: null, ...extra })

/**
 * 只读校验授权清单。返回 { ok, reason, expired, digestValid, remainingMs }。
 * reason 取值：invalid-shape / unsupported-version / wrong-kind / bad-id / id-mismatch /
 *   bad-nonce / nonce-mismatch / bad-risk / bad-outcome / bad-timestamps /
 *   missing-approval-id / guard-executed / not-decision-only / bad-exit-code /
 *   digest-mismatch / expired
 */
export function verifyApprovalManifest(manifest, { now = Date.now(), expectedId = null, expectedNonce = null, hmacSecret = null, requireSignature = false } = {}) {
  if (!manifest || typeof manifest !== 'object') return fail('invalid-shape')
  if (manifest.version !== CONTRACT_VERSION) return fail('unsupported-version')
  if (manifest.kind !== APPROVAL_KIND) return fail('wrong-kind')
  if (!isManifestId(manifest.id)) return fail('bad-id')
  if (expectedId !== null && manifest.id !== expectedId) return fail('id-mismatch')
  if (!isNonce(manifest.nonce)) return fail('bad-nonce')
  if (expectedNonce !== null && manifest.nonce !== expectedNonce) return fail('nonce-mismatch')
  if (!isRisk(manifest.risk)) return fail('bad-risk')
  if (!OUTCOMES.has(manifest.outcome)) return fail('bad-outcome')
  if (manifest.outcome === 'approved' && !manifest.approvalId) return fail('missing-approval-id')

  const { requestedAt, approvedAt, expiresAt } = manifest
  if (!Number.isFinite(requestedAt) || !Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) {
    return fail('bad-timestamps')
  }
  if (approvedAt < requestedAt || expiresAt <= approvedAt) return fail('bad-timestamps')
  if (expiresAt - approvedAt > MAX_MANIFEST_TTL_MS) return fail('ttl-too-long')

  const execution = manifest.execution
  if (!execution || typeof execution !== 'object') return fail('invalid-shape')
  // 守卫自己执行过 => 这份清单不是给 supervisor 用的；supervisor 必须拒绝。
  if (execution.executed !== false) return fail('guard-executed')
  if (execution.decisionOnly !== true) return fail('not-decision-only')
  if (execution.plannedExitCode !== PLANNED_EXIT_CODE) return fail('bad-exit-code')

  const digest = checkDigest(manifest)
  if (!digest.ok) return fail('digest-mismatch')

  if (hmacSecret) {
    const signature = verifyRecordSignature(manifest, hmacSecret)
    if (!signature.ok) return fail(signature.reason)
  } else if (requireSignature) {
    return fail('missing-signature')
  }

  const remainingMs = Math.max(0, expiresAt - now)
  const expired = now >= expiresAt
  return { ok: !expired, reason: expired ? 'expired' : null, expired, digestValid: true, remainingMs }
}

// ───────────────────────────── 阶段 2：执行回执 ─────────────────────────────

/**
 * 构造执行回执（只有真的完成了重启的 supervisor 才允许调用/写盘）。
 * 回执的 execution.executed 恒为 true —— 这就是「已执行」的唯一证明。
 *
 * @param {object} input
 * @param {object} input.manifest     已通过 verifyApprovalManifest 的授权清单
 * @param {string} input.supervisorId 执行者标识（非空）
 * @param {number|null} [input.pid]   supervisor 进程 pid
 * @param {number} [input.executedAt] 实际执行时间（默认 now）
 * @param {number} [input.exitCode]   目标进程的退出码（默认 75 = 守卫放行码）
 * @param {number|null} [input.previousPid]    被重启进程的 pid（supervisor 记录）
 * @param {number|null} [input.replacementPid] 新进程的 pid（supervisor 记录）
 */
export function buildExecutionReceipt({ manifest, supervisorId, pid = null, executedAt = Date.now(), exitCode = PLANNED_EXIT_CODE, previousPid = null, replacementPid = null } = {}) {
  const at = Number.isFinite(executedAt) ? Math.floor(executedAt) : Date.now()
  const verification = verifyApprovalManifest(manifest, { now: at })
  if (!verification.ok) throw new Error(`cannot build receipt for an invalid manifest: ${verification.reason}`)
  const by = String(supervisorId ?? '').trim()
  if (!by || by.length > 128) throw new TypeError('supervisorId must be a non-empty string (<=128 chars)')

  const body = {
    version: CONTRACT_VERSION,
    kind: EXECUTION_KIND,
    id: manifest.id,
    nonce: manifest.nonce,
    manifestDigest: manifest.digest,
    approvedAt: manifest.approvedAt,
    execution: {
      executed: true,
      executedBy: by,
      supervisorPid: Number.isFinite(pid) ? Math.floor(pid) : null,
      at,
      exitCode: Number.isFinite(exitCode) ? Math.floor(exitCode) : PLANNED_EXIT_CODE,
      ...(Number.isFinite(previousPid) ? { previousPid: Math.floor(previousPid) } : {}),
      ...(Number.isFinite(replacementPid) ? { replacementPid: Math.floor(replacementPid) } : {}),
    },
  }
  return { ...body, digest: digestOf(body) }
}

/**
 * 只读校验执行回执。硬规则：execution.executed 必须是 true，否则一律视为**未执行**。
 * 传 manifest 时还会校验 nonce / manifestDigest，并把清单的有效期换算到执行时刻。
 *
 * reason 取值：invalid-shape / unsupported-version / wrong-kind / bad-id / bad-nonce /
 *   not-executed / bad-executor / bad-timestamp / digest-mismatch / manifest-mismatch /
 *   manifest-invalid / receipt-outside-window
 */
export function verifyExecutionReceipt(receipt, { manifest = null } = {}) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'invalid-shape', executed: false }
  if (receipt.version !== CONTRACT_VERSION) return { ok: false, reason: 'unsupported-version', executed: false }
  if (receipt.kind !== EXECUTION_KIND) return { ok: false, reason: 'wrong-kind', executed: false }
  if (!isManifestId(receipt.id)) return { ok: false, reason: 'bad-id', executed: false }
  if (!isNonce(receipt.nonce)) return { ok: false, reason: 'bad-nonce', executed: false }
  const execution = receipt.execution
  if (!execution || typeof execution !== 'object') return { ok: false, reason: 'invalid-shape', executed: false }
  // 唯一证明：executed === true。false / 缺失 / 'true' 字符串都不算。
  if (execution.executed !== true) return { ok: false, reason: 'not-executed', executed: false }
  if (typeof execution.executedBy !== 'string' || !execution.executedBy.trim()) {
    return { ok: false, reason: 'bad-executor', executed: false }
  }
  if (!Number.isFinite(execution.at)) return { ok: false, reason: 'bad-timestamp', executed: false }

  const digest = checkDigest(receipt)
  if (!digest.ok) return { ok: false, reason: 'digest-mismatch', executed: false }

  if (manifest) {
    if (manifest.id !== receipt.id || manifest.nonce !== receipt.nonce) {
      return { ok: false, reason: 'manifest-mismatch', executed: false }
    }
    if (manifest.digest !== receipt.manifestDigest) return { ok: false, reason: 'manifest-mismatch', executed: false }
    if (execution.at < manifest.approvedAt || execution.at >= manifest.expiresAt) {
      return { ok: false, reason: 'receipt-outside-window', executed: false }
    }
    const atVerification = verifyApprovalManifest(manifest, { now: execution.at })
    if (!atVerification.ok) return { ok: false, reason: `manifest-invalid:${atVerification.reason}`, executed: false }
  }

  return { ok: true, reason: null, executed: true, executedAt: execution.at, executedBy: execution.executedBy }
}

/**
 * 清单是否「已武装」：supervisor 只能执行已武装的批准。
 * 对应参考实现三重门禁里的两个**可由清单证明**的条件：
 *   mode === 'enforce' ∧ allowProcessRestart === true
 * 第三重 supervisorPresent 不写进清单——校验者本身就是一个 supervisor。
 */
export function isArmedManifest(manifest) {
  return !!(manifest && manifest.guard && manifest.guard.mode === 'enforce' && manifest.guard.allowProcessRestart === true)
}

/**
 * 未来 supervisor 入口在动进程前的唯一校验入口（只读）。
 * 返回 { ok, allowed, reason, verification, receipt }。
 * 注意：这里放行的是「可以执行」，不代表「已经执行」；执行完必须写回执。
 * requireArmed=true（默认）时，observe 模式或 allowProcessRestart=false 的批准一律不放行。
 */
export function verifyRestartAuthorization(manifest, { now = Date.now(), expectedId = null, receipt = null, requireArmed = true } = {}) {
  const verification = verifyApprovalManifest(manifest, { now, expectedId })
  if (!verification.ok) {
    return { ok: false, allowed: false, reason: verification.reason, verification, receipt: null }
  }
  if (requireArmed && !isArmedManifest(manifest)) {
    const reason = manifest.guard?.mode !== 'enforce' ? 'guard-not-enforce' : 'process-restart-disabled'
    return { ok: false, allowed: false, reason, verification, receipt: null }
  }
  if (receipt !== null && receipt !== undefined) {
    const receiptVerification = verifyExecutionReceipt(receipt, { manifest })
    if (receiptVerification.ok) {
      return { ok: false, allowed: false, reason: 'already-executed', verification, receipt: receiptVerification }
    }
    // 存在但不可信的回执 => fail-closed，不允许重试执行（可能是损坏或伪造）。
    return { ok: false, allowed: false, reason: `invalid-receipt:${receiptVerification.reason}`, verification, receipt: receiptVerification }
  }
  return { ok: true, allowed: true, reason: null, verification, receipt: null }
}

// ───────────────────────────── 只读磁盘辅助 ─────────────────────────────

export function approvalDir(stateDir) {
  return path.join(String(stateDir), APPROVAL_DIRNAME)
}

export function executionDir(stateDir) {
  return path.join(String(stateDir), EXECUTION_DIRNAME)
}

/** id 非法时返回 null —— 绝不把未校验的 id 拼进路径。 */
export function approvalFile(stateDir, id) {
  return isManifestId(id) ? path.join(approvalDir(stateDir), `${id}.json`) : null
}

export function receiptFile(stateDir, id) {
  return isManifestId(id) ? path.join(executionDir(stateDir), `${id}.json`) : null
}

export function latestApprovalFile(stateDir) {
  return path.join(approvalDir(stateDir), LATEST_FILENAME)
}

function readJson(file) {
  if (!file) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function readApprovalManifest(stateDir, id) {
  return readJson(approvalFile(stateDir, id))
}

export function readExecutionReceipt(stateDir, id) {
  return readJson(receiptFile(stateDir, id))
}

/** 已落盘的清单 id（`latest.json` 与非 rst_ 文件不在此列），不保证内容有效。 */
export function listApprovalIds(stateDir) {
  let names
  try {
    names = fs.readdirSync(approvalDir(stateDir))
  } catch {
    return []
  }
  return names
    .filter(n => n.endsWith('.json'))
    .map(n => n.slice(0, -'.json'.length))
    .filter(isManifestId)
}

/**
 * 只读检查一份授权（清单 + 回执）。不做任何写入/审计。
 * 返回对象包含 valid/expired/executed/authorized/stale 五个布尔量与原始记录。
 */
export function inspectApproval(stateDir, id, { now = Date.now(), hmacSecret = null, requireSignature = false } = {}) {
  const base = {
    id, found: false, valid: false, expired: false, executed: false, authorized: false, stale: false, armed: false,
    receiptState: 'absent', blockedReason: null, manifest: null, receipt: null,
    manifestVerification: null, receiptVerification: null,
  }
  if (!isManifestId(id)) return { ...base, reason: 'bad-id', blockedReason: 'bad-id' }
  const manifest = readApprovalManifest(stateDir, id)
  if (!manifest) return { ...base, reason: 'not-found', blockedReason: 'not-found' }
  const manifestVerification = verifyApprovalManifest(manifest, { now, expectedId: id, hmacSecret, requireSignature })
  const receipt = readExecutionReceipt(stateDir, id)
  const receiptVerification = receipt ? verifyExecutionReceipt(receipt, { manifest }) : null
  const executed = receiptVerification?.ok === true
  const receiptPresent = receipt !== null
  // 清单格式/摘要可信（过期也仍然可信，只是不能再授权执行）。
  const valid = manifestVerification.ok === true || manifestVerification.expired === true
  const expired = manifestVerification.expired === true
  const armed = isArmedManifest(manifest)
  // 有回执（哪怕损坏）就不允许再执行：损坏回执是 fail-closed，不是「没执行过」。
  const authorized = manifestVerification.ok === true && !receiptPresent && armed
  const stale = valid && expired && !executed
  const blockedReason = !manifestVerification.ok
    ? manifestVerification.reason
    : executed ? 'already-executed'
      : receiptPresent ? 'invalid-receipt'
        : !armed ? (manifest?.guard?.mode !== 'enforce' ? 'guard-not-enforce' : 'process-restart-disabled')
          : null
  return {
    ...base, found: true, valid, expired, executed, authorized, stale, armed,
    receiptState: !receiptPresent ? 'absent' : executed ? 'executed' : 'invalid',
    blockedReason, manifest, receipt, manifestVerification, receiptVerification,
  }
}

/**
 * 启动对账：扫描 approved/ + executed/，把每份清单归类为
 * armed / not-armed / executed / invalid-receipt / stale / invalid。
 * 只读，不删任何东西；HMAC secret 可选，提供时签名错误会判 invalid。
 */
export function reconcileRestartState(stateDir, { now = Date.now(), hmacSecret = null } = {}) {
  const rows = listApprovalIds(stateDir).map((id) => {
    const manifest = readApprovalManifest(stateDir, id)
    if (!manifest) return { id, state: 'invalid', reason: 'not-found', approvedAt: null, expiresAt: null, signed: false, armed: false }
    const verification = verifyApprovalManifest(manifest, { now, expectedId: id, hmacSecret })
    const receipt = readExecutionReceipt(stateDir, id)
    const receiptVerification = receipt ? verifyExecutionReceipt(receipt, { manifest }) : null
    const executed = receiptVerification?.ok === true
    const armed = isArmedManifest(manifest)
    const state = executed ? 'executed'
      : receipt ? 'invalid-receipt'
        : verification.ok ? (armed ? 'armed' : 'not-armed')
          : verification.expired ? 'stale' : 'invalid'
    return {
      id,
      state,
      reason: verification.reason ?? null,
      approvedAt: Number(manifest.approvedAt) || null,
      expiresAt: Number(manifest.expiresAt) || null,
      signed: Boolean(manifest.signature),
      armed,
    }
  })
  const count = (state) => rows.filter(row => row.state === state).length
  return {
    ok: true,
    checked: rows.length,
    counts: {
      armed: count('armed'),
      notArmed: count('not-armed'),
      executed: count('executed'),
      stale: count('stale'),
      invalid: count('invalid') + count('invalid-receipt'),
    },
    rows,
  }
}

/**
 * 旧清单 prune：删除陈旧/已执行/无效的清单与回执文件，保护 newest keep 份 + latest 指针。
 * 返回 { ok, removed:[id], kept, latestCleared }。
 */
export function pruneRestartState(stateDir, { now = Date.now(), hmacSecret = null, retentionMs = 7 * 24 * 3600_000, keep = 20 } = {}) {
  const reconciled = reconcileRestartState(stateDir, { now, hmacSecret })
  const sorted = [...reconciled.rows].sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0))
  const protectedIds = new Set(sorted.slice(0, Math.max(0, Math.floor(Number(keep) || 0))).map(row => row.id))
  const removable = reconciled.rows.filter((row) => {
    if (!['stale', 'invalid', 'invalid-receipt', 'executed'].includes(row.state)) return false
    if (protectedIds.has(row.id)) return false
    const at = Number(row.approvedAt ?? row.expiresAt ?? 0)
    return now - at >= retentionMs
  })
  const removed = []
  for (const row of removable) {
    let ok = true
    for (const file of [approvalFile(stateDir, row.id), receiptFile(stateDir, row.id)]) {
      if (!file) { ok = false; continue }
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch { ok = false }
    }
    if (ok) removed.push(row.id)
  }
  // latest.json 指向被删的 id 时，改指向剩余最新的一份；没有就删掉指针。
  let latestCleared = false
  try {
    const latestFile = latestApprovalFile(stateDir)
    const latest = readJson(latestFile)
    if (latest && removed.includes(String(latest.id))) {
      const next = sorted.find(row => !removed.includes(row.id))
      if (next) {
        fs.writeFileSync(latestFile, JSON.stringify({ ...latest, id: next.id, file: `${next.id}.json`, at: now }), 'utf8')
      } else {
        fs.unlinkSync(latestFile)
        latestCleared = true
      }
    }
  } catch { /* prune is best-effort */ }
  return { ok: true, removed, kept: reconciled.checked - removed.length, latestCleared, retentionMs }
}

/** 从摘要行统计：CLI / HTTP / UI 共用的唯一计数口径。 */export function summarizeApprovalCounts(rows = []) {
  const count = (state) => rows.filter(r => r.state === state).length
  return {
    total: rows.length,
    authorized: count('authorized'),
    executed: count('executed'),
    stale: count('stale'),
    notArmed: count('not-armed'),
    invalid: count('invalid') + count('invalid-receipt') + count('missing'),
  }
}

/**
 * 只读汇总：`<dataDir>/restart` 的守卫状态 + 授权清单摘要。
 * 不写盘、不审计、不执行；CLI（fangctl restart-status）与 HTTP/UI 共用同一投影。
 * 状态文件缺失/损坏时 state='unknown'，不伪造 idle。
 */
export function readRestartStatus(dataDir, { now = Date.now(), limit = 50 } = {}) {
  const dataDirText = String(dataDir ?? '')
  const stateDirPath = path.join(dataDirText, 'restart')
  const raw = readJson(path.join(stateDirPath, 'state.json'))
  const max = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50))
  const rows = listApprovalIds(stateDirPath)
    .map(id => summarizeApproval(inspectApproval(stateDirPath, id, { now })))
    .sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0))
  return {
    ok: true,
    dataDir: dataDirText,
    stateDir: stateDirPath,
    state: typeof raw?.state === 'string' ? raw.state : 'unknown',
    pending: raw?.pending ?? null,
    lastInterrupted: raw?.lastInterrupted ?? null,
    disposed: raw?.disposed === true,
    stateAt: Number.isFinite(raw?.at) ? raw.at : null,
    approvals: { items: rows.slice(0, max), counts: summarizeApprovalCounts(rows) },
    dirs: {
      approved: approvalDir(stateDirPath),
      executed: executionDir(stateDirPath),
      latest: latestApprovalFile(stateDirPath),
    },
    contract: {
      version: CONTRACT_VERSION,
      decisionOnly: true,
      guardExecuted: false,
      plannedExitCode: PLANNED_EXIT_CODE,
      armedWhen: ['guard.mode === "enforce"', 'guard.allowProcessRestart === true'],
      rule: '「已执行」只认回执 execution.executed === true；授权清单里恒为 false。',
    },
    executed: false,
  }
}

/** 给面板/列表用的紧凑摘要（不携带完整清单/回执）。 */
export function summarizeApproval(inspected) {
  const m = inspected?.manifest ?? null
  const executed = inspected?.executed === true
  const expired = inspected?.expired === true
  const authorized = inspected?.authorized === true
  const armed = inspected?.armed === true
  const state = !inspected?.found
    ? 'missing'
    : executed ? 'executed'
      : !inspected?.valid ? 'invalid'
        : expired ? 'stale'
          : authorized ? 'authorized'
            : inspected?.receiptState === 'invalid' ? 'invalid-receipt'
              : !armed ? 'not-armed' : 'invalid'
  return {
    id: inspected?.id ?? null,
    found: inspected?.found === true,
    state,
    risk: m?.risk ?? null,
    outcome: m?.outcome ?? null,
    approvalId: m?.approvalId ?? null,
    approvedBy: m?.approvedBy ?? null,
    approvedAt: m?.approvedAt ?? null,
    expiresAt: m?.expiresAt ?? null,
    digest: m?.digest ?? null,
    expired, executed, authorized, armed,
    stale: inspected?.stale === true,
    receiptState: inspected?.receiptState ?? 'absent',
    blockedReason: inspected?.blockedReason ?? null,
    reason: inspected?.manifestVerification?.reason ?? inspected?.reason ?? null,
  }
}
