// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.2.1 查漏补缺：defer 幂等、pending 防修剪、取消不放弃黄蓝、旧票不误自动执行。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './helpers.mjs'
import { apply } from '../src/plugins/decision-center.mjs'

function boot({ root, config = {} } = {}) {
  const dataRoot = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fang-policy-hard-'))
  const ctx = makeCtx()
  const service = apply(ctx, { dataRoot, autoAdvise: false, ...config })
  return { ctx, service, root: dataRoot }
}
function drop(ctx, root) {
  try { ctx.dispose() } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  assert.equal(fs.existsSync(root), false)
}
const opt = (value, recommended = false) => ({ value, label: value, ...(recommended ? { isRecommended: true } : {}) })

test('yellow defer is idempotent across concurrent waits and later repeat waits', async () => {
  const { ctx, service, root } = boot()
  try {
    const created = service.create({ level: 'yellow', title: 'once', timeoutMinutes: 0.001, options: [opt('a')] })
    const [one, two] = await Promise.all([service.wait(created.ticket.id), service.wait(created.ticket.id)])
    assert.equal(one.outcome, 'deferred')
    assert.equal(two.outcome, 'deferred')
    const rev = service.get(created.ticket.id).rev
    const again = await service.wait(created.ticket.id)
    assert.equal(again.outcome, 'deferred')
    assert.equal(service.get(created.ticket.id).rev, rev, 'repeat defer must not advance revision or duplicate audit')
  } finally { drop(ctx, root) }
})

test('capacity pruning never deletes a pending yellow ticket; only closed history is evicted', () => {
  const { ctx, service, root } = boot({ config: { maxTickets: 10 } })
  try {
    const yellow = service.create({ level: 'yellow', title: 'keep me', options: [opt('a')] })
    for (let i = 0; i < 14; i += 1) service.create({ level: 'green', title: `history-${i}` })
    const kept = service.get(yellow.ticket.id)
    assert.ok(kept, 'pending yellow must survive the maxTickets prune')
    assert.equal(kept.status, 'pending')
    assert.equal(kept.level, 'yellow')
    assert.ok(service.list({ includeArchived: true }).total <= 10, 'closed green history is still bounded')
  } finally { drop(ctx, root) }
})

test('aborting a yellow or blue wait does not abandon the ticket', async () => {
  const { ctx, service, root } = boot()
  try {
    for (const level of ['yellow', 'blue']) {
      const created = service.create({ level, title: `${level} abort`, options: [opt('a', true)] })
      const controller = new AbortController()
      const pending = service.wait(created.ticket.id, controller.signal)
      controller.abort()
      await assert.rejects(pending, /aborted/)
      const ticket = service.get(created.ticket.id)
      assert.equal(ticket.status, 'pending')
      assert.equal(ticket.level, level)
      assert.notEqual(ticket.status, 'abandoned')
    }
  } finally { drop(ctx, root) }
})

test('legacy pending tickets without waitDeadlineAt are not mistaken for expired policy tickets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-policy-legacy-'))
  const id = 'dec_legacy_blue'
  fs.writeFileSync(path.join(root, 'decision-center.json'), JSON.stringify({
    version: 1,
    tickets: [{
      id, rev: 1, level: 'blue', status: 'pending', title: 'legacy blue',
      source: { sessionId: 'old', agentRole: 'worker' }, options: [opt('auto', true)],
      createdAt: Date.now() - 100000, expiresAt: null,
    }],
  }), 'utf8')
  const { ctx, service } = boot({ root })
  try {
    const controller = new AbortController()
    const pending = service.wait(id, controller.signal)
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(pending, /aborted/)
    const ticket = service.get(id)
    assert.equal(ticket.status, 'pending')
    assert.equal(ticket.resolvedOption, null, 'legacy blue must not be auto-executed merely because its deadline is missing')
  } finally { drop(ctx, root) }
})
