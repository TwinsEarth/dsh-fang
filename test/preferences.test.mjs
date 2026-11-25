// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 — schema 驱动偏好：默认值/迁移/校验/未知字段/损坏回退/step 对齐。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  PREFERENCES_KEYS, PREFERENCES_SCHEMA, PreferencesStore,
  buildDefaultPreferences, normalizePreferences,
} from '../src/lib/preferences.mjs'
import { tmpDir } from './helpers.mjs'

function makeStore() {
  const root = tmpDir('fang-prefs-')
  const mirrorRoot = path.join(root, 'mirror')
  fs.mkdirSync(mirrorRoot, { recursive: true })
  return { mirrorRoot, store: new PreferencesStore({ mirrorRoot }) }
}

test('preferences schema: 字段与默认值', () => {
  assert.deepEqual([...PREFERENCES_KEYS].sort(), [
    'activeIdleTimeoutMs', 'backupRetentionDays', 'idleDowngradeNotification',
    'idlePollIntervalMs', 'pollIntervalMs', 'strictConflictMode', 'syncIntervalHours',
  ])
  const defaults = buildDefaultPreferences()
  assert.equal(defaults.activeIdleTimeoutMs, 30_000)
  assert.equal(defaults.syncIntervalHours, 'off')
  assert.equal(defaults.pollIntervalMs, 5_000)
  assert.equal(defaults.idlePollIntervalMs, 60_000)
  assert.equal(defaults.backupRetentionDays, 30)
  assert.equal(defaults.idleDowngradeNotification, 'silent')
  assert.equal(defaults.strictConflictMode, false)
})

test('preferences: 文件缺失 → 全部默认值并写回', () => {
  const { store, mirrorRoot } = makeStore()
  const loaded = store.load()
  assert.deepEqual(loaded, buildDefaultPreferences())
  assert.equal(fs.existsSync(path.join(mirrorRoot, 'preferences.json')), true)
})

test('preferences: 合法文件完整读回；旧文件缺新字段自动补默认', () => {
  const { store, mirrorRoot } = makeStore()
  fs.writeFileSync(path.join(mirrorRoot, 'preferences.json'), JSON.stringify({
    activeIdleTimeoutMs: 15_000, backupRetentionDays: 7,
  }), 'utf8')
  const loaded = store.load()
  assert.equal(loaded.activeIdleTimeoutMs, 15_000)
  assert.equal(loaded.backupRetentionDays, 7)
  assert.equal(loaded.pollIntervalMs, 5_000)
  const written = JSON.parse(fs.readFileSync(path.join(mirrorRoot, 'preferences.json'), 'utf8'))
  assert.equal(written.pollIntervalMs, 5_000)
})

test('preferences: 未知字段丢弃并写回', () => {
  const { mirrorRoot } = makeStore()
  fs.writeFileSync(path.join(mirrorRoot, 'preferences.json'), JSON.stringify({
    activeIdleTimeoutMs: 15_000, unknownField: 'x',
  }), 'utf8')
  const report = normalizePreferences(JSON.parse(fs.readFileSync(path.join(mirrorRoot, 'preferences.json'), 'utf8')))
  assert.deepEqual(report.droppedUnknown, ['unknownField'])
  const store = new PreferencesStore({ mirrorRoot })
  store.load()
  const written = JSON.parse(fs.readFileSync(path.join(mirrorRoot, 'preferences.json'), 'utf8'))
  assert.equal(written.unknownField, undefined)
  assert.equal(written.activeIdleTimeoutMs, 15_000)
})

test('preferences: 旧值 migrate / 越界 → 默认值并报告 migrated', () => {
  const { store, mirrorRoot } = makeStore()
  fs.writeFileSync(path.join(mirrorRoot, 'preferences.json'), JSON.stringify({
    activeIdleTimeoutMs: 45_000, pollIntervalMs: 999_999,
  }), 'utf8')
  const loaded = store.load()
  assert.equal(loaded.activeIdleTimeoutMs, 30_000)
  assert.equal(loaded.pollIntervalMs, 5_000)
  const report = normalizePreferences({ activeIdleTimeoutMs: 45_000, pollIntervalMs: 999_999 })
  assert.ok(report.migrated.includes('activeIdleTimeoutMs'))
  assert.ok(report.migrated.includes('pollIntervalMs'))
})

test('preferences: 损坏 JSON 返回默认值且不覆盖原文件', () => {
  const { store, mirrorRoot } = makeStore()
  const broken = '{ not json'
  fs.writeFileSync(path.join(mirrorRoot, 'preferences.json'), broken, 'utf8')
  assert.deepEqual(store.load(), buildDefaultPreferences())
  assert.equal(fs.readFileSync(path.join(mirrorRoot, 'preferences.json'), 'utf8'), broken)
})

test('preferences: update 校验、step 对齐、越界拒绝、未知字段忽略', () => {
  const { store, mirrorRoot } = makeStore()
  store.load()
  const next = store.update({ activeIdleTimeoutMs: 32_345, backupRetentionDays: 60 })
  assert.equal(next.activeIdleTimeoutMs, 30_000) // step 5000 对齐
  assert.equal(next.backupRetentionDays, 60)
  const written = JSON.parse(fs.readFileSync(path.join(mirrorRoot, 'preferences.json'), 'utf8'))
  assert.equal(written.backupRetentionDays, 60)
  assert.throws(() => store.update({ activeIdleTimeoutMs: 1 }), /invalid value/)
  assert.throws(() => store.update({ idleDowngradeNotification: 'nope' }), /invalid value/)
  assert.equal(store.get().activeIdleTimeoutMs, 30_000)
  assert.deepEqual(store.update({ notAField: 'x' }), store.get())
})

test('preferences: enum 选项校验通过', () => {
  const { store } = makeStore()
  store.load()
  assert.equal(store.update({ idleDowngradeNotification: 'toast' }).idleDowngradeNotification, 'toast')
  assert.equal(store.update({ strictConflictMode: true }).strictConflictMode, true)
  assert.equal(store.update({ pollIntervalMs: 3_000 }).pollIntervalMs, 3_000)
})

test('preferences: 自定义 schema 也能驱动默认值与校验', () => {
  const schema = {
    flag: { kind: 'boolean', defaultValue: true },
    mode: { kind: 'enum', defaultValue: 'a', options: [{ value: 'a', label: 'A' }] },
  }
  const normalized = normalizePreferences({ mode: 'b', extra: 1 }, schema)
  assert.deepEqual(normalized.preferences, { flag: true, mode: 'a' })
  assert.deepEqual(normalized.droppedUnknown, ['extra'])
  assert.throws(() => {
    const root = tmpDir('fang-prefs-custom-')
    const store = new PreferencesStore({ mirrorRoot: root, schema })
    store.load()
    store.update({ flag: 'yes' })
  }, /invalid value/)
})
