// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.7/S1 — UI 动作语义契约：稳定 id、disabled 必带 code/reason、locked/archived 矩阵。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ESSENCE_ACTION_IDS, TASK_ACTION_IDS, buildEssenceActions, buildTaskActions,
} from '../src/lib/ui-actions.mjs'

function assertShape(actions, ids) {
  assert.deepEqual(Object.keys(actions).sort(), [...ids].sort())
  for (const id of ids) {
    const action = actions[id]
    assert.equal(action.id, id)
    assert.equal(typeof action.enabled, 'boolean')
    assert.equal(typeof action.code, 'string')
    assert.equal(typeof action.reason, 'string')
    assert.ok(['none', 'once', 'strong'].includes(action.confirm))
    if (!action.enabled) assert.ok(action.reason.length > 0, `${id} disabled 必须有 reason`)
    if (action.enabled) assert.equal(action.code, 'ok')
  }
}

test('S1: 分身动作 id/形状稳定，运行中矩阵正确', () => {
  const { actions, blocks } = buildTaskActions({ running: true, archived: false })
  assertShape(actions, TASK_ACTION_IDS)
  assert.equal(actions.open.enabled, true)
  assert.equal(actions.archive.enabled, true)
  assert.equal(actions.archive.confirm, 'once')
  assert.equal(actions.delete.enabled, false)
  assert.equal(actions.delete.code, 'archived-required')
  assert.equal(actions.delete.confirm, 'strong')
  assert.deepEqual(blocks, [])
})

test('S1: 分身归档后 delete 可用、rename/open/archive 禁用且带原因', () => {
  const { actions, blocks } = buildTaskActions({ running: false, archived: true })
  assertShape(actions, TASK_ACTION_IDS)
  assert.equal(actions.delete.enabled, true)
  assert.equal(actions.open.enabled, false)
  assert.equal(actions.rename.enabled, false)
  assert.equal(actions.rename.code, 'archived')
  assert.ok(blocks.some((b) => b.code === 'archived'))
})

test('S1: 官方 locked 元主只允许派生/复制/下载', () => {
  const { actions, blocks } = buildEssenceActions({ locked: true, archived: false })
  assertShape(actions, ESSENCE_ACTION_IDS)
  for (const id of ['configure', 'rename', 'archive', 'delete']) {
    assert.equal(actions[id].enabled, false, id)
    assert.equal(actions[id].code, 'locked', id)
    assert.ok(actions[id].reason.includes('官方'))
  }
  assert.equal(actions.derive.enabled, true)
  assert.equal(actions.copy.enabled, true)
  assert.equal(actions.download.enabled, true)
  assert.ok(blocks.some((b) => b.code === 'locked'))
})

test('S1: 归档元主（冻结）只能还原（解冻）或删除', () => {
  const { actions, blocks } = buildEssenceActions({ locked: false, archived: true })
  assertShape(actions, ESSENCE_ACTION_IDS)
  assert.equal(actions.derive.enabled, false)
  assert.equal(actions.derive.code, 'archived')
  assert.equal(actions.configure.enabled, false)
  assert.equal(actions.copy.enabled, false)
  assert.equal(actions.download.enabled, false)
  assert.equal(actions.rename.enabled, false)
  assert.equal(actions.archive.enabled, false)
  assert.equal(actions.restore.enabled, true, '冻结后可以还原（解冻）')
  assert.equal(actions.delete.enabled, true, '冻结后可以删除')
  assert.equal(actions.delete.confirm, 'strong')
  assert.ok(blocks.some((b) => b.code === 'archived'))
})

test('S1: 未冻结元主的 restore（解冻）不可用', () => {
  const { actions } = buildEssenceActions({ locked: false, archived: false })
  assert.equal(actions.restore.enabled, false)
  assert.equal(actions.restore.code, 'not-archived')
})

test('S1: 动作 id 与 data-btn-id 映射集合一致', () => {
  assert.deepEqual([...TASK_ACTION_IDS], ['open', 'rename', 'archive', 'copy', 'download', 'delete'])
  assert.deepEqual([...ESSENCE_ACTION_IDS], ['derive', 'configure', 'rename', 'archive', 'restore', 'copy', 'download', 'delete'])
})
