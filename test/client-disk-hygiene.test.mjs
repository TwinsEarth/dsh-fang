// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('disk hygiene banner is gated by a real cache threshold and opens the modal', () => {
  assert.match(source, /function renderDiskHygieneBanner\(S, app\)/)
  assert.match(source, /cacheBytes < 256 \* 1024 \* 1024/)
  assert.match(source, /openDiskHygiene\(\)/)
  assert.match(source, /data-zone': 'disk-hygiene-banner'/)
})

test('disk hygiene modal separates browser cache from the Windows Search index', () => {
  assert.match(source, /function renderDiskHygieneModal\(S, app\)/)
  assert.match(source, /Cookies、登录态、Local Storage 不会被移动/)
  assert.match(source, /windows\.db 是 Windows Search 系统数据库/)
  assert.match(source, /不要直接删除 windows\.db/)
  assert.match(source, /kind === 'diskHygiene'/)
})

test('browser cache cleanup stays explicit and confirmation-gated', () => {
  assert.match(source, /async function cleanupBrowserCache\(taskId\)/)
  assert.match(source, /window\.confirm/)
  assert.match(source, /confirm: true/)
  assert.match(source, /row\.status === 'archived'/)
})
