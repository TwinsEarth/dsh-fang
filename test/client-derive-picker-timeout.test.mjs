// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.34 回归：派生弹窗必须存在，且超时未选择自动新建空会话。
// 2026-11-21：倒计时 7 秒；会话统一三分组（活跃中 7 天 / 已归档 / 旧会话 >7 天，组内按最后活跃倒序）；
//            母体面板会话列表与派生弹窗共用同一分类；页脚提示行移除。
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

test('session categorization: active(7d) → archived → older, each sorted by last active desc', () => {
  // 统一分类：7 天窗口 + 固定分类顺序 + 中文组名。
  assert.match(client, /SESSION_ACTIVE_WINDOW_MS = 7 \* 24 \* 60 \* 60 \* 1000/, 'active window must be 7 days')
  assert.match(client, /SESSION_GROUP_ORDER = \['active', 'archived', 'older'\]/, 'category order must be active→archived→older')
  assert.match(client, /SESSION_GROUP_LABELS = \{/, 'categories need display labels')
  assert.match(client, /active: '活跃中（7 天内）'/, 'active label')
  assert.match(client, /archived: '已归档'/, 'archived label')
  assert.match(client, /older: '旧会话（超过 7 天）'/, 'older label')
  assert.match(client, /function classifySessionsByRecency/, 'shared classifier must exist')
  assert.match(client, /function sessionCategoryOf/, 'single-session category helper must exist')
  // 分类优先级：归档优先于时间（归档一律进 archived，不参与 7 天/更早时间分组）。
  const start = client.indexOf('function classifySessionsByRecency')
  const end = client.indexOf('function sessionCategoryOf')
  assert.ok(start > 0 && end > start, 'classifier body must be found')
  const body = client.slice(start, end)
  const archivedIndex = body.indexOf('archived.push')
  const activeIndex = body.indexOf('active.push')
  assert.ok(archivedIndex > 0 && activeIndex > archivedIndex, 'archived must be classified before the 7-day window')
  // 组内排序：按最后活跃时间从新到旧。
  assert.match(body, /byLastActiveDesc/, 'inside-group sort helper')
  assert.match(client, /const byLastActiveDesc = \(a, b\) => \(Number\(b\?\.updatedAt\) \|\| 0\) - \(Number\(a\?\.updatedAt\) \|\| 0\)/, 'sort must use updatedAt desc')
  assert.equal((body.match(/\.sort\(byLastActiveDesc\)/g) || []).length, 3, 'all three categories must be sorted')
})

test('derive picker: groups come from the shared classifier, staged in one dialog', () => {
  const start = client.indexOf('function splitSessionsForDerive')
  const end = client.indexOf('function sessionOption')
  assert.ok(start > 0 && end > start, 'splitSessionsForDerive must exist')
  const body = client.slice(start, end)
  assert.match(body, /classifySessionsByRecency\(sessions, now\)/, 'derive picker must reuse the shared classifier')
  assert.match(body, /return \{ recent: active, archived, older \}/, 'derive picker maps active → recent')
  // 第 1 组：活跃中（7 天内），可选。
  assert.match(client, /最近 7 天没有活跃会话（可展开下方分组查看）/, 'recent group empty hint')
  // 第 2 组：已归档，单独折叠 + 灰色 + 不可选。
  assert.match(client, /derive-archived-sessions/, 'archived group must be its own fold')
  assert.match(client, /已归档会话（/, 'archived fold needs a labeled summary')
  assert.match(client, /不可选择/, 'archived fold must say it is not selectable')
  assert.match(client, /disabled: true/, 'archived select must be disabled (gray, unselectable)')
  // 第 3 组：旧会话（>7 天），折叠但可选。
  assert.match(client, /derive-older-sessions/, 'older group must be a fold')
  assert.match(client, /更早的会话（/, 'older fold needs a labeled summary')
  // 两处派生入口都必须请求归档会话，否则第 2 组永远为空。
  assert.equal((client.match(/\/fang\/api\/sessions\?[^'"`\n]*includeArchived=1/g) || []).length, 2, 'both derive entry points must request archived sessions')
  // 派生入口不得提前按 archived 过滤：分类必须发生在弹窗内。
  assert.doesNotMatch(client, /res\.body\.sessions\.filter\(\(session\) => session\.archived !== true\)/)
})

test('mother panel session list: category headers + per-category order', () => {
  const start = client.indexOf('function renderMotherSessions')
  assert.ok(start > 0, 'renderMotherSessions must exist')
  const body = client.slice(start, start + 4200)
  assert.match(body, /classifySessionsByRecency\(group\.sessions\)/, 'panel list must classify sessions')
  assert.match(body, /SESSION_GROUP_ORDER/, 'panel list must render categories in the fixed order')
  assert.match(body, /ordered\.push\(\{ session, category \}\)/, 'panel list must build a categorized order')
  assert.match(body, /session-group-head/, 'panel list must render category headers')
  assert.match(body, /SESSION_GROUP_LABELS\[category\]/, 'headers must use the shared labels')
  assert.match(client, /\.session-group-head\{/, 'category header CSS must exist')
  // 面板工具栏与卡片摘要也按同一分类计数。
  assert.match(client, /活跃中（7 天） \$\{sessionGroups\.active\.length\}/, 'toolbar active count')
  assert.match(client, /已归档 \$\{sessionGroups\.archived\.length\} · 旧会话 \$\{sessionGroups\.older\.length\}/, 'toolbar archived/older counts')
  assert.match(client, /活跃 \$\{categories\.active\.length\} · 归档 \$\{categories\.archived\.length\} · 旧 \$\{categories\.older\.length\}/, 'card summary counts')
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
