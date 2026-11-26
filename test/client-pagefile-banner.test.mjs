// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')

test('v3.9.4: pagefile missing renders a closable advisory, never a forced single-fork banner', () => {
  assert.match(client, /function renderPagefileBanner\(S, app\)/)
  assert.match(client, /memory\.pagefileMissing === true/)
  assert.match(client, /memory\.pagingFilesEmpty === true/)
  assert.match(client, /memory\.commitLimitNearRam === true/)
  assert.match(client, /'data-zone': 'pagefile-banner'/)
  assert.ok(client.includes('未启用页面文件 · 仅提醒，不限制分身'))
  assert.equal(client.includes('已强制单分身'), false)
  assert.match(client, /pagefile-dismiss/)
  assert.match(client, /app\.armNotice\?\.\('banner:pagefile'/)
  assert.match(client, /function renderNotices\(S, app\)[\s\S]{0,300}renderPagefileBanner/)
  assert.doesNotMatch(client, /function renderPagefileBanner\(S, app\)[\s\S]{0,300}safeMode/)
})

test('pagefile banner offers a one-click repair explanation and a fresh probe', () => {
  assert.match(client, /app\.openPagefileHelp\(\)/)
  assert.match(client, /app\.probeMemory\(\)/)
  assert.match(client, /function renderPagefileModal\(S, app\)/)
  assert.ok(client.includes('自动管理所有驱动器的分页文件大小'))
  assert.ok(client.includes('Get-CimInstance Win32_PageFileUsage'))
  assert.match(client, /S\.modal\.kind === 'pagefile'/)
})

test('orchestrator exposes a memory snapshot and a manual probe route', () => {
  assert.match(orchestrator, /let memorySnapshot = null/)
  assert.match(orchestrator, /function rememberMemory|const rememberMemory/)
  assert.match(orchestrator, /memory: memorySnapshot,/)
  assert.match(orchestrator, /probeMemory: async \(\) =>/)
  assert.match(orchestrator, /api\/memory\/probe/)
})
