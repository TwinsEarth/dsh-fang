// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.9 fail-closed path guard: canonicalize and keep every path inside its root.
import fs from 'node:fs'
import path from 'node:path'

export function safeJoin(root, ...parts) {
  const base = path.resolve(root)
  const target = path.resolve(base, ...parts)
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('path-escape')
  if (String(target).includes('\0')) throw new Error('path-escape')
  return target
}

export function assertInside(root, target, { followSymlink = true } = {}) {
  const base = path.resolve(root)
  let resolved = path.resolve(target)
  let boundary = base
  if (followSymlink) {
    try { boundary = fs.realpathSync.native(base) } catch { /* keep lexical */ }
    try { resolved = fs.realpathSync.native(resolved) } catch {
      try { resolved = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)) } catch { /* keep lexical */ }
    }
  }
  const rel = path.relative(boundary, resolved)
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('path-escape')
  return resolved
}
