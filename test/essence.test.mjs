// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v2.10.0 — Essence 覆盖层合并库验收：纯合并 / 冲突 / 配额 / 物化 / 凭据边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  EssenceManager,
  VIP_QUOTAS,
  checkActiveSessionQuota,
  checkEssenceQuota,
  checkSubEssenceQuota,
  mergeProfiles,
  parsePatchEntries,
  serializePatchEntries,
  ESSENCE_STATUS,
  CONFLICT_KIND,
  CONFLICT_SEVERITY,
} from '../src/lib/essence.mjs'
import { tmpDir } from './helpers.mjs'

const PATCH_TEXT = `- insert:
    - id: core-session
      name: "@dsh/session"
      config:
        maxSessions: 100
    - id: core-tools
      name: "@dsh/tools"
      config: { enable: true }
    - id: opt-theme
      name: "@dsh/theme"
      config: { mode: light }
`

function mirrorProfile() {
  return {
    root: '/mirror/active/profile',
    version: '2.10.0',
    fingerprint: 'fp-1',
    patchEntries: [
      { id: 'core-session', name: '@dsh/session', config: { maxSessions: 100 } },
      { id: 'core-tools', name: '@dsh/tools', config: { enable: true } },
      { id: 'opt-theme', name: '@dsh/theme', config: { mode: 'light' } },
    ],
    packageJson: { name: 'mirror', dependencies: { '@dsh/core': '^2.0.0' }, settings: { ui: { theme: 'light', fontSize: 14 } } },
    lockedPluginIds: new Set(['core-session', 'core-tools']),
  }
}

function overlay(over) {
  return { root: '/essence/overlay', patchEntries: [], packageJson: {}, settings: {}, ...over }
}

// ── 纯合并 ────────────────────────────────────────────────────────────────
test('essence merge: 原身新增插件 → 合并后包含', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [{ id: 'my-plugin', name: '/local/my-plugin.ts' }],
  }))
  assert.ok(result.mergedPatchEntries.some(entry => entry.id === 'my-plugin'))
  assert.equal(result.hasFatal, false)
})

test('essence merge: 原身覆盖可调插件配置 → 原身胜且深合并', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [{ id: 'opt-theme', config: { mode: 'dark' } }],
  }))
  const theme = result.mergedPatchEntries.find(entry => entry.id === 'opt-theme')
  assert.equal(theme.config.mode, 'dark')
  assert.equal(result.hasFatal, false)
})

test('essence merge: 原身禁用可调插件 → 条目移除', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [{ id: 'opt-theme', disabled: true }],
  }))
  assert.equal(result.mergedPatchEntries.some(entry => entry.id === 'opt-theme'), false)
})

test('essence merge: 原身禁用锁定插件 → fatal，镜像条目保留', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [{ id: 'core-session', disabled: true }],
  }))
  assert.equal(result.hasFatal, true)
  const conflict = result.conflicts.find(item => item.kind === CONFLICT_KIND.LOCKED_PLUGIN_DISABLED)
  assert.ok(conflict)
  assert.equal(conflict.severity, CONFLICT_SEVERITY.FATAL)
  assert.ok(result.mergedPatchEntries.some(entry => entry.id === 'core-session'))
})

test('essence merge: 原身覆盖锁定插件配置 → fatal，镜像配置保留', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [{ id: 'core-session', config: { maxSessions: 5 } }],
  }))
  assert.equal(result.hasFatal, true)
  const session = result.mergedPatchEntries.find(entry => entry.id === 'core-session')
  assert.equal(session.config.maxSessions, 100)
})

test('essence merge: 锁定插件无差异覆盖 → 无冲突', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [{ id: 'core-session', config: { maxSessions: 100 } }],
  }))
  assert.equal(result.hasFatal, false)
  assert.equal(result.conflicts.length, 0)
})

test('essence merge: 依赖主版本兼容 → 原身 pin 胜', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    packageJson: { dependencies: { '@dsh/core': '^2.1.0' } },
  }))
  assert.equal(result.mergedPackageJson.dependencies['@dsh/core'], '^2.1.0')
  assert.equal(result.hasFatal, false)
})

test('essence merge: 依赖主版本不兼容 → fatal，镜像版本保留', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    packageJson: { dependencies: { '@dsh/core': '^3.0.0' } },
  }))
  assert.equal(result.hasFatal, true)
  assert.equal(result.mergedPackageJson.dependencies['@dsh/core'], '^2.0.0')
})

test('essence merge: settings 深合并（原身胜）', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({ settings: { ui: { theme: 'dark' } } }))
  assert.deepEqual(result.mergedSettings.ui, { theme: 'dark', fontSize: 14 })
})

test('essence merge: 多个 fatal 冲突全部记录', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [
      { id: 'core-session', disabled: true },
      { id: 'core-tools', config: { enable: false } },
    ],
    packageJson: { dependencies: { '@dsh/core': '^9.0.0' } },
  }))
  assert.equal(result.conflicts.filter(conflict => conflict.severity === CONFLICT_SEVERITY.FATAL).length, 3)
})

test('essence merge: 原身 patch 重复 id → warning，后者生效', () => {
  const result = mergeProfiles(mirrorProfile(), overlay({
    patchEntries: [
      { id: 'opt-theme', config: { mode: 'dark' } },
      { id: 'opt-theme', config: { mode: 'mono' } },
    ],
  }))
  const theme = result.mergedPatchEntries.find(entry => entry.id === 'opt-theme')
  assert.equal(theme.config.mode, 'mono')
  assert.ok(result.conflicts.some(conflict => conflict.kind === CONFLICT_KIND.DUPLICATE_ID))
})

test('essence patch: 根列表与 {insert} 两种形状都能解析，序列化可回读', () => {
  const fromList = parsePatchEntries(PATCH_TEXT)
  assert.equal(fromList.entries.length, 3)
  assert.equal(fromList.errors.length, 0)
  const fromMap = parsePatchEntries(JSON.stringify({ insert: [{ id: 'x', name: 'y' }] }))
  assert.deepEqual(fromMap.entries, [{ id: 'x', name: 'y' }])
  const roundTrip = parsePatchEntries(serializePatchEntries(fromList.entries))
  assert.deepEqual(roundTrip.entries, fromList.entries)
})

// ── 配额 ──────────────────────────────────────────────────────────────────
test('essence quota: free 原身上限 5', () => {
  assert.equal(checkEssenceQuota('free', 4).ok, true)
  assert.equal(checkEssenceQuota('free', 5).ok, false)
  assert.match(checkEssenceQuota('free', 5).reason, /5\/5/)
  assert.match(checkEssenceQuota('free', 5).reason, /free/)
})

test('essence quota: vip100 原身上限 100', () => {
  assert.equal(checkEssenceQuota('vip100', 99).ok, true)
  assert.equal(checkEssenceQuota('vip100', 100).ok, false)
})

test('essence quota: 子原身配额独立', () => {
  assert.equal(checkSubEssenceQuota('free', 4).ok, true)
  assert.equal(checkSubEssenceQuota('free', 5).ok, false)
  assert.equal(VIP_QUOTAS.vip30.maxSubEssences, 30)
})

test('essence quota: 活跃会话配额（归档不限）', () => {
  assert.equal(checkActiveSessionQuota('free', 9).ok, true)
  assert.equal(checkActiveSessionQuota('free', 10).ok, false)
  assert.equal(checkActiveSessionQuota('vip30', 29).ok, true)
  assert.equal(checkActiveSessionQuota('vip30', 30).ok, false)
})

// ── Manager 集成 ──────────────────────────────────────────────────────────
function makeFixture(options = {}) {
  const root = tmpDir('fang-essence-')
  const mirrorRoot = path.join(root, 'mirror')
  const profileDir = path.join(mirrorRoot, 'active', 'profile')
  fs.mkdirSync(path.join(profileDir, 'settings'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PATCH_TEXT, 'utf8')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'mirror-profile',
    dependencies: { '@dsh/core': '^2.0.0' },
    settings: { ui: { theme: 'light', fontSize: 14 } },
  }, null, 2), 'utf8')
  fs.writeFileSync(path.join(profileDir, 'settings', 'default.yaml'), JSON.stringify({ theme: 'light' }), 'utf8')
  // 镜像里不应存在的凭据：用于验证物化时被剔除
  fs.mkdirSync(path.join(profileDir, 'credentials'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'credentials', 'bad-token.json'), '{"leak":true}', 'utf8')
  fs.writeFileSync(path.join(mirrorRoot, 'meta.json'), JSON.stringify({ version: '2.10.0' }, null, 2), 'utf8')
  fs.writeFileSync(path.join(mirrorRoot, 'mirror-locked.json'), JSON.stringify(['core-session', 'core-tools']), 'utf8')
  const essencesRoot = path.join(root, 'essences')
  fs.mkdirSync(essencesRoot, { recursive: true })
  const manager = new EssenceManager({ essencesRoot, mirrorRoot, logger: options.logger })
  return { root, mirrorRoot, profileDir, essencesRoot, manager }
}

test('essence manager: create 物化 merged/profile 且锁定项来自 mirror-locked.json', () => {
  const { manager } = makeFixture()
  const meta = manager.create({ name: '原身A' })
  assert.equal(meta.status, ESSENCE_STATUS.READY)
  const mergedProfile = manager.mergedProfileDir(meta.id)
  assert.equal(fs.existsSync(path.join(mergedProfile, 'cordis.patch.yml')), true)
  assert.equal(fs.existsSync(path.join(mergedProfile, 'package.json')), true)
  const patch = parsePatchEntries(fs.readFileSync(path.join(mergedProfile, 'cordis.patch.yml'), 'utf8'))
  assert.equal(patch.entries.length, 3)
  const fingerprint = JSON.parse(fs.readFileSync(path.join(manager.essenceRoot(meta.id), 'merged', 'fingerprint.json'), 'utf8'))
  assert.equal(fingerprint.mirrorVersion, '2.10.0')
})

test('essence manager: update 覆盖配置与 settings 后重新物化', async () => {
  const { manager } = makeFixture()
  const meta = manager.create({ name: '原身B' })
  await manager.update(meta.id, (overlay) => {
    overlay.patchEntries.push({ id: 'opt-theme', config: { mode: 'dark' } })
    overlay.packageJson = { dependencies: { 'my-plugin': '^1.0.0' } }
    overlay.settings = { ui: { theme: 'dark' } }
  })
  const mergedProfile = manager.mergedProfileDir(meta.id)
  const patch = parsePatchEntries(fs.readFileSync(path.join(mergedProfile, 'cordis.patch.yml'), 'utf8'))
  const theme = patch.entries.find(entry => entry.id === 'opt-theme')
  assert.equal(theme.config.mode, 'dark')
  const pkg = JSON.parse(fs.readFileSync(path.join(mergedProfile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['my-plugin'], '^1.0.0')
  assert.equal(pkg.dependencies['@dsh/core'], '^2.0.0')
  const settings = JSON.parse(fs.readFileSync(path.join(mergedProfile, 'settings', 'ui.yaml'), 'utf8'))
  assert.deepEqual(settings, { theme: 'dark', fontSize: 14 })
})

test('essence manager: fatal 冲突 → status=conflicted、保留旧物化结果；修复后恢复 ready', async () => {
  const { manager } = makeFixture()
  const meta = manager.create({ name: '原身C' })
  const beforePatch = fs.readFileSync(path.join(manager.mergedProfileDir(meta.id), 'cordis.patch.yml'), 'utf8')

  await manager.update(meta.id, (overlay) => {
    overlay.patchEntries.push({ id: 'core-session', disabled: true })
  })
  assert.equal(manager.getMeta(meta.id).status, ESSENCE_STATUS.CONFLICTED)
  assert.equal(manager.getConflicts(meta.id).filter(conflict => conflict.severity === 'fatal').length, 1)
  assert.equal(fs.readFileSync(path.join(manager.mergedProfileDir(meta.id), 'cordis.patch.yml'), 'utf8'), beforePatch)

  await manager.update(meta.id, (overlay) => {
    overlay.patchEntries = overlay.patchEntries.filter(entry => entry.id !== 'core-session')
  })
  assert.equal(manager.getMeta(meta.id).status, ESSENCE_STATUS.READY)
  assert.equal(fs.existsSync(path.join(manager.essenceRoot(meta.id), 'conflicts.json')), false)
})

test('essence manager: 物化永不复制凭据（镜像与原身凭据都不进 merged/profile）', () => {
  const { manager, essencesRoot } = makeFixture()
  const meta = manager.create({ name: '原身D' })
  const credentialsDir = path.join(essencesRoot, meta.id, 'overlay', 'credentials')
  fs.writeFileSync(path.join(credentialsDir, 'own.json'), '{"ok":true}', 'utf8')
  manager.recompute(meta.id)
  const mergedCredentials = path.join(manager.mergedProfileDir(meta.id), 'credentials')
  assert.equal(fs.existsSync(path.join(mergedCredentials, 'bad-token.json')), false)
  assert.equal(fs.existsSync(path.join(mergedCredentials, 'own.json')), false, '凭据不得进入派生 profile')
})

test('essence manager: free 配额上限 5，第 6 个拒绝', () => {
  const { manager } = makeFixture()
  for (let index = 0; index < 5; index += 1) manager.create({ name: `原身${index}`, tier: 'free' })
  assert.throws(() => manager.create({ name: '超限' }), /essence quota exceeded/)
})

test('essence manager: 子原身规则（两级上限、父级删除保护）', () => {
  const { manager } = makeFixture()
  const parent = manager.create({ name: '父原身', tier: 'vip10' })
  const child = manager.create({ name: '子原身', tier: 'vip10', parentId: parent.id })
  assert.equal(manager.listChildren(parent.id).length, 1)
  assert.throws(() => manager.create({ name: '孙原身', parentId: child.id }), /只允许两级原身/)
  manager.archive(parent.id)
  manager.archive(child.id)
  assert.throws(() => manager.remove(parent.id), /sub-essences/)
  manager.remove(child.id)
  assert.deepEqual(manager.remove(parent.id), { removed: true })
})

test('essence manager: captureFromProfile 克隆母体可写层（patch/依赖/设置），不复制凭据', () => {
  const { manager, root } = makeFixture()
  const mother = path.join(root, 'mother-profile')
  fs.mkdirSync(path.join(mother, 'settings'), { recursive: true })
  fs.mkdirSync(path.join(mother, 'credentials'), { recursive: true })
  fs.writeFileSync(path.join(mother, 'cordis.patch.yml'), `- insert:
    - id: my-plugin
      name: "@x/my-plugin"
      config: { a: 1 }
`, 'utf8')
  fs.writeFileSync(path.join(mother, 'package.json'), JSON.stringify({
    name: 'desktop',
    private: true,
    dsh: { profile: { bundles: ['@dsh/base', '@dsh/web-app'] } },
    dependencies: { '@dsh/base': '^1.0.0', 'my-plugin': '^2.0.0' },
    scripts: { build: 'echo should-not-copy' },
  }), 'utf8')
  fs.writeFileSync(path.join(mother, 'settings', 'ui.yaml'), JSON.stringify({ theme: 'dark' }), 'utf8')
  fs.writeFileSync(path.join(mother, 'credentials', 'mother-secret.json'), '{"leak":true}', 'utf8')

  const out = manager.captureFromProfile(mother, { name: '母体克隆' })
  assert.equal(out.meta.status, ESSENCE_STATUS.READY)
  assert.equal(out.captured.patchEntries, 1)
  assert.equal(out.captured.dependencies, 2)
  assert.equal(out.captured.bundles, 2)
  assert.equal(out.captured.settings, 1)
  assert.equal(out.captured.credentialsCopied, false)

  const overlayRoot = path.join(manager.essenceRoot(out.meta.id), 'overlay')
  const patch = parsePatchEntries(fs.readFileSync(path.join(overlayRoot, 'cordis.patch.yml'), 'utf8'))
  assert.equal(patch.entries.some(entry => entry.id === 'my-plugin'), true)
  const pkg = JSON.parse(fs.readFileSync(path.join(overlayRoot, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dependencies, { '@dsh/base': '^1.0.0', 'my-plugin': '^2.0.0' })
  assert.equal(pkg.scripts, undefined, 'scripts 不进元主 overlay')
  assert.equal(Array.isArray(pkg.dsh?.profile?.bundles), true)
  const settings = JSON.parse(fs.readFileSync(path.join(overlayRoot, 'settings', 'ui.yaml'), 'utf8'))
  assert.deepEqual(settings, { theme: 'dark' })
  // 母体凭据既不进 overlay，也不进物化 profile（B8）
  const overlayCredentials = fs.readdirSync(path.join(overlayRoot, 'credentials'))
  assert.deepEqual(overlayCredentials, [])
  assert.equal(fs.existsSync(path.join(manager.mergedProfileDir(out.meta.id), 'credentials')), false)
})

test('essence manager: captureFromProfile 拒绝把元主目录当母体', () => {
  const { manager } = makeFixture()
  const meta = manager.create({ name: '原身G' })
  assert.throws(
    () => manager.captureFromProfile(manager.mergedProfileDir(meta.id), { name: '克隆失败' }),
    /refusing to clone from an essence directory/,
  )
  assert.throws(() => manager.captureFromProfile(path.join(manager.essencesRoot, 'missing'), {}), /no package.json/)
})

test('essence manager: importBundle 整包往返（含引导/清单）且不覆盖新 meta', () => {
  const { manager } = makeFixture()
  const source = manager.create({ name: '源元主', defaultPatchEntries: [{ id: 'p1', name: '@x/p1' }] })
  const bundle = manager.downloadBundle(source.id, { full: true })
  assert.equal(bundle.full, true)
  assert.ok(bundle.files.some((file) => file.path === 'IMPORT-GUIDE.md'))
  assert.ok(bundle.files.some((file) => file.path === 'manifest.json'))
  const imported = manager.importBundle(bundle, { name: '导入元主' })
  assert.equal(imported.ok, true)
  assert.notEqual(imported.essence.id, source.id)
  assert.equal(imported.essence.name, '导入元主')
  const importedPatch = path.join(manager.essenceRoot(imported.essence.id), 'overlay', 'cordis.patch.yml')
  assert.equal(fs.existsSync(importedPatch), true, '导入后 overlay 必须存在')
  assert.equal(manager.getMeta(imported.essence.id).id, imported.essence.id, 'meta.json 不得被旧包覆盖')
})

test('essence manager: recomputeAll 在镜像指纹变化后批量更新', async () => {
  const { manager, profileDir } = makeFixture()
  const first = manager.create({ name: '原身E' })
  const second = manager.create({ name: '原身F' })
  const before = manager.getMeta(first.id).lastMergedFingerprint
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'mirror-profile', dependencies: { '@dsh/core': '^2.0.0', added: '^1.0.0' },
    settings: { ui: { theme: 'light', fontSize: 14 } },
  }, null, 2), 'utf8')
  const result = await manager.recomputeAll()
  assert.deepEqual(result.conflicted, [])
  assert.deepEqual(new Set(result.recomputed), new Set([first.id, second.id]))
  assert.deepEqual(result.failed, [])
  assert.equal(result.aborted, false)
  const mergedPkg = JSON.parse(fs.readFileSync(path.join(manager.mergedProfileDir(first.id), 'package.json'), 'utf8'))
  assert.equal(mergedPkg.dependencies.added, '^1.0.0')
  assert.notEqual(manager.getMeta(first.id).lastMergedFingerprint, before)
})
