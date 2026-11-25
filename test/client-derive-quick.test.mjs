// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.32 回归：绿色「派生新分身」必须走「默认元主 + 选择会话」，
// 不能直接发一个没有 sessionId 的派生请求（否则服务端回 session-required）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('derive button: primary derive uses deriveQuick (not a bare deriveTask)', () => {
  // 绿色主按钮
  assert.match(client, /void app\.deriveQuick\(\)/, 'primary derive button must call app.deriveQuick()')
  // 不允许再出现「直接无会话派生」的按钮接线
  assert.doesNotMatch(
    client,
    /onClick: \(\) => void app\.deriveTask\(\{ title: '派生新分身' \}\)/,
    'derive button must not call deriveTask without a session',
  )
})

test('deriveQuick: resolves the default essence before deriving', () => {
  const start = client.indexOf('async function deriveQuick()')
  assert.ok(start > 0, 'deriveQuick must exist')
  const body = client.slice(start, start + 4000)
  assert.match(body, /\/fang\/api\/essence\/list/, 'must read the essence list')
  assert.match(body, /defaultId/, 'must honour the default (developer-recommended) essence id')
  assert.match(body, /showDerivePicker/, 'must let the user pick exactly one in-progress session')
  assert.match(body, /essenceId: essence\.id/, 'must derive from the resolved essence template')
  assert.match(body, /importSession: \{ sessionId \}/, 'must import the picked session')
})

test('deriveQuick: is exposed on the app surface', () => {
  assert.match(client, /deriveFromEssence, deriveQuick,/, 'app object must expose deriveQuick')
})

test('deriveQuick: reuses the single-session picker (no multi-select path)', () => {
  const start = client.indexOf('async function deriveQuick()')
  const body = client.slice(start, start + 4000)
  // 走 showDerivePicker（单选），不是 showSessionPicker（多选 1–5）
  assert.match(body, /showDerivePicker/)
  assert.doesNotMatch(body, /showSessionPicker/)
})
