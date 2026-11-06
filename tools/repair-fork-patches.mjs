// SPDX-License-Identifier: AGPL-3.0-or-later
// 修复被错误追加的 fork profile patch：模板 `[]` 与 `- id:` 混排会让 DSH 启动即崩。
// 用法：node tools/repair-fork-patches.mjs --root <forks 根> [--apply]
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const rootArgs = []
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--root') rootArgs.push(String(argv[i + 1] ?? ''))
const scanRoots = rootArgs.filter(Boolean)

const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
const repaired = []
const skipped = []
for (const root of scanRoots) {
  if (!exists(root)) { skipped.push({ root, reason: 'missing' }); continue }
  for (const fork of fs.readdirSync(root, { withFileTypes: true })) {
    if (!fork.isDirectory()) continue
    const profilesDir = path.join(root, fork.name, 'profiles')
    if (!exists(profilesDir)) continue
    for (const profile of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue
      const file = path.join(profilesDir, profile.name, 'cordis.patch.yml')
      if (!exists(file)) continue
      // cordis.yml 不能只读：DSH 启动时会打开它做规范化写入（只读会 EPERM）。
      const cordisFile = path.join(profilesDir, profile.name, 'cordis.yml')
      if (apply && exists(cordisFile)) { try { fs.chmodSync(cordisFile, 0o644) } catch { /* ignore */ } }
      const raw = fs.readFileSync(file, 'utf8')
      const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)
      const kept = lines.filter((line) => !/^\s*\[\s*\]\s*(#.*)?$/.test(line))
      if (kept.length === lines.length) continue
      const fixed = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
      if (!apply) { repaired.push({ file, dryRun: true }); continue }
      try { fs.chmodSync(file, 0o644) } catch { /* ignore */ }
      fs.writeFileSync(file, fixed, 'utf8')
      try { fs.chmodSync(file, 0o444) } catch { /* ignore */ }
      repaired.push({ file })
    }
  }
}
console.log(JSON.stringify({ ok: true, apply, roots: scanRoots, repaired, skipped }, null, 2))
