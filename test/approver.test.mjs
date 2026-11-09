// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v1.0.0 — 2.4 审批子插件测试（T3）
// 硬约束：只用 node:test + node:assert/strict，零外部依赖；临时目录 mkdtemp，用例结束清理。
// 覆盖：注册 key / request→decide 批准 / deny / TTL fail-closed 超时 / 红灯不可被 auto 绕过 /
//       A-B 双备 snapshot+轮换+rollback / monitor 报警 / pending 列表 / 文件桥 / dispose 清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as approver from '../src/plugins/approver.mjs'
import { makeCtx } from './helpers.mjs'
import { AUDIT, SERVICE, bus, copyTree, exists, removeTree, sleep } from '../src/kernel/index.mjs'

const FIXTURE_TREE = path.join(import.meta.dirname, 'fixtures', 't3', 'tree')
const BRIDGE_FILES = {
  command: 'dsh-approval-command.json',
  answer: 'dsh-approval-answer.json',
  pending: 'dsh-approval-pending.json',
  status: 'dsh-approval-status.json',
}

function tempRoot(prefix = 'fang-approver-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function waitFor(check, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await check()) return true
    await sleep(interval)
  }
  return false
}

/** makeCtx + apply，dataDir 固定为 <root>/data，绝不碰真实的 profile 目录。 */
function makeBridgeCtx(root, config = {}, services = {}) {
  const ctx = makeCtx({ services })
  approver.apply(ctx, { dataRoot: path.join(root, 'data'), ...config })
  return ctx
}

function collectDecidedEvents() {
  const events = []
  bus.on('fang/approval-decided', payload => events.push(payload))
  return events
}

function makeAuditor() {
  const records = []
  return {
    records,
    append(kind, data) {
      records.push({ kind, data })
      return { kind, data }
    },
  }
}

test('模块形状与 fangApprover 服务注册（契约 §3/§5.7）', () => {
  assert.equal(approver.name, 'fang-approver')
  assert.deepEqual(approver.inject, [])
  assert.ok(approver.Config, '必须导出 Config schema')
  assert.equal(typeof approver.apply, 'function')
  // Config 走 kernel 的 schemastery：默认值可用、非法枚举被拒
  const defaults = approver.Config({})
  assert.equal(defaults.authMode, 'manual')
  assert.equal(defaults.strictRedLine, true)
  assert.equal(defaults.defaultTtlMs, 300000)
  assert.equal(defaults.role, 'mother', 'v2: role defaults to mother')
  assert.throws(() => approver.Config({ authMode: 'bogus' }))
  assert.throws(() => approver.Config({ role: 'bogus' }))

  const root = tempRoot()
  const ctx = makeCtx()
  try {
    assert.doesNotThrow(() => approver.apply(ctx, { dataRoot: root }))
    const service = ctx.get(SERVICE.approver)
    assert.ok(service, 'ctx.get(fangApprover) 必须可读')
    assert.equal(service.scope, 'mother', 'v2: service exposes scope')
    for (const method of ['request', 'pending', 'decide', 'requestPromotion', 'requestRestart', 'summary', 'snapshot', 'rollback', 'monitor', 'status']) {
      assert.equal(typeof service[method], 'function', `${method} 必须是函数`)
    }
    // 文件桥路径固定落在 dataDir 下（供 tools/fangctl.mjs 对齐）
    assert.equal(service.paths.status, path.join(root, BRIDGE_FILES.status))
    assert.equal(service.paths.pending, path.join(root, BRIDGE_FILES.pending))
    // 只 apply、不调用业务方法时不应落任何盘（不污染 profile / 数据目录）
    assert.equal(exists(path.join(root, BRIDGE_FILES.status)), false)
    assert.equal(exists(path.join(root, BRIDGE_FILES.pending)), false)
  } finally {
    ctx.dispose()
    removeTree(root)
  }

  // 裸 config（宿主默认值路径）也必须能 apply 且不抛错
  const bare = makeCtx()
  try {
    assert.doesNotThrow(() => approver.apply(bare, {}))
    assert.ok(bare.get(SERVICE.approver))
  } finally {
    bare.dispose()
  }
})

test('request → decide approved：pending 列表 / Promise 结果 / 审计 / bus 事件', async () => {
  const root = tempRoot()
  const auditor = makeAuditor()
  const events = collectDecidedEvents()
  const ctx = makeBridgeCtx(root, {}, { [SERVICE.auditor]: auditor })
  const service = ctx.get(SERVICE.approver)
  try {
    const promise = service.request({
      kind: 'swap',
      risk: 'blue',
      title: '热更 plugin',
      detail: 'swap foo@1.0.1',
      impact: { files: 2 },
    })
    assert.ok(promise instanceof Promise, 'request 必须返回 Promise')

    const items = service.pending()
    assert.equal(items.length, 1)
    const item = items[0]
    assert.match(item.id, /^apr_/)
    assert.equal(item.kind, 'swap')
    assert.equal(item.risk, 'blue')
    assert.equal(item.title, '热更 plugin')
    assert.equal(item.detail, 'swap foo@1.0.1')
    assert.deepEqual(item.impact, { files: 2 })
    assert.equal(item.state, 'pending')
    assert.ok(item.deadlineAt > item.createdAt)
    assert.equal(service.status().pending, 1)

    const decided = service.decide(item.id, 'approved', { by: 'tester', note: 'looks fine' })
    assert.equal(decided.ok, true)
    assert.equal(decided.outcome, 'approved')

    const result = await promise
    assert.equal(result.id, item.id)
    assert.equal(result.outcome, 'approved')
    assert.equal(result.by, 'tester')
    assert.equal(typeof result.at, 'string')

    assert.equal(service.pending().length, 0)
    assert.ok(events.some(e => e.id === item.id && e.outcome === 'approved'), '必须 emit fang/approval-decided')
    assert.ok(
      auditor.records.some(r => r.kind === AUDIT.APPROVAL_REQUESTED && r.data.id === item.id),
      'request 必须 append approval-requested 审计',
    )
    assert.ok(
      auditor.records.some(r => r.kind === AUDIT.APPROVAL_DECIDED && r.data.outcome === 'approved' && r.data.by === 'tester'),
      'decide 必须 append approval-decided 审计',
    )
    const last = service.status().lastDecisions.at(-1)
    assert.equal(last.outcome, 'approved')
    assert.equal(last.note, 'looks fine')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('request → decide denied：拒绝路径', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const promise = service.request({ kind: 'promote', risk: 'yellow', title: '晋升到母体', detail: 'x' })
    const id = service.pending()[0].id
    const decided = service.decide(id, 'denied', { by: 'reviewer', note: '缺证据' })
    assert.equal(decided.ok, true)
    const result = await promise
    assert.equal(result.outcome, 'denied')
    assert.equal(result.by, 'reviewer')
    assert.equal(service.pending().length, 0)
    assert.equal(service.status().lastDecisions[0].outcome, 'denied')
    assert.equal(service.status().lastDecisions[0].note, '缺证据')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('TTL 到期 fail-closed：outcome=timeout（短 TTL，不等待）', async () => {
  const root = tempRoot()
  const events = collectDecidedEvents()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const started = Date.now()
    const result = await service.request({ kind: 'restart', risk: 'yellow', title: '超时用例', detail: 'x', ttlMs: 60 })
    const elapsed = Date.now() - started
    assert.equal(result.outcome, 'timeout')
    assert.equal(result.by, 'ttl')
    assert.equal(typeof result.at, 'string')
    assert.ok(elapsed >= 45 && elapsed < 3000, `TTL 应约 60ms 到期，实测 ${elapsed}ms`)
    assert.equal(service.pending().length, 0)
    assert.equal(service.status().lastDecisions.at(-1).outcome, 'timeout')
    assert.ok(events.some(e => e.outcome === 'timeout'), '超时也必须 emit approval-decided')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('strictRedLine：红灯不被 authMode=auto 绕过；非红自动放行', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root, { authMode: 'auto', strictRedLine: true })
  const service = ctx.get(SERVICE.approver)
  try {
    const blue = await service.request({ kind: 'plugin-load', risk: 'blue', title: '低风险加载', detail: 'x' })
    assert.equal(blue.outcome, 'approved')
    assert.equal(blue.by, 'auto')
    assert.equal(service.pending().length, 0)

    const redPromise = service.request({ kind: 'mother-restart', risk: 'red', title: '母体重启', detail: 'x', ttlMs: 5000 })
    await sleep(40)
    const pending = service.pending()
    assert.equal(pending.length, 1, '红灯必须在队列里等显式 decide，auto 不能绕过')
    assert.equal(pending[0].risk, 'red')
    assert.equal(service.decide(pending[0].id, 'approved', { by: 'human' }).ok, true)
    const red = await redPromise
    assert.equal(red.outcome, 'approved')
    assert.equal(red.by, 'human')
  } finally {
    ctx.dispose()
    removeTree(root)
  }

  // 显式关闭 strictRedLine 时红灯才允许 auto 放行（这是配置边界，不是默认行为）
  const root2 = tempRoot()
  const ctx2 = makeBridgeCtx(root2, { authMode: 'auto', strictRedLine: false })
  try {
    const redAuto = await ctx2.get(SERVICE.approver).request({
      kind: 'mother-restart',
      risk: 'red',
      title: '显式关闭红线',
      detail: 'x',
    })
    assert.equal(redAuto.outcome, 'approved')
    assert.equal(redAuto.by, 'auto')
  } finally {
    ctx2.dispose()
    removeTree(root2)
  }
})

test('pending queue recovers as orphaned after restart, never fake pending', () => {
  const root = tempRoot()
  const pendingFile = path.join(root, 'data', 'dsh-approval-pending.json')
  try {
    const ctx1 = makeBridgeCtx(root)
    try {
      const first = ctx1.get(SERVICE.approver)
      void first.request({ kind: 'promotion', risk: 'red', title: 'before restart', ttlMs: 60000 })
      assert.ok(exists(pendingFile))
      var snapshot = fs.readFileSync(pendingFile, 'utf8')
    } finally {
      ctx1.dispose()
    }
    fs.writeFileSync(pendingFile, snapshot)
    const ctx2 = makeBridgeCtx(root)
    try {
      const second = ctx2.get(SERVICE.approver)
      assert.equal(second.status().pending, 0)
      assert.equal(second.status().orphaned, 1)
      const orphaned = second.orphaned()
      assert.equal(orphaned.length, 1)
      assert.equal(orphaned[0].state, 'orphaned')
      assert.equal(orphaned[0].by, 'restart')
      assert.deepEqual(second.pending(), [])
      assert.deepEqual(JSON.parse(fs.readFileSync(pendingFile, 'utf8')), [])
      assert.equal(second.decide(orphaned[0].id, 'approved').reason, 'not-pending')
    } finally {
      ctx2.dispose()
    }
  } finally {
    removeTree(root)
  }
})

test('generic request() blocks mother-only kinds on fork scope', async () => {
  const root = tempRoot()
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'fork'
  try {
    const ctx = makeBridgeCtx(root)
    try {
      const service = ctx.get(SERVICE.approver)
      assert.equal(service.scope, 'fork')
      const denied = await service.request({ kind: 'promotion', risk: 'red', title: 'escaped gate' })
      assert.equal(denied.outcome, 'denied')
      assert.equal(denied.by, 'scope')
      assert.equal(denied.reason, 'mother-only')
      assert.deepEqual(service.pending(), [])
      const restart = await service.request({ kind: 'restart', risk: 'red', title: 'escaped restart' })
      assert.equal(restart.outcome, 'denied')
      assert.equal(restart.reason, 'mother-only')
      const promise = service.request({ kind: 'action', risk: 'yellow', title: 'fork local' })
      const [item] = service.pending()
      assert.ok(item)
      assert.equal(service.decide(item.id, 'denied').ok, true)
      assert.equal((await promise).outcome, 'denied')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
    removeTree(root)
  }
})

test('snapshot index persists across restart so rollback still works', () => {
  const root = tempRoot()
  const work = path.join(root, 'work')
  try {
    copyTree(FIXTURE_TREE, work)
    const ctx1 = makeBridgeCtx(root)
    try {
      const first = ctx1.get(SERVICE.approver)
      assert.equal(first.snapshot({ tag: 'persisted', dir: work }).tag, 'persisted')
      assert.ok(exists(path.join(root, 'data', 'snapshots', 'index.json')))
    } finally {
      ctx1.dispose()
    }
    const ctx2 = makeBridgeCtx(root)
    try {
      const second = ctx2.get(SERVICE.approver)
      assert.equal(second.status().snapshots, 1, 'index must be loaded after restart')
      fs.writeFileSync(path.join(work, 'a.txt'), 'junk\n')
      const rolled = second.rollback({ tag: 'persisted', dir: work })
      assert.equal(rolled.ok, true)
      assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'alpha\n')
    } finally {
      ctx2.dispose()
    }
  } finally {
    removeTree(root)
  }
})

test('A/B 双备：snapshot 落盘 / 轮换保留上一代 / rollback 恢复内容并校验 digest', () => {
  const root = tempRoot()
  const auditor = makeAuditor()
  const ctx = makeBridgeCtx(root, {}, { [SERVICE.auditor]: auditor })
  const service = ctx.get(SERVICE.approver)
  const work = path.join(root, 'work')
  const snapshotsRoot = path.join(root, 'data', 'snapshots')
  try {
    copyTree(FIXTURE_TREE, work)
    assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'alpha\n')

    const snap1 = service.snapshot({ tag: 'abc', dir: work })
    assert.equal(snap1.tag, 'abc')
    assert.match(snap1.A.digest, /^[0-9a-f]{64}$/)
    assert.equal(typeof snap1.A.at, 'number')
    assert.equal(snap1.B, null, '第一次快照没有上一代')
    assert.ok(exists(path.join(snapshotsRoot, 'abc', 'A', 'a.txt')))
    assert.equal(service.status().snapshots, 1)

    // 模拟一次热更造成的目录变化
    fs.writeFileSync(path.join(work, 'a.txt'), 'alpha-v2\n')
    fs.rmSync(path.join(work, 'sub'), { recursive: true, force: true })
    fs.writeFileSync(path.join(work, 'c.txt'), 'gamma\n')
    const snap2 = service.snapshot({ tag: 'abc', dir: work })
    assert.notEqual(snap2.A.digest, snap1.A.digest)
    assert.ok(snap2.B, '第二次快照应保留上一代 B')
    assert.equal(snap2.B.digest, snap1.A.digest)
    assert.ok(exists(path.join(snapshotsRoot, 'abc', 'B', 'a.txt')))

    // 破坏工作区，从 A（最近一次快照）回滚
    fs.writeFileSync(path.join(work, 'a.txt'), 'junk\n')
    fs.rmSync(path.join(work, 'c.txt'), { force: true })
    const rolledA = service.rollback({ tag: 'abc', dir: work })
    assert.equal(rolledA.ok, true)
    assert.ok(rolledA.restored)
    assert.equal(rolledA.restored.slot, 'A')
    assert.equal(rolledA.restored.matches, true)
    assert.equal(rolledA.restored.digest, snap2.A.digest)
    assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'alpha-v2\n')
    assert.ok(exists(path.join(work, 'c.txt')))
    assert.equal(exists(path.join(work, 'sub', 'b.txt')), false)

    // 再破坏，从 B（上一代 = fixture 原始内容）回滚
    fs.writeFileSync(path.join(work, 'a.txt'), 'junk-again\n')
    const rolledB = service.rollback({ tag: 'abc', dir: work, to: 'B' })
    assert.equal(rolledB.ok, true)
    assert.equal(rolledB.restored.slot, 'B')
    assert.equal(rolledB.restored.digest, snap1.A.digest)
    assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'alpha\n')
    assert.equal(fs.readFileSync(path.join(work, 'sub', 'b.txt'), 'utf8'), 'beta\n')
    assert.equal(exists(path.join(work, 'c.txt')), false)

    assert.ok(auditor.records.some(r => r.kind === AUDIT['SNapshot_CREATED']), 'snapshot 必须写审计')
    assert.ok(auditor.records.some(r => r.kind === AUDIT.ROLLBACK && r.data.ok === true), 'rollback 必须写审计')

    // 失败路径
    assert.equal(service.snapshot({ tag: 'x', dir: path.join(root, 'missing') }).ok, false)
    assert.equal(service.rollback({ tag: 'no-such', dir: work }).ok, false)
    assert.equal(service.rollback({ tag: 'abc' }).reason, 'no-target-dir')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('多代快照：保留 3 代、可回滚 C，index 重启后仍可恢复', () => {
  const root = tempRoot()
  const work = path.join(root, 'work')
  try {
    copyTree(FIXTURE_TREE, work)
    const ctx1 = makeBridgeCtx(root, { snapshotGenerations: 3 })
    try {
      const first = ctx1.get(SERVICE.approver).snapshot({ tag: 'multi', dir: work })
      assert.equal(first.ok, undefined)
      assert.equal(first.A.digest.length, 64)
      assert.equal(first.generations.length, 1)
      fs.writeFileSync(path.join(work, 'a.txt'), 'alpha-v2\n')
      const second = ctx1.get(SERVICE.approver).snapshot({ tag: 'multi', dir: work })
      assert.equal(second.generations.length, 2)
      fs.writeFileSync(path.join(work, 'a.txt'), 'alpha-v3\n')
      const third = ctx1.get(SERVICE.approver).snapshot({ tag: 'multi', dir: work })
      assert.deepEqual(third.generations.map(g => g.slot), ['A', 'B', 'C'])
      assert.notEqual(third.A.digest, third.B.digest)
      assert.notEqual(third.B.digest, third.C.digest)
      const rolled = ctx1.get(SERVICE.approver).rollback({ tag: 'multi', dir: work, to: 'C' })
      assert.equal(rolled.ok, true)
      assert.equal(rolled.restored.slot, 'C')
      assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'alpha\n')
    } finally {
      ctx1.dispose()
    }
    // 重启后 index 仍保留 C 代
    const ctx2 = makeBridgeCtx(root, { snapshotGenerations: 3 })
    try {
      const service = ctx2.get(SERVICE.approver)
      assert.equal(service.rollback({ tag: 'multi', dir: work, to: 'C' }).ok, true)
      assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'alpha\n')
    } finally {
      ctx2.dispose()
    }
  } finally {
    removeTree(root)
  }
})

test('多代快照：snapshotGenerations=2 时只保留 A/B', () => {
  const root = tempRoot()
  const work = path.join(root, 'work')
  try {
    copyTree(FIXTURE_TREE, work)
    const ctx = makeBridgeCtx(root, { snapshotGenerations: 2 })
    try {
      const service = ctx.get(SERVICE.approver)
      service.snapshot({ tag: 'two', dir: work })
      fs.writeFileSync(path.join(work, 'a.txt'), 'alpha-v2\n')
      const second = service.snapshot({ tag: 'two', dir: work })
      assert.deepEqual(second.generations.map(g => g.slot), ['A', 'B'])
      assert.equal(exists(path.join(root, 'data', 'snapshots', 'two', 'C')), false)
      assert.equal(service.rollback({ tag: 'two', dir: work, to: 'C' }).reason, 'slot-empty')
    } finally {
      ctx.dispose()
    }
  } finally {
    removeTree(root)
  }
})

test('崩溃 journal：request/settled 落盘；未结请求重启后标记 orphaned', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  try {
    const service = ctx.get(SERVICE.approver)
    const pending = service.request({ kind: 'promotion', risk: 'red', title: 'journal-crash', ttlMs: 5000 })
    const journalFile = path.join(root, 'data', 'dsh-approval-journal.jsonl')
    assert.ok(exists(journalFile))
    const read = () => fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const requestLine = read().find(line => line.type === 'request')
    assert.equal(requestLine.kind, 'promotion')
    const id = requestLine.id
    service.decide(id, 'approved', { by: 'tester' })
    await pending
    assert.equal(read().some(line => line.type === 'settled' && line.id === id && line.outcome === 'approved'), true)
  } finally {
    ctx.dispose()
    removeTree(root)
  }

  // 模拟“进程在 pending 期间崩溃”：只剩 journal 的 request，没有 pending.json。
  const crashRoot = tempRoot()
  try {
    const dataDir = path.join(crashRoot, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const crashedAt = Date.now() - 1000
    fs.writeFileSync(path.join(dataDir, 'dsh-approval-journal.jsonl'), JSON.stringify({
      at: new Date(crashedAt).toISOString(), type: 'request', id: 'apr_crashed', kind: 'restart', risk: 'red',
      title: 'crashed request', detail: 'x', taskId: 't1', pluginId: null,
      createdAt: crashedAt, deadlineAt: crashedAt + 5000, ttlMs: 5000,
    }) + '\n')
    const ctx2 = makeBridgeCtx(crashRoot)
    try {
      const service = ctx2.get(SERVICE.approver)
      assert.equal(service.status().orphaned, 1)
      const rows = service.orphaned()
      assert.equal(rows[0].id, 'apr_crashed')
      assert.equal(rows[0].state, 'orphaned')
      assert.equal(rows[0].by, 'restart')
      assert.equal(service.pending().length, 0)
    } finally {
      ctx2.dispose()
    }
  } finally {
    removeTree(crashRoot)
  }
})

test('monitor：采样、阈值报警（数字 / {op,value}）与状态统计', () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const hit = service.monitor({ label: 'heapMB', value: 128, threshold: 100 })
    assert.equal(hit.ok, true)
    assert.equal(hit.alert, true)

    const calm = service.monitor({ label: 'heapMB', value: 64, threshold: 100 })
    assert.equal(calm.ok, true)
    assert.equal(calm.alert, false)

    const low = service.monitor({ label: 'swapRatio', value: 0.2, threshold: { op: '<', value: 0.4 } })
    assert.equal(low.alert, true)
    assert.equal(low.threshold.op, '<')

    const noThreshold = service.monitor({ label: 'plain', value: 1 })
    assert.equal(noThreshold.alert, false)

    const status = service.status()
    assert.equal(status.monitors, 3)
    const heap = status.monitorsList.find(m => m.label === 'heapMB')
    assert.equal(heap.samples, 2)
    assert.equal(heap.last, 64)
    assert.equal(heap.min, 64)
    assert.equal(heap.max, 128)
    assert.equal(heap.alerts.length, 1)

    assert.equal(service.monitor({ label: 'bad', value: 'oops' }).ok, false)
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('decide 边界：未知 id / 非法结论 / 重复决策', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    assert.equal(service.decide('apr_nope', 'approved').ok, false)
    const promise = service.request({ kind: 'x', risk: 'yellow', title: 't', detail: 'd' })
    const id = service.pending()[0].id
    assert.equal(service.decide(id, 'maybe').ok, false)
    assert.equal(service.pending().length, 1, '非法结论不能把请求结掉')
    assert.equal(service.decide(id, 'denied', { by: 'reviewer' }).ok, true)
    await promise
    const again = service.decide(id, 'approved', { by: 'tester2' })
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'not-pending')
    assert.equal(service.status().lastDecisions.at(-1).outcome, 'denied', '重复决策不能覆盖第一个结论')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('文件桥：command / pending / status / answer json 供 CLI 驱动', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root, { fileBridgePollMs: 20 })
  const service = ctx.get(SERVICE.approver)
  const dataDir = path.join(root, 'data')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(dataDir, BRIDGE_FILES.command),
      JSON.stringify({ action: 'request', kind: 'bridge', risk: 'yellow', title: '由 CLI 发起', detail: 'x', ttlMs: 5000 }),
    )
    const queued = await waitFor(() => service.pending().length === 1)
    assert.equal(queued, true, 'command 文件应被轮询执行')
    const item = service.pending()[0]
    assert.equal(item.kind, 'bridge')
    assert.equal(item.title, '由 CLI 发起')
    assert.equal(exists(path.join(dataDir, BRIDGE_FILES.command)), false, 'command 文件必须被消费')

    const pendingJson = JSON.parse(fs.readFileSync(path.join(dataDir, BRIDGE_FILES.pending), 'utf8'))
    assert.equal(pendingJson.length, 1)
    const statusJson = JSON.parse(fs.readFileSync(path.join(dataDir, BRIDGE_FILES.status), 'utf8'))
    assert.equal(statusJson.counts.pending, 1)
    assert.equal(statusJson.pending[0].id, item.id)

    fs.writeFileSync(
      path.join(dataDir, BRIDGE_FILES.answer),
      JSON.stringify({ id: item.id, decision: 'approve', by: 'cli' }),
    )
    const settled = await waitFor(() => service.pending().length === 0)
    assert.equal(settled, true, 'answer 文件应被消费')
    const last = service.status().lastDecisions.at(-1)
    assert.equal(last.outcome, 'approved')
    assert.equal(last.by, 'cli')
    assert.equal(exists(path.join(dataDir, BRIDGE_FILES.answer)), false)
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('文件桥：bridgeSecret 要求 HMAC，未签名命令/答案被拒绝', async () => {
  const root = tempRoot()
  const secret = 'test-bridge-secret'
  const ctx = makeBridgeCtx(root, { fileBridgePollMs: 20, bridgeAclCheck: false, bridgeSecret: secret })
  const service = ctx.get(SERVICE.approver)
  const dataDir = path.join(root, 'data')
  const stableStringify = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  const sign = (payload) => {
    const copy = { ...payload }
    delete copy.signature
    return { ...copy, signature: crypto.createHmac('sha256', secret).update(stableStringify(copy)).digest('hex') }
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, BRIDGE_FILES.command), JSON.stringify({ action: 'request', kind: 'unsigned', risk: 'yellow', title: 'x' }))
    await sleep(120)
    assert.equal(service.pending().length, 0, 'unsigned command must not execute')
    assert.equal(exists(path.join(dataDir, BRIDGE_FILES.command)), false)

    fs.writeFileSync(path.join(dataDir, BRIDGE_FILES.command), JSON.stringify(sign({ action: 'request', kind: 'signed', risk: 'yellow', title: 'signed', ttlMs: 5000 })))
    assert.equal(await waitFor(() => service.pending().length === 1), true)
    const item = service.pending()[0]
    fs.writeFileSync(path.join(dataDir, BRIDGE_FILES.answer), JSON.stringify({ id: item.id, decision: 'approve', by: 'unsigned' }))
    await sleep(120)
    assert.equal(service.pending().length, 1, 'unsigned answer must not decide')
    fs.writeFileSync(path.join(dataDir, BRIDGE_FILES.answer), JSON.stringify(sign({ id: item.id, decision: 'approve', by: 'signed' })))
    assert.equal(await waitFor(() => service.pending().length === 0), true)
    assert.equal(service.status().lastDecisions.at(-1).by, 'signed')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('dispose：未决请求按 timeout 结算、定时器清理、dispose 后请求 fail-closed', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const promise = service.request({ kind: 'x', risk: 'yellow', title: '卸载时未决', detail: 'x', ttlMs: 60000 })
    assert.equal(service.pending().length, 1)
    ctx.dispose()
    const result = await promise
    assert.equal(result.outcome, 'timeout')
    assert.equal(result.by, 'unload')
    assert.equal(service.pending().length, 0)

    const after = await service.request({ kind: 'x', risk: 'blue', title: '卸载后', detail: 'x' })
    assert.equal(after.outcome, 'timeout')
    assert.equal(after.by, 'unload')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

// ───────── v2.0.0（T9）：角色门禁 / 双侧语义 / 汇总 ─────────

test('v2 role gate：mother/fork 两侧都激活、scope 正确、env 优先 config.role', () => {
  const root = tempRoot()
  const mother = makeBridgeCtx(root, { role: 'mother' })
  try {
    assert.equal(mother.get(SERVICE.approver).scope, 'mother')
    assert.ok(mother.get(SERVICE.approver), 'approver 在 mother 角色激活')
  } finally {
    mother.dispose()
  }

  const fork = makeBridgeCtx(root, { role: 'fork' })
  try {
    assert.equal(fork.get(SERVICE.approver).scope, 'fork')
    assert.ok(fork.get(SERVICE.approver), 'approver 在 fork 角色也激活（矩阵：mother+fork）')
  } finally {
    fork.dispose()
  }

  const previousEnv = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'fork'
  try {
    const envWins = makeBridgeCtx(root, { role: 'mother' })
    try {
      assert.equal(envWins.get(SERVICE.approver).scope, 'fork', 'DSH_FANG_ROLE 优先于 config.role')
    } finally {
      envWins.dispose()
    }
  } finally {
    if (previousEnv === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previousEnv
  }
  removeTree(root)
})

test('v2 requestPromotion/requestRestart：kind/risk 固定语义，仍必须显式 decide', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const promotionPromise = service.requestPromotion({
      pluginId: 'plugin-x',
      taskId: 'task-1',
      detail: '证据齐全',
      impact: { files: 3 },
    })
    assert.ok(promotionPromise instanceof Promise, 'requestPromotion 返回 Promise')
    assert.equal(service.pending().length, 1)
    const promotion = service.pending()[0]
    assert.equal(promotion.kind, 'promotion')
    assert.equal(promotion.risk, 'red', '晋升固定红灯')
    assert.equal(promotion.taskId, 'task-1')
    assert.equal(promotion.pluginId, 'plugin-x')
    assert.equal(promotion.detail, '证据齐全')
    assert.deepEqual(promotion.impact, { files: 3 })
    assert.equal(service.decide(promotion.id, 'approved', { by: 'mother-ui' }).ok, true)
    assert.equal((await promotionPromise).outcome, 'approved')
    const promotionDecision = service.status().lastDecisions.at(-1)
    assert.equal(promotionDecision.kind, 'promotion')
    assert.equal(promotionDecision.taskId, 'task-1')

    const restartPromise = service.requestRestart({ reason: '版本升级', impact: { sessions: 2 }, risk: 'blue' })
    const restart = service.pending()[0]
    assert.equal(restart.kind, 'restart')
    assert.equal(restart.risk, 'red', '重启风险由服务强制红灯，调用方不能降级')
    assert.match(restart.title, /版本升级/)
    assert.equal(service.decide(restart.id, 'denied', { by: 'human' }).ok, true)
    assert.equal((await restartPromise).outcome, 'denied')
  } finally {
    ctx.dispose()
    removeTree(root)
  }

  // authMode=auto 也不能把红灯 promotion/restart 自动放行（strictRedLine 默认 true）
  const autoRoot = tempRoot()
  const autoCtx = makeBridgeCtx(autoRoot, { authMode: 'auto', strictRedLine: true })
  try {
    const autoService = autoCtx.get(SERVICE.approver)
    const autoPromise = autoService.requestPromotion({ pluginId: 'p-auto', taskId: 't-auto' })
    await sleep(30)
    assert.equal(autoService.pending().length, 1, 'auto 模式不得绕过红灯 promotion')
    assert.equal(autoService.pending()[0].risk, 'red')
    assert.equal(autoService.decide(autoService.pending()[0].id, 'denied', { by: 'human' }).ok, true)
    assert.equal((await autoPromise).outcome, 'denied')
  } finally {
    autoCtx.dispose()
    removeTree(autoRoot)
  }
})

test('v2 summary：本地 pending + 多 remote 并发汇总，单 remote 失败不阻塞', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const localPromise = service.requestPromotion({ pluginId: 'p-local', taskId: 'task-local' })

    const onlyLocal = await service.summary()
    assert.equal(onlyLocal.ok, true)
    assert.equal(onlyLocal.complete, true)
    assert.deepEqual(onlyLocal.remote, [])
    assert.equal(onlyLocal.local.length, 1)
    assert.equal(onlyLocal.total, 1)
    assert.equal(onlyLocal.failed, 0)

    const fetchCalls = []
    const result = await service.summary({
      remotes: [
        {
          taskId: 'task-1',
          fetchApprovals: async () => {
            fetchCalls.push('task-1')
            return { ok: true, items: [{ id: 'r1a' }, { id: 'r1b' }] }
          },
        },
        {
          taskId: 'task-2',
          fetchApprovals: async () => {
            fetchCalls.push('task-2')
            return { ok: true, data: { items: [{ id: 'r2a' }] } }
          },
        },
        {
          taskId: 'task-3',
          fetchApprovals: async () => {
            fetchCalls.push('task-3')
            throw new Error('remote down')
          },
        },
        {
          taskId: 'task-4',
          fetchApprovals: async () => {
            fetchCalls.push('task-4')
            return { ok: false, reason: 'offline' }
          },
        },
        { taskId: 'task-5' },
      ],
    })
    assert.equal(result.ok, true, '汇总本身完成即 ok')
    assert.equal(result.failed, 3, '抛错 / ok:false / 无 fetchApprovals 都是降级但不阻塞')
    assert.equal(result.degraded, true)
    assert.equal(result.complete, false, 'ok=true only means aggregation completed; complete=false exposes remote failures')
    assert.equal(result.local.length, 1)
    assert.equal(result.local[0].kind, 'promotion')
    assert.equal(result.local[0].taskId, 'task-local')
    assert.equal(result.remote.length, 5)
    assert.equal(result.remote[0].ok, true)
    assert.equal(result.remote[0].items.length, 2)
    assert.equal(result.remote[1].ok, true)
    assert.deepEqual(result.remote[1].items, [{ id: 'r2a' }], '兼容 {data:{items}} 形状')
    assert.equal(result.remote[2].ok, false)
    assert.deepEqual(result.remote[2].items, [])
    assert.match(result.remote[2].error, /remote down/)
    assert.equal(result.remote[3].ok, false)
    assert.equal(result.remote[3].error, 'offline')
    assert.equal(result.remote[4].ok, false)
    assert.deepEqual(result.remote.map((entry) => entry.taskId), ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'])
    assert.equal(result.total, 4, 'total 只计本地 + 成功 remote 的 items')
    assert.deepEqual(fetchCalls, ['task-1', 'task-2', 'task-3', 'task-4'], '每个 remote 都尝试过')

    const localItem = service.pending()[0]
    service.decide(localItem.id, 'denied', { by: 'test' })
    assert.equal((await localPromise).outcome, 'denied')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('v2 summary：remote 是并发拉取（不是顺序 await）', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const started = []
    const deferred = () => {
      let resolve
      const promise = new Promise((r) => { resolve = r })
      return { promise, resolve }
    }
    const first = deferred()
    const second = deferred()
    const summaryPromise = service.summary({
      remotes: [
        { taskId: 'a', fetchApprovals: () => { started.push('a'); return first.promise } },
        { taskId: 'b', fetchApprovals: () => { started.push('b'); return second.promise } },
      ],
    })
    assert.deepEqual(started, ['a', 'b'], '两个 remote 必须在 await 前一起启动（并发）')
    first.resolve({ ok: true, items: [{ id: 'a1' }] })
    second.resolve({ ok: true, items: [{ id: 'b1' }, { id: 'b2' }] })
    const result = await summaryPromise
    assert.equal(result.ok, true)
    assert.equal(result.failed, 0)
    assert.equal(result.total, 3)
    assert.deepEqual(result.remote.map((entry) => entry.taskId), ['a', 'b'])
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('v2 hardening: safeTag collisions, invalid answers, summary.complete, mother-only entries', async () => {
  // Distinct raw tags must not share a snapshot directory.
  const root = tempRoot()
  const work = path.join(root, 'work')
  copyTree(FIXTURE_TREE, work)
  const ctx = makeBridgeCtx(root)
  const service = ctx.get(SERVICE.approver)
  try {
    const slash = service.snapshot({ tag: 'a/b', dir: work })
    const underscore = service.snapshot({ tag: 'a_b', dir: work })
    assert.notEqual(slash.tag, underscore.tag)
    assert.ok(exists(path.join(root, 'data', 'snapshots', slash.tag, 'A')))
    assert.ok(exists(path.join(root, 'data', 'snapshots', underscore.tag, 'A')))

    const local = await service.summary()
    assert.equal(local.complete, true)

    const prev = process.env.DSH_FANG_ROLE
    process.env.DSH_FANG_ROLE = 'fork'
    try {
      const forkCtx = makeBridgeCtx(root, { role: 'fork' })
      const forkService = forkCtx.get(SERVICE.approver)
      try {
        const promotion = await forkService.requestPromotion({ pluginId: 'p', taskId: 't' })
        assert.equal(promotion.outcome, 'denied')
        assert.equal(promotion.by, 'scope')
        assert.equal(promotion.reason, 'mother-only')
        const restart = await forkService.requestRestart({ reason: 'x' })
        assert.equal(restart.outcome, 'denied')
        assert.equal(restart.reason, 'mother-only')
        assert.equal(forkService.pending().length, 0)
      } finally {
        forkCtx.dispose()
      }
    } finally {
      if (prev === undefined) delete process.env.DSH_FANG_ROLE
      else process.env.DSH_FANG_ROLE = prev
    }
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})

test('v2 hardening: invalid/unknown answer files are consumed instead of polled forever', async () => {
  const root = tempRoot()
  const ctx = makeBridgeCtx(root, { fileBridgePollMs: 20 })
  const dataDir = path.join(root, 'data')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const answer = path.join(dataDir, BRIDGE_FILES.answer)
    fs.writeFileSync(answer, '{ not json', 'utf8')
    assert.equal(await waitFor(() => !exists(answer)), true, 'malformed answer must be consumed')
    fs.writeFileSync(answer, JSON.stringify({ id: 'apr_missing', decision: 'approve' }), 'utf8')
    assert.equal(await waitFor(() => !exists(answer)), true, 'unknown answer must be consumed')
  } finally {
    ctx.dispose()
    removeTree(root)
  }
})
