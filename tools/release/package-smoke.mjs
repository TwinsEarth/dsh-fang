// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/package-smoke.mjs — PKG-01：tarball 可安装性冒烟（纯本机、无网络）。
// 用法：node tools/release/package-smoke.mjs <tarball> [--keep]
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tarball = path.resolve(process.argv[2] ?? '')
const KEEP = process.argv.includes('--keep')
if (!tarball || !fs.existsSync(tarball)) {
  console.error('FAIL package-smoke: tarball not found:', tarball)
  process.exit(2)
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-pkg-smoke-'))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed += 1
}

try {
  execFileSync('tar', ['-xzf', tarball, '-C', tmp], { stdio: 'pipe' })
  const pkgDir = path.join(tmp, 'package')
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))

  check('package.json present', !!pkg.name && !!pkg.version, `${pkg.name}@${pkg.version}`)
  check('exports client subpath', pkg.exports?.['./client']?.browser === './client.js' || pkg.exports?.['./client'] === './client.js')
  // A2：浏览器 client half 必须禁用；client 入口保留给桌面壳
  check('browser client half disabled', pkg.dsh?.client === undefined)
  check('client entry kept for desktop shell', Boolean(pkg.exports?.['./client']))

  const clientInPkg = path.join(pkgDir, 'client.js')
  check('client.js shipped', fs.existsSync(clientInPkg))
  if (fs.existsSync(clientInPkg)) {
    // build 会把 `@local/dsh-fang` 重写为发布包名（PUBLISH_NAME）；按同样规则归一后比较
    const expected = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8').split('@local/dsh-fang').join(pkg.name)
    check('client.js matches repo after publish rewrite', sha256(Buffer.from(expected)) === sha256(fs.readFileSync(clientInPkg)))
  }

  const entry = path.join(pkgDir, 'src', 'index.mjs')
  check('server entry exists', fs.existsSync(entry))
  const mod = await import(pathToFileURL(entry).href)
  check('server entry exports apply()', typeof mod.apply === 'function')

  const patchPath = path.join(pkgDir, 'cordis.patch.yml')
  const patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
  const rowIds = [...patch.matchAll(/^\s*-\s*id:\s*['"]?([A-Za-z0-9_-]+)/gm)].map((m) => m[1])
  check('cordis rows = 16', rowIds.length === 16, `rows=${rowIds.length}`)
  check('no invalid ui-fang loader row', !rowIds.includes('ui-fang'))

  const pluginsDir = path.join(pkgDir, 'src', 'plugins')
  const pluginFiles = fs.readdirSync(pluginsDir).filter((f) => f.endsWith('.mjs') && f !== 'imports.mjs')
  check('plugin modules >= 16', pluginFiles.length >= 16, `modules=${pluginFiles.length}`)
  let bad = 0
  for (const file of pluginFiles) {
    try {
      const m = await import(pathToFileURL(path.join(pluginsDir, file)).href)
      if (typeof m.apply !== 'function') bad += 1
    } catch { bad += 1 }
  }
  check('all plugin modules import with apply()', bad === 0, bad ? `bad=${bad}` : '')

  const sidecar = `${tarball}.sha256`
  const digest = sha256(fs.readFileSync(tarball))
  const sidecarOk = fs.existsSync(sidecar) && fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] === digest
  check('sha256 sidecar matches tarball', sidecarOk, digest.slice(0, 16))
} catch (error) {
  console.error('FAIL package-smoke:', String(error?.message ?? error))
  failed += 1
} finally {
  if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true })
  else console.log('keep:', tmp)
}

if (failed > 0) {
  console.error(`FAIL package-smoke (${failed} checks failed)`)
  process.exit(1)
}
console.log('PASS package-smoke (tarball installability)')
