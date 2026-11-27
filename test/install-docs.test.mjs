// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('README indexes the v3.8.2 migration guide and key docs', () => {
  const readme = read('README.md')
  assert.match(readme, /当前发布线：\*\*v3\.9\.9\*\*/)
  assert.match(readme, /## 升级到 v3\.8\.2（数据根迁移，必读）/)
  assert.match(readme, /node tools\/migrate-fang-home\.mjs --apply/)
  assert.match(readme, /docs\/INSTALL\.md/)
  assert.match(readme, /## 文档索引/)
  assert.match(readme, /docs\/ERROR-BOOK\.md/)
  assert.match(readme, /docs\/HOST-SMOKE\.md/)
})

test('installation guide covers stop-host, migration, report and formal-entry acceptance', () => {
  const guide = read('docs/INSTALL.md')
  assert.match(guide, /宿主运行中禁止执行迁移或替换 profile/)
  assert.match(guide, /node tools\/migrate-fang-home\.mjs --apply/)
  assert.match(guide, /_migration\\migration-<stamp>\.json/)
  assert.match(guide, /数据迁移报告/)
  assert.match(guide, /正式开始菜单入口/)
  assert.match(guide, /node tools\/release\/deploy-profile\.mjs --check/)
})

test('host smoke doc records real-host assertions, evidence and limits', () => {
  const guide = read('docs/HOST-SMOKE.md')
  assert.match(guide, /只有一个/)
  assert.match(guide, /watchdog sidecar 是该宿主的子进程/)
  assert.match(guide, /primary-runtime/)
  assert.match(guide, /data-fang-overlays="visible"/)
  assert.match(guide, /PID 7132/)
  assert.match(guide, /PID 13296/)
  assert.match(guide, /17 项检查全部 PASS/)
})

test('install guide is included in the npm package file allowlist', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.files.includes('docs/INSTALL.md'))
  assert.ok(pkg.files.includes('docs/HOST-SMOKE.md'))
  assert.ok(pkg.files.includes('tools/release/host-boot-smoke.mjs'))
})


