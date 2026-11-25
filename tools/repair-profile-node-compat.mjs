// SPDX-License-Identifier: AGPL-3.0-or-later
// Repair a profile so @twinsearth/dsh-fang-node-compat is installed as the FIRST
// bundle (before every experimental bundle) and client.js carries the waiting label.
// Refuses to run while DSH is alive (ERROR-BOOK EB-03).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback = '') => {
  const i = args.indexOf(name)
  return i >= 0 ? String(args[i + 1] ?? '') : fallback
}
const profile = path.resolve(opt('--profile', path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')))
if (args.includes('--all')) {
  const home = process.env.USERPROFILE ?? ''
  const candidates = [path.join(home, '.dsh', 'profiles', 'desktop')]
  const fangDesktop = path.join(home, '.dsh', 'fang', 'desktop')
  candidates.push(path.join(fangDesktop, 'essences', 'essence-official-dev', 'merged', 'profile'))
  candidates.push(path.join(fangDesktop, 'runtime', 'essence-official-dev', 'home', 'profiles', 'essence-runtime'))
  try {
    for (const task of fs.readdirSync(path.join(fangDesktop, 'forks'))) {
      const profiles = path.join(fangDesktop, 'forks', task, 'profiles')
      if (!fs.existsSync(profiles)) continue
      for (const name of fs.readdirSync(profiles)) candidates.push(path.join(profiles, name))
    }
  } catch { /* no forks */ }
  let failed = 0
  for (const candidate of [...new Set(candidates)]) {
    if (!fs.existsSync(path.join(candidate, 'package.json'))) continue
    try { execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--profile', candidate], { stdio: 'inherit' }) }
    catch { failed += 1 }
  }
  process.exit(failed === 0 ? 0 : 1)
}
if (!fs.existsSync(path.join(profile, 'package.json'))) {
  console.error(`not a profile: ${profile}`)
  process.exit(2)
}
// EB-03: never write a profile while DSH is running.
try {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
  if (/DeepSeek Harness\.exe/i.test(out)) {
    console.error('REFUSED: DeepSeek Harness is running. Close it, then rerun (ERROR-BOOK EB-03).')
    process.exit(2)
  }
} catch { /* tasklist unavailable: continue */ }

const name = '@twinsearth/dsh-fang-node-compat'
const sourcePackage = path.join(ROOT, 'node_modules', ...name.split('/'))
if (!fs.existsSync(path.join(sourcePackage, 'package.json'))) {
  console.error(`missing ${sourcePackage}; run npm install first`)
  process.exit(2)
}
const pkgFile = path.join(profile, 'package.json')
const clientFile = path.join(profile, 'node_modules', '@twinsearth', 'fang-dsh-plugin', 'client.js')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(ROOT, 'archive', 'profile-repair', stamp)
fs.mkdirSync(backup, { recursive: true })
fs.copyFileSync(pkgFile, path.join(backup, 'package.json'))
if (fs.existsSync(clientFile)) fs.copyFileSync(clientFile, path.join(backup, 'client.js'))

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {}
pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
pkg.dependencies[name] = '^0.1.0'
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.filter((item) => item !== name) : []
bundles.unshift(name)
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)

const targetPackage = path.join(profile, 'node_modules', ...name.split('/'))
fs.rmSync(targetPackage, { recursive: true, force: true })
fs.mkdirSync(path.dirname(targetPackage), { recursive: true })
fs.cpSync(sourcePackage, targetPackage, { recursive: true, dereference: true })

const builtClient = path.join(ROOT, 'client.js')
if (fs.existsSync(clientFile) && fs.existsSync(builtClient)) fs.copyFileSync(builtClient, clientFile)
console.log(JSON.stringify({ ok: true, profile, firstBundle: bundles[0], backup, clientUpdated: fs.existsSync(clientFile) }, null, 2))
