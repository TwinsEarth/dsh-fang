// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.8.2: migrate legacy Fang data into the canonical isolated root.
// Copy-only, never delete, never overwrite; run with the DSH host stopped.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] ?? '') : '' }
const dshHome = path.resolve(argValue('--dsh-home') || path.join(process.env.USERPROFILE || '', '.dsh'))
const target = path.resolve(argValue('--to') || 'D:\\ToFuture\\FangData')
const profile = argValue('--profile') || 'desktop'
const legacyData = path.join(dshHome, 'fang', profile)
const legacyRoot = path.join(dshHome, 'fang')
const oldToFuture = 'D:\\ToFuture'
const reportDir = path.join(target, '_migration')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

function hostRunning() {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return out.includes('DeepSeek Harness.exe')
  } catch { return false }
}
function exists(p) { try { return fs.existsSync(p) } catch { return false } }
function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function countTree(root) {
  if (!isDir(root)) return 0
  let n = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name)
    n += entry.isDirectory() ? countTree(p) : 1
  }
  return n
}
function copyNoOverwrite(src, dest, report, skip = new Set()) {
  if (!exists(src)) return
  if (!isDir(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyNoOverwrite(from, to, report, skip)
    else if (!exists(to)) { fs.copyFileSync(from, to); report.copied += 1 }
    else { report.skipped += 1; report.conflicts.push(path.relative(target, to)) }
  }
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n') }

if (hostRunning()) {
  console.error('REFUSED: DeepSeek Harness is running. Fully quit the host before migration.')
  process.exit(2)
}
if (!exists(legacyData) && !exists(path.join(oldToFuture, 'mirror', profile))) {
  console.error(`No legacy Fang data found: ${legacyData} or ${oldToFuture}\\mirror\\${profile}`)
  process.exit(1)
}
if (exists(path.join(target, 'mirror', profile, 'tasks.json')) && !args.includes('--force')) {
  console.error(`REFUSED: target already has tasks: ${path.join(target, 'mirror', profile, 'tasks.json')}`)
  console.error('Move it aside or pass --force after reading the conflict report.')
  process.exit(3)
}

const sources = []
if (exists(legacyData)) sources.push({ kind: 'dsh-home', dataDir: legacyData, forks: path.join(legacyData, 'forks'), essences: path.join(legacyData, 'essences'), sessions: path.join(legacyData, 'sessions') })
const oldData = path.join(oldToFuture, 'mirror', profile)
if (exists(oldData) && path.resolve(oldData) !== path.resolve(legacyData)) sources.push({ kind: 'tofuture-old', dataDir: oldData, forks: path.join(oldToFuture, 'forks'), essences: path.join(oldToFuture, 'essence'), sessions: path.join(oldToFuture, 'sessions') })

const report = { stamp, apply, dshHome, target, profile, sources, copied: 0, skipped: 0, conflicts: [], files: {}, ok: false }
console.log(JSON.stringify({ dryRun: !apply, target, sources: sources.map((s) => s.dataDir) }, null, 2))
if (!apply) {
  report.ok = true
  console.log('DRY RUN: add --apply to copy. Source data is never deleted.')
  process.exit(0)
}

fs.mkdirSync(reportDir, { recursive: true })
for (const source of sources) {
  copyNoOverwrite(source.dataDir, path.join(target, 'mirror', profile), report, new Set(['forks', 'essences', 'sessions']))
  copyNoOverwrite(source.forks, path.join(target, 'forks'), report)
  copyNoOverwrite(source.essences, path.join(target, 'essence'), report)
  copyNoOverwrite(source.sessions, path.join(target, 'sessions'), report)
}
// Rewrite fork homeDir references to the canonical root (registry is copied, not moved).
const tasksFile = path.join(target, 'mirror', profile, 'tasks.json')
if (exists(tasksFile)) {
  const doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : Array.isArray(doc.forks) ? doc.forks : []
  for (const task of tasks) {
    const id = String(task.taskId || task.forkId || '')
    if (id && exists(path.join(target, 'forks', id))) task.homeDir = path.join(target, 'forks', id)
  }
  if (Array.isArray(doc.tasks)) doc.tasks = tasks
  else doc.forks = tasks
  writeJson(tasksFile, doc)
  report.files.tasks = { path: tasksFile, sha256: hashFile(tasksFile), count: tasks.length }
}
const pointerFile = path.join(legacyRoot, 'fang-home.txt')
fs.mkdirSync(legacyRoot, { recursive: true })
fs.writeFileSync(pointerFile, target + '\n')
report.files.pointer = pointerFile
report.files.targetTasks = exists(tasksFile) ? hashFile(tasksFile) : null
report.files.targetFiles = countTree(target)
report.ok = true
writeJson(path.join(reportDir, `migration-${stamp}.json`), report)
console.log(`MIGRATED -> ${target}`)
console.log(`report: ${path.join(reportDir, `migration-${stamp}.json`)}`)
console.log(`source preserved; conflicts=${report.conflicts.length}`)
