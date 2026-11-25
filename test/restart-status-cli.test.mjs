// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — restart-status: 只读的 CLI/库投影（fangctl restart-status + readRestartStatus）。
// 覆盖：无状态时不伪造 idle、清单计数口径、pending/lastInterrupted、limit、只读性、CLI 输出。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  approvalFile,
  buildApprovalManifest,
  buildExecutionReceipt,
  readRestartStatus,
  receiptFile,
  summarizeApprovalCounts,
} from '../src/lib/restart-contract.mjs'

const TOOL = path.join(import.meta.dirname, '..', 'tools', 'fangctl.mjs')
const execFileAsync = promisify(execFile)
const now = Date.now()

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fang-restart-status-'))
}

function armedManifest({ id, pid = 0, approvedAt = now, ttlMs = 60000, mode = 'enforce', allow = true } = {}) {
  return buildApprovalManifest({
    id,
    risk: 'red',
    outcome: 'approved',
    approvalId: `apr_${id}`,
    approvedBy: 'tester',
    reason: 'status test',
    scope: 'process',
    origin: 'supervisor',
    digests: ['sha256:d'],
    requestedAt: approvedAt - 10,
    approvedAt,
    ttlMs,
    guard: { mode, authMode: 'manual', strictRedLine: true, allowProcessRestart: allow, pid, instanceId: 'inst' },
  })
}

function writeManifest(stateDir, manifest) {
  const file = approvalFile(stateDir, manifest.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(manifest), 'utf8')
}

function seedRestartDir(dataDir) {
  const stateDir = path.join(dataDir, 'restart')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
    version: 1,
    state: 'awaiting',
    pending: { id: 'rst_pending', risk: 'red', phase: 'awaiting', since: now - 1000, deadlineAt: now + 60000 },
    at: now,
    lastInterrupted: { id: 'rst_old', risk: 'red', previousState: 'executing', at: now - 500000 },
  }), 'utf8')

  const authorized = armedManifest({ id: 'rst_authorized', approvedAt: now - 100 })
  const unarmed = armedManifest({ id: 'rst_unarmed', approvedAt: now - 200, allow: false })
  const expired = armedManifest({ id: 'rst_expired', approvedAt: now - 120000, ttlMs: 1000 })
  const executed = armedManifest({ id: 'rst_executed', approvedAt: now - 300 })
  for (const manifest of [authorized, unarmed, expired, executed]) writeManifest(stateDir, manifest)

  const receipt = buildExecutionReceipt({ manifest: executed, supervisorId: 'test-supervisor', executedAt: now - 250, previousPid: 123 })
  fs.mkdirSync(path.dirname(receiptFile(stateDir, executed.id)), { recursive: true })
  fs.writeFileSync(receiptFile(stateDir, executed.id), JSON.stringify(receipt), 'utf8')

  // latest.json 是指针，不是清单；不能被计数
  fs.writeFileSync(path.join(stateDir, 'approved', 'latest.json'), JSON.stringify({ id: 'rst_authorized' }), 'utf8')
  return { stateDir, ids: ['rst_authorized', 'rst_unarmed', 'rst_expired', 'rst_executed'] }
}

test('readRestartStatus: empty/missing state never pretends to be idle', () => {
  const dataDir = tmp()
  try {
    const status = readRestartStatus(dataDir)
    assert.equal(status.ok, true)
    assert.equal(status.state, 'unknown')
    assert.equal(status.pending, null)
    assert.equal(status.stateAt, null)
    assert.deepEqual(status.approvals.items, [])
    assert.deepEqual(status.approvals.counts, summarizeApprovalCounts([]))
    assert.equal(status.executed, false)
    assert.equal(status.contract.decisionOnly, true)
    assert.equal(status.contract.guardExecuted, false)
    assert.equal(status.dirs.approved, path.join(dataDir, 'restart', 'approved'))
    assert.equal(status.dirs.executed, path.join(dataDir, 'restart', 'executed'))
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('readRestartStatus: counts and summaries share the guard/HTTP projection', () => {
  const dataDir = tmp()
  try {
    const { stateDir, ids } = seedRestartDir(dataDir)
    const status = readRestartStatus(dataDir, { now })
    assert.equal(status.state, 'awaiting')
    assert.equal(status.pending.id, 'rst_pending')
    assert.equal(status.pending.risk, 'red')
    assert.equal(status.lastInterrupted.id, 'rst_old')
    assert.equal(status.stateAt, now)
    assert.deepEqual(status.approvals.counts, {
      total: 4, authorized: 1, executed: 1, stale: 1, notArmed: 1, invalid: 0,
    })
    const states = Object.fromEntries(status.approvals.items.map(item => [item.id, item.state]))
    assert.deepEqual(states, {
      rst_authorized: 'authorized',
      rst_unarmed: 'not-armed',
      rst_expired: 'stale',
      rst_executed: 'executed',
    })
    // 按 approvedAt 倒序；latest.json 不参与
    assert.deepEqual(status.approvals.items.map(item => item.id), [
      'rst_authorized', 'rst_unarmed', 'rst_executed', 'rst_expired',
    ])
    assert.deepEqual(status.approvals.items.map(item => item.id), ids.slice().sort((a, b) => {
      const at = (id) => status.approvals.items.find(item => item.id === id)?.approvedAt ?? 0
      return at(b) - at(a)
    }))
    assert.equal(status.approvals.items.find(item => item.id === 'rst_unarmed').blockedReason, 'process-restart-disabled')
    assert.equal(status.approvals.items.find(item => item.id === 'rst_expired').expired, true)

    // limit 只截断 items，不影响 counts
    const limited = readRestartStatus(dataDir, { now, limit: 2 })
    assert.equal(limited.approvals.items.length, 2)
    assert.equal(limited.approvals.counts.total, 4)
    assert.equal(limited.approvals.counts.authorized, 1)

    // 幂等 + 只读：连续读取结果一致，不新增文件
    const before = fs.readdirSync(path.join(stateDir, 'approved')).sort()
    const again = readRestartStatus(dataDir, { now })
    assert.deepEqual(again, status)
    assert.deepEqual(fs.readdirSync(path.join(stateDir, 'approved')).sort(), before)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('fangctl restart-status --json: offline read-only CLI projection', () => {
  const dataDir = tmp()
  try {
    seedRestartDir(dataDir)
    const result = spawnSync(process.execPath, [TOOL, 'restart-status', '--data-root', dataDir, '--json'], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const body = JSON.parse(result.stdout)
    assert.equal(body.ok, true)
    assert.equal(body.dataDir, dataDir)
    assert.equal(body.state, 'awaiting')
    assert.equal(body.approvals.counts.total, 4)
    assert.equal(body.approvals.counts.authorized, 1)
    assert.equal(body.executed, false)
    assert.match(body.contract.rule, /execution\.executed === true/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('fangctl restart-status (human): prints state, manifest table and no-execution note', () => {
  const dataDir = tmp()
  try {
    seedRestartDir(dataDir)
    const result = spawnSync(process.execPath, [TOOL, 'restart-status', '--data-root', dataDir], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /restart guard @/)
    assert.match(result.stdout, /state\s+: awaiting/)
    assert.match(result.stdout, /rst_pending/)
    assert.match(result.stdout, /authorized=1/)
    assert.match(result.stdout, /rst_authorized/)
    assert.match(result.stdout, /decision-only; no execution/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('fangctl restart-status: missing data dir reports unknown, not idle', () => {
  const dataDir = tmp()
  try {
    const result = spawnSync(process.execPath, [TOOL, 'restart-status', '--data-root', dataDir, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const body = JSON.parse(result.stdout)
    assert.equal(body.state, 'unknown')
    assert.equal(body.approvals.counts.total, 0)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

function withHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

test('fangctl restart-status --url: reads the live host contract read-only', async () => {
  const remoteBody = {
    ok: true,
    available: true,
    decisionOnly: true,
    executed: false,
    state: { state: 'idle', pending: null },
    policy: {
      mode: 'enforce', authMode: 'auto', strictRedLine: false, redLineAutoAllowed: true,
      allowProcessRestart: true, decisionOnly: true,
    },
    contract: { decisionOnly: true, guardExecuted: false, rule: '「已执行」只认回执 execution.executed === true；授权清单里恒为 false。' },
    approvals: {
      items: [{ id: 'rst_remote', state: 'authorized' }],
      counts: { total: 1, authorized: 1, executed: 0, stale: 0, notArmed: 0, invalid: 0 },
    },
  }
  const server = await withHttpServer((req, res) => {
    if (req.url === '/fang/api/restart') {
      assert.equal(req.headers['x-fang-auth'], 'tok')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(remoteBody))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not-found' }))
  })
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      TOOL, 'restart-status', '--url', server.url, '--token', 'tok', '--json',
    ], { encoding: 'utf8' })
    const body = JSON.parse(stdout)
    assert.equal(body.status, 200)
    assert.equal(body.available, true)
    assert.equal(body.state.state, 'idle')
    assert.equal(body.policy.mode, 'enforce')
    assert.equal(body.policy.redLineAutoAllowed, true)
    assert.equal(body.approvals.counts.authorized, 1)
    assert.equal(body.executed, false)

    const human = await execFileAsync(process.execPath, [
      TOOL, 'restart-status', '--url', server.url, '--token', 'tok',
    ], { encoding: 'utf8' })
    assert.match(human.stdout, /restart guard \(remote, read-only\)/)
    assert.match(human.stdout, /strictRedLine=false/)
    assert.match(human.stdout, /armed\s+: yes/)
    assert.match(human.stdout, /authorized=1/)
    assert.match(human.stdout, /decision-only; no execution/)
  } finally {
    await server.close()
  }
})

test('fangctl restart-status --url: old bundle 404 is reported, not faked', async () => {
  const server = await withHttpServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not-found' }))
  })
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [TOOL, 'restart-status', '--url', server.url, '--token', 'tok'], { encoding: 'utf8' }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(String(error.stderr), /HTTP 404/)
        assert.match(String(error.stderr), /旧 bundle/)
        return true
      },
    )
  } finally {
    await server.close()
  }
})
