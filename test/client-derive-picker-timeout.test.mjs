// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.34 回归：派生弹窗必须存在，且超时未选择自动新建空会话。
// 2026-11-21：倒计时 7 秒；三分组（最近 7 天活跃 → 已归档灰显只读 → 更早折叠，归档优先于时间）；页脚提示行移除。
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
  const body = client.slice(start, start + 9000)
  assert.match(body, /let settled = false/, 'must guard against double settle')
  assert.match(body, /const settle = \(value\) =>/, 'must centralise settling')
  assert.match(body, /if \(settled\) return/, 'settle must be idempotent')
  assert.match(body, /settle\(null\)/, 'timeout must fall back to an empty session')
  assert.match(body, /setInterval\(tick, 1000\)/, 'must tick the countdown every second')
  assert.match(body, /clearInterval/, 'must stop the timer when closed')
})

test('derive picker: three mutually-exclusive groups ordered recent → archived → older', () => {
  assert.match(client, /DERIVE_ACTIVE_WINDOW_MS = 7 \* 24 \* 60 \* 60 \* 1000/, 'active window must be 7 days')
  assert.match(client, /function splitSessionsForDerive/, 'must classify sessions into the three groups')
  // 分类优先级：归档优先于时间 → 归档一律进第 2 组，不参与 7 天/更早的时间分组。
  const start = client.indexOf('function splitSessionsForDerive')
  const body = client.slice(start, client.indexOf('function sessionOption'))
  assert.ok(body.length > 0, 'splitSessionsForDerive body must be found')
  const archivedIndex = body.indexOf('archived.push')
  const recentIndex = body.indexOf('recent.push')
  assert.ok(archivedIndex > 0 && recentIndex > archivedIndex, 'archived must be classified before the 7-day window')
  // 第 1 组：最近 7 天活跃，可选。
  assert.match(body, /recent\.push/, 'recent group must exist')
  // 第 2 组：已归档，单独折叠 + 灰色 + 不可选。
  assert.match(client, /derive-archived-sessions/, 'archived group must be its own fold')
  assert.match(client, /已归档会话（/, 'archived fold needs a labeled summary')
  assert.match(client, /不可选择/, 'archived fold must say it is not selectable')
  assert.match(client, /disabled: true/, 'archived select must be disabled (gray, unselectable)')
  // 第 3 组：更早（超 7 天、未归档），折叠但可选。
  assert.match(client, /derive-older-sessions/, 'older group must be a fold')
  assert.match(client, /更早的会话（/, 'older fold needs a labeled summary')
  // 两处派生入口都必须请求归档会话，否则第 2 组永远为空。
  assert.equal((client.match(/\/fang\/api\/sessions\?[^'"`\n]*includeArchived=1/g) || []).length, 2, 'both derive entry points must request archived sessions')
  // 派生入口不得提前按 archived 过滤：分类必须发生在弹窗内。
  assert.doesNotMatch(client, /res\.body\.sessions\.filter\(\(session\) => session\.archived !== true\)/)
})

test('panel footer hint line was removed (2026-11-21)', () => {
  assert.doesNotMatch(client, /双击「瓮城」图标或输入框徽标/, 'long footer hint must be gone')
  assert.doesNotMatch(client, /renderFooter\(/, 'footer renderer must be gone')
  assert.doesNotMatch(client, /刷新于 \$\{fmtClock/, 'footer refresh timestamp must be gone')
})

test('deriveQuick: null session derives without importing any mother session', () => {
  const start = client.indexOf('async function deriveQuick()')
  assert.ok(start > 0, 'deriveQuick must exist')
  const body = client.slice(start, start + 6000)
  assert.match(body, /const emptySession = !sessionId/, 'must detect the empty-session path')
  assert.match(body, /if \(!emptySession\) payload\.importSession/, 'must only import when a session was picked')
  assert.match(body, /已派生分身（空会话）/, 'must report the empty-session outcome distinctly')
})
