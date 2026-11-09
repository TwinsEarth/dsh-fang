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

test('fang-home.txt 无效指针（指向普通文件/不存在盘）回退本机布局，不阻塞启动', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ptr-bad-')), '.dsh')
  const bogusTarget = path.join(home, 'not-a-dir.txt')
  fs.mkdirSync(path.join(home, 'fang'), { recursive: true })
  fs.writeFileSync(bogusTarget, 'x', 'utf8')
  fs.writeFileSync(path.join(home, 'fang', 'fang-home.txt'), bogusTarget + '\n', 'utf8')
  const layout = resolveFangLayout({ env: { DSH_HOME: home, DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(layout.fangHome, '')
  assert.equal(layout.dataDir, path.join(home, 'fang', 'desktop'))

  // 不存在盘符（Z: 在本机不存在时）同样忽略；存在则跳过该断言。
  const missingRoot = path.parse('Z:\\').root
  if (!fs.existsSync(missingRoot)) {
    fs.writeFileSync(path.join(home, 'fang', 'fang-home.txt'), 'Z:\\fang-poison\n', 'utf8')
    const fallback = resolveFangLayout({ env: { DSH_HOME: home, DSH_PROFILE: 'desktop' }, argv: [] })
    assert.equal(fallback.fangHome, '')
  }
})

test('without FANG_HOME: legacy data keeps legacy layout, fresh install defaults to D:/ToFuture', () => {
  // 旧布局已有数据 → 不搬家
  const legacyHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fang-legacy-')), '.dsh')
  fs.mkdirSync(path.join(legacyHome, 'fang', 'desktop'), { recursive: true })
  const legacy = resolveFangLayout({ env: { DSH_HOME: legacyHome, DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(legacy.fangHome, '')
  assert.equal(legacy.dataDir, path.join(legacyHome, 'fang', 'desktop'))

  // 显式 DSH_HOME（e2e/测试/便携）→ 保持旧布局，不自动跳 D:\ToFuture
  const freshHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fang-fresh-')), '.dsh')
  const fresh = resolveFangLayout({ env: { DSH_HOME: freshHome, DSH_PROFILE: 'desktop' }, argv: [] })
  assert.equal(fresh.fangHome, '')
  assert.equal(fresh.dataDir, path.join(freshHome, 'fang', 'desktop'))
})
