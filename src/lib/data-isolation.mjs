// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.8.2 data-root isolation. Fang data (mirror/essence/forks/sessions) must
// never resolve inside the host/client/project tree (notably E:\DSH\DS).
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_FANG_DATA_ROOT = 'D:\\ToFuture\\FangData'
export const DEFAULT_FORBIDDEN_ROOTS = ['E:\\DSH\\DS', 'E:\\DSH\\DS\\Fang', 'D:\\DSH\\DS\\Fang']

function normalize(value) { return path.resolve(String(value ?? '')).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() }

export function isPathInside(child, parent) {
  const c = normalize(child)
  const p = normalize(parent)
  if (!c || !p) return false
  return c === p || c.startsWith(p + '/')
}

/** Pure guard: returns an error code instead of throwing. */
export function assertDataPath(target, { fangHome = '', forbiddenRoots = DEFAULT_FORBIDDEN_ROOTS } = {}) {
  const resolved = path.resolve(String(target ?? ''))
  for (const root of forbiddenRoots) {
    if (root && isPathInside(resolved, root)) return { ok: false, error: 'data-root-forbidden', target: resolved, forbiddenRoot: root }
  }
  if (fangHome && !isPathInside(resolved, fangHome)) return { ok: false, error: 'data-root-outside-fang-home', target: resolved, fangHome }
  return { ok: true, target: resolved }
}

export function ensureDataPath(target, options) {
  const check = assertDataPath(target, options)
  if (check.ok !== true) {
    const error = new Error(check.error)
    error.code = check.error
    error.detail = check
    throw error
  }
  fs.mkdirSync(path.dirname(check.target), { recursive: true })
  return check.target
}

export function workspaceForFork(homeDir) {
  const home = String(homeDir)
  // Windows drive paths are still tested on Linux CI; path.join would mix separators there.
  const joiner = /^[A-Za-z]:\\/.test(home) ? path.win32 : path
  return joiner.join(home, 'workspace')
}
