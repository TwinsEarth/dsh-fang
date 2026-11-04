// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.9 read-only broker adapter: issues only read capabilities. Write is intentionally absent.
const READ_ROOTS = new Set(['essence', 'sessions'])

export function issueReadCapability(broker, identity, root) {
  if (!READ_ROOTS.has(root)) throw new Error('read-root-not-allowed')
  const role = identity?.role
  if (!role) throw new Error('identity-missing')
  return broker.issue({
    role,
    root,
    op: 'read',
    essenceId: String(identity.essenceId || ''),
    forkId: String(identity.forkId || ''),
  })
}

export function checkReadCapability(broker, token, scope) {
  if (!READ_ROOTS.has(scope?.root)) return { ok: false, error: 'access-denied', reason: 'read-root-not-allowed' }
  return broker.resolve({
    token,
    root: scope.root,
    op: 'read',
    essenceId: scope.essenceId || '',
    ownerEssenceId: scope.ownerEssenceId || '',
    forkId: scope.forkId || '',
    ownerForkId: scope.ownerForkId || '',
    path: scope.path || '',
  })
}
