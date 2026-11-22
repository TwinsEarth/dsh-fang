// SPDX-License-Identifier: AGPL-3.0-or-later
// src/lib/watch-guard.mjs — 2026-11-22 宿主 EPERM watch 崩溃的止损层。
//
// DSH Desktop host 的 fs.watch 在 profile 目录被替换/权限变化时会发出
// `error {code:'EPERM'}`；如果没有 error 监听，Node 会抛 uncaughtException 并让 host
// 以 exit 1 退出（真机事故）。这里在瓮城插件加载时包装 fs.watch / fs.watchFile，
// 为每个 watcher 挂 error 监听并降级为日志，绝不让单个 watcher 错误杀死宿主。
//
// 注意：这是止损，不是替代 DSH 上游修复；上游仍应把 watcher error 记录为 warning 并重建 watcher。
import fs from 'node:fs'

const GUARDED = Symbol.for('fang.watchGuard.installed')
const ORIGINAL_WATCH = fs.watch
const ORIGINAL_WATCH_FILE = fs.watchFile

export function installWatchGuard({ logger = null } = {}) {
  if (fs.watch[GUARDED] === true) return { ok: true, already: true, repaired: 0 }
  let repaired = 0
  const onError = (scope) => (error) => {
    repaired += 1
    const code = String(error?.code ?? 'unknown')
    try { logger?.warn?.(`[fang] ${scope} watcher error downgraded: ${code}`) } catch { /* logger must never throw */ }
  }
  const watched = function fangGuardedWatch(...args) {
    const watcher = ORIGINAL_WATCH.apply(this, args)
    try { watcher.on('error', onError('fs.watch')) } catch { /* non-EventEmitter watcher */ }
    return watcher
  }
  watched[GUARDED] = true
  watched.__fangOriginal = ORIGINAL_WATCH
  const watchedFile = function fangGuardedWatchFile(...args) {
    const out = ORIGINAL_WATCH_FILE.apply(this, args)
    return out
  }
  watchedFile[GUARDED] = true
  watchedFile.__fangOriginal = ORIGINAL_WATCH_FILE
  try { fs.watch = watched } catch { return { ok: false, error: 'fs-watch-readonly' } }
  try { fs.watchFile = watchedFile } catch { /* optional */ }
  return { ok: true, already: false, repaired }
}

export function watchGuardInstalled() {
  return fs.watch[GUARDED] === true
}

export function uninstallWatchGuard() {
  if (fs.watch[GUARDED] !== true) return { ok: true, removed: false }
  try { fs.watch = fs.watch.__fangOriginal ?? ORIGINAL_WATCH } catch { /* ignore */ }
  try { fs.watchFile = fs.watchFile.__fangOriginal ?? ORIGINAL_WATCH_FILE } catch { /* ignore */ }
  return { ok: true, removed: true }
}
