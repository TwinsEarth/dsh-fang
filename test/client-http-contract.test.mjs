// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser bundle contract guards: client.js is not imported by unit tests, so these
// source-level assertions lock the two regressions that caused real 401s:
//   1. options.headers replacing the default auth headers;
//   2. api() accepting an absolute URL (token exfiltration).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(import.meta.dirname, '..', 'client.js')
const source = fs.readFileSync(file, 'utf8')

test('client.js: api() rejects absolute / scheme-relative URLs', () => {
  const start = source.indexOf('async function api(path, options)')
  assert.ok(start >= 0, 'api() must exist')
  const end = source.indexOf('function resolveMotherOrigin', start)
  assert.ok(end > start, 'api() boundary must be findable')
  const body = source.slice(start, end)
  assert.match(body, /if \(!url\.startsWith\('\/'\) \|\| url\.startsWith\('\/\/'\)\)/)
  assert.match(body, /invalid-api-path/)
})

test('client.js: api() merges caller headers before writing x-fang-auth', () => {
  const start = source.indexOf('async function api(path, options)')
  const end = source.indexOf('function resolveMotherOrigin', start)
  const body = source.slice(start, end)
  const mergeAt = body.indexOf('...(request.headers ?? {})')
  const tokenAt = body.indexOf("'x-fang-auth': token")
  assert.ok(mergeAt >= 0, 'caller headers must be merged')
  assert.ok(tokenAt > mergeAt, 'auth header must be written after caller headers')
})

test('client.js: Electron portal opens the upstream origin, not the proxy', () => {
  assert.match(source, /window\.__fangDesktopUpstream/)
  assert.match(source, /desktopInfo\?\.\(\)\.then/)
})

test('client.js: restart guard mode and the red-line auto-allow warning are rendered', () => {
  // 状态摘要来自 GET /fang/api/status 的 restart 字段；缺失时整块不渲染（available:false）。
  assert.match(source, /data\?\.restart/)
  assert.match(source, /restart\?\.available/)
  assert.match(source, /redLineAutoAllowed/)
  assert.match(source, /红灯自动放行/)
  assert.match(source, /重启守卫/)
  // 警告必须注明「只到决策层」，避免把红灯自动放行误读成进程会被自动重启。
  assert.match(source, /execution\.executed 恒为 false/)
})

test('client.js: decision inbox is an independent sidebar entry + right drawer, not a panel notice', () => {
  // 独立侧边栏入口（footer action seat）+ 未读红点
  assert.match(source, /sidebar\.footer\.action/)
  assert.match(source, /fang-inbox-seat/)
  assert.match(source, /fang-inbox-badge/)
  // 右侧抽屉：优先宿主 right pane tab，Slot 不可用时回退固定 drawer
  assert.match(source, /sidebar\.right\.pane\.tab/)
  assert.match(source, /sidebarRightTabs\.register/)
  assert.match(source, /openTab\(DECISION_INBOX\.kind/)
  assert.match(source, /fang-inbox-drawer/)
  // 可折叠分组 + 未读计数 + 键盘导航 + 批量操作
  assert.match(source, /INBOX_LEVELS/)
  assert.match(source, /ArrowDown/)
  assert.match(source, /ArrowUp/)
  assert.match(source, /resolveSelected/)
  assert.match(source, /全选可推荐/)
  assert.match(source, /待处理 /)
  // 实时推送（fetch 流 SSE，非 EventSource）+ 未读已读游标 + 红色强提醒
  assert.match(source, /\/fang\/api\/decisions\/events/)
  assert.match(source, /text\/event-stream/)
  assert.match(source, /seenRev/)
  assert.match(source, /markSeen/)
  assert.match(source, /fang-inbox-red-alert/)
  assert.match(source, /Notification/)
  assert.match(source, /has-red/)
  // 多选 / 批量归档 / 批量失败逐条 / 批量确认弹窗
  assert.match(source, /selectAllPending/)
  assert.match(source, /归档选中/)
  // 分身看护 UI 开关：GET/POST /api/forks/supervision + 运行时 supervise
  assert.match(source, /\/fang\/api\/forks\/supervision/)
  assert.match(source, /setForkSupervision/)
  assert.match(source, /data-supervision/)
  assert.match(source, /archiveSelected/)
  assert.match(source, /batchFailures/)
  assert.match(source, /批量操作有/)
  assert.match(source, /retryFailures/)
  assert.match(source, /confirmBatchDialog/)
  assert.match(source, /fang-inbox-confirm/)
  // AI Key 持久化 / 测试连接 / 日配额 / 熔断
  assert.match(source, /\/fang\/api\/decisions\/ai\/test/)
  assert.match(source, /测试连接/)
  assert.match(source, /saveAiWithTest/)
  assert.match(source, /persistence/)
  assert.match(source, /quota/)
  assert.match(source, /circuit/)
  // AI 建议 schema v2 + token/cost 展示
  assert.match(source, /optionRisks/)
  assert.match(source, /missingInfo/)
  assert.match(source, /fang-inbox-risk/)
  assert.match(source, /costMicros/)
  assert.match(source, /endpointHost/)
  assert.match(source, /未核实/)
  assert.match(source, /注意力降级/)
  assert.match(source, /attentionQuota/)
  assert.match(source, /fang-inbox-exec/)
  // 右侧工作区内的决策中心区域
  assert.match(source, /fang-decision-mini/)
  assert.match(source, /决策中心/)
  assert.match(source, /已被处理/)
  assert.match(source, /renderDecisionMini/)
  // 主面板不再渲染决策中心
  assert.doesNotMatch(source, /renderDecisionCenter\(S, app\)\) frag\.append/)
})
