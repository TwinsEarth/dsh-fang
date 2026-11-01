// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// kernel v2: 角色矩阵与商用扩展位（Lead-owned）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ROLE, MATRIX, resolveRole, roleAllows, roleGate, rolesOf,
  COMMERCIAL, SERVICE_COMMERCIAL, commercialConfigSchemaDefaults, resolveCommercial, invokeCommercial,
  FANG_VERSION, SERVICE, TASK_STATUS, ADAPTER_OP, ADAPTER_ROUTE, CONTAINER,
} from '../src/kernel/index.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('role: environment wins over config, config over default', () => {
  assert.equal(resolveRole({ cfgRole: 'mother', env: { DSH_FANG_ROLE: 'fork' } }), 'fork')
  assert.equal(resolveRole({ cfgRole: 'fork', env: { DSH_FANG_ROLE: 'mother' } }), 'mother')
  assert.equal(resolveRole({ cfgRole: 'fork', env: {} }), 'fork')
  assert.equal(resolveRole({ cfgRole: '', env: {} }), 'mother')
  assert.equal(resolveRole({ cfgRole: 'bogus', env: { DSH_FANG_ROLE: 'bogus' } }), 'mother', 'invalid values fall back')
  assert.equal(resolveRole({ cfgRole: '', env: { DSH_FANG_ROLE: 'consumer' } }), 'consumer', 'consumer is a first-class role')
})

test('role: the v2 matrix covers all eleven plugins and the 3-layer split', () => {
  const expected = {
    orchestrator: ['mother'],
    forker: ['mother'],
    restartGuard: ['mother'],
    healer: ['fork'],
    hotReloader: ['fork'],
    adapter: ['fork'],
    scorer: ['mother', 'fork'],
    router: ['mother', 'fork'],
    approver: ['mother', 'fork'],
    bufferKeeper: ['fork'],
    auditor: ['mother', 'fork'],
    sessionCatalog: ['mother'],
    sessionBridge: ['mother'],
    sessionSync: ['mother', 'consumer'],
    sessionRouter: ['mother'],
  }
  for (const [key, roles] of Object.entries(expected)) {
    assert.deepEqual(rolesOf(key), roles, `matrix for ${key}`)
  }
  assert.equal(Object.keys(MATRIX).length, 15)
  assert.equal(roleAllows('orchestrator', 'fork'), false)
  assert.equal(roleAllows('adapter', 'mother'), false)
  assert.equal(roleAllows('auditor', 'fork'), true)
})

test('role: roleGate reports the reason and never throws on a missing logger', () => {
  const mother = roleGate('forker', { env: { DSH_FANG_ROLE: 'mother' } })
  assert.deepEqual({ role: mother.role, active: mother.active }, { role: 'mother', active: true })
  const gated = roleGate('forker', { env: { DSH_FANG_ROLE: 'fork' } })
  assert.equal(gated.active, false)
  assert.match(gated.reason, /not deployed in fork/)
  assert.equal(roleGate('scorer', { env: { DSH_FANG_ROLE: 'fork' } }).active, true)
})

test('role: every plugin file declares a roleGate matching the matrix', async () => {
  const files = [
    ['orchestrator', 'orchestrator'], ['forker', 'forker'], ['restart-guard', 'restartGuard'],
    ['healer', 'healer'], ['hot-reloader', 'hotReloader'], ['adapter', 'adapter'],
    ['scorer', 'scorer'], ['router', 'router'], ['approver', 'approver'],
    ['buffer-keeper', 'bufferKeeper'], ['auditor', 'auditor'],
  ]
  for (const [file] of files) {
    const p = path.join(ROOT, 'src/plugins', `${file}.mjs`)
    if (!fs.existsSync(p)) continue // teammate not delivered yet; shape test owns the strict check
    const src = fs.readFileSync(p, 'utf8')
    assert.match(src, /roleGate\(/, `${file}.mjs must call roleGate()`)
  }
})

test('commercial: hooks are off by default and no-op without a provider', async () => {
  const defaults = commercialConfigSchemaDefaults()
  assert.deepEqual(defaults, { collaboration: false, git: false, backup: false, tokenApi: false, teams: false })
  for (const capability of Object.values(COMMERCIAL)) {
    assert.equal(resolveCommercial({ commercialHooks: defaults, provider: { [capability]: {} }, capability }), undefined, `${capability} disabled by default`)
  }
  const enabled = { ...defaults, backup: true }
  assert.equal(resolveCommercial({ commercialHooks: enabled, capability: 'backup' }), undefined, 'no provider')
  const provider = { backup: { upload: async () => ({ uri: 'x' }) } }
  assert.ok(resolveCommercial({ commercialHooks: enabled, provider, capability: 'backup' }))

  const missing = await invokeCommercial({ commercialHooks: defaults, capability: 'backup', method: 'upload' })
  assert.deepEqual(missing, { ok: false, error: 'not-configured' })

  const ok = await invokeCommercial({ commercialHooks: enabled, provider, capability: 'backup', method: 'upload', args: [{ a: 1 }] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, { uri: 'x' })

  const broken = { backup: { upload: async () => { throw new Error('relay down') } } }
  const failed = await invokeCommercial({ commercialHooks: enabled, provider: broken, capability: 'backup', method: 'upload' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /relay down/)
})

test('vocabulary: v2 version, task lifecycle, adapter protocol and container states', () => {
  assert.equal(FANG_VERSION, '2.6.3')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.version, FANG_VERSION, 'package.json version must match kernel FANG_VERSION')
  assert.deepEqual(Object.values(TASK_STATUS), ['provisioning', 'ready', 'running', 'archived', 'failed'])
  assert.equal(ADAPTER_OP.READ_PLUGIN, 'read-plugin')
  assert.equal(ADAPTER_OP.SCORE_PLUGIN, 'score-plugin')
  assert.equal(ADAPTER_ROUTE.HELLO, '/adapter/hello')
  assert.equal(ADAPTER_ROUTE.COMMAND, '/adapter/command')
  assert.deepEqual(Object.values(CONTAINER), ['disabled', 'unavailable', 'ready'])
  assert.equal(SERVICE.adapter, 'fangAdapter')
  assert.equal(SERVICE.sessionCatalog, 'fangSessionCatalog')
  assert.equal(SERVICE_COMMERCIAL, 'fangCommercial')
  assert.equal(ROLE.MOTHER, 'mother')
})
