// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.6 — 元主 CRUD：rename/archive/default/copy/pluginCount/download（凭据永不导出/复制）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { EssenceManager, OFFICIAL_ESSENCE_ID } from '../src/lib/essence.mjs'
import { tmpDir } from './helpers.mjs'

function makeFixture() {
  const root = tmpDir('fang-essence-crud-')
  const mirrorRoot = path.join(root, 'mirror')
  const profileDir = path.join(mirrorRoot, 'active', 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'mirror', dependencies: {} }), 'utf8')
  fs.writeFileSync(path.join(mirrorRoot, 'meta.json'), JSON.stringify({ version: '3.0.6' }), 'utf8')
  const essencesRoot = path.join(root, 'essences')
  fs.mkdirSync(essencesRoot, { recursive: true })
  return { root, essencesRoot, manager: new EssenceManager({ essencesRoot, mirrorRoot }) }
}

test('v3.0.6: rename 生效；locked 官方原身拒绝', () => {
  const { manager } = makeFixture()
  const meta = manager.create({ name: '旧名', tier: 'vip100' })
  assert.equal(manager.rename(meta.id, '  新名  ').name, '新名')
  manager.ensureOfficialEssence()
  assert.throws(() => manager.rename(OFFICIAL_ESSENCE_ID, '篡改'), /locked/)
  assert.throws(() => manager.rename(meta.id, ''), /1\.\.80/)
})

test('v3.0.6: archive/取消归档只改元数据，不删目录', () => {
  const { manager, essencesRoot } = makeFixture()
  const meta = manager.create({ name: '待归档', tier: 'vip100' })
  const archived = manager.archive(meta.id, true)
  assert.equal(archived.archived, true)
  assert.ok(archived.archivedAt)
  assert.equal(fs.existsSync(path.join(essencesRoot, meta.id, 'meta.json')), true)
  const restored = manager.archive(meta.id, false)
  assert.equal(restored.archived, false)
  assert.equal(restored.archivedAt, null)
})

test('v3.0.6: default essence 设置/读取/官方兜底', () => {
  const { manager } = makeFixture()
  manager.ensureOfficialEssence()
  assert.equal(manager.getDefault().essenceId, OFFICIAL_ESSENCE_ID)
  const regular = manager.create({ name: '我的元主', tier: 'vip100' })
  assert.deepEqual(manager.setDefault(regular.id), { essenceId: regular.id, name: '我的元主' })
  assert.equal(manager.getDefault().essenceId, regular.id)
  assert.equal(manager.getDefault().official, false)
})

test('v3.0.6: copy 复制配置但不复制 credentials', () => {
  const { manager, essencesRoot } = makeFixture()
  const source = manager.create({ name: '源元主', tier: 'vip100' })
  const credentialsDir = path.join(essencesRoot, source.id, 'overlay', 'credentials')
  fs.writeFileSync(path.join(credentialsDir, 'secret.json'), '{"secret":true}', 'utf8')
  const copied = manager.copy(source.id, { name: '副本元主' })
  assert.notEqual(copied.id, source.id)
  assert.equal(copied.name, '副本元主')
  assert.equal(copied.locked, false)
  const mergedDir = manager.mergedProfileDir(copied.id)
  assert.equal(fs.existsSync(path.join(mergedDir, 'credentials')), false, '凭据不得进入副本 merged/profile')
  const copiedOverlay = path.join(essencesRoot, copied.id, 'overlay', 'credentials')
  assert.equal(fs.existsSync(path.join(copiedOverlay, 'secret.json')), false, '凭据不得被复制到 overlay')
})

test('v3.0.6: pluginCount 与 downloadBundle 只导出 overlay 且不含凭据', async () => {
  const { manager, essencesRoot } = makeFixture()
  const meta = manager.create({ name: '导出', tier: 'vip100' })
  await manager.update(meta.id, (overlay) => { overlay.patchEntries.push({ id: 'demo', name: '/demo.ts' }) })
  const token = path.join(essencesRoot, meta.id, 'overlay', 'credentials', 'token.json')
  fs.writeFileSync(token, '{"token":"secret"}', 'utf8')
  const bundle = manager.downloadBundle(meta.id)
  assert.equal(bundle.ok, true)
  assert.ok(bundle.files.some((file) => file.path.endsWith('cordis.patch.yml')))
  assert.equal(bundle.files.some((file) => file.path.includes('credentials')), false)
  assert.ok(bundle.bytes > 0)
  assert.equal(manager.pluginCount(meta.id), 1)
})
