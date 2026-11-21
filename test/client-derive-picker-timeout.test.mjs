// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.34 回归：派生弹窗必须存在，且超时未选择自动新建空会话。
// 2026-11-21：兜底倒计时由 5 秒改为 7 秒；列表只列最近 7 天活跃会话，更早的折叠；页脚提示行移除。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('derive picker: auto-fallback window is exactly 7 seconds', () => {
  assert.match(client, /DERIVE_PICKER_TIMEOUT_MS = 7000/, 'picker timeout must be 7000 ms')
})

test('derive picker: shows a countdown and a new-empty-session escape hatch', () => {
  assert.match(client, /秒内不选择将默认新建空会话/, 'must tell the user what happens on timeout')
  assert.match(client, /新建空会话/, 'must offer an explicit empty-session button')
})

test('derive picker: timeout settles exactly once and calls onPick(null)', () => {
  const start = client.indexOf('function showDerivePicker')
  assert.ok(start > 0, 'showDerivePicker must exist')
  const body = client.slice(start, start + 6500)
  assert.match(body, /let settled = false/, 'must guard against double settle')
  assert.match(body, /const settle = \(value\) =>/, 'must centralise settling')
  assert.match(body, /if \(settled\) return/, 'settle must be idempotent')
  assert.match(body, /settle\(null\)/, 'timeout must fall back to an empty session')
  assert.match(body, /setInterval\(tick, 1000\)/, 'must tick the countdown every second')
  assert.match(body, /clearInterval/, 'must stop the timer when closed')
})

test('derive picker: default list is the 7-day active window, older sessions folded', () => {
  assert.match(client, /DERIVE_ACTIVE_WINDOW_MS = 7 \* 24 \* 60 \* 60 \* 1000/, 'active window must be 7 days')
  assert.match(client, /function splitSessionsByRecency/, 'must split recent vs older sessions')
  assert.match(client, /derive-older-sessions/, 'older sessions must live in a collapsible container')
  assert.match(client, /更早的会话（/, 'collapsed label must explain the fold')
  assert.match(client, /<details|h\('details'/, 'fold must be a closed-by-default details element')
})

test('panel footer hint line was removed (2026-11-21)', () => {
  assert.doesNotMatch(client, /双击「瓮城」图标或输入框徽标/, 'long footer hint must be gone')
  assert.doesNotMatch(client, /renderFooter\(/, 'footer renderer must be gone')
  assert.doesNotMatch(client, /刷新于 \$\{fmtClock/, 'footer refresh timestamp must be gone')
})

test('deriveQuick: null session derives without importing any mother session', () => {
  const start = client.indexOf('async function deriveQuick()')
  assert.ok(start > 0, 'deriveQuick must exist')
  const body = client.slice(start, start + 5000)
  assert.match(body, /const emptySession = !sessionId/, 'must detect the empty-session path')
  assert.match(body, /if \(!emptySession\) payload\.importSession/, 'must only import when a session was picked')
  assert.match(body, /已派生分身（空会话）/, 'must report the empty-session outcome distinctly')
})
