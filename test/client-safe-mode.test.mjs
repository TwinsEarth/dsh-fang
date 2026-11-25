// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')

test('Safe Mode top banner carries reason and recovery checklist entry', () => {
  assert.match(client, /function renderSafeModeBanner\(S, app\)/)
  assert.match(client, /'data-zone': 'safe-mode-banner'/)
  assert.ok(client.includes('Safe Mode · 自动恢复已禁止'))
  assert.ok(client.includes('恢复前检查清单'))
  assert.match(client, /app\.reviewSafeMode\(\)/)
})

test('Safe Mode reset is gated by an explicit checklist modal', () => {
  assert.match(client, /function renderSafeModeModal\(S, app\)/)
  assert.ok(client.includes('解除 Safe Mode 前检查'))
  assert.ok(client.includes('页面文件 / Commit 余量已恢复'))
  assert.ok(client.includes('旧数据已迁移到规范数据根'))
  assert.ok(client.includes('已释放内存并确认没有运行中的分身'))
  assert.match(client, /required\.every\(\(key\) => checks\[key\] === true\)/)
  assert.match(client, /app\.confirmSafeModeReset\(\)/)
})

test('pagefile missing hard-blocks Safe Mode reset on both client and server', () => {
  assert.match(client, /const pagefileMissing = memory\?\.ok === true && \(memory\?\.hasPageFile !== true \|\| pageFileMB <= 0\)/)
  assert.match(client, /modal\.pagefileMissing === true/)
  assert.match(client, /页面文件缺失\/被禁用，不能解除/)
  assert.match(orchestrator, /resetSafeMode: async/)
  assert.match(orchestrator, /evaluateSafeModeReset\(memory, \{ hostCriticalFreeMB: cfg\.hostCriticalFreeMB \}\)/)
  assert.match(orchestrator, /error: 'pagefile-missing'/)
  assert.match(orchestrator, /const out = await service\.resetSafeMode\(\)/)
})

test('header Safe Mode action opens the checklist instead of resetting directly', () => {
  assert.match(client, /onClick: \(\) => app\.reviewSafeMode\(\),\n\s+fk: 'safe-mode-reset'/)
  assert.doesNotMatch(client, /button\('解除 Safe Mode'[\s\S]{0,260}?safe-mode\/reset/, 'header must not bypass the checklist')
})

test('migration report call site guards the optional client API', () => {
  assert.match(client, /typeof app\.openMigrationReport !== 'function'/)
  assert.match(client, /请单独上报 DSH 客户端 API 问题/)
})
