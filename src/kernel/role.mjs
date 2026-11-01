// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — deployment roles and the plugin/role matrix.
//
// The same bundle is installed in the mother and in every fork, so which half of a
// plugin activates must be decided at runtime: the forker launches a fork with
// DSH_FANG_ROLE=fork, and every plugin asks this module whether its role is enabled.
//
// Matrix is the product contract (docs/CONTRACTS-V2.md §2). Adding a plugin to a role
// here is the only place that decision lives.

export const ROLE = { MOTHER: 'mother', FORK: 'fork', CONSUMER: 'consumer' }

/** plugin key → roles in which the plugin activates. */
export const MATRIX = {
  orchestrator: ['mother'],
  forker: ['mother'],
  restartGuard: ['mother'],
  healer: ['fork'],
  hotReloader: ['fork'],
  adapter: ['fork'],
  scorer: ['mother', 'fork'],
  router: ['mother', 'fork'],
  approver: ['mother', 'fork'],
  bufferKeeper: ['fork'],
  auditor: ['mother', 'fork'],
  sessionCatalog: ['mother'],
  sessionBridge: ['mother'],
  sessionSync: ['mother', 'consumer'],
  sessionRouter: ['mother'],
}

const VALID_ROLES = new Set([ROLE.MOTHER, ROLE.FORK, ROLE.CONSUMER])

/**
 * The environment wins over config: a fork is started by the forker with
 * DSH_FANG_ROLE=fork and must never be able to promote itself to a mother by config.
 * @returns {'mother'|'fork'|'consumer'}
 */
export function resolveRole({ cfgRole = '', env = process.env } = {}) {
  const fromEnv = env?.DSH_FANG_ROLE
  if (VALID_ROLES.has(fromEnv)) return fromEnv
  if (VALID_ROLES.has(cfgRole)) return cfgRole
  return ROLE.MOTHER
}

export function roleAllows(pluginKey, role) {
  return (MATRIX[pluginKey] ?? []).includes(role)
}

/**
 * Guard used at the top of every plugin's apply().
 * @returns {{role:string, active:boolean, reason:string}}
 */
export function roleGate(pluginKey, { cfgRole = '', env = process.env, logger = null } = {}) {
  const role = resolveRole({ cfgRole, env })
  const active = roleAllows(pluginKey, role)
  const reason = active ? `${pluginKey} active in ${role}` : `${pluginKey} is not deployed in ${role}`
  if (!active && logger && typeof logger.info === 'function') logger.info(reason)
  return { role, active, reason }
}

/** Roles a plugin activates in — used by status surfaces and tests. */
export function rolesOf(pluginKey) {
  return [...(MATRIX[pluginKey] ?? [])]
}
