// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 2026-11-22：母体面板「分身状态栏」= 4 态（运行中/等待启动/已停止/故障）+ 2 操作（启动/一键修复）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
const compat = fs.readFileSync(new URL('../src/lib/compat.mjs', import.meta.url), 'utf8')

test('fork status bar: four states and two actions are present', () => {
  for (const label of ['运行中', '等待启动', '已停止', '故障']) {
    assert.ok(client.includes(label), `missing state label: ${label}`)
  }
  assert.match(client, /function forkStateOf\(task\)/)
  assert.match(client, /class: 'fork-status'/)
  assert.match(client, /app\.repairTask\(task\)/)
  assert.match(client, /app\.restoreTask\(task\)/)
  assert.ok(client.includes('一键修复'), 'one-click repair action must be rendered')
})

test('repair endpoint + service are wired (no new dependency)', () => {
  assert.match(client, /\/fang\/api\/tasks\/repair/)
  assert.match(orchestrator, /async repairTask\(taskId\)/)
  assert.match(orchestrator, /\$\{prefix\}\/api\/tasks\/repair/)
  assert.match(orchestrator, /pruneAliasStubs\(profileDir\)/)
  assert.match(orchestrator, /task-repaired/)
  assert.match(compat, /DEFAULT_EXPECTED_ROUTE_COUNT = 87/)
})
