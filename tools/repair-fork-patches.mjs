// SPDX-License-Identifier: AGPL-3.0-or-later
// 修复 fork profile patch：
//   1) 去掉模板遗留的 `[]`（与 `- id:` 混排会让 DSH 启动即崩）；
//   2) 去掉会破坏客户端服务图的旧禁用项（config-editor/ui-settings* 移除 configForms，
//      导致 locale 及之后 50 个客户端插件永久 pending）；
//   3) 用当前安全集合重新加锁；
//   4) cordis.yml 保持可写（DSH 启动会写它）。
// 用法：node tools/repair-fork-patches.mjs --root <forks 根> [--apply]
import fs from 'node:fs'
import path from 'node:path'
import { applyForkConfigLock } from '../src/lib/fork-config-lock.mjs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const rootArgs = []
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--root') rootArgs.push(String(argv[i + 1] ?? ''))
const scanRoots = rootArgs.filter(Boolean)

const BAD_IDS = new Set([
  'plugin-manager', 'config-editor', 'ui-settings', 'ui-settings-account', 'ui-settings-general',
  'tool-plugin-manager',
])

const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
const stripBadBlocks = (lines) => {
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*-\s*id:\s*([A-Za-z0-9_-]+)\s*$/.exec(lines[i])
    if (match && BAD_IDS.has(match[1])) {
      // 跳过该条目的后续缩进行（通常只有 `  disabled: true`）
      let j = i + 1
      while (j < lines.length && /^\s+\S/.test(lines[j])) j += 1
      i = j - 1
      continue
    }
    kept.push(lines[i])
  }
  return kept
}

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
      const profileDir = path.join(profilesDir, profile.name)
      const file = path.join(profileDir, 'cordis.patch.yml')
      if (!exists(file)) continue
      const cordisFile = path.join(profileDir, 'cordis.yml')
      const raw = fs.readFileSync(file, 'utf8')
      const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)
        .filter((line) => !/^\s*\[\s*\]\s*(#.*)?$/.test(line))
      const stripped = stripBadBlocks(lines).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
      if (!apply) { repaired.push({ file, dryRun: true }); continue }
      try { fs.chmodSync(file, 0o644) } catch { /* ignore */ }
      fs.writeFileSync(file, stripped, 'utf8')
      if (exists(cordisFile)) { try { fs.chmodSync(cordisFile, 0o644) } catch { /* ignore */ } }
      try { applyForkConfigLock(profileDir) } catch { /* 锁失败不阻塞修复 */ }
      try { fs.chmodSync(file, 0o444) } catch { /* ignore */ }
      repaired.push({ file })
    }
  }
}
console.log(JSON.stringify({ ok: true, apply, roots: scanRoots, repaired, skipped }, null, 2))
