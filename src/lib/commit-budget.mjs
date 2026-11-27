// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.8.13 P0: aggregate fork commit budget with a hard host reserve.
//
// Two ceilings apply together:
//   1. fork trees may use at most `share` (40%) of CommitLimit;
//   2. the host keeps at least `reserveMB` (4 GB) of CommitLimit.
// The effective ceiling is the smaller one. A missing CommitLimit is never
// treated as "unlimited"; callers decide whether that is fail-open or closed.

export const FORK_COMMIT_SHARE_DEFAULT = 0.4
export const HOST_COMMIT_RESERVE_MB_DEFAULT = 4096

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function shareOf(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return FORK_COMMIT_SHARE_DEFAULT
  return Math.min(1, number)
}

/**
 * Resolve the effective fork commit ceiling.
 * @param {{commitLimitMB:number, share?:number, reserveMB?:number}} input
 */
export function resolveForkCommitBudget({ commitLimitMB, share = FORK_COMMIT_SHARE_DEFAULT, reserveMB = HOST_COMMIT_RESERVE_MB_DEFAULT } = {}) {
  const limitMB = positive(commitLimitMB)
  const shareLimitMB = limitMB > 0 ? limitMB * shareOf(share) : 0
  const reserve = Number.isFinite(Number(reserveMB)) && Number(reserveMB) >= 0 ? Number(reserveMB) : HOST_COMMIT_RESERVE_MB_DEFAULT
  const reserveLimitMB = limitMB > 0 ? Math.max(0, limitMB - reserve) : 0
  const effectiveLimitMB = Math.max(0, Math.min(shareLimitMB, reserveLimitMB))
  return {
    ok: effectiveLimitMB > 0,
    reason: limitMB <= 0 ? 'commit-limit-unavailable' : effectiveLimitMB <= 0 ? 'host-reserve-consumes-limit' : 'ok',
    commitLimitMB: limitMB,
    share: shareOf(share),
    reserveMB: reserve,
    shareLimitMB: Math.round(shareLimitMB),
    reserveLimitMB: Math.round(reserveLimitMB),
    limitMB: Math.round(effectiveLimitMB),
  }
}

/**
 * Compare aggregate fork+browser commit against the effective ceiling.
 * `over` is only true when the ceiling is usable.
 */
export function evaluateForkCommitBudget({ commitLimitMB, forkTotalMB, share = FORK_COMMIT_SHARE_DEFAULT, reserveMB = HOST_COMMIT_RESERVE_MB_DEFAULT } = {}) {
  const budget = resolveForkCommitBudget({ commitLimitMB, share, reserveMB })
  const totalMB = Math.max(0, Math.round(Number(forkTotalMB) || 0))
  const remainingMB = budget.ok ? Math.max(0, budget.limitMB - totalMB) : 0
  return {
    ...budget,
    forkTotalMB: totalMB,
    remainingMB,
    over: budget.ok && totalMB > budget.limitMB,
  }
}
