// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 装载形状验收（v2）：十一行插件都存在、导出形状合规、角色矩阵正确。
// 这是"能不能装进 profile"的离线等价物；任何一行缺失/形状不对/角色错位都会失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { makeCtx } from './helpers.mjs'
import { SERVICE } from '../src/kernel/index.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = [
  { file: 'orchestrator', name: 'fang-orchestrator', key: 'orchestrator', roles: ['mother'] },
  { file: 'forker', name: 'fang-forker', key: 'forker', roles: ['mother'] },
  { file: 'restart-guard', name: 'fang-restart-guard', key: 'restart', roles: ['mother'] },
  { file: 'session-catalog', name: 'fang-session-catalog', key: 'sessionCatalog', roles: ['mother'] },
  { file: 'healer', name: 'fang-healer', key: 'healer', roles: ['fork'] },
  { file: 'hot-reloader', name: 'fang-hot-reloader', key: 'hotReloader', roles: ['fork'] },
  { file: 'adapter', name: 'fang-adapter', key: 'adapter', roles: ['fork'] },
  { file: 'scorer', name: 'fang-scorer', key: 'scorer', roles: ['mother', 'fork'] },
  { file: 'umbrella', name: 'fang-umbrella', key: 'umbrella', roles: ['mother', 'fork'] },
  { file: 'router', name: 'fang-router', key: 'router', roles: ['mother', 'fork'] },
  { file: 'approver', name: 'fang-approver', key: 'approver', roles: ['mother', 'fork'] },
  { file: 'buffer-keeper', name: 'fang-buffer-keeper', key: 'buffer', roles: ['fork'] },
  { file: 'auditor', name: 'fang-auditor', key: 'auditor', roles: ['mother', 'fork'] },
]

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fang-shape-'))
}

/** Minimal config that keeps every plugin's apply() away from the real $DSH_HOME. */
function configFor(file, dataRoot) {
  const base = { dataRoot, forksRoot: path.join(dataRoot, 'forks') }
  if (file === 'orchestrator') return { ...base, adapterTimeoutMs: 150, routes: { enabled: false } }
  if (file === 'forker') return base
  if (file === 'session-catalog') return { ...base, sessionsRoot: path.join(dataRoot, 'sessions'), storagesRoot: path.join(dataRoot, 'storages') }
  if (file === 'buffer-keeper') return { root: path.join(dataRoot, 'buffer'), watch: false }
  return {}
}

async function withRole(role, fn) {
  const prev = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = role
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = prev
  }
}

for (const spec of PLUGINS) {
  test(`plugin shape + role matrix: ${spec.file}`, async () => {
    const file = path.join(ROOT, 'src/plugins', `${spec.file}.mjs`)
    assert.ok(fs.existsSync(file), `src/plugins/${spec.file}.mjs must exist`)
    const mod = await import(`../src/plugins/${spec.file}.mjs`)
    assert.equal(typeof mod.name, 'string', 'name export')
    assert.equal(mod.name, spec.name, 'name matches loader row vocabulary')
    assert.ok(Array.isArray(mod.inject), 'inject export must be an array')
    assert.equal(typeof mod.apply, 'function', 'apply export')
    assert.ok(mod.Config, 'Config export (schemastery schema)')

    for (const role of ['mother', 'fork']) {
      await withRole(role, () => {
        const dataRoot = tmpRoot()
        const ctx = makeCtx()
        try {
          mod.apply(ctx, configFor(spec.file, dataRoot))
          const svc = ctx.get(SERVICE[spec.key])
          if (spec.roles.includes(role)) {
            assert.ok(svc, `${spec.name} must register ${SERVICE[spec.key]} in ${role}`)
          } else {
            assert.equal(svc, undefined, `${spec.name} must NOT activate in ${role} (deployment matrix)`)
          }
        } finally {
          ctx.dispose()
          fs.rmSync(dataRoot, { recursive: true, force: true })
        }
      })
    }
  })
}

test('compose mode mounts every plugin of the current role through one row', async () => {
  const mod = await import('../src/compose.mjs')
  assert.equal(mod.name, 'fang-compose')
  const dataRoot = tmpRoot()
  const previous = process.env.DSH_FANG_ROLE
  try {
    // mother: mother-role plugins provide services, fork-only ones stay silent
    delete process.env.DSH_FANG_ROLE
    let ctx = makeCtx()
    mod.apply(ctx, {
      orchestrator: { dataRoot, adapterTimeoutMs: 150, routes: { enabled: false } },
      forker: { dataRoot },
    })
    assert.ok(ctx.get(SERVICE.orchestrator), 'compose must mount orchestrator in mother')
    assert.equal(ctx.get(SERVICE.adapter), undefined, 'compose must not activate adapter in mother')
    ctx.dispose()

    // fork: organs only
    process.env.DSH_FANG_ROLE = 'fork'
    ctx = makeCtx()
    mod.apply(ctx, {
      adapter: { taskId: 't1' },
      bufferKeeper: { root: path.join(dataRoot, 'buffer'), watch: false },
    })
    assert.ok(ctx.get(SERVICE.adapter), 'compose must mount adapter in fork')
    assert.ok(ctx.get(SERVICE.hotReloader), 'compose must mount hot-reloader in fork')
    assert.equal(ctx.get(SERVICE.orchestrator), undefined, 'compose must not activate orchestrator in fork')
    assert.equal(ctx.get(SERVICE.forker), undefined, 'compose must not activate forker in fork')
    ctx.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('package exports + bundle patch reference every row (install preflight)', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@local/dsh-fang')
  assert.equal(pkg.version, '3.1.28')
  assert.ok(pkg.dsh?.bundle?.patch, 'dsh.bundle.patch is required to be a bundle')
  assert.ok(fs.existsSync(path.join(ROOT, pkg.dsh.bundle.patch)), 'bundle patch file exists')
  assert.equal(pkg.dsh?.client?.platform, 'web', '浏览器 client half 必须启用（插件可脱离桌面端使用）')
  assert.ok(pkg.exports['./client'], 'client 入口供 DSH Web 加载')

  for (const [sub, target] of Object.entries(pkg.exports)) {
    const rel = typeof target === 'string' ? target : target.default ?? target.browser
    if (!rel || rel.includes('*')) continue
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `exports["${sub}"] -> ${rel}`)
  }

  const patch = fs.readFileSync(path.join(ROOT, pkg.dsh.bundle.patch), 'utf8')
  for (const spec of PLUGINS) {
    // the orchestrator row must be the BARE package name so the client half is discovered
    const expected = spec.file === 'orchestrator' ? '@local/dsh-fang' : `@local/dsh-fang/${spec.file}`
    assert.ok(patch.includes(expected), `patch must reference ${spec.file}`)
  }
  assert.ok(patch.includes('id: fang-adapter'), 'adapter row present')
  assert.ok(patch.includes('id: fang-orchestrator'), 'orchestrator row present')
})
