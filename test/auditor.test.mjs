// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T1 — auditor tests: chained ledger, chain verification and the boot admission gate.
//
// "The previous run" is simulated the honest way: records are written with the kernel's
// own appendChained() (i.e. exactly what another process would leave on disk), then a
// fresh plugin instance is applied on top of that ledger.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AUDIT,
  GENESIS,
  SERVICE,
  appendChained,
  exists,
  iso,
  readTextSafe,
  removeTree,
} from '../src/kernel/index.mjs'
import * as auditor from '../src/plugins/auditor.mjs'
import { makeCtx } from './helpers.mjs'

const tmpDirs = []
function tmp(prefix = 'fang-t1-auditor-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
function cleanupTmp() {
  for (const dir of tmpDirs.splice(0)) removeTree(dir)
}
after(cleanupTmp)

function newAuditor(config = {}) {
  const ctx = makeCtx()
  const service = auditor.apply(ctx, config)
  return { ctx, service }
}

/** Leave a ledger behind exactly like a previous process would have. */
function writePreviousRun(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (const record of records) appendChained(file, { at: iso(Date.now() - 60_000), ...record })
}

test('module surface: cordis plugin shape and config defaults', () => {
  assert.equal(auditor.name, 'fang-auditor')
  assert.deepEqual(auditor.inject, [])
  assert.equal(typeof auditor.Config, 'function')
  assert.equal(typeof auditor.apply, 'function')
  const cfg = auditor.Config({})
  assert.equal(cfg.bootSelfCheck, true)
  assert.equal(cfg.dataRoot, '')
  assert.equal(cfg.ledgerFile, '')
  assert.equal(cfg.role, 'mother', 'v2: role defaults to mother')
  assert.throws(() => auditor.Config({ role: 'bogus' }))
})

test('apply registers fangAudit, exposes ledgerFile and writes nothing by itself', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root })
  try {
    assert.equal(ctx.get(SERVICE.auditor), service)
    assert.equal(service.ledgerFile, path.join(root, 'audit.jsonl'))
    assert.equal(service.scope, 'mother', 'v2: default role is mother')
    for (const method of ['append', 'read', 'verify', 'bootCheck', 'bootAudit', 'aggregate', 'cloudSink']) {
      assert.equal(typeof service[method], 'function', `missing service.${method}`)
    }
    // apply() is read-only: the eager boot self-check must not create the ledger.
    assert.equal(exists(path.join(root, 'audit.jsonl')), false)
    assert.deepEqual(service.read(), [])
    assert.equal(service.verify().ok, true)
    assert.equal(service.verify().records, 0)
    const boot = service.bootCheck()
    assert.equal(boot.ok, true)
    assert.deepEqual(boot.findings, [])
    assert.equal(service.lastBoot.ok, true, 'bootSelfCheck=true stores the eager result')
  } finally {
    ctx.dispose()
  }
})

test('append builds a chained ledger with at/seq and read returns the newest records', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root })
  try {
    const first = service.append('first', { note: 'a' })
    assert.equal(first.kind, 'first')
    assert.equal(first.seq, 0)
    assert.equal(first.prevHash, GENESIS)
    assert.match(first.hash, /^[0-9a-f]{64}$/)
    assert.equal(Number.isFinite(Date.parse(first.at)), true)
    assert.equal(first.inst, service.instanceId)

    const second = service.append('second', { note: 'b' })
    assert.equal(second.seq, 1)
    assert.equal(second.prevHash, first.hash)

    const third = service.append(AUDIT.FORK_STARTED, { forkId: 'f1' })
    assert.equal(third.seq, 2)
    assert.equal(third.pid, process.pid)

    assert.equal(service.read().length, 3)
    assert.deepEqual(
      service.read({ limit: 2 }).map((rec) => rec.kind),
      ['second', AUDIT.FORK_STARTED],
    )
    assert.equal(service.read({ limit: 0 }).length, 0)
    assert.deepEqual(service.read({ limit: 1 }).map((rec) => rec.seq), [2])

    assert.equal(service.append('', {}), null)
    assert.equal(service.append(null, {}), null)

    const lines = readTextSafe(service.ledgerFile).trim().split('\n')
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[0]).prevHash, GENESIS)
    assert.equal(JSON.parse(lines[2]).kind, AUDIT.FORK_STARTED)
  } finally {
    ctx.dispose()
  }
})

test('verify() accepts an intact chain and names the first bad record after tampering', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root })
  try {
    service.append(AUDIT.BOOT, { note: 'boot' })
    service.append(AUDIT.FORK_STARTED, { forkId: 'f1' })
    service.append(AUDIT.FORK_REAPED, { forkId: 'f1' })
    const good = service.verify()
    assert.equal(good.ok, true)
    assert.equal(good.records, 3)
    assert.equal(good.firstBadSeq, null)

    const lines = readTextSafe(service.ledgerFile).trim().split('\n')
    const tampered = JSON.parse(lines[1])
    tampered.forkId = 'someone-else'
    lines[1] = JSON.stringify(tampered)
    fs.writeFileSync(service.ledgerFile, lines.join('\n') + '\n')

    const bad = service.verify()
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'hash-mismatch')
    assert.equal(bad.badIndex, 1)
    assert.equal(bad.firstBadSeq, 1)

    // A corrupt tail must never be silently extended (that would hide the tampering).
    const before = readTextSafe(service.ledgerFile).trim().split('\n').length
    assert.equal(service.append('after-tamper', {}), null)
    assert.ok(service.lastError)
    assert.equal(readTextSafe(service.ledgerFile).trim().split('\n').length, before)
    assert.equal(service.read().length, 3)
  } finally {
    ctx.dispose()
  }
})

test('read() skips unparsable lines while verify() reports them (fail-closed)', () => {
  const root = tmp()
  const ledgerFile = path.join(root, 'ledger.jsonl')
  writePreviousRun(ledgerFile, [{ kind: 'ok-a', pid: 4242 }])
  fs.appendFileSync(ledgerFile, 'this is not json\n')
  const { ctx, service } = newAuditor({ ledgerFile })
  try {
    assert.equal(service.read().length, 1, 'read never throws on a broken line')
    const bad = service.verify()
    assert.equal(bad.ok, false)
    assert.equal(bad.reason, 'unparsable')
    assert.equal(bad.firstBadSeq, 1)
    assert.equal(service.append('nope', {}), null, 'an unparsable tail must not be extended')
  } finally {
    ctx.dispose()
  }
})

test('bootCheck ignores this instance own records (no false unclean-boot)', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root })
  try {
    assert.equal(service.bootCheck().ok, true)
    service.append(AUDIT.FORK_STARTED, { forkId: 'f1' })
    service.append(AUDIT.BOOT, { note: 'this run' })
    const again = service.bootCheck()
    assert.equal(again.ok, true)
    assert.equal(again.findings.length, 0)
    assert.equal(again.records, 2)
  } finally {
    ctx.dispose()
  }
})

test('bootCheck reports unclean-boot unless the previous run ended with shutdown-graceful', () => {
  const root = tmp()
  const dirtyRoot = path.join(root, 'dirty-data')
  writePreviousRun(path.join(dirtyRoot, 'audit.jsonl'), [
    { kind: AUDIT.BOOT, pid: 4242 },
    { kind: AUDIT.FORK_CRASHED, pid: 4242, forkId: 'old-fork', code: 3 },
  ])
  const dirty = newAuditor({ dataRoot: dirtyRoot })
  try {
    const boot = dirty.service.bootCheck()
    assert.equal(boot.ok, false)
    assert.equal(boot.findings.length, 1)
    const finding = boot.findings[0]
    assert.equal(finding.id, 'unclean-boot')
    assert.equal(finding.level, 'warn')
    assert.match(finding.message, /未干净收尾/)
    assert.equal(finding.detail.lastKind, AUDIT.FORK_CRASHED)
    assert.equal(finding.detail.pid, 4242)
  } finally {
    dirty.ctx.dispose()
  }

  const cleanRoot = path.join(root, 'clean-data')
  writePreviousRun(path.join(cleanRoot, 'audit.jsonl'), [
    { kind: AUDIT.BOOT, pid: 5005 },
    { kind: AUDIT.SHUTDOWN_GRACEFUL, pid: 5005 },
  ])
  const clean = newAuditor({ dataRoot: cleanRoot })
  try {
    const boot = clean.service.bootCheck()
    assert.equal(boot.findings.some((finding) => finding.id === 'unclean-boot'), false)
    assert.equal(boot.ok, true)
  } finally {
    clean.ctx.dispose()
  }
})

test('bootCheck reports interrupted-in-guard until restart-resolved closes the ticket', () => {
  const root = tmp()
  const dataRoot = path.join(root, 'data')
  const ledgerFile = path.join(dataRoot, 'audit.jsonl')
  writePreviousRun(ledgerFile, [
    { kind: AUDIT.BOOT, pid: 4242 },
    { kind: AUDIT.RESTART_REQUESTED, pid: 4242, requestId: 'req-1', risk: 'yellow' },
  ])
  const { ctx, service } = newAuditor({ dataRoot })
  try {
    const open = service.bootCheck()
    assert.equal(open.ok, false)
    const guard = open.findings.find((finding) => finding.id === 'interrupted-in-guard')
    assert.ok(guard, 'restart-requested without restart-resolved must be surfaced')
    assert.equal(guard.level, 'warn')
    assert.equal(guard.detail.requestId, 'req-1')

    // The guard eventually resolved the ticket (previous run recovered) — finding clears.
    appendChained(ledgerFile, {
      kind: AUDIT.RESTART_RESOLVED,
      at: iso(),
      pid: 4242,
      requestId: 'req-1',
      outcome: 'approved',
    })
    const closed = service.bootCheck()
    assert.equal(closed.findings.some((finding) => finding.id === 'interrupted-in-guard'), false)
    assert.equal(closed.findings.some((finding) => finding.id === 'unclean-boot'), true, 'tail is still not shutdown-graceful')
  } finally {
    ctx.dispose()
  }
})

test('append fills at/seq but caller data wins (fork pid, explicit at)', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root })
  try {
    const record = service.append('custom-kind', {
      pid: 999,
      at: '2020-01-01T00:00:00.000Z',
      extra: { n: 1 },
    })
    assert.equal(record.pid, 999)
    assert.equal(record.at, '2020-01-01T00:00:00.000Z')
    assert.deepEqual(record.extra, { n: 1 })
    assert.equal(record.seq, 0)
    assert.equal(record.inst, service.instanceId)

    const stored = JSON.parse(readTextSafe(service.ledgerFile).trim())
    assert.equal(stored.hash, record.hash)
    assert.equal(stored.pid, 999)
    assert.equal(stored.kind, 'custom-kind')
  } finally {
    ctx.dispose()
  }
})

test('bootSelfCheck:false skips the eager check; bootCheck() still works on demand', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root, bootSelfCheck: false })
  try {
    assert.equal(service.lastBoot, null)
    assert.equal(service.bootCheck().ok, true)
  } finally {
    ctx.dispose()
  }
})

test('each plugin instance gets a fresh instance id, so a restart sees the old run as previous', () => {
  const root = tmp()
  const first = newAuditor({ dataRoot: root })
  try {
    const rec = first.service.append('fork-crashed', { forkId: 'f-old' })
    assert.equal(first.service.bootCheck().ok, true, 'own write is never "previous run"')
    const second = newAuditor({ dataRoot: root, bootSelfCheck: false })
    try {
      assert.notEqual(second.service.instanceId, first.service.instanceId)
      const boot = second.service.bootCheck()
      assert.equal(boot.ok, false)
      assert.equal(boot.findings[0].id, 'unclean-boot')
      assert.equal(boot.findings[0].detail.lastKind, 'fork-crashed')
      assert.equal(boot.findings[0].detail.seq, rec.seq)
    } finally {
      second.ctx.dispose()
    }
  } finally {
    first.ctx.dispose()
  }
})

// ───────── v2.0.0（T9）：角色门禁 / scope / aggregate / bootAudit / cloudSink ─────────

test('v2 role gate: mother、fork 两侧都激活，scope 跟随角色，env 优先于 config.role', () => {
  const root = tmp()
  const defaultRole = newAuditor({ dataRoot: root })
  try {
    assert.equal(defaultRole.service.scope, 'mother', '缺省角色 mother')
    assert.equal(typeof defaultRole.ctx.get(SERVICE.auditor), 'object')
  } finally {
    defaultRole.ctx.dispose()
  }

  const fork = newAuditor({ dataRoot: root, role: 'fork' })
  try {
    assert.equal(fork.service.scope, 'fork', 'config.role=fork 时 scope=fork')
    assert.ok(fork.ctx.get(SERVICE.auditor), 'auditor 在 fork 角色也激活（矩阵：mother+fork）')
  } finally {
    fork.ctx.dispose()
  }

  const previousEnv = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'fork'
  try {
    const envWins = newAuditor({ dataRoot: root, role: 'mother' })
    try {
      assert.equal(envWins.service.scope, 'fork', 'DSH_FANG_ROLE 优先级高于 config.role')
    } finally {
      envWins.ctx.dispose()
    }
  } finally {
    if (previousEnv === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previousEnv
  }
})

test('v2 aggregate: 本地 taskId=null、分身记录打 taskId，按 at 升序合并', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root })
  try {
    service.append('local-a', { at: '2026-01-01T00:00:02.000Z', note: 'A' })
    service.append('local-b', { at: '2026-01-01T00:00:04.000Z', note: 'B' })
    const sources = [
      {
        taskId: 'task-1',
        records: [
          { kind: 'fork-1-a', seq: 0, at: '2026-01-01T00:00:03.000Z' },
          { kind: 'fork-1-b', seq: 1, at: '2026-01-01T00:00:01.000Z' },
        ],
      },
      { taskId: 'task-2', records: [{ kind: 'fork-2-a', seq: 0, at: '2026-01-01T00:00:05.000Z' }] },
    ]
    const out = service.aggregate({ sources })
    assert.equal(out.ok, true)
    assert.equal(out.total, 5, 'total = 本地 + 所有 source')
    assert.deepEqual(out.sources, ['task-1', 'task-2'])
    assert.deepEqual(
      out.records.map((record) => record.kind),
      ['fork-1-b', 'local-a', 'fork-1-a', 'local-b', 'fork-2-a'],
      '按 at 升序合并多进程时间线',
    )
    assert.equal(out.records[0].taskId, 'task-1')
    assert.equal(out.records[1].taskId, null, '本地记录 taskId=null')
    assert.equal(out.records[4].taskId, 'task-2')
    // 纯汇总：不改本地账本/链
    assert.equal(service.read().length, 2)
    assert.equal(service.verify().ok, true)

    const localOnly = service.aggregate()
    assert.equal(localOnly.total, 2)
    assert.deepEqual(localOnly.sources, [])
    assert.equal(localOnly.records.every((record) => record.taskId === null), true)
  } finally {
    ctx.dispose()
  }
})

test('v2 aggregate: total 统计全部、limit 取最新 N 条、缺 at 时按 seq 兜底', () => {
  const root = tmp()
  const { ctx, service } = newAuditor({ dataRoot: root })
  try {
    for (let i = 0; i < 5; i += 1) {
      service.append(`r${i}`, { at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
    }
    const limited = service.aggregate({ limit: 2 })
    assert.equal(limited.total, 5)
    assert.equal(limited.records.length, 2)
    assert.deepEqual(limited.records.map((record) => record.kind), ['r3', 'r4'], 'limit 保留最新')
    const none = service.aggregate({ limit: 0 })
    assert.equal(none.total, 5)
    assert.deepEqual(none.records, [])
  } finally {
    ctx.dispose()
  }

  // 空账本的实例：只有 source 记录且缺 at → 按 seq 排序
  const empty = newAuditor({ dataRoot: tmp() })
  try {
    const bySeq = empty.service.aggregate({
      sources: [{ taskId: 't1', records: [{ kind: 's2', seq: 2 }, { kind: 's0', seq: 0 }, { kind: 's1', seq: 1 }] }],
    })
    assert.deepEqual(bySeq.records.map((record) => record.kind), ['s0', 's1', 's2'])
    assert.equal(bySeq.records[0].taskId, 't1')
    assert.equal(bySeq.sources[0], 't1')
  } finally {
    empty.ctx.dispose()
  }
})

test('v2 bootAudit 是 bootCheck 的等价别名；cloudSink 是未配置占位', () => {
  const root = tmp()
  const dirtyRoot = path.join(root, 'dirty-data')
  writePreviousRun(path.join(dirtyRoot, 'audit.jsonl'), [
    { kind: AUDIT.BOOT, pid: 4242 },
    { kind: AUDIT.FORK_CRASHED, pid: 4242, forkId: 'old-fork', code: 3 },
  ])
  const { ctx, service } = newAuditor({ dataRoot: dirtyRoot })
  try {
    assert.equal(typeof service.bootAudit, 'function')
    const viaAlias = service.bootAudit()
    const viaLegacy = service.bootCheck()
    assert.equal(viaAlias.ok, false)
    assert.equal(viaAlias.findings[0].id, 'unclean-boot')
    assert.deepEqual(
      viaAlias.findings.map((finding) => finding.id),
      viaLegacy.findings.map((finding) => finding.id),
      'bootAudit 与 bootCheck 结论一致',
    )
    assert.deepEqual(service.cloudSink(), { ok: false, reason: 'not-configured' })
  } finally {
    ctx.dispose()
  }
})
