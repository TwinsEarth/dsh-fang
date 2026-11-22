// SPDX-License-Identifier: AGPL-3.0-or-later
// Global red line for every Fang fork: a fork process may write its own DSH_HOME,
// but never the mother profile/client install, mother data, or another fork home.
// This is an in-process guard, not an OS sandbox: a child process spawned by a
// plugin is outside its reach, so deploy-time ACL is still the hard boundary.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARK = Symbol.for('dsh-fang.global-redline')
const WRITE_FLAGS = /[wa+]/i

function norm(p) {
  const value = path.resolve(String(p ?? ''))
  try { return fs.realpathSync.native(value) } catch { /* may not exist */ }
  let parent = path.dirname(value)
  const tail = [path.basename(value)]
  for (let i = 0; i < 20; i += 1) {
    try {
      const real = fs.realpathSync.native(parent)
      return path.join(real, ...tail)
    } catch {
      const next = path.dirname(parent)
      if (next === parent) break
      tail.unshift(path.basename(parent))
      parent = next
    }
  }
  return value
}

function isUnder(child, parent) {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

export function installGlobalRedline({
  ownHome,
  motherData,
  profilesRoot = path.join(os.homedir(), '.dsh', 'profiles'),
  installRoot = path.dirname(process.execPath),
  logger = null,
} = {}) {
  if (globalThis[MARK]?.installed) return { ok: true, already: true, protected: globalThis[MARK].protected }
  const own = String(ownHome ?? process.env.DSH_HOME ?? '')
  if (!own) return { ok: false, error: 'own-home-missing' }
  const mother = String(motherData ?? process.env.DSH_FANG_MOTHER ?? '')
  const protectedRoots = [
    profilesRoot,
    installRoot,
    mother ? path.join(mother, 'essences') : '',
    mother ? path.join(mother, 'runtime') : '',
    mother ? path.join(mother, 'forks') : '',
    mother ? path.join(mother, '.plugin-manager') : '',
    mother ? path.join(mother, 'mirror') : '',
    mother ? path.join(mother, 'tasks') : '',
    mother ? path.join(mother, 'endpoint.json') : '',
    mother ? path.join(mother, 'tasks.json') : '',
    mother ? path.join(mother, 'audit.jsonl') : '',
    mother ? path.join(mother, 'fang-auth.json') : '',
    mother ? path.join(mother, 'default-essence.json') : '',
    mother ? path.join(mother, 'decision-center.json') : '',
  ].filter(Boolean)

  const deny = (target, action) => {
    const message = `[fang-global-redline] 分身禁止 ${action} 母体/客户端/其他分身路径：${target}`
    const error = new Error(message)
    error.code = 'EPERM'
    error.fangRedline = true
    try { logger?.error?.(message) } catch { /* ignore */ }
    try {
      const logDir = path.join(own, 'fang')
      fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(path.join(logDir, 'global-redline.log'), `${new Date().toISOString()} ${message}\n`)
    } catch { /* ignore */ }
    return error
  }

  const check = (target, action) => {
    if (typeof target !== 'string' && !(target instanceof URL)) return null
    const value = target instanceof URL ? target.pathname : target
    if (!value) return null
    const resolved = path.resolve(String(value))
    if (isUnder(resolved, own)) return null
    for (const root of protectedRoots) {
      if (isUnder(resolved, root)) return deny(resolved, action)
    }
    return null
  }

  const guardArgs = (action, indexes) => (args) => {
    for (const index of indexes) {
      const error = check(args[index], action)
      if (error) throw error
    }
  }

  const wrap = (owner, name, action, indexes) => {
    const original = owner?.[name]
    if (typeof original !== 'function') return
    const guard = guardArgs(action, indexes)
    owner[name] = function guarded(...args) {
      guard(args)
      return original.apply(this, args)
    }
  }

  const fsPromises = fs.promises
  const syncSpecs = [
    ['writeFileSync', [0]], ['appendFileSync', [0]], ['renameSync', [0, 1]],
    ['copyFileSync', [1]], ['cpSync', [1]], ['unlinkSync', [0]], ['rmSync', [0]],
    ['rmdirSync', [0]], ['mkdirSync', [0]], ['symlinkSync', [1]], ['linkSync', [1]],
    ['chmodSync', [0]], ['truncateSync', [0]],
  ]
  for (const [name, indexes] of syncSpecs) wrap(fs, name, name.replace(/Sync$/, ''), indexes)
  const asyncSpecs = [
    ['writeFile', [0]], ['appendFile', [0]], ['rename', [0, 1]], ['copyFile', [1]],
    ['cp', [1]], ['unlink', [0]], ['rm', [0]], ['rmdir', [0]], ['mkdir', [0]],
    ['symlink', [1]], ['link', [1]], ['chmod', [0]], ['truncate', [0]],
  ]
  for (const [name, indexes] of asyncSpecs) wrap(fs, name, name, indexes)
  for (const [name, indexes] of asyncSpecs) wrap(fsPromises, name, `promises.${name}`, indexes)

  const isWriteFlags = (flags) => {
    if (flags === undefined) return true
    if (typeof flags === 'number') {
      const c = fs.constants
      return (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND)) !== 0
    }
    return WRITE_FLAGS.test(String(flags))
  }
  const wrapOpen = (owner, name, label) => {
    const original = owner?.[name]
    if (typeof original !== 'function') return
    owner[name] = function guardedOpen(target, flags, ...rest) {
      if (isWriteFlags(flags)) {
        const error = check(target, label)
        if (error) throw error
      }
      return original.call(this, target, flags, ...rest)
    }
  }
  wrapOpen(fs, 'openSync', 'openSync')
  wrapOpen(fs, 'open', 'open')
  wrapOpen(fsPromises, 'open', 'promises.open')

  const originalCreateWriteStream = fs.createWriteStream
  if (typeof originalCreateWriteStream === 'function') {
    fs.createWriteStream = function guardedCreateWriteStream(target, ...rest) {
      const error = check(target, 'createWriteStream')
      if (error) throw error
      return originalCreateWriteStream.call(this, target, ...rest)
    }
  }

  const state = { installed: true, protected: protectedRoots, ownHome: own }
  globalThis[MARK] = state
  return { ok: true, installed: true, protected: protectedRoots, ownHome: own }
}

export function globalRedlineInstalled() {
  return globalThis[MARK]?.installed === true
}
