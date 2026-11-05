// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.3 — 兼容性门禁：模块导入/apply、路由契约、状态落盘、升级失败保持子插件关闭。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  COMPAT_STATUS_FILE,
  DEFAULT_EXPECTED_ROUTE_COUNT,
  listCompatModules,
  readCompatStatus,
  runCompatGate,
  writeCompatStatus,
} from '../src/lib/compat.mjs'
import { tmpDir } from './helpers.mjs'

function makeFakeRoot(options = {}) {
  const root = tmpDir('fang-compat-')
  const kernel = path.join(root, 'src/kernel/index.mjs')
  const plugins = path.join(root, 'src/plugins')
  fs.mkdirSync(path.dirname(kernel), { recursive: true })
  fs.mkdirSync(plugins, { recursive: true })
  fs.writeFileSync(kernel, 'export default {}\n', 'utf8')
  const names = options.plugins ?? ['adapter.mjs', 'auditor.mjs', 'orchestrator.mjs']
  for (const name of names) {
    fs.writeFileSync(path.join(plugins, name), 'export const name = "x"; export function apply() {}\n', 'utf8')
  }
  fs.writeFileSync(path.join(plugins, 'imports.mjs'), 'export const x = 1\n', 'utf8')
  return root
}

function fakeImporter(failures = {}) {
  return async (url) => {
    for (const [needle, kind] of Object.entries(failures)) {
      if (url.includes(needle)) {
        if (kind === 'throw') throw new Error(`boom ${needle}`)
        return kind === 'no-apply' ? { name: 'x' } : { apply() {}, name: 'x' }
      }
    }
    return { name: 'x', apply() {} }
  }
}

test('compat: listCompatModules 排除 imports.mjs 并排序', () => {
  const root = makeFakeRoot()
  const modules = listCompatModules(root)
  assert.deepEqual(modules, ['src/plugins/adapter.mjs', 'src/plugins/auditor.mjs', 'src/plugins/orchestrator.mjs'])
  assert.ok(!modules.includes('src/plugins/imports.mjs'))
})

test('compat: 全部模块可导入且路由契约满足 → ok', async () => {
  const root = makeFakeRoot()
  const routePaths = [
    '/fang/api/status', '/fang/api/mirror/status',
    '/fang/api/mirror/upgrade', '/fang/api/mirror/recompute-status',
    '/fang/api/compat', '/fang/api/essence/list', '/fang/api/auth-token',
    '/fang/api/tasks/open-url', '/fang/api/essence/create', '/fang/api/tasks/rename',
    '/fang/api/upgrade/status', '/fang/api/tasks/branches',
    '/fang/api/tasks/branches/activate', '/fang/api/tasks/branches/status',
    '/fang/api/reflow/policy', '/other',
  ]
  const result = await runCompatGate({
    rootDir: root,
    expectedRouteCount: routePaths.length,
    routePaths,
    importModule: fakeImporter(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.moduleCount, 3)
  assert.equal(result.findings.filter(item => item.severity === 'error').length, 0)
})

test('compat: 模块导入失败 / 缺 apply → 子插件保持关闭', async () => {
  const root = makeFakeRoot()
  const result = await runCompatGate({
    rootDir: root,
    expectedRouteCount: 1,
    routePaths: ['/not-required'],
    requiredRoutes: ['/not-required'],
    importModule: fakeImporter({ 'auditor.mjs': 'throw', 'adapter.mjs': 'no-apply' }),
  })
  assert.equal(result.ok, false)
  assert.ok(result.findings.some(f => f.code === 'plugin-import-failed'))
  assert.ok(result.findings.some(f => f.code === 'plugin-apply-missing'))
})

test('compat: 路由数量不匹配 / 必需路由缺失 → 失败', async () => {
  const root = makeFakeRoot()
  const result = await runCompatGate({
    rootDir: root,
    expectedRouteCount: 99,
    routePaths: ['/fang/other'],
    requiredRoutes: ['/fang/api/mirror/status'],
    importModule: fakeImporter(),
  })
  assert.equal(result.ok, false)
  assert.ok(result.findings.some(f => f.code === 'route-count-mismatch'))
  assert.ok(result.findings.some(f => f.code === 'route-missing'))
})

test('compat: 内核导入失败 → 失败', async () => {
  const root = makeFakeRoot()
  const result = await runCompatGate({
    rootDir: root,
    expectedRouteCount: 0,
    requiredRoutes: [],
    importModule: fakeImporter({ 'src/kernel/index.mjs': 'throw' }),
  })
  assert.equal(result.ok, false)
  assert.ok(result.findings.some(f => f.code === 'kernel-import-failed'))
})

test('compat: 状态默认 subPluginsEnabled=false；通过后 true 并落盘', () => {
  const stateDir = tmpDir('fang-compat-state-')
  const initial = readCompatStatus(stateDir)
  assert.equal(initial.ok, false)
  assert.equal(initial.subPluginsEnabled, false)

  const written = writeCompatStatus(stateDir, {
    ok: true, checkedAt: 123, moduleCount: 16, routeCount: DEFAULT_EXPECTED_ROUTE_COUNT,
    expectedRouteCount: DEFAULT_EXPECTED_ROUTE_COUNT, findings: [],
  })
  assert.equal(written.subPluginsEnabled, true)
  assert.equal(fs.existsSync(path.join(stateDir, COMPAT_STATUS_FILE)), true)
  const loaded = readCompatStatus(stateDir)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.subPluginsEnabled, true)
  assert.equal(loaded.moduleCount, 16)
})

test('compat: 门禁失败结果落盘时保持 subPluginsEnabled=false', () => {
  const stateDir = tmpDir('fang-compat-state-')
  writeCompatStatus(stateDir, { ok: false, findings: [{ code: 'x', severity: 'error', message: 'm' }] })
  const loaded = readCompatStatus(stateDir)
  assert.equal(loaded.ok, false)
  assert.equal(loaded.subPluginsEnabled, false)
})

// ── 与 MirrorManager 的升级联动（客户端版本升级 → compat 门禁）──────────────
import { MirrorManager } from '../src/lib/mirror.mjs'

function makeMirrorFixture() {
  const root = tmpDir('fang-compat-mirror-')
  const mirrorRoot = path.join(root, 'mirror')
  fs.mkdirSync(path.join(mirrorRoot, 'active'), { recursive: true })
  fs.writeFileSync(path.join(mirrorRoot, 'active', 'version.json'), JSON.stringify({ version: '3.0.2' }), 'utf8')
  return { mirrorRoot }
}

function makeOfficial() {
  return {
    getLatestVersion() { return '3.0.3' },
    download(version, dest) {
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'version.json'), JSON.stringify({ version }), 'utf8')
    },
  }
}

test('compat gate 失败：升级保留但子插件关闭、跳过重算钩子、结果带 compat', async () => {
  const { mirrorRoot } = makeMirrorFixture()
  const compatResults = []
  const hooks = []
  const manager = new MirrorManager({
    mirrorRoot,
    officialSource: makeOfficial(),
    compatGate: async () => {
      const result = await runCompatGate({ rootDir: makeFakeRoot(), expectedRouteCount: 0, routePaths: [], requiredRoutes: [], importModule: fakeImporter({ 'auditor.mjs': 'throw' }) })
      return result
    },
    onCompatResult: (compat) => { compatResults.push(compat) },
    postUpgradeHook: (input) => { hooks.push(input) },
  })
  const result = await manager.upgrade()
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'compat-gate-failed')
  assert.equal(result.compat.ok, false)
  assert.equal(result.postUpgradeTriggered, false)
  assert.equal(compatResults.length, 1)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(hooks.length, 0)
  // 新版本已落地（保留升级，只是子插件关闭）
  assert.equal(manager.readMeta().version, '3.0.3')
})

test('compat gate 通过：升级成功并触发重算钩子', async () => {
  const { mirrorRoot } = makeMirrorFixture()
  const hooks = []
  const manager = new MirrorManager({
    mirrorRoot,
    officialSource: makeOfficial(),
    compatGate: async () => ({ ok: true, checkedAt: Date.now(), findings: [] }),
    onCompatResult: () => {},
    postUpgradeHook: (input) => { hooks.push(input) },
  })
  const result = await manager.upgrade()
  assert.equal(result.ok, true)
  assert.equal(result.compat.ok, true)
  assert.equal(result.postUpgradeTriggered, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(hooks.length, 1)
})

test('compat gate 抛错：按失败处理，不阻塞升级返回', async () => {
  const { mirrorRoot } = makeMirrorFixture()
  const manager = new MirrorManager({
    mirrorRoot,
    officialSource: makeOfficial(),
    compatGate: async () => { throw new Error('gate boom') },
  })
  const result = await manager.upgrade()
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'compat-gate-failed')
  assert.equal(result.compat.ok, false)
  assert.match(result.compat.findings[0].message, /gate boom/)
})
