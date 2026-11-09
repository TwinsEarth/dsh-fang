// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// business-producers — 业务生产者 → 决策中心的命名适配层（P4 业务接入契约）。
//
// 这不是“外部系统已接”：HarnessMM/PluginUpdater/SuperAgent/PJM/Worker 的本体不在
// 本仓。本模块给它们一个**明确、稳定、可测试**的调用面；只要在各自进程里调用对应
// 方法（或等价 ingest payload），就会生成正确等级/kind/dedupeKey 的 ticket。
import { nowMs } from '../kernel/index.mjs'

/** 把外部系统的动作映射成 decision-center ingest/submit 的稳定 payload。 */
export function createBusinessProducers({ submit, now = nowMs } = {}) {
  if (typeof submit !== 'function') throw new TypeError('createBusinessProducers: submit required')
  const send = (payload) => submit({ ...payload, at: now() })

  return {
    /** MirrorUpgrade 成功但需要重启宿主：红色，动作 confirm_restart。 */
    mirrorUpgradeRestartRequired({ from = 'unknown', to = 'unknown', reason = '' } = {}) {
      return send({
        producer: 'MirrorUpgrade', kind: 'mirror-upgrade', level: 'red',
        title: '镜像升级完成，需重启宿主',
        context: `镜像已从 ${from} 切换到 ${to}${reason ? `（${reason}）` : ''}；重启后新镜像才会完全生效。`,
        actions: [
          { id: 'confirm_restart', label: '立即重启', type: 'primary' },
          { id: 'later', label: '稍后', type: 'default' },
        ],
        dedupeKey: `mirror-upgrade:restart:${from}->${to}`,
      })
    },
    /** MirrorUpgrade 失败/exception。 */
    mirrorUpgradeFailed({ from = 'unknown', to = null, reason = 'unknown', level = 'yellow' } = {}) {
      return send({
        producer: 'MirrorUpgrade', kind: 'mirror-upgrade', level,
        title: '母体镜像升级失败',
        context: `镜像升级未成功：${reason}${from ? `（from ${from}${to ? ` -> ${to}` : ''}）` : ''}`,
        actions: [{ id: 'retry', label: '重试升级', type: 'primary' }, { id: 'ignore', label: '忽略', type: 'default' }],
        dedupeKey: `mirror-upgrade:failed:${reason}`.slice(0, 200),
      })
    },
    /** EssenceManager 合并冲突：黄色，合并同一 essence 的冲突。 */
    essenceConflict({ essenceId = 'unknown', conflicts = [], severity = 'warning' } = {}) {
      return send({
        producer: 'EssenceManager', kind: 'essence-conflict', level: severity === 'fatal' ? 'red' : 'yellow',
        title: `元主合并冲突：${essenceId}`,
        context: `essence=${essenceId}; conflicts=${Array.isArray(conflicts) ? conflicts.length : 0}`,
        actions: [{ id: 'review', label: '查看冲突', type: 'primary' }, { id: 'ignore', label: '忽略', type: 'default' }],
        dedupeKey: `essence-conflict:${essenceId}`,
      })
    },
    /** HarnessMM 优化建议：蓝色（异步建议，不阻塞）。 */
    harnessmmSuggestion({ id = null, summary = '', score = null } = {}) {
      return send({
        producer: 'HarnessMM', kind: 'harnessmm-suggestion', level: 'blue',
        title: summary || 'HarnessMM 优化建议',
        context: `suggestion=${id ?? 'n/a'}; score=${score ?? 'n/a'}`,
        actions: [{ id: 'accept', label: '采纳', type: 'default' }, { id: 'ignore', label: '忽略', type: 'default' }],
        dedupeKey: id ? `harnessmm:${id}` : undefined,
      })
    },
    /** PluginUpdater 备份完成通知：绿色（FYI）。 */
    pluginUpdaterBackup({ pluginId = 'unknown', backupId = null } = {}) {
      return send({
        producer: 'PluginUpdater', kind: 'plugin-updater-backup', level: 'green',
        title: `插件更新前备份完成：${pluginId}`,
        context: `plugin=${pluginId}; backup=${backupId ?? 'n/a'}`,
        dedupeKey: backupId ? `plugin-updater:backup:${backupId}` : undefined,
      })
    },
    /** SuperAgent 任务完成汇报：绿色。 */
    superagentCompletion({ taskId = null, summary = '' } = {}) {
      return send({
        producer: 'SuperAgent', kind: 'superagent-completion', level: 'green',
        title: summary || 'SuperAgent 任务完成',
        context: `task=${taskId ?? 'n/a'}`,
        dedupeKey: taskId ? `superagent:completed:${taskId}` : undefined,
      })
    },
    /** PJM 超时：黄色 + 默认 5 分钟自动转灰。 */
    pjmTimeout({ projectId = null, phase = 'unknown', timeoutMinutes = 5 } = {}) {
      return send({
        producer: 'PJM', kind: 'pjm-timeout', level: 'yellow', timeoutMinutes,
        title: `PJM 超时：${projectId ?? 'unknown'}`,
        context: `project=${projectId ?? 'n/a'}; phase=${phase}`,
        actions: [{ id: 'retry', label: '重试', type: 'primary' }, { id: 'abandon', label: '放弃', type: 'default' }],
        dedupeKey: projectId ? `pjm:timeout:${projectId}:${phase}` : undefined,
      })
    },
    /** PJM 致命错误：黄色（需要人看，但不阻塞整个 Agent）。 */
    pjmFatal({ projectId = null, error = 'unknown' } = {}) {
      return send({
        producer: 'PJM', kind: 'pjm-fatal', level: 'yellow',
        title: `PJM 致命错误：${projectId ?? 'unknown'}`,
        context: `project=${projectId ?? 'n/a'}; error=${String(error).slice(0, 500)}`,
        actions: [{ id: 'retry', label: '重试', type: 'primary' }, { id: 'abandon', label: '放弃', type: 'default' }],
        dedupeKey: projectId ? `pjm:fatal:${projectId}` : undefined,
      })
    },
    /** Worker 跑偏：黄色（可在 payload 带偏离详情）。 */
    workerDeviation({ workerId = null, taskId = null, detail = '' } = {}) {
      return send({
        producer: 'Worker', kind: 'worker-deviation', level: 'yellow',
        title: `Worker 跑偏：${workerId ?? 'unknown'}`,
        context: `worker=${workerId ?? 'n/a'}; task=${taskId ?? 'n/a'}; ${String(detail).slice(0, 500)}`,
        actions: [{ id: 'review', label: '查看', type: 'primary' }, { id: 'ignore', label: '忽略', type: 'default' }],
        dedupeKey: taskId ? `worker:deviation:${taskId}` : undefined,
      })
    },
  }
}
