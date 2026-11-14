// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// v3.2.0 四色决策状态机（唯一事实来源）。
// `expiresAt` 是归档期限；`waitDeadlineAt` 只是 Agent 的流程等待窗口，二者不可混用。
export const DECISION_LEVEL_POLICY = Object.freeze({
  red: Object.freeze({ waitMode: 'human', graceMs: null, afterWait: 'keep-waiting', label: '必须人工选择', priority: 'P0', risk: 'high' }),
  yellow: Object.freeze({ waitMode: 'grace-defer', graceMs: 3 * 60_000, afterWait: 'defer', label: '3 分钟后继续，可补选', priority: 'P1', risk: 'medium' }),
  blue: Object.freeze({ waitMode: 'grace-recommended', graceMs: 60_000, afterWait: 'recommended', label: '1 分钟后按推荐执行', priority: 'P2', risk: 'low' }),
  green: Object.freeze({ waitMode: 'immediate', graceMs: 0, afterWait: 'recommended', label: '自动执行并留底', priority: 'P3', risk: 'info' }),
})

export const DECISION_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3'])
export const DECISION_RISKS = Object.freeze(['high', 'medium', 'low', 'info'])

/** 调用方可以覆盖默认优先级/风险（例如低等级但高风险的安全票）。 */
export function normalizeDecisionPriority(value, level) {
  const raw = String(value ?? '').trim().toUpperCase()
  if (DECISION_PRIORITIES.includes(raw)) return raw
  return decisionPolicy(level).priority
}

export function normalizeDecisionRisk(value, level) {
  const raw = String(value ?? '').trim().toLowerCase()
  const alias = { critical: 'high', high: 'high', medium: 'medium', med: 'medium', low: 'low', info: 'info', none: 'info' }
  const mapped = alias[raw]
  if (mapped) return mapped
  return decisionPolicy(level).risk
}

export function decisionPolicy(level) {
  return DECISION_LEVEL_POLICY[level] ?? DECISION_LEVEL_POLICY.yellow
}

export function decisionWaitMs(level, timeoutMinutes) {
  const policy = decisionPolicy(level)
  if (policy.graceMs === null) return null
  // timeoutMinutes 对黄/蓝表示等待窗口；未显式指定时使用该等级的默认值。
  const override = Number(timeoutMinutes)
  if (Number.isFinite(override) && override > 0) return Math.max(1, Math.round(override * 60_000))
  return policy.graceMs
}

/** 推荐项优先；低风险票没有推荐标记时确定性地取第一项，保证流程能继续。 */
export function recommendedDecisionOption(options) {
  const list = Array.isArray(options) ? options : []
  return list.find((option) => option?.isRecommended === true) ?? list[0] ?? null
}

export function isDeferredDecision(ticket) {
  return ticket?.status === 'pending' && ticket?.level === 'yellow' && Number(ticket?.deferredAt) > 0
}
