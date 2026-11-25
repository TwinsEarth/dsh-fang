// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — restart 契约加固：HMAC 清单签名、启动对账、旧清单 prune。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  approvalDir,
  approvalFile,
  buildApprovalManifest,
  buildExecutionReceipt,
  executionDir,
  latestApprovalFile,
  pruneRestartState,
  readHmacSecret,
  reconcileRestartState,
  resolveHmacSecret,
  signRecord,
  verifyApprovalManifest,
  verifyRecordSignature,
} from '../src/lib/restart-contract.mjs'

const SECRET = 'unit-test-hmac-secret-0123456789abcdef'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-hmac-'))
const mkManifest = (extra = {}) => buildApprovalManifest({
  id: extra.id ?? 'rst_0123456789abcdef',
  risk: 'yellow',
  outcome: 'approved',
  approvalId: 'apr_1',
  approvedBy: 'tester',
  reason: 'unit',
  requestedAt: 1000,
  approvedAt: 1000,
  ttlMs: 60000,
  guard: { mode: 'enforce', allowProcessRestart: true, pid: 111, authMode: 'manual', strictRedLine: true },
  hmacSecret: extra.hmacSecret === undefined ? SECRET : extra.hmacSecret,
  ...extra,
})

function writeManifest(stateDir, manifest) {
  fs.mkdirSync(approvalDir(stateDir), { recursive: true })
  fs.writeFileSync(approvalFile(stateDir, manifest.id), JSON.stringify(manifest), 'utf8')
}

function writeReceipt(stateDir, receipt) {
  fs.mkdirSync(executionDir(stateDir), { recursive: true })
  fs.writeFileSync(path.join(executionDir(stateDir), `${receipt.id}.json`), JSON.stringify(receipt), 'utf8')
}

test('restart-contract: HMAC signature makes a tampered manifest fail before execution', () => {
  const manifest = mkManifest({ hmacSecret: SECRET })
  assert.equal(manifest.signature.alg, 'hmac-sha256')
  assert.equal(typeof manifest.signature.value, 'string')
  const ok = verifyApprovalManifest(manifest, { now: 2000, hmacSecret: SECRET })
  assert.equal(ok.ok, true)

  const tampered = { ...manifest, reason: 'tampered after signing' }
  const verdict = verifyApprovalManifest(tampered, { now: 2000, hmacSecret: SECRET })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'digest-mismatch')

  // 没有签名 (或本机有 key) 时也必须 fail-closed，而不是忽略签名。
  const unsigned = mkManifest({ hmacSecret: null })
  assert.equal(verifyApprovalManifest(unsigned, { now: 2000, hmacSecret: SECRET }).reason, 'missing-signature')
  assert.equal(verifyApprovalManifest(unsigned, { now: 2000, requireSignature: true }).reason, 'missing-signature')
  assert.equal(verifyApprovalManifest(manifest, { now: 2000 }).ok, true, 'no key configured => digest-only fallback')
})

test('restart-contract: HMAC secret resolve/read (env first, file generated 0600)', () => {
  const dir = tmp()
  try {
    const generated = resolveHmacSecret(dir)
    assert.equal(generated.ok, true)
    assert.equal(generated.source, 'generated')
    assert.ok(fs.existsSync(path.join(dir, 'restart-hmac.key')))
    const read = readHmacSecret(dir)
    assert.equal(read.ok, true)
    assert.equal(read.secret, generated.secret)
    assert.equal(read.source, 'file')

    const fromEnv = readHmacSecret(dir, { env: { FANG_RESTART_HMAC_SECRET: SECRET } })
    assert.equal(fromEnv.source, 'env')
    assert.equal(fromEnv.secret, SECRET)

    const empty = tmp()
    assert.equal(readHmacSecret(empty).ok, false, 'verifier must not generate a key')
    fs.rmSync(empty, { recursive: true, force: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('restart-contract: signRecord/verifyRecordSignature roundtrip and tamper detection', () => {
  const record = { a: 1, b: { c: 2 } }
  const signed = signRecord(record, SECRET)
  assert.equal(verifyRecordSignature(signed, SECRET).ok, true)
  assert.equal(verifyRecordSignature({ ...signed, a: 9 }, SECRET).ok, false)
  assert.equal(verifyRecordSignature({ a: 1 }, SECRET).reason, 'missing-signature')
})

test('restart-contract: startup reconcile classifies armed/executed/stale/invalid', () => {
  const stateDir = tmp()
  try {
    const now = 10_000_000
    const armed = mkManifest({ id: 'rst_aaaaaaaaaaaaaaaa', approvedAt: now - 1000, requestedAt: now - 1000, ttlMs: 60000 })
    writeManifest(stateDir, armed)

    const expired = mkManifest({ id: 'rst_bbbbbbbbbbbbbbbb', approvedAt: now - 120000, requestedAt: now - 120000, ttlMs: 1000 })
    writeManifest(stateDir, expired)

    const executed = mkManifest({ id: 'rst_cccccccccccccccc', approvedAt: now - 1000, requestedAt: now - 1000, ttlMs: 60000 })
    writeManifest(stateDir, executed)
    writeReceipt(stateDir, buildExecutionReceipt({ manifest: executed, supervisorId: 'unit-supervisor', previousPid: 111, replacementPid: 222, executedAt: now - 500 }))

    const invalid = { ...mkManifest({ id: 'rst_dddddddddddddddd', approvedAt: now - 1000, requestedAt: now - 1000, ttlMs: 60000 }), title: 'tampered' }
    writeManifest(stateDir, invalid)

    const report = reconcileRestartState(stateDir, { now, hmacSecret: SECRET })
    assert.equal(report.checked, 4)
    assert.equal(report.counts.armed, 1)
    assert.equal(report.counts.executed, 1)
    assert.equal(report.counts.stale, 1)
    assert.equal(report.counts.invalid, 1)
    assert.equal(report.rows.find(row => row.id === 'rst_bbbbbbbbbbbbbbbb').state, 'stale')
    assert.equal(report.rows.find(row => row.id === 'rst_aaaaaaaaaaaaaaaa').signed, true)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('restart-contract: prune removes old manifests but keeps armed/newest and fixes latest pointer', () => {
  const stateDir = tmp()
  try {
    const now = 20_000_000
    const stale = mkManifest({ id: 'rst_eeeeeeeeeeeeeeee', approvedAt: now - 90 * 86400_000, requestedAt: now - 90 * 86400_000, ttlMs: 1000 })
    writeManifest(stateDir, stale)
    const armed = mkManifest({ id: 'rst_ffffffffffffffff', approvedAt: now - 1000, requestedAt: now - 1000, ttlMs: 60000 })
    writeManifest(stateDir, armed)
    fs.writeFileSync(latestApprovalFile(stateDir), JSON.stringify({ id: stale.id, file: `${stale.id}.json` }), 'utf8')

    const pruned = pruneRestartState(stateDir, { now, hmacSecret: SECRET, retentionMs: 0, keep: 0 })
    assert.deepEqual(pruned.removed, [stale.id])
    assert.equal(fs.existsSync(approvalFile(stateDir, stale.id)), false)
    assert.equal(fs.existsSync(approvalFile(stateDir, armed.id)), true)
    const latest = JSON.parse(fs.readFileSync(latestApprovalFile(stateDir), 'utf8'))
    assert.equal(latest.id, armed.id, 'latest pointer must move to a surviving manifest')

    const keepNewest = pruneRestartState(stateDir, { now, hmacSecret: SECRET, retentionMs: 0, keep: 1 })
    assert.equal(keepNewest.removed.includes(armed.id), false, 'keep protects the newest manifest even if expired')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
