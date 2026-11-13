// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.34 回归：派生弹窗必须存在，且 5 秒未选择自动新建空会话。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('derive picker: auto-fallback window is exactly 5 seconds', () => {
  assert.match(client, /DERIVE_PICKER_TIMEOUT_MS = 5000/, 'picker timeout must be 5000 ms')
})

test('derive picker: shows a countdown and a new-empty-session escape hatch', () => {
  assert.match(client, /秒内不选择将默认新建空会话/, 'must tell the user what happens on timeout')
  assert.match(client, /新建空会话/, 'must offer an explicit empty-session button')
})

test('derive picker: timeout settles exactly once and calls onPick(null)', () => {
  const start = client.indexOf('function showDerivePicker')
  assert.ok(start > 0, 'showDerivePicker must exist')
  const body = client.slice(start, start + 4500)
  assert.match(body, /let settled = false/, 'must guard against double settle')
  assert.match(body, /const settle = \(value\) =>/, 'must centralise settling')
  assert.match(body, /if \(settled\) return/, 'settle must be idempotent')
  assert.match(body, /settle\(null\)/, 'timeout must fall back to an empty session')
  assert.match(body, /setInterval\(tick, 1000\)/, 'must tick the countdown every second')
  assert.match(body, /clearInterval/, 'must stop the timer when closed')
})

test('deriveQuick: null session derives without importing any mother session', () => {
  const start = client.indexOf('async function deriveQuick()')
  assert.ok(start > 0, 'deriveQuick must exist')
  const body = client.slice(start, start + 5000)
  assert.match(body, /const emptySession = !sessionId/, 'must detect the empty-session path')
  assert.match(body, /if \(!emptySession\) payload\.importSession/, 'must only import when a session was picked')
  assert.match(body, /已派生分身（空会话）/, 'must report the empty-session outcome distinctly')
})
