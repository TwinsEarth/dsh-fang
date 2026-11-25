// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — fork 侧 decision-center 代理：submit → 母体 ingest；红色轮询；母体不可达落 outbox。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers.mjs'
import { apply } from '../src/plugins/decision-center.mjs'

function setup() {
  const forkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-fork-decision-'))
  const motherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-mother-decision-'))
  fs.writeFileSync(path.join(motherRoot, 'endpoint.json'), JSON.stringify({ url: 'http://mother.test:1234' }), 'utf8')
  fs.writeFileSync(path.join(motherRoot, 'fang-auth.json'), JSON.stringify({ token: 'mother-token-0123456789abcdef' }), 'utf8')
  return { forkRoot, motherRoot }
}

function withForkEnv(fn) {
  const previous = { role: process.env.DSH_FANG_ROLE, task: process.env.DSH_FANG_TASK_ID, mother: process.env.DSH_FANG_MOTHER, fork: process.env.DSH_FANG_FORK_ID }
  process.env.DSH_FANG_ROLE = 'fork'
  process.env.DSH_FANG_TASK_ID = 'task-fork-1'
  process.env.DSH_FANG_FORK_ID = 'fork-1'
  return fn().finally(() => {
    for (const [key, envKey] of [['role', 'DSH_FANG_ROLE'], ['task', 'DSH_FANG_TASK_ID'], ['mother', 'DSH_FANG_MOTHER'], ['fork', 'DSH_FANG_FORK_ID']]) {
      if (previous[key] === undefined) delete process.env[envKey]
      else process.env[envKey] = previous[key]
    }
  })
}

test('fork decision-center: submit proxies to mother ingest and marks origin', async () => {
  const { forkRoot, motherRoot } = setup()
  process.env.DSH_FANG_MOTHER = motherRoot
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_remote_1', level: 'yellow', status: 'pending', isBlocking: false } }) } }
  }
  const ctx = makeCtx()
  try {
    await withForkEnv(async () => {
      const service = apply(ctx, { dataRoot: forkRoot })
      assert.equal(service.environment, 'fork')
      const submitted = await service.submit({ level: 'yellow', title: 'fork asks', context: 'x', options: [{ value: 'a', label: 'A' }] })
      assert.equal(submitted.queued, false)
      assert.equal(submitted.ticket.id, 'dec_remote_1')
      assert.equal(calls.length, 1)
      assert.match(calls[0].url, /\/fang\/api\/decisions\/ingest$/)
      assert.equal(calls[0].init.headers['x-fang-auth'], 'mother-token-0123456789abcdef')
      const payload = JSON.parse(calls[0].init.body)
      assert.equal(payload.producer, 'fork')
      assert.equal(payload.originForkId, 'fork-1')
      assert.equal(payload.taskId, 'task-fork-1')
    })
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_FANG_MOTHER
    ctx.dispose()
    fs.rmSync(forkRoot, { recursive: true, force: true })
    fs.rmSync(motherRoot, { recursive: true, force: true })
  }
})

test('fork decision-center: red tool waits for mother resolution and returns selected value', async () => {
  const { forkRoot, motherRoot } = setup()
  process.env.DSH_FANG_MOTHER = motherRoot
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const originalFetch = globalThis.fetch
  let polls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('/decisions/ingest')) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_red_1', level: 'red', status: 'pending', isBlocking: true } }) } }
    }
    polls += 1
    return {
      ok: true, status: 200,
      async text() { return JSON.stringify({ ok: true, ticket: { id: 'dec_red_1', level: 'red', status: 'resolved', outcome: 'resolved', resolvedOption: 'deploy' } }) },
    }
  }
  const ctx = makeCtx({ services: { tools } })
  try {
    await withForkEnv(async () => {
      apply(ctx, { dataRoot: forkRoot })
      const tool = registered.find((item) => item.name === 'request_human_decision')
      assert.ok(tool, 'fork tool must be registered')
      const result = await tool.execute({
        level: 'red', title: 'deploy?', context: 'x',
        options: [{ value: 'deploy', label: 'Deploy' }, { value: 'hold', label: 'Hold' }],
      }, { agent: { id: 'fork-session-1' } })
      assert.equal(result.blocking, true)
      assert.equal(result.status, 'resolved')
      assert.equal(result.selectedValue, 'deploy')
      assert.equal(polls, 1)
    })
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_FANG_MOTHER
    ctx.dispose()
    fs.rmSync(forkRoot, { recursive: true, force: true })
    fs.rmSync(motherRoot, { recursive: true, force: true })
  }
})

test('fork decision-center: PJM/Worker report tools submit stable payloads', async () => {
  const { forkRoot, motherRoot } = setup()
  process.env.DSH_FANG_MOTHER = motherRoot
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const payloads = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/decisions/ingest')) {
      payloads.push(JSON.parse(init.body))
      const id = `dec_${payloads.length}`
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id, level: 'yellow', status: 'pending', isBlocking: false } }) } }
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, ticket: { id: 'x', status: 'resolved' } }) } }
  }
  const ctx = makeCtx({ services: { tools } })
  try {
    await withForkEnv(async () => {
      apply(ctx, { dataRoot: forkRoot })
      const pjmTool = registered.find((item) => item.name === 'report_pjm_timeout')
      const workerTool = registered.find((item) => item.name === 'report_worker_deviation')
      assert.ok(pjmTool, 'report_pjm_timeout must be registered in fork')
      assert.ok(workerTool, 'report_worker_deviation must be registered in fork')
      const pjm = await pjmTool.execute({ projectId: 'p1', phase: 'build', timeoutMinutes: 2 })
      assert.equal(pjm.status, 'pending')
      await workerTool.execute({ workerId: 'w1', taskId: 't1', detail: 'edited outside scope' })
      assert.equal(payloads[0].producer, 'PJM')
      assert.equal(payloads[0].kind, 'pjm-timeout')
      assert.equal(payloads[0].level, 'yellow')
      assert.equal(payloads[0].timeoutMinutes, 2)
      assert.equal(payloads[0].dedupeKey, 'pjm:timeout:p1:build')
      assert.equal(payloads[1].producer, 'Worker')
      assert.equal(payloads[1].kind, 'worker-deviation')
      assert.equal(payloads[1].dedupeKey, 'worker:deviation:t1')
    })
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_FANG_MOTHER
    ctx.dispose()
    fs.rmSync(forkRoot, { recursive: true, force: true })
    fs.rmSync(motherRoot, { recursive: true, force: true })
  }
})

test('fork decision-center: mother unreachable queues the payload instead of losing it', async () => {
  const forkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-fork-decision-offline-'))
  process.env.DSH_FANG_MOTHER = path.join(forkRoot, 'no-mother-here')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  const ctx = makeCtx()
  try {
    await withForkEnv(async () => {
      const service = apply(ctx, { dataRoot: forkRoot })
      const queued = await service.submit({ level: 'yellow', title: 'offline ask', context: 'x', options: [{ value: 'a', label: 'A' }] })
      assert.equal(queued.ok, true)
      assert.equal(queued.queued, true)
      assert.ok(queued.outboxId)
      assert.equal(service.outboxStatus().pending, 1)
    })
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_FANG_MOTHER
    ctx.dispose()
    fs.rmSync(forkRoot, { recursive: true, force: true })
  }
})
