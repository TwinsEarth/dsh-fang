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

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name)
  return key ? headers[key] : ''
}

export function resolveIdentity({ headers = {}, url = '/' }, resolveToken) {
  const auth = String(headerValue(headers, 'x-fang-auth') || '')
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headerValue(headers, 'authorization') || ''))?.[1] || ''
  let query = ''
  try { query = new URL(url, 'http://127.0.0.1').searchParams.get('token') || '' } catch { /* ignore */ }
  const token = auth || bearer || query
  if (!token) return { ok: false, status: 401, error: 'unauthorized' }
  if (typeof resolveToken !== 'function') return { ok: false, status: 401, error: 'unauthorized' }
  const identity = resolveToken(token)
  if (!identity) return { ok: false, status: 401, error: 'unauthorized' }
  if (identity.denied) return { ok: false, status: 403, error: 'access-denied', reason: String(identity.reason || 'denied') }
  if (!identity.role) return { ok: false, status: 401, error: 'unauthorized' }
  return {
    ok: true,
    token,
    role: String(identity.role),
    essenceId: String(identity.essenceId || ''),
    forkId: String(identity.forkId || ''),
  }
}

export function denialToHttp(result) {
  if (result?.ok) return null
  const status = result?.status === 403 ? 403 : 401
  return {
    status,
    body: status === 403
      ? { ok: false, error: 'access-denied', reason: String(result?.reason || 'denied') }
      : { ok: false, error: 'unauthorized' },
  }
}
