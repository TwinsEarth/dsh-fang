// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Fork Web capacity by product edition (v3.9.10).
//
// The ordinary edition is the only one enabled in this release. Professional and
// team are reserved capacity tiers: their numbers are defined here so the runtime
// and future activation code share one table instead of scattering magic numbers.
// Activation must switch `ACTIVE_FORK_EDITION` (build-time) — never accept an
// untrusted config value as proof of a paid edition.

export const FORK_EDITION = Object.freeze({
  STANDARD: 'standard',
  PROFESSIONAL: 'professional',
  TEAM: 'team',
})

/**
 * `maxForkWeb` limits concurrently live managed browser windows.
 * `maxForks` limits concurrently live fork processes (task slots).
 * Both are edition quotas; memory/commit guards may still refuse earlier.
 */
export const FORK_WEB_QUOTAS = Object.freeze({
  standard: Object.freeze({
    edition: FORK_EDITION.STANDARD,
    label: '普通版',
    maxForkWeb: 5,
    maxForks: 5,
    available: true,
  }),
  professional: Object.freeze({
    edition: FORK_EDITION.PROFESSIONAL,
    label: '专业版',
    maxForkWeb: 20,
    maxForks: 20,
    available: false,
    reserved: true,
  }),
  team: Object.freeze({
    edition: FORK_EDITION.TEAM,
    label: '团队版',
    maxForkWeb: 100,
    maxForks: 100,
    available: false,
    reserved: true,
  }),
})

export const DEFAULT_FORK_EDITION = FORK_EDITION.STANDARD
/** The edition compiled into this release. Professional/team are not active yet. */
export const ACTIVE_FORK_EDITION = DEFAULT_FORK_EDITION

export const DEFAULT_MAX_FORK_WEBS = FORK_WEB_QUOTAS[DEFAULT_FORK_EDITION].maxForkWeb
export const HARD_MAX_FORK_WEBS = FORK_WEB_QUOTAS[FORK_EDITION.TEAM].maxForkWeb
export const DEFAULT_MAX_FORKS = FORK_WEB_QUOTAS[DEFAULT_FORK_EDITION].maxForks
export const HARD_MAX_FORKS = FORK_WEB_QUOTAS[FORK_EDITION.TEAM].maxForks

/** Resolve an edition table entry; unknown values fail closed to the ordinary tier. */
export function forkQuotaForEdition(edition = ACTIVE_FORK_EDITION) {
  return FORK_WEB_QUOTAS[String(edition ?? '')] ?? FORK_WEB_QUOTAS[DEFAULT_FORK_EDITION]
}

function clampToPlan(configured, planValue, hardMax) {
  const raw = Number(configured)
  const requested = Number.isFinite(raw) ? Math.floor(raw) : planValue
  return Math.max(1, Math.min(planValue, hardMax, requested))
}

/** Effective concurrently live managed-browser windows for the active edition. */
export function effectiveForkWebLimit(configured, edition = ACTIVE_FORK_EDITION) {
  const plan = forkQuotaForEdition(edition)
  return clampToPlan(configured, plan.maxForkWeb, HARD_MAX_FORK_WEBS)
}

/** Effective concurrently live fork processes for the active edition. */
export function effectiveForkLimit(configured, edition = ACTIVE_FORK_EDITION) {
  const plan = forkQuotaForEdition(edition)
  return clampToPlan(configured, plan.maxForks, HARD_MAX_FORKS)
}
