// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')

test('quarantined task card offers an explicit restart-and-unquarantine action', () => {
  assert.match(client, /function restartQuarantinedTask\(task\)/)
  assert.ok(client.includes('重启并解除隔离'))
  assert.ok(client.includes('旧页面/旧 token 失效'))
  assert.match(client, /task\.quarantined \? button\('重启并解除隔离'/)
  assert.match(client, /task\.quarantined \? null : button\(task\.memoryGuard \? '重新打开' : '打开'/)
})

test('quarantined state is distinct and start action is not duplicated', () => {
  assert.match(client, /if \(task\?\.quarantined\) return \{ key: 'quarantined', label: '已隔离'/)
  assert.match(client, /stateView\.key !== 'running' && !task\.quarantined \? button\('启动'/)
})

test('restore response explicitly reports token rotation and quarantine clear', () => {
  assert.match(orchestrator, /tokenRotated: true, quarantineCleared: wasQuarantined/)
  assert.match(orchestrator, /fork-quarantine-cleared.*tokenRotated: true/)
})

test('endpoint discovery carries pid/instance identity and every Fang response exposes it', () => {
  assert.match(orchestrator, /pid: process\.pid/)
  assert.match(orchestrator, /instanceId/)
  assert.match(orchestrator, /pid: process\.pid,\s*instanceId/)
  assert.match(orchestrator, /x-fang-instance/)
})
