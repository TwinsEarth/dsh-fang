// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.4 — 三层产品形态的权限契约（fail-closed）。
//
// 母体版 Mirror：只有官方插件，不能开会话/任务；
// 原身版 Essence：可装第三方插件，不能开会话/任务；
// 分身版 Derived：不能装插件，可开会话/任务。
//
// 说明：真正的硬隔离靠“profile 里装不装对应插件”（第一道门）；
// 本模块是宿主/Adapter 侧的第二道门（防止直连 API 绕过 UI）。

export const ENV_TYPE = Object.freeze({
  MIRROR: 'mirror',
  ESSENCE: 'essence',
  DERIVED: 'derived',
})

export const ENV_TYPES = Object.freeze(Object.values(ENV_TYPE))

/** @type {Record<string, {installPlugins:boolean, openSessions:boolean}>} */
export const PERMISSION_RULES = Object.freeze({
  mirror: Object.freeze({ installPlugins: false, openSessions: false }),
  essence: Object.freeze({ installPlugins: true, openSessions: false }),
  derived: Object.freeze({ installPlugins: false, openSessions: true }),
})

export const ACTION_GROUPS = Object.freeze({
  installPlugins: Object.freeze(['plugin-install', 'plugin-uninstall', 'plugin-update', 'plugin-set']),
  openSessions: Object.freeze(['session-create', 'task-enqueue', 'agent-run', 'chat-send']),
})

export const PERMISSION_DENIED = 'permission-denied'

/**
 * 规范化环境类型；未知值一律视为 unknown（后续 fail-closed 拒绝）。
 * @param {unknown} value
 * @returns {'mirror'|'essence'|'derived'|'unknown'}
 */
export function resolveEnvType(value) {
  const text = String(value ?? '')
  return ENV_TYPES.includes(text) ? text : 'unknown'
}

/**
 * 检查某个动作在某环境下是否允许。
 * 未知环境 / 未知动作 → 拒绝（fail-closed）。
 * @param {unknown} envType
 * @param {string} action
 * @returns {{allowed:boolean, envType:string, action:string, code?:string, message?:string}}
 */
export function checkPermission(envType, action) {
  const env = resolveEnvType(envType)
  const name = String(action ?? '')
  const rule = PERMISSION_RULES[env]
  if (rule === undefined) {
    return {
      allowed: false, envType: env, action: name, code: PERMISSION_DENIED,
      message: `未知环境类型：${String(envType)}（fail-closed）`,
    }
  }
  const group = Object.keys(ACTION_GROUPS).find(key => ACTION_GROUPS[key].includes(name))
  if (group === undefined) {
    return {
      allowed: false, envType: env, action: name, code: PERMISSION_DENIED,
      message: `未知动作：${name}（fail-closed）`,
    }
  }
  if (rule[group] !== true) {
    const label = group === 'installPlugins' ? '安装/修改插件' : '开启会话或任务'
    const envLabel = { mirror: '母体版', essence: '原身版', derived: '分身版' }[env]
    return {
      allowed: false, envType: env, action: name, code: PERMISSION_DENIED,
      message: `[权限拒绝] ${envLabel} 不支持${label}`,
    }
  }
  return { allowed: true, envType: env, action: name }
}

/** 权限拒绝错误（Adapter/Guard 抛出用）。 */
export class PermissionDeniedError extends Error {
  constructor(decision) {
    super(decision?.message ?? 'permission denied')
    this.name = 'PermissionDeniedError'
    this.code = PERMISSION_DENIED
    this.envType = decision?.envType ?? 'unknown'
    this.action = decision?.action ?? ''
  }
}

/**
 * 创建一个绑定环境的守卫：返回 decision；`assert` 形式抛错。
 * @param {unknown} envType
 */
export function createEnvironmentGuard(envType) {
  const env = resolveEnvType(envType)
  const decide = (action) => checkPermission(env, action)
  return {
    envType: env,
    can: (action) => decide(action).allowed,
    check: decide,
    assert(action) {
      const decision = decide(action)
      if (!decision.allowed) throw new PermissionDeniedError(decision)
      return decision
    },
  }
}

/** 供 UI 展示的能力摘要。 */
export function describePermissions(envType) {
  const env = resolveEnvType(envType)
  const rule = PERMISSION_RULES[env]
  return rule === undefined
    ? { envType: env, installPlugins: false, openSessions: false, known: false }
    : { envType: env, installPlugins: rule.installPlugins, openSessions: rule.openSessions, known: true }
}
