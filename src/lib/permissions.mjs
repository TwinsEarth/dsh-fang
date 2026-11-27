// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.4 — 三层产品形态的权限契约（fail-closed）。
//
// STATUS（2026-11-27 v3.9.9 接线）：本模块已接入生产权限链——
// orchestrator 的任务创建/派生/提升/元主写操作与 adapter 的 fork-session/archive
// 命令都会在原有 roleGate 之后调用本模块。默认 permissionEnv=auto：
// 母体映射为 host（装插件 + 开会话都允许），分身映射为 derived（装插件拒绝、开会话允许），
// 因此不改变既有行为；permissionEnv 显式设为 mirror/essence/derived 时才是真正的第二道门。
//
// 母体宿主 Host：官方 + 已装插件，可开会话/任务（母体既是安装者也是使用者）；
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
  HOST: 'host',
})

export const ENV_TYPES = Object.freeze(Object.values(ENV_TYPE))

/** @type {Record<string, {installPlugins:boolean, openSessions:boolean}>} */
export const PERMISSION_RULES = Object.freeze({
  host: Object.freeze({ installPlugins: true, openSessions: true }),
  mirror: Object.freeze({ installPlugins: false, openSessions: false }),
  essence: Object.freeze({ installPlugins: true, openSessions: false }),
  derived: Object.freeze({ installPlugins: false, openSessions: true }),
})

export const ACTION_GROUPS = Object.freeze({
  installPlugins: Object.freeze(['plugin-install', 'plugin-uninstall', 'plugin-update', 'plugin-set']),
  openSessions: Object.freeze(['session-create', 'task-enqueue', 'agent-run', 'chat-send']),
})

export const PERMISSION_DENIED = 'permission-denied'

/** 运行时角色 → 权限环境。auto 模式使用；未知角色 fail-closed。 */
export const RUNTIME_ENV_BY_ROLE = Object.freeze({
  mother: ENV_TYPE.HOST,
  fork: ENV_TYPE.DERIVED,
  consumer: ENV_TYPE.DERIVED,
})

/** orchestrator 路由 → 权限动作；未列出的路由不做第二道门判定。 */
export const PERMISSION_ROUTE_ACTIONS = Object.freeze({
  '/api/tasks/create': 'task-enqueue',
  '/api/derive': 'task-enqueue',
  '/api/forks/create': 'task-enqueue',
  '/api/tasks/open': 'task-enqueue',
  '/api/tasks/branches/fork': 'task-enqueue',
  '/api/tasks/archive/delete': 'task-enqueue',
  '/api/tasks/reprobe': 'task-enqueue',
  '/api/tasks/promote': 'plugin-install',
  '/api/promote': 'plugin-install',
  '/api/essence/create': 'plugin-install',
  '/api/essence/capture': 'plugin-install',
  '/api/essence/import': 'plugin-install',
  '/api/essence/restore': 'plugin-install',
  '/api/essence/copy': 'plugin-install',
  '/api/essence/delete': 'plugin-uninstall',
  '/api/essence/archive': 'plugin-uninstall',
  '/api/essence/rename': 'plugin-set',
  '/api/essence/default': 'plugin-set',
  '/api/fork-core': 'plugin-install',
})

/** Adapter 命令 → 权限动作；未列出的命令不做第二道门判定。 */
export const PERMISSION_ADAPTER_OP_ACTIONS = Object.freeze({
  'fork-session': 'session-create',
  archive: 'task-enqueue',
})

/**
 * 规范化环境类型；未知值一律视为 unknown（后续 fail-closed 拒绝）。
 * @param {unknown} value
 * @returns {'host'|'mirror'|'essence'|'derived'|'unknown'}
 */
export function resolveEnvType(value) {
  const text = String(value ?? '')
  return ENV_TYPES.includes(text) ? text : 'unknown'
}

/**
 * 解析实际生效的权限环境：显式值优先，auto/空值按运行时角色映射。
 * @param {{envType?: unknown, role?: unknown}} [options]
 * @returns {'host'|'mirror'|'essence'|'derived'|'unknown'}
 */
export function resolvePermissionEnv({ envType = 'auto', role = '' } = {}) {
  const explicit = resolveEnvType(envType)
  if (explicit !== 'unknown') return explicit
  const text = String(envType ?? '')
  if (text !== '' && text !== 'auto') return 'unknown'
  return RUNTIME_ENV_BY_ROLE[String(role ?? '')] ?? 'unknown'
}

function stripPrefix(pathname, prefix) {
  const path = String(pathname ?? '').split('?')[0].replace(/\/+$/, '')
  const base = String(prefix ?? '').replace(/\/+$/, '')
  if (!base) return path
  return path === base ? '' : path.startsWith(`${base}/`) ? path.slice(base.length) : path
}

/**
 * 把 orchestrator 的请求路径映射为权限动作。
 * @param {string} pathname
 * @param {string} [prefix]
 * @returns {string|null}
 */
export function permissionActionForPath(pathname, prefix = '/fang') {
  const route = stripPrefix(pathname, prefix)
  return PERMISSION_ROUTE_ACTIONS[route] ?? null
}

/**
 * 把 Adapter 命令映射为权限动作。
 * @param {string} op
 * @returns {string|null}
 */
export function permissionActionForAdapterOp(op) {
  return PERMISSION_ADAPTER_OP_ACTIONS[String(op ?? '')] ?? null
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
    const envLabel = { host: '母体宿主', mirror: '母体版', essence: '原身版', derived: '分身版' }[env]
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
