// SPDX-License-Identifier: AGPL-3.0-or-later
// 把旧布局（$DSH_HOME/fang/<tag>）迁移到 FANG_HOME 三区布局。
//
// 用法（宿主必须已停止）：
//   node tools/migrate-to-fang-home.mjs --profile desktop            # dry-run，只打印计划
//   node tools/migrate-to-fang-home.mjs --profile desktop --apply    # 真正执行（先自动备份）
//
// 目标布局：
//   <fangHome>/mirror/<tag>/    母体（mirror/active|backup|restore + tasks.json 等）
//   <fangHome>/essence/         原身沙箱（essence-*）
//   <fangHome>/forks/           分身 home（task_*，tasks.json 的 homeDir 会被重写）
//   <fangHome>/sessions/<id>/home/  运行态 DSH_HOME
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf('--' + name)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const flag = (name) => argv.includes('--' + name)

const profile = arg('profile', 'desktop')
const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(process.env.USERPROFILE ?? '', '.dsh')
const legacyDir = path.resolve(arg('from', path.join(dshHome, 'fang', profile)))
const fangHome = path.resolve(arg('to', process.env.FANG_HOME || 'D:/ToFuture'))
const apply = flag('apply')
const force = flag('force')

const paths = {
  dataDir: path.join(fangHome, 'mirror', profile),
  essence: path.join(fangHome, 'essence'),
  forks: path.join(fangHome, 'forks'),
  sessions: path.join(fangHome, 'sessions'),
}

const size = (dir) => {
  let total = 0
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      // 不跟随 junction/symlink：node_modules 只是链接，展开会复制出几十 GB。
      try { if (fs.readlinkSync(p)) continue } catch { /* 普通文件/目录 */ }
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) total += fs.statSync(p).size
    }
  }
  try { walk(dir) } catch { /* 不存在 */ }
  return total
}
const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
// junction 感知复制：目录递归、文件复制、symlink/junction 原样重建（不展开目标）。
const cp = (from, to) => {
  const stack = [[from, to]]
  while (stack.length > 0) {
    const [src, dst] = stack.pop()
    let st
    try { st = fs.lstatSync(src) } catch { continue }
    let isLink = false
    try { isLink = Boolean(fs.readlinkSync(src)) } catch { isLink = false }
    if (isLink) {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      try {
        const target = fs.readlinkSync(src)
        fs.symlinkSync(target, dst, process.platform === 'win32' ? 'junction' : 'dir')
      } catch { /* 链接无法重建则跳过（不展开） */ }
      continue
    }
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true })
      for (const entry of fs.readdirSync(src)) stack.push([path.join(src, entry), path.join(dst, entry)])
      continue
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

if (!exists(legacyDir)) {
  console.error(`[migrate] 旧数据目录不存在: ${legacyDir}`)
  process.exit(2)
}
const plan = []
const add = (label, from, to) => plan.push({ label, from, to, bytes: size(from) })
if (exists(path.join(legacyDir, 'mirror'))) add('mirror', path.join(legacyDir, 'mirror'), path.join(paths.dataDir, 'mirror'))
for (const file of ['tasks.json', 'forks.json', 'fang-auth.json', 'audit.jsonl', 'compat-status.json', 'composer-journal.json', 'state.json']) {
  const from = path.join(legacyDir, file)
  if (exists(from)) add('file:' + file, from, path.join(paths.dataDir, file))
}
if (exists(path.join(legacyDir, 'essences'))) add('essences', path.join(legacyDir, 'essences'), paths.essence)
if (exists(path.join(legacyDir, 'forks'))) add('forks', path.join(legacyDir, 'forks'), paths.forks)
if (exists(path.join(legacyDir, 'runtime'))) add('runtime', path.join(legacyDir, 'runtime'), paths.sessions)

console.log(`[migrate] 旧布局: ${legacyDir}`)
console.log(`[migrate] 新布局: ${fangHome}  (profile=${profile})`)
for (const item of plan) console.log(`  ${item.label.padEnd(18)} ${(item.bytes / 1048576).toFixed(1)} MB  ->  ${item.to}`)

if (!apply) {
  console.log('[migrate] DRY-RUN：未做任何修改。加 --apply 执行（会先备份旧目录）。')
  process.exit(0)
}
if (!force) {
  const occupied = [paths.dataDir, paths.essence, paths.forks, paths.sessions].filter((dir) => exists(dir) && fs.readdirSync(dir).length > 0)
  if (occupied.length > 0) {
    console.error('[migrate] 目标非空，拒绝迁移（确认后加 --force）：' + occupied.join(', '))
    process.exit(3)
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = legacyDir + '.bak-' + stamp
console.log(`[migrate] 备份旧目录 -> ${backupDir}`)
cp(legacyDir, backupDir)

for (const item of plan) {
  console.log(`[migrate] 复制 ${item.label}`)
  cp(item.from, item.to)
}

// tasks.json / forks.json 里的绝对 homeDir 从旧 forks 根改到新 forks 根（结构化解码，兼容 JSON 转义）
const rewrite = (file) => {
  if (!exists(file)) return
  let doc
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
  const oldForks = path.join(legacyDir, 'forks')
  let changed = 0
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (!node || typeof node !== 'object') return
    for (const key of Object.keys(node)) {
      const value = node[key]
      if (typeof value === 'string' && value.startsWith(oldForks)) {
        node[key] = paths.forks + value.slice(oldForks.length)
        changed += 1
      } else {
        walk(value)
      }
    }
  }
  walk(doc)
  if (changed > 0) {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    console.log(`[migrate] 重写路径: ${file} (${changed} 处)`)
  }
}
rewrite(path.join(paths.dataDir, 'tasks.json'))
rewrite(path.join(paths.dataDir, 'forks.json'))

// 运行态：旧 runtime/rt-<id>/home -> sessions/essence-<id>/home
const legacyRuntime = path.join(legacyDir, 'runtime')
if (exists(legacyRuntime)) {
  for (const entry of fs.readdirSync(legacyRuntime, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('rt-')) continue
    const essenceId = 'essence-' + entry.name.slice(3)
    const from = path.join(legacyRuntime, entry.name, 'home')
    if (!exists(from)) continue
    const target = path.join(paths.sessions, essenceId, 'home')
    if (exists(target) && fs.readdirSync(target).length > 0) continue
    cp(from, target)
    console.log(`[migrate] 运行态 ${entry.name} -> ${target}`)
  }
}

fs.writeFileSync(path.join(paths.dataDir, 'migrated-to-fang-home.json'), JSON.stringify({
  at: new Date().toISOString(), from: legacyDir, to: fangHome, profile, backupDir,
}, null, 2) + '\n', 'utf8')

console.log('[migrate] 完成。')
console.log('[migrate] 下一步：设置 FANG_HOME=' + fangHome + '（或 fang 配置 fangHome），重启宿主。')
