// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')

test('pagefile missing renders a persistent red banner independent of Safe Mode', () => {
  assert.match(client, /function renderPagefileBanner\(S, app\)/)
  assert.match(client, /memory\.hasPageFile === true && Number\(memory\.pageFileMB\) > 0/)
  assert.match(client, /'data-zone': 'pagefile-banner'/)
  assert.ok(client.includes('页面文件缺失 · 宿主随时可能 OOM'))
  assert.match(client, /function renderNotices\(S, app\)[\s\S]{0,80}renderPagefileBanner/)
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
