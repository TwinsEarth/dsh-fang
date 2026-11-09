// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 端到端：真实 decision-center + 真实 restart-guard + 真实 orchestrator 注册 confirm_restart 执行器。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx, makeWebServerStub, TEST_AUTH_TOKEN } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'
import { apply as applyDecisionCenter } from '../src/plugins/decision-center.mjs'
import { apply as applyRestartGuard } from '../src/plugins/restart-guard.mjs'
import * as orchestrator from '../src/plugins/orchestrator.mjs'

const waitFor = async (fn, { timeout = 3000, interval = 20 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

test('confirm_restart: real plugins execute restart.request (not just record selectedActionId)', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-action-e2e-'))
  const webServer = makeWebServerStub()
  const forker = {
    list: () => [], health: () => null, reap: async () => ({ ok: true }), recover: async () => ({ ok: true }),
    create: async () => ({ forkId: 'f1', url: 'http://127.0.0.1:1/?token=x', port: 1, pid: 1 }),
  }
  const ctx = makeCtx({ services: { webServer, [SERVICE.forker]: forker } })
  try {
    const center = applyDecisionCenter(ctx, { dataRoot, registerTool: false, autoAdvise: false })
    assert.ok(center, 'decision-center must be active as mother')
    const guard = applyRestartGuard(ctx, { dataRoot, mode: 'observe', authMode: 'manual', allowProcessRestart: false })
    assert.ok(guard, 'restart-guard must be active as mother')
    orchestrator.apply(ctx, { dataRoot, authToken: TEST_AUTH_TOKEN, routes: { enabled: false } })

    // 真实 decision-center handler 已由 orchestrator 注册
    assert.ok(center.listActionHandlers().includes('confirm_restart'), 'orchestrator must register confirm_restart')

    const submitted = center.submit({
      level: 'yellow', title: 'restart host?', context: 'unit e2e',
      actions: [{ id: 'confirm_restart', label: '立即重启', type: 'primary', payload: { reason: 'unit-e2e' } }],
      source: 'System',
    })
    assert.equal(submitted.ok, true)
    const resolved = center.resolveAction(submitted.ticket.id, 'confirm_restart', { reason: 'unit-e2e' })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.ticket.selectedActionId, 'confirm_restart')

    const done = await waitFor(() => {
      const ticket = center.get(submitted.ticket.id)
      return ticket.execution && ticket.execution.status !== 'running' ? ticket : null
    })
    // 证明真的调用了 restart-guard：execution 有 result（observe 模式下是记录/拒绝，不重启）
    assert.equal(done.execution.status, 'done')
    assert.ok(done.execution.result, 'handler must return restart-guard result')
    assert.match(JSON.stringify(done.execution.result), /requested|observed|denied|state|risk/i)
  } finally {
    ctx.dispose()
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})
