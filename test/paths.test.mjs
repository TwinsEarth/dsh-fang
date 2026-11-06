// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { resolveFangHome, resolveFangLayout } from '../src/kernel/paths.mjs'

test('FANG_HOME gives D:/fang mirror/essence/sessions layout', () => {
  const layout = resolveFangLayout({ env: { FANG_HOME: 'D:/fang', DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(layout.fangHome, path.resolve('D:/fang'))
  assert.equal(layout.dataDir, path.resolve('D:/fang/mirror/desktop'))
  assert.equal(layout.essenceRoot, path.resolve('D:/fang/essence'))
  assert.equal(layout.forkHomesDir, path.resolve('D:/fang/forks'))
  assert.equal(layout.runtimeRoot, path.resolve('D:/fang/sessions'))
  assert.equal(layout.sessionsRoot, path.resolve('D:/fang/sessions'))
  assert.equal(layout.forksFile, path.join(layout.dataDir, 'forks.json'))
})

test('fang-home.txt 迁移指针优先于旧布局（无需改环境变量）', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ptr-')), '.dsh')
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ptr-target-')), 'Future')
  fs.mkdirSync(path.join(home, 'fang'), { recursive: true })
  fs.writeFileSync(path.join(home, 'fang', 'fang-home.txt'), target + '\n', 'utf8')
  const layout = resolveFangLayout({ env: { DSH_HOME: home, DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(layout.fangHome, path.resolve(target))
  assert.equal(layout.dataDir, path.join(path.resolve(target), 'mirror', 'desktop'))
  assert.equal(layout.essenceRoot, path.join(path.resolve(target), 'essence'))
})

test('without FANG_HOME: legacy data keeps legacy layout, fresh install defaults to D:/ToFuture', () => {
  // 旧布局已有数据 → 不搬家
  const legacyHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fang-legacy-')), '.dsh')
  fs.mkdirSync(path.join(legacyHome, 'fang', 'desktop'), { recursive: true })
  const legacy = resolveFangLayout({ env: { DSH_HOME: legacyHome, DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(legacy.fangHome, '')
  assert.equal(legacy.dataDir, path.join(legacyHome, 'fang', 'desktop'))

  // 全新环境：Windows 且有 D: → 默认主文件夹 D:\ToFuture；否则保持旧布局
  const freshHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fang-fresh-')), '.dsh')
  const fresh = resolveFangLayout({ env: { DSH_HOME: freshHome, DSH_PROFILE: 'desktop' }, argv: [] })
  const expected = process.platform === 'win32' && fs.existsSync('D:\\') ? path.resolve('D:\\ToFuture') : ''
  assert.equal(fresh.fangHome, expected)
  if (expected) {
    assert.equal(fresh.dataDir, path.join(expected, 'mirror', 'desktop'))
    assert.equal(fresh.essenceRoot, path.join(expected, 'essence'))
  } else {
    assert.equal(fresh.dataDir, path.join(freshHome, 'fang', 'desktop'))
  }
})
