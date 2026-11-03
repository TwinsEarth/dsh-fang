// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.7 UI-01…UI-12 自动化用例（S1 actions/blocks 已就绪；富面板 harness 待接）。
// 当前以 todo 形式登记，保证用例清单可追踪；harness 完成后逐个转成真实 DOM 断言。
import test from 'node:test'
import assert from 'node:assert/strict'

import { ESSENCE_ACTION_IDS, TASK_ACTION_IDS, buildEssenceActions, buildTaskActions } from '../src/lib/ui-actions.mjs'

// UI-10 / UI-11 已由 S1 动作语义覆盖，转为真实断言
test('UI-10 官方 locked 元主：配置/删除禁用且服务端给出 locked 原因', () => {
  const { actions, blocks } = buildEssenceActions({ locked: true, archived: false })
  assert.equal(actions.configure.enabled, false)
  assert.equal(actions.configure.code, 'locked')
  assert.equal(actions.delete.enabled, false)
  assert.equal(actions.derive.enabled, true)
  assert.ok(blocks.some((b) => b.code === 'locked' && b.reason.includes('官方')))
})

test('UI-11 data-btn-id / data-reason 语义：动作 id 稳定且禁用必带原因', () => {
  for (const [actions, ids] of [
    [buildTaskActions({ running: true }).actions, TASK_ACTION_IDS],
    [buildEssenceActions({ archived: true }).actions, ESSENCE_ACTION_IDS],
  ]) {
    assert.deepEqual(Object.keys(actions).sort(), [...ids].sort())
    for (const id of ids) {
      assert.equal(actions[id].id, id)
      assert.equal(typeof actions[id].enabled, 'boolean')
      if (!actions[id].enabled) assert.ok(actions[id].reason.length > 0, `${id} disabled reason`)
      assert.ok(['ok', 'locked', 'archived', 'archived-required', 'not-running'].includes(actions[id].code), `${id} code`)
    }
  }
})

const CASES = [
  ['UI-01', 'Header 三计数（母体/元主/分身）与 API 一致'],
  ['UI-02', 'Mother 单击打开浮层（克隆/打开/备份）'],
  ['UI-03', 'Mother 双击直接打开母体 Web'],
  ['UI-04', '浮层 Esc/遮罩关闭 + 焦点返回'],
  ['UI-05', '左 7 槽 / 5 配额（第 6/7 锁定）'],
  ['UI-06', '状态色：running 绿 / paused 蓝 / crashed 红 / 离线灰'],
  ['UI-07', '双击重命名：Enter 保存、Esc 取消、失败回滚、刷新持久'],
  ['UI-08', '分身折叠 + 五项操作（打开/复制/归档/下载/删除）'],
  ['UI-09', '信息栏（对话名/创建/更新/体积）'],
  ['UI-12', '键盘/触屏可达性（F2、≥34px、hover:none 常显）'],
]

for (const [id, title] of CASES) {
  test(`${id} ${title}`, { todo: '富面板 DOM harness 待接入（依赖 S2 三区渲染）' }, () => {})
}
