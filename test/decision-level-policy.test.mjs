// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.2.0：四色决策状态机、真实落库、重启恢复与临时目录零残留。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers.mjs'
import { apply } from '../src/plugins/decision-center.mjs'
import { DECISION_LEVEL_POLICY, decisionWaitMs } from '../src/lib/decision-policy.mjs'

function boot({ root, config = {}, services = {} } = {}) {
  const dataRoot = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fang-policy-'))
  const ctx = makeCtx({ services })
  const service = apply(ctx, { dataRoot, autoAdvise: false, tickMs: 20, ...config })
  return { ctx, service, root: dataRoot }
}
function drop(ctx, root) {
  try { ctx.dispose() } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  assert.equal(fs.existsSync(root), false, 'temporary decision store must leave no residue')
}
async function waitFor(fn, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('waitFor timeout')
}
const option = (value, recommended = false) => ({ id: value, value, label: value, ...(recommended ? { isRecommended: true } : {}) })

test('policy defaults: red=human, yellow=3m defer, blue=1m recommended, green=immediate', () => {
  assert.equal(DECISION_LEVEL_POLICY.red.waitMode, 'human')
  assert.equal(decisionWaitMs('yellow'), 180_000)
  assert.equal(decisionWaitMs('blue'), 60_000)
  assert.equal(decisionWaitMs('green'), 0)
  assert.equal(decisionWaitMs('red'), null)
  assert.equal(decisionWaitMs('yellow', 0.001), 60)
})

test('red never auto-selects: the workflow resumes only after a human choice', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({ level: 'red', title: '必须选', options: [option('A', true), option('B')] })
    const pending = service.wait(created.ticket.id)
    let settled = false
    void pending.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(settled, false)
    assert.equal(service.get(created.ticket.id).status, 'pending')
    service.resolve(created.ticket.id, 'B', { by: 'human' })
    const result = await pending
    assert.equal(result.resolvedOption, 'B')
    assert.equal(result.autoResolved, false)
  } finally { drop(ctx, root) }
})

test('yellow defers after its wait window, stays pending, and a late choice executes the action', async () => {
  const { ctx, service, root } = boot()
  try {
    const calls = []
    service.registerActionHandler('apply_late', async ({ payload }) => { calls.push(payload); return { ok: true } })
    const created = service.create({
      level: 'yellow', title: '黄色可补选', timeoutMinutes: 0.001,
      options: [option('apply_late', true), option('skip')],
    })
    assert.equal(created.ticket.expiresAt, null, 'wait window must not become archive expiry')
    const result = await service.wait(created.ticket.id)
    assert.equal(result.status, 'pending')
    assert.equal(result.outcome, 'deferred')
    assert.ok(result.deferredAt > 0)
    assert.equal(calls.length, 0, 'timeout alone must not execute a yellow action')
    const late = service.resolveAction(created.ticket.id, 'apply_late', { patch: 7 }, { by: 'human-late' })
    assert.equal(late.ok, true)
    assert.equal(late.ticket.lateResponse, true)
    assert.equal(late.ticket.level, 'yellow', 'late resolution keeps the original color for history')
    await waitFor(() => service.get(created.ticket.id).execution?.status === 'done')
    assert.deepEqual(calls, [{ patch: 7 }])
  } finally { drop(ctx, root) }
})

test('blue auto-selects the recommended option after one wait window and records execution', async () => {
  const { ctx, service, root } = boot()
  try {
    const calls = []
    service.registerActionHandler('auto_fix', async ({ payload }) => { calls.push(payload); return { ok: true, applied: true } })
    const created = service.create({
      level: 'blue', title: '蓝色自动推荐', timeoutMinutes: 0.001,
      options: [option('hold'), option('auto_fix', true)],
    })
    const result = await service.wait(created.ticket.id)
    assert.equal(result.status, 'resolved')
    assert.equal(result.resolvedOption, 'auto_fix')
    assert.equal(result.autoResolved, true)
    assert.equal(result.autoReason, 'blue-timeout')
    assert.equal(result.resolvedBy, 'auto:blue-timeout')
    await waitFor(() => service.get(created.ticket.id).execution?.status === 'done')
    assert.deepEqual(calls, [null])
  } finally { drop(ctx, root) }
})

test('green closes immediately without a pending notification and keeps a record', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({ level: 'green', title: '绿色通知', options: [option('done', true)] })
    assert.equal(created.ticket.status, 'resolved')
    assert.equal(created.ticket.autoResolved, true)
    assert.equal(created.ticket.autoReason, 'green-immediate')
    assert.equal(service.list().active, 0)
    const history = service.list({ includeArchived: true })
    assert.equal(history.items[0].level, 'green')
    assert.equal(history.items[0].resolvedOption, 'done')
  } finally { drop(ctx, root) }
})

test('history exposes red/yellow/blue/green records with their own colors', async () => {
  const { ctx, service, root } = boot()
  try {
    service.create({ level: 'red', title: 'r', options: [option('a')] })
    service.create({ level: 'yellow', title: 'y', timeoutMinutes: 0.001, options: [option('a')] })
    service.create({ level: 'blue', title: 'b', timeoutMinutes: 0.001, options: [option('a', true)] })
    service.create({ level: 'green', title: 'g' })
    await waitFor(() => service.list({ includeArchived: true }).items.filter((item) => item.level === 'blue' && item.status === 'resolved').length === 1)
    const history = service.list({ includeArchived: true })
    for (const level of ['red', 'yellow', 'blue', 'green']) {
      assert.ok(history.items.some((item) => item.level === level), `${level} must appear in history`)
    }
    const yellow = history.items.find((item) => item.level === 'yellow')
    assert.equal(yellow.status, 'pending')
    assert.equal(yellow.outcome, 'deferred')
  } finally { drop(ctx, root) }
})

test('policy state persists to JSON and survives a restart without losing yellow late-answer capability', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-policy-restart-'))
  const first = boot({ root })
  let yellowId = ''
  let blueId = ''
  try {
    yellowId = first.service.create({ level: 'yellow', title: 'restart-y', timeoutMinutes: 0.001, options: [option('a')] }).ticket.id
    blueId = first.service.create({ level: 'blue', title: 'restart-b', timeoutMinutes: 0.001, options: [option('b', true)] }).ticket.id
    await waitFor(() => first.service.get(yellowId).deferredAt)
    await waitFor(() => first.service.get(blueId).status === 'resolved')
    const storeFile = path.join(root, 'decision-center.json')
    const disk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    assert.equal(disk.tickets.length, 2)
    assert.equal(disk.tickets.find((item) => item.id === yellowId).outcome, 'deferred')
    assert.equal(disk.tickets.find((item) => item.id === blueId).autoResolved, true)
  } finally {
    try { first.ctx.dispose() } catch { /* ignore */ }
  }
  const second = boot({ root })
  try {
    const yellow = second.service.get(yellowId)
    const blue = second.service.get(blueId)
    assert.equal(yellow.status, 'pending')
    assert.equal(yellow.outcome, 'deferred')
    assert.equal(yellow.isBlocking, false)
    assert.equal(blue.status, 'resolved')
    assert.equal(blue.resolvedOption, 'b')
    const late = second.service.resolve(yellowId, 'a', { by: 'after-restart' })
    assert.equal(late.ok, true)
    assert.equal(late.ticket.lateResponse, true)
  } finally { drop(second.ctx, root) }
})

test('agent tool returns deferred yellow / auto blue / immediate green with explicit outcomes', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition); return () => {} } }
  const { ctx, root } = boot({ services: { tools } })
  try {
    const tool = registered.find((item) => item.name === 'request_human_decision')
    const yellow = await tool.execute({ level: 'yellow', title: 'ty', timeoutMinutes: 0.001, options: [option('a')] }, { agent: { id: 's1' } })
    assert.equal(yellow.outcome, 'deferred')
    assert.equal(yellow.continueWithoutDecision, true)
    assert.equal(yellow.canAnswerLater, true)
    const blue = await tool.execute({ level: 'blue', title: 'tb', timeoutMinutes: 0.001, options: [option('b', true)] }, { agent: { id: 's2' } })
    assert.equal(blue.status, 'resolved')
    assert.equal(blue.autoResolved, true)
    assert.equal(blue.selectedValue, 'b')
    const green = await tool.execute({ level: 'green', title: 'tg' }, { agent: { id: 's3' } })
    assert.equal(green.status, 'resolved')
    assert.equal(green.outcome, 'acked')
    assert.equal(green.blocking, false)
  } finally { drop(ctx, root) }
})
