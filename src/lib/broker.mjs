// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto'
import { canAccess } from './roots.mjs'

export class Broker {
  constructor(secret) {
    this.secret = secret || crypto.randomBytes(32)
    this.audit = []
  }

  issue({ role, root, op, essenceId = '', forkId = '', ttlMs = 60_000 }) {
    const payload = Buffer.from(JSON.stringify({ role, root, op, essenceId, forkId, exp: Date.now() + ttlMs })).toString('base64url')
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url')
    return `${payload}.${sig}`
  }

  verify(token) {
    const [payload, sig] = String(token || '').split('.')
    if (!payload || !sig) return null
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url')
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    try {
      const caps = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (!caps.exp || caps.exp < Date.now()) return null
      return caps
    } catch { return null }
  }

  resolve({ token, root, op, essenceId = '', ownerEssenceId = '', forkId = '', ownerForkId = '', path = '' }) {
    const caps = this.verify(token)
    const deny = (reason) => {
      this.audit.push({ ok: false, reason, root, op, essenceId, forkId, at: Date.now() })
      return { ok: false, error: 'access-denied', reason }
    }
    if (!caps) return deny('bad-capability')
    if (caps.root !== root || caps.op !== op) return deny('capability-mismatch')
    if (caps.role !== 'coordinator' && caps.essenceId && ownerEssenceId && caps.essenceId !== ownerEssenceId) return deny('wrong-essence')
    if (caps.role === 'fork' && caps.forkId && ownerForkId && caps.forkId !== ownerForkId) return deny('wrong-fork')
    const allowed = canAccess({ role: caps.role, root, op, essenceId: caps.essenceId || essenceId, ownerEssenceId, forkId: caps.forkId || forkId, ownerForkId, path })
    if (!allowed) return deny('matrix')
    this.audit.push({ ok: true, root, op, essenceId: caps.essenceId, forkId: caps.forkId, at: Date.now() })
    return { ok: true, role: caps.role }
  }
}
