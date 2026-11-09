// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 集成：fork 侧 umbrella ASK → fork decision-center 代理 → outbox/母体 ingest。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import { apply as applyDecisionCenter } from '../src/plugins/decision-center.mjs'
import { apply as applyUmbrella } from '../src/plugins/umbrella.mjs'

const waitFor = async (fn, { timeout = 3000, interval = 20 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

function setup() {
  const forkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-umbrella-fork-'))
  const motherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-umbrella-mother-'))
  fs.writeFileSync(path.join(motherRoot, 'endpoint.json'), JSON.stringify({ url: 'http://mother.test:5678' }), 'utf8')
  fs.writeFileSync(path.join(motherRoot, 'fang-auth.json'), JSON.stringify({ token: 'umbrella-token-0123456789abcdef' }), 'utf8')
  return { forkRoot, motherRoot }
}

function withForkEnv(fn) {
  const previous = { role: process.env.DSH_FANG_ROLE, task: process.env.DSH_FANG_TASK_ID, fork: process.env.DSH_FANG_FORK_ID }
  process.env.DSH_FANG_ROLE = 'fork'
  process.env.DSH_FANG_TASK_ID = 'task-umbrella'
  process.env.DSH_FANG_FORK_ID = 'fork-umbrella'
  return fn().finally(() => {
    for (const [key, envKey] of [['role', 'DSH_FANG_ROLE'], ['task', 'DSH_FANG_TASK_ID'], ['fork', 'DSH_FANG_FORK_ID']]) {
      if (previous[key] === undefined) delete process.env[envKey]
      else process.env[envKey] = previous[key]
    }
  })
}

test('umbrella ASK in fork goes through decision-center proxy outbox to mother ingest', async () => {
  const { forkRoot, motherRoot } = setup()
  process.env.DSH_FANG_MOTHER = motherRoot
  const ingestPayloads = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/fang/api/decisions/ingest')) {
      ingestPayloads.push(JSON.parse(init.body))
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_umbrella_1', level: 'yellow', status: 'pending' } }) } }
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }) } }
  }
  const ctx = makeCtx()
  try {
    await withForkEnv(async () => {
      const center = applyDecisionCenter(ctx, { dataRoot: forkRoot })
      let proxySubmitCalls = 0
      const realSubmit = center.submit
      center.submit = (...args) => { proxySubmitCalls += 1; return realSubmit(...args) }
      applyUmbrella(ctx, { bufferRoot: forkRoot, productionRoot: forkRoot, allowPaths: [forkRoot] })
      const umbrella = ctx.get(SERVICE.umbrella)
      assert.ok(umbrella, 'umbrella service must be active in fork')
      const out = umbrella.decideAction({ tool: 'write', args: { path: path.resolve('C:/outside/umbrella.txt') } }, { grade: 'A' })
      assert.equal(out.decision, 'ask')
      await waitFor(() => ingestPayloads.length >= 1)
      assert.equal(proxySubmitCalls, 1, 'umbrella must call the fork proxy service.submit')
      const linked = await out.decisionTicketPromise
      assert.equal(linked.ticket.id, 'dec_umbrella_1')
      assert.equal(out.decisionRecord.decisionTicketId, 'dec_umbrella_1')
      const payload = ingestPayloads[0]
      assert.equal(payload.producer, 'fork')
      assert.equal(payload.originForkId, 'fork-umbrella')
      assert.match(String(payload.title), /保护伞请求确认/)
      assert.ok(['yellow', 'red'].includes(payload.level))
      assert.ok(Array.isArray(payload.actions))
    })
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_FANG_MOTHER
    ctx.dispose()
    fs.rmSync(forkRoot, { recursive: true, force: true })
    fs.rmSync(motherRoot, { recursive: true, force: true })
  }
})

test('umbrella ASK in fork with mother offline writes outbox then flushes after recovery', async () => {
  const { forkRoot, motherRoot } = setup()
  process.env.DSH_FANG_MOTHER = motherRoot
  const delivered = []
  const originalFetch = globalThis.fetch
  let online = false
  globalThis.fetch = async (url, init) => {
    if (!online) throw new Error('ECONNREFUSED')
    if (String(url).includes('/fang/api/decisions/ingest')) {
      delivered.push(JSON.parse(init.body))
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_flush_1' } }) } }
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }) } }
  }
  const ctx = makeCtx()
  try {
    await withForkEnv(async () => {
      const center = applyDecisionCenter(ctx, { dataRoot: forkRoot })
      applyUmbrella(ctx, { bufferRoot: forkRoot, productionRoot: forkRoot, allowPaths: [forkRoot] })
      const umbrella = ctx.get(SERVICE.umbrella)
      const out = umbrella.decideAction({ tool: 'write', args: { path: path.resolve('C:/outside/umbrella-offline.txt') } }, { grade: 'A' })
      assert.equal(out.decision, 'ask')

      // 证明 outbox 真的被调用：不仅 pending=1，磁盘上也有完整 payload。
      await waitFor(() => center.outboxStatus().pending >= 1)
      assert.equal(center.outboxStatus().pending, 1)
      const outboxDir = path.join(forkRoot, 'decision-outbox')
      const files = fs.readdirSync(outboxDir).filter((name) => name.endsWith('.json'))
      assert.equal(files.length, 1, 'exactly one outbox record')
      const record = JSON.parse(fs.readFileSync(path.join(outboxDir, files[0]), 'utf8'))
      assert.match(String(record.payload.title), /保护伞请求确认/)
      assert.ok(['yellow', 'red'].includes(record.payload.level))
      assert.ok(Array.isArray(record.payload.actions))
      assert.equal(record.attempts, 0)

      // 母体恢复后 flush 重放，payload 原样送达，outbox 清空。
      online = true
      const flushed = await center.flush()
      assert.equal(flushed.ok, true)
      assert.equal(flushed.sent, 1)
      assert.equal(center.outboxStatus().pending, 0)
      assert.equal(delivered.length, 1)
      assert.match(String(delivered[0].title), /保护伞请求确认/)
    })
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_FANG_MOTHER
    ctx.dispose()
    fs.rmSync(forkRoot, { recursive: true, force: true })
    fs.rmSync(motherRoot, { recursive: true, force: true })
  }
})
