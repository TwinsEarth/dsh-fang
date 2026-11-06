// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.7/S1 — UI 动作语义的唯一来源：稳定 action id / enabled / code / reason / confirm。
// 服务端返回后，UI 只做投影，不再自行推断禁用原因；data-btn-id 与 id 一一对应。

export const TASK_ACTION_IDS = Object.freeze(['open', 'rename', 'archive', 'copy', 'download', 'delete'])
export const ESSENCE_ACTION_IDS = Object.freeze(['derive', 'configure', 'rename', 'archive', 'copy', 'download', 'delete'])

const item = (id, enabled, code, reason, confirm = 'none') => ({
  id,
  enabled: enabled === true,
  code: enabled === true ? 'ok' : code,
  reason: enabled === true ? '' : reason,
  confirm,
})

/** 分身动作矩阵：运行中可打开/归档；归档后可删除；未运行禁止打开/归档。 */
export function buildTaskActions({ running = false, archived = false } = {}) {
  const actions = {
    open: item('open', running, 'not-running', '分身未运行，先打开或复原后再操作'),
    rename: item('rename', !archived, 'archived', '已归档的分身不可重命名'),
    archive: item('archive', running && !archived, 'not-running', '分身未运行，无需归档', 'once'),
    copy: item('copy', true, 'ok', ''),
    download: item('download', true, 'ok', ''),
    delete: item('delete', archived, 'archived-required', '需先归档才能永久删除', 'strong'),
  }
  const blocks = []
  if (!running) blocks.push({ code: 'not-running', reason: '分身未运行' })
  if (archived) blocks.push({ code: 'archived', reason: '分身已归档（home 已保留）' })
  return { actions, blocks }
}

/** 元主动作矩阵：冻结（archived）后只能删除；官方 locked 只允许派生/复制/下载。 */
export function buildEssenceActions({ locked = false, archived = false } = {}) {
  const frozen = archived === true
  const mutable = locked !== true && frozen !== true
  const actions = {
    derive: item('derive', frozen !== true, 'archived', '已归档（冻结）的元主不可派生'),
    configure: item('configure', mutable, locked ? 'locked' : 'archived', locked ? '官方推荐元主不支持修改设置' : '已冻结的元主不可配置'),
    rename: item('rename', mutable, locked ? 'locked' : 'archived', locked ? '官方推荐元主不可重命名' : '已冻结的元主不可重命名'),
    archive: item('archive', mutable, locked ? 'locked' : 'archived', locked ? '官方推荐元主不可归档' : '已归档（冻结）', 'once'),
    copy: item('copy', frozen !== true, 'archived', '已冻结的元主不可复制'),
    download: item('download', frozen !== true, 'archived', '已冻结的元主不可下载'),
    delete: item('delete', frozen === true && locked !== true, locked ? 'locked' : 'archived-required', locked ? '官方推荐元主不可删除' : '需先归档（冻结）才能删除', 'strong'),
  }
  const blocks = locked === true
    ? [{ code: 'locked', reason: '官方推荐元主不支持修改设置' }]
    : frozen
      ? [{ code: 'archived', reason: '元主已归档（冻结）：只能删除' }]
      : []
  return { actions, blocks }
}

export const _internals = Object.freeze({ item })
