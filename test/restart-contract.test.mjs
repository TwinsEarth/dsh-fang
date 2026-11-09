// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — restart-contract（supervisor 契约的阶段 1 清单 / 阶段 2 回执）
// 覆盖：清单形状与 digest、TTL 边界、只读校验的每个失败原因、回执「只认 executed===true」、
//       supervisor 放行前置条件、磁盘只读辅助（路径穿越/损坏 JSON/latest 指针）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  APPROVAL_KIND,
  CONTRACT_VERSION,
  DEFAULT_MANIFEST_TTL_MS,
  EXECUTION_KIND,
  MAX_MANIFEST_TTL_MS,
  MIN_MANIFEST_TTL_MS,
  approvalDir,
  approvalFile,
  buildApprovalManifest,
  buildExecutionReceipt,
  checkDigest,
  digestOf,
  executionDir,
  inspectApproval,
  isManifestId,
  latestApprovalFile,
  listApprovalIds,
  normalizeManifestTtl,
  readApprovalManifest,
  readExecutionReceipt,
  receiptFile,
  summarizeApproval,
  verifyApprovalManifest,
  verifyExecutionReceipt,
  verifyRestartAuthorization,
} from '../src/lib/restart-contract.mjs'

const T = 1_700_000_000_000
const NONCE = 'a'.repeat(64)

function baseInput(overrides = {}) {
  return {
    id: 'rst_test1',
    risk: 'red',
    outcome: 'approved',
    approvalId: 'apr_1',
    approvedBy: 'alice',
    reason: 'upgrade mother',
    scope: 'process',
    origin: 'supervisor',
    digests: ['sha256:aaa'],
    impactSource: 'service',
    requestedAt: T - 1000,
    approvedAt: T,
    ttlMs: 60000,
    nonce: NONCE,
    guard: {
      mode: 'enforce', authMode: 'manual', strictRedLine: true,
      allowProcessRestart: true, pid: 1234, instanceId: 'inst_1',
    },
    ...overrides,
  }
}

const build = (overrides = {}) => buildApprovalManifest(baseInput(overrides))
const redigest = (record) => {
  const copy = structuredClone(record)
  delete copy.digest
  return { ...copy, digest: digestOf(copy) }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fang-contract-'))

test('approval manifest: shape, digest and deterministic canonical form', () => {
  const manifest = build()
  assert.equal(manifest.version, CONTRACT_VERSION)
  assert.equal(manifest.kind, APPROVAL_KIND)
  assert.equal(manifest.id, 'rst_test1')
  assert.match(manifest.nonce, /^[0-9a-f]{64}$/)
  assert.equal(manifest.execution.executed, false, 'guard is decision-only: executed is always false')
  assert.equal(manifest.execution.decisionOnly, true)
  assert.equal(manifest.execution.plannedExitCode, 75)
  assert.equal(manifest.execution.executedBy, null)
  assert.equal(manifest.expiresAt, T + 60000)
  assert.equal(manifest.guard.decisionOnly, true)
  assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(checkDigest(manifest), { ok: true, expected: manifest.digest })

  const again = build()
  assert.deepEqual(again, manifest, 'same inputs + same nonce => identical digest/record')
  const other = build({ nonce: 'b'.repeat(64) })
  assert.notEqual(other.digest, manifest.digest)
})

test('approval manifest builder rejects bad input and clamps the TTL', () => {
  assert.throws(() => buildApprovalManifest(baseInput({ id: 'nope' })), /invalid restart request id/)
  assert.throws(() => buildApprovalManifest(baseInput({ id: '../etc/passwd' })), /invalid restart request id/)
  assert.throws(() => buildApprovalManifest(baseInput({ risk: 'green' })), /invalid risk/)
  assert.throws(() => buildApprovalManifest(baseInput({ outcome: 'denied' })), /invalid outcome/)
  assert.throws(() => buildApprovalManifest(baseInput({ approvalId: null })), /requires approvalId/)
  assert.throws(() => buildApprovalManifest(baseInput({ approvalId: '' })), /requires approvalId/)

  // auto-allow has no approval id; that is allowed.
  const auto = build({ outcome: 'auto-allow', approvalId: null, approvedBy: null })
  assert.equal(auto.outcome, 'auto-allow')
  assert.equal(auto.approvalId, null)
  assert.equal(verifyApprovalManifest(auto, { now: T + 1 }).ok, true)

  assert.equal(normalizeManifestTtl(1), MIN_MANIFEST_TTL_MS)
  assert.equal(normalizeManifestTtl(MAX_MANIFEST_TTL_MS * 10), MAX_MANIFEST_TTL_MS)
  assert.equal(normalizeManifestTtl(NaN), DEFAULT_MANIFEST_TTL_MS)
  assert.equal(normalizeManifestTtl(-5), DEFAULT_MANIFEST_TTL_MS)
  assert.equal(build({ ttlMs: 1 }).expiresAt - T, MIN_MANIFEST_TTL_MS)
  assert.equal(build({ ttlMs: 10 ** 9 }).expiresAt - T, MAX_MANIFEST_TTL_MS)
})

test('verifyApprovalManifest: valid manifest passes at several clocks within the window', () => {
  const manifest = build()
  assert.deepEqual(
    verifyApprovalManifest(manifest, { now: T + 1, expectedId: 'rst_test1', expectedNonce: NONCE }),
    { ok: true, reason: null, expired: false, digestValid: true, remainingMs: 59999 },
  )
  assert.deepEqual(
    verifyApprovalManifest(manifest, { now: T }),
    { ok: true, reason: null, expired: false, digestValid: true, remainingMs: 60000 },
  )
  // 只读：校验不得改记录
  const before = structuredClone(manifest)
  verifyApprovalManifest(manifest, { now: T + 5000 })
  assert.deepEqual(manifest, before)
})

test('verifyApprovalManifest: one failure reason per broken invariant', () => {
  const manifest = build()
  const v = (m, opts) => verifyApprovalManifest(m, opts)

  assert.equal(v(null).reason, 'invalid-shape')
  assert.equal(v({ ...manifest, version: 2 }).reason, 'unsupported-version')
  assert.equal(v({ ...manifest, kind: 'other' }).reason, 'wrong-kind')
  assert.equal(v({ ...manifest, id: 'bad id' }).reason, 'bad-id')
  assert.equal(v(manifest, { expectedId: 'rst_other' }).reason, 'id-mismatch')
  assert.equal(v({ ...manifest, nonce: 'zz' }).reason, 'bad-nonce')
  assert.equal(v(manifest, { expectedNonce: 'c'.repeat(64) }).reason, 'nonce-mismatch')
  assert.equal(v({ ...manifest, risk: 'purple' }).reason, 'bad-risk')
  assert.equal(v({ ...manifest, outcome: 'denied' }).reason, 'bad-outcome')
  assert.equal(v(redigest({ ...manifest, approvalId: null })).reason, 'missing-approval-id')
  assert.equal(v({ ...manifest, requestedAt: T + 5000 }).reason, 'bad-timestamps', 'approvedAt < requestedAt')
  assert.equal(v({ ...manifest, expiresAt: T }).reason, 'bad-timestamps', 'expiresAt <= approvedAt')
  assert.equal(v(redigest({ ...manifest, expiresAt: T + MAX_MANIFEST_TTL_MS + 1 })).reason, 'ttl-too-long')
  assert.equal(v({ ...manifest, execution: { ...manifest.execution, executed: true } }).reason, 'guard-executed')
  assert.equal(v({ ...manifest, execution: { ...manifest.execution, decisionOnly: false } }).reason, 'not-decision-only')
  assert.equal(v({ ...manifest, execution: { ...manifest.execution, plannedExitCode: 1 } }).reason, 'bad-exit-code')
  assert.equal(v({ ...manifest, reason: 'tampered' }).reason, 'digest-mismatch')

  const expired = v(manifest, { now: T + 60000 })
  assert.deepEqual(expired, { ok: false, reason: 'expired', expired: true, digestValid: true, remainingMs: 0 })
  assert.equal(v(manifest, { now: T + 60000 }).digestValid, true, 'expired is not the same as corrupt')
})

test('execution receipt: built only for a valid manifest, executed===true is the proof', () => {
  const manifest = build()
  const receipt = buildExecutionReceipt({ manifest, supervisorId: 'sup-1', pid: 4242, executedAt: T + 5000 })
  assert.equal(receipt.version, CONTRACT_VERSION)
  assert.equal(receipt.kind, EXECUTION_KIND)
  assert.equal(receipt.id, manifest.id)
  assert.equal(receipt.nonce, manifest.nonce)
  assert.equal(receipt.manifestDigest, manifest.digest)
  assert.equal(receipt.execution.executed, true)
  assert.equal(receipt.execution.executedBy, 'sup-1')
  assert.equal(receipt.execution.supervisorPid, 4242)
  assert.equal(receipt.execution.exitCode, 75)
  assert.equal(checkDigest(receipt).ok, true)

  // 回执的有效性按「执行时刻」判定：清单后来过期了，回执仍然是有效的执行证明。
  const late = verifyExecutionReceipt(receipt, { manifest, now: T + 10 * 60000 })
  assert.equal(late.ok, true)
  assert.equal(late.executed, true)
  assert.equal(late.executedAt, T + 5000)

  // 没有清单时也能独立核验回执
  assert.equal(verifyExecutionReceipt(receipt).ok, true)
  assert.equal(verifyExecutionReceipt(receipt, { manifest: build({ nonce: 'd'.repeat(64) }) }).reason, 'manifest-mismatch')

  assert.throws(() => buildExecutionReceipt({ manifest: { ...manifest, reason: 'tampered' }, supervisorId: 's' }), /invalid manifest/)
  assert.throws(
    () => buildExecutionReceipt({ manifest, supervisorId: '   ', executedAt: T + 1 }),
    /supervisorId/,
  )
  assert.throws(() => buildExecutionReceipt({ manifest, supervisorId: 's', executedAt: manifest.expiresAt }), /invalid manifest/)
})

test('execution receipt: false / missing / string executed are all "not executed"', () => {
  const manifest = build()
  const receipt = buildExecutionReceipt({ manifest, supervisorId: 'sup-1', executedAt: T + 1 })
  const bad = (mutate) => {
    const copy = structuredClone(receipt)
    mutate(copy)
    return redigest(copy)
  }

  const notExecuted = bad((r) => { r.execution.executed = false })
  assert.deepEqual(
    verifyExecutionReceipt(notExecuted, { manifest }),
    { ok: false, reason: 'not-executed', executed: false },
  )
  const missing = bad((r) => { delete r.execution.executed })
  assert.equal(verifyExecutionReceipt(missing, { manifest }).reason, 'not-executed')
  const stringTrue = bad((r) => { r.execution.executed = 'true' })
  assert.equal(verifyExecutionReceipt(stringTrue, { manifest }).reason, 'not-executed', 'string "true" is not proof')
  assert.equal(verifyExecutionReceipt(bad((r) => { r.execution.executedBy = '' }), { manifest }).reason, 'bad-executor')
  assert.equal(verifyExecutionReceipt(bad((r) => { r.execution.at = NaN }), { manifest }).reason, 'bad-timestamp')
  assert.equal(verifyExecutionReceipt(bad((r) => { r.execution.executedBy = 'tampered' }), { manifest }).ok, true)
  assert.equal(
    verifyExecutionReceipt(bad((r) => { r.execution.executedBy = 'x' }), { manifest }).ok,
    true,
    'digest is recomputed in bad(), so this record is internally consistent',
  )
  // 未重算 digest 的字段篡改必须被发现
  const tampered = structuredClone(receipt)
  tampered.execution.executedBy = 'mine'
  assert.equal(verifyExecutionReceipt(tampered, { manifest }).reason, 'digest-mismatch')

  // 外部时间窗口：回执声明的执行时刻必须在清单窗口内
  const outside = bad((r) => { r.execution.at = manifest.expiresAt })
  assert.equal(verifyExecutionReceipt(outside, { manifest }).reason, 'receipt-outside-window')
  const before = bad((r) => { r.execution.at = manifest.approvedAt - 1 })
  assert.equal(verifyExecutionReceipt(before, { manifest }).reason, 'receipt-outside-window')
})

test('verifyRestartAuthorization: the only pre-execution gate, fail-closed', () => {
  const manifest = build()
  const allowed = verifyRestartAuthorization(manifest, { now: T + 1000, expectedId: manifest.id })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.reason, null)

  const receipt = buildExecutionReceipt({ manifest, supervisorId: 'sup-1', executedAt: T + 1000 })
  assert.equal(
    verifyRestartAuthorization(manifest, { now: T + 1000, receipt }).reason,
    'already-executed',
    'never execute twice',
  )

  const fakeReceipt = redigest({ ...receipt, execution: { ...receipt.execution, executed: false } })
  assert.match(
    verifyRestartAuthorization(manifest, { now: T + 1000, receipt: fakeReceipt }).reason,
    /^invalid-receipt:not-executed$/,
    'a receipt that does not prove execution must block, not be ignored',
  )

  assert.equal(verifyRestartAuthorization(manifest, { now: manifest.expiresAt }).reason, 'expired')
  assert.equal(verifyRestartAuthorization(null).reason, 'invalid-shape')

  // 三重门禁里可由清单证明的两把钥匙：mode=enforce 与 allowProcessRestart=true
  const observe = build({ guard: { ...baseInput().guard, mode: 'observe' } })
  assert.equal(verifyRestartAuthorization(observe, { now: T + 1 }).reason, 'guard-not-enforce')
  const disabled = build({ guard: { ...baseInput().guard, allowProcessRestart: false } })
  assert.equal(verifyRestartAuthorization(disabled, { now: T + 1 }).reason, 'process-restart-disabled')
  assert.equal(
    verifyRestartAuthorization(disabled, { now: T + 1, requireArmed: false }).allowed,
    true,
    'requireArmed:false is only for pure structure checks, never for execution',
  )
})

test('read-only disk helpers: path containment, atomic manifest round-trip, latest pointer ignored', () => {
  const dir = tmp()
  try {
    const manifest = build()
    const file = approvalFile(dir, manifest.id)
    assert.equal(file, path.join(approvalDir(dir), 'rst_test1.json'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(manifest), 'utf8')
    fs.writeFileSync(latestApprovalFile(dir), JSON.stringify({ id: manifest.id, file: 'rst_test1.json' }), 'utf8')
    fs.writeFileSync(path.join(approvalDir(dir), 'notes.txt'), 'ignored', 'utf8')

    assert.deepEqual(readApprovalManifest(dir, manifest.id), manifest)
    assert.equal(readExecutionReceipt(dir, manifest.id), null)
    assert.deepEqual(listApprovalIds(dir), ['rst_test1'], 'latest.json / non-json / non-rst files are excluded')
    assert.equal(approvalDir(dir), path.join(dir, 'approved'))
    assert.equal(executionDir(dir), path.join(dir, 'executed'))

    // 未校验的 id 永远不拼路径
    assert.equal(approvalFile(dir, '../escape'), null)
    assert.equal(receiptFile(dir, 'rst_a/../../b'), null)
    assert.equal(approvalFile(dir, 'rst_ok'), path.join(dir, 'approved', 'rst_ok.json'))
    assert.equal(isManifestId('rst_ok'), true)
    assert.equal(isManifestId('rst_'), false)
    assert.equal(readApprovalManifest(dir, '../../etc/passwd'), null)
    assert.equal(readExecutionReceipt(dir, '../../etc/passwd'), null)
    assert.deepEqual(listApprovalIds(path.join(dir, 'missing')), [])

    // 损坏 JSON：文件存在但不可读 => found:false，不抛
    fs.writeFileSync(approvalFile(dir, 'rst_broken'), '{not json', 'utf8')
    assert.equal(readApprovalManifest(dir, 'rst_broken'), null)
    const broken = inspectApproval(dir, 'rst_broken')
    assert.equal(broken.found, false)
    assert.equal(broken.reason, 'not-found')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectApproval: authorized → stale → executed / invalid-receipt state machine', () => {
  const dir = tmp()
  try {
    const manifest = build()
    fs.mkdirSync(approvalDir(dir), { recursive: true })
    fs.writeFileSync(approvalFile(dir, manifest.id), JSON.stringify(manifest), 'utf8')

    const fresh = inspectApproval(dir, manifest.id, { now: T + 1000 })
    assert.equal(fresh.found, true)
    assert.equal(fresh.valid, true)
    assert.equal(fresh.authorized, true)
    assert.equal(fresh.executed, false)
    assert.equal(fresh.expired, false)
    assert.equal(fresh.stale, false)
    assert.equal(fresh.receiptState, 'absent')
    assert.equal(fresh.manifestVerification.ok, true)
    assert.equal(summarizeApproval(fresh).state, 'authorized')

    const expired = inspectApproval(dir, manifest.id, { now: manifest.expiresAt })
    assert.equal(expired.expired, true)
    assert.equal(expired.authorized, false)
    assert.equal(expired.stale, true)
    assert.equal(summarizeApproval(expired).state, 'stale')

    // supervisor 完成后写回执
    const receipt = buildExecutionReceipt({ manifest, supervisorId: 'sup-1', executedAt: T + 1000 })
    fs.mkdirSync(executionDir(dir), { recursive: true })
    fs.writeFileSync(receiptFile(dir, manifest.id), JSON.stringify(receipt), 'utf8')
    const executed = inspectApproval(dir, manifest.id, { now: manifest.expiresAt })
    assert.equal(executed.executed, true)
    assert.equal(executed.authorized, false, 'executed approval must never be re-authorized')
    assert.equal(executed.stale, false)
    assert.equal(executed.receiptState, 'executed')
    assert.equal(summarizeApproval(executed).state, 'executed')

    // 损坏/不证明执行的回执 => fail-closed，不允许再执行
    const badReceipt = structuredClone(receipt)
    badReceipt.execution.executed = false
    fs.writeFileSync(receiptFile(dir, manifest.id), JSON.stringify(badReceipt), 'utf8')
    const invalidReceipt = inspectApproval(dir, manifest.id, { now: T + 1000 })
    assert.equal(invalidReceipt.executed, false)
    assert.equal(invalidReceipt.authorized, false, 'a present-but-invalid receipt blocks re-execution')
    assert.equal(invalidReceipt.receiptState, 'invalid')
    assert.equal(summarizeApproval(invalidReceipt).state, 'invalid-receipt')

    // 摘要状态：missing / invalid
    const missing = summarizeApproval(inspectApproval(dir, 'rst_missing'))
    assert.equal(missing.state, 'missing')
    fs.rmSync(receiptFile(dir, manifest.id), { force: true })
    const invalid = inspectApproval(dir, manifest.id, { now: T + 1000 })
    invalid.valid = false
    invalid.authorized = false
    invalid.manifestVerification = { ok: false, reason: 'digest-mismatch', expired: false, digestValid: false }
    assert.equal(summarizeApproval(invalid).state, 'invalid')

    // 非法 id 的只读检查不碰磁盘
    const badId = inspectApproval(dir, '../x')
    assert.equal(badId.found, false)
    assert.equal(badId.reason, 'bad-id')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('inspectApproval: tampered manifest is invalid and never authorized', () => {
  const dir = tmp()
  try {
    const manifest = build()
    const tampered = { ...manifest, risk: 'blue' } // digest 未重算
    fs.mkdirSync(approvalDir(dir), { recursive: true })
    fs.writeFileSync(approvalFile(dir, manifest.id), JSON.stringify(tampered), 'utf8')
    const inspected = inspectApproval(dir, manifest.id, { now: T + 1000 })
    assert.equal(inspected.valid, false)
    assert.equal(inspected.authorized, false)
    assert.equal(inspected.manifestVerification.reason, 'digest-mismatch')
    assert.equal(summarizeApproval(inspected).state, 'invalid')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
