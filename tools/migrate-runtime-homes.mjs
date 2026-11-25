// SPDX-License-Identifier: AGPL-3.0-or-later
// 把迁移后仍留在 <FANG_HOME>/essence/<id>/runtime/home 的运行态 home 归口到
// <FANG_HOME>/sessions/<essenceId>/home（三区规则）。同盘 rename，快且不复制。
// 用法：node tools/migrate-runtime-homes.mjs --home D:/ToFuture [--apply]
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? String(argv[i + 1] ?? '') : fallback
}
const apply = argv.includes('--apply')
const fangHome = path.resolve(arg('home', process.env.FANG_HOME || process.env.USERPROFILE + '/.dsh/fang'))
const essenceRoot = path.join(fangHome, 'essence')
const sessionsRoot = path.join(fangHome, 'sessions')

const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
if (!exists(essenceRoot)) {
  console.error('[runtime-migrate] essence root missing: ' + essenceRoot)
  process.exit(2)
}

const moved = []
const skipped = []

// 目标已存在时做合并：目录递归、文件覆盖（先解锁）、链接保留不展开。
const mergeCopy = (src, dst) => {
  const stack = [[src, dst]]
  while (stack.length > 0) {
    const [from, to] = stack.pop()
    let st
    try { st = fs.lstatSync(from) } catch { continue }
    let isLink = false
    try { isLink = Boolean(fs.readlinkSync(from)) } catch { isLink = false }
    if (isLink) {
      if (!exists(to)) {
        try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.symlinkSync(fs.readlinkSync(from), to, process.platform === 'win32' ? 'junction' : 'dir') } catch { /* skip */ }
      }
      continue
    }
    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true })
      for (const name of fs.readdirSync(from)) stack.push([path.join(from, name), path.join(to, name)])
      continue
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try { if (exists(to)) fs.chmodSync(to, 0o644) } catch { /* ignore */ }
    fs.copyFileSync(from, to)
  }
}

for (const entry of fs.readdirSync(essenceRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const runtimeHome = path.join(essenceRoot, entry.name, 'runtime', 'home')
  if (!exists(runtimeHome)) continue
  const target = path.join(sessionsRoot, entry.name, 'home')
  if (!apply) {
    moved.push({ essenceId: entry.name, from: runtimeHome, to: target, dryRun: true, merged: exists(target) })
    continue
  }
  try {
    if (exists(target)) {
      mergeCopy(runtimeHome, target)
      fs.rmSync(path.join(essenceRoot, entry.name, 'runtime'), { recursive: true, force: true })
      moved.push({ essenceId: entry.name, from: runtimeHome, to: target, merged: true })
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(runtimeHome, target)
      try { fs.rmSync(path.join(essenceRoot, entry.name, 'runtime'), { recursive: true, force: true }) } catch { /* 残留不阻塞 */ }
      moved.push({ essenceId: entry.name, from: runtimeHome, to: target })
    }
  } catch (error) {
    skipped.push({ essenceId: entry.name, reason: String(error?.message ?? error) })
  }
}
console.log(JSON.stringify({ ok: true, apply, essenceRoot, sessionsRoot, moved, skipped }, null, 2))
