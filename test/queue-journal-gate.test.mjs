// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.3.3: queue-journal 默认禁用时的能力门控：
//   * host 行 disabled 时 boot-guard 不因可选包缺失阻塞；
//   * host half 只有 apply 后才提供 fangQueueJournal；
//   * 主包行默认 disabled（UI 不会由该 client 注册）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readBundleRows, checkBundleRows } from '../src/lib/boot-guard.mjs'
import { apply as queueApply, version as queueVersion } from '../queue-journal/index.js'

const ROOT = path.resolve(import.meta.dirname, '..')

test('queue-journal host half provides fangQueueJournal only after apply()', () => {
  const provided = new Map()
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { try { dispose?.() } catch { /* ignore */ } } },
    provide(name, service) { provided.set(name, service); return () => provided.delete(name) },
  }
  const service = queueApply(ctx)
  assert.equal(queueVersion, '0.1.7')
  assert.equal(service.recoveryOnly, true)
  assert.equal(provided.get('fangQueueJournal')?.version, '0.1.7')
  assert.equal(provided.get('fangQueueJournal')?.capability, 'queueJournal')
})

test('main bundle disables the queue-journal row by default', () => {
  const parsed = readBundleRows(ROOT)
  const row = parsed.rows.find((item) => item.id === 'fang-queue-journal')
  assert.ok(row, 'fang-queue-journal row must stay in the bundle')
  assert.equal(row.disabled, true, 'queue journal must be off by default')
})

test('boot-guard skips disabled rows instead of blocking on an optional missing package', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-queue-gate-'))
  const profile = path.join(home, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', private: true }))
  try {
    const disabledOnly = checkBundleRows([
      { id: 'fang-queue-journal', name: '@twinsearth/dsh-fang-queue-journal', disabled: true },
    ], { profileDir: profile, ownPackage: '@twinsearth/fang-dsh-plugin' })
    assert.equal(disabledOnly.ok, true, 'a disabled optional row must not block boot')
    assert.equal(disabledOnly.findings.some((finding) => finding.id === 'fang-queue-journal'), false)
    assert.equal(disabledOnly.checked, 0)
    const mixed = checkBundleRows([
      { id: 'fang-queue-journal', name: '@twinsearth/dsh-fang-queue-journal', disabled: true },
      { id: 'fang-good', name: '@twinsearth/fang-dsh-plugin', disabled: false },
    ], { profileDir: profile, ownPackage: '@twinsearth/fang-dsh-plugin' })
    assert.equal(mixed.findings.some((finding) => finding.id === 'fang-queue-journal'), false)
    assert.equal(mixed.findings.some((finding) => finding.id === 'fang-good'), true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
