// SPDX-License-Identifier: AGPL-3.0-or-later

export const ROOTS = Object.freeze({ MIRROR: 'mirror', ESSENCE: 'essence', SESSIONS: 'sessions' })
export const ROLES = Object.freeze({ COORDINATOR: 'coordinator', MOTHER: 'mother', ESSENCE: 'essence', FORK: 'fork' })

const MATRIX = {
  [ROLES.COORDINATOR]: { mirror: 'rw', essence: 'rw', sessions: 'rw' },
  [ROLES.MOTHER]: { mirror: 'r', essence: 'none', sessions: 'none' },
  [ROLES.ESSENCE]: { mirror: 'r', essence: 'rw', sessions: 'none' },
  [ROLES.FORK]: { mirror: 'none', essence: 'r', sessions: 'rw' },
}

export function decisionFor(role, root) {
  const row = MATRIX[role]
  if (!row || !Object.prototype.hasOwnProperty.call(row, root)) return 'none'
  return row[root]
}

export function canAccess({ role, root, op, essenceId, ownerEssenceId, forkId, ownerForkId, path }) {
  const base = decisionFor(role, root)
  if (base === 'none') return false
  if (base === 'r' && op === 'write') return false
  if (role === ROLES.ESSENCE && root === ROOTS.ESSENCE && essenceId && ownerEssenceId && essenceId !== ownerEssenceId) return false
  if (role === ROLES.FORK) {
    if (root === ROOTS.ESSENCE && essenceId && ownerEssenceId && essenceId !== ownerEssenceId) return false
    if (root === ROOTS.SESSIONS && forkId && ownerForkId && forkId !== ownerForkId) return false
  }
  if (typeof path === 'string' && (path.includes('..') || path.includes('\0'))) return false
  return true
}
