// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.4 — 官方推荐原身：seed 幂等、锁定保护、默认插件注入、列表可见。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_OFFICIAL_PATCH_ENTRIES,
  OFFICIAL_ESSENCE_ID,
  OFFICIAL_ESSENCE_NAME,
  EssenceManager,
  parsePatchEntries,
} from '../src/lib/essence.mjs'
import { tmpDir } from './helpers.mjs'

function makeFixture() {
  const root = tmpDir('fang-official-')
  const mirrorRoot = path.join(root, 'mirror')
  const profileDir = path.join(mirrorRoot, 'active', 'profile')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'mirror', dependencies: {} }), 'utf8')
  fs.writeFileSync(path.join(mirrorRoot, 'meta.json'), JSON.stringify({ version: '3.0.4' }), 'utf8')
  const essencesRoot = path.join(root, 'essences')
  fs.mkdirSync(essencesRoot, { recursive: true })
  const manager = new EssenceManager({ essencesRoot, mirrorRoot })
  return { root, mirrorRoot, essencesRoot, manager }
}

test('official essence: 首次 seed 创建锁定原身，重复调用幂等', () => {
  const { manager } = makeFixture()
  const first = manager.ensureOfficialEssence()
  assert.equal(first.id, OFFICIAL_ESSENCE_ID)
  assert.equal(first.name, OFFICIAL_ESSENCE_NAME)
  assert.equal(first.locked, true)
  assert.equal(first.official, true)
  assert.equal(first.status, 'ready')

  const second = manager.ensureOfficialEssence()
  assert.equal(second.id, first.id)
  assert.equal(manager.list().filter(meta => meta.id === OFFICIAL_ESSENCE_ID).length, 1)
})

test('official essence: 默认插件条目写入 overlay 并出现在 merged profile', () => {
  const { manager, essencesRoot } = makeFixture()
  manager.ensureOfficialEssence()
  const overlayPatch = fs.readFileSync(path.join(essencesRoot, OFFICIAL_ESSENCE_ID, 'overlay', 'cordis.patch.yml'), 'utf8')
  const overlay = parsePatchEntries(overlayPatch)
  assert.deepEqual(
    overlay.entries.map(entry => entry.id),
    DEFAULT_OFFICIAL_PATCH_ENTRIES.map(entry => entry.id),
  )
  const mergedPatch = fs.readFileSync(path.join(manager.mergedProfileDir(OFFICIAL_ESSENCE_ID), 'cordis.patch.yml'), 'utf8')
  const merged = parsePatchEntries(mergedPatch)
  assert.ok(merged.entries.some(entry => entry.name === 'dshmarket' && entry.disabled !== true))
  assert.ok(merged.entries.some(entry => entry.name === '@twinsearth/dsh-fang' && entry.disabled !== true))
  assert.ok(merged.entries.some(entry => entry.name === '@twinsearth/dsh-2xray' && entry.disabled === true))
  assert.ok(merged.entries.some(entry => entry.name === '@liustack/modsearch' && entry.disabled === true))
  assert.equal(merged.entries.filter(entry => entry.disabled === true).length, 6)
  assert.equal(merged.entries.filter(entry => entry.disabled !== true).length, 5)
})

test('official essence: 锁定后 update/remove/setTier 都被拒绝', async () => {
  const { manager } = makeFixture()
  manager.ensureOfficialEssence()
  await assert.rejects(() => manager.update(OFFICIAL_ESSENCE_ID, () => {}), /locked/)
  assert.throws(() => manager.remove(OFFICIAL_ESSENCE_ID), /locked/)
  assert.throws(() => manager.setTier(OFFICIAL_ESSENCE_ID, 'free'), /locked/)
})

test('official essence: 普通原身不受锁定影响', async () => {
  const { manager } = makeFixture()
  manager.ensureOfficialEssence()
  const normal = manager.create({ name: '普通原身', tier: 'vip100' })
  assert.equal(normal.locked, false)
  await manager.update(normal.id, (overlay) => { overlay.patchEntries.push({ id: 'x', name: '/x.ts' }) })
  manager.setTier(normal.id, 'vip30')
  assert.equal(manager.getMeta(normal.id).tier, 'vip30')
  assert.equal(manager.remove(normal.id).removed, true)
})

test('official essence: 自定义默认插件条目可覆盖 seed 内容', () => {
  const { manager } = makeFixture()
  const meta = manager.ensureOfficialEssence({ defaultPatchEntries: [{ id: 'only-one', name: '/only.ts' }] })
  assert.equal(meta.id, OFFICIAL_ESSENCE_ID)
  const merged = fs.readFileSync(path.join(manager.mergedProfileDir(OFFICIAL_ESSENCE_ID), 'cordis.patch.yml'), 'utf8')
  const entries = parsePatchEntries(merged).entries
  assert.deepEqual(entries.map(entry => entry.id), ['only-one'])
})
