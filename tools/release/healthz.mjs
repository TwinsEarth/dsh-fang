// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/healthz.mjs — 发布健康检查：本地 tarball 完整性 + 模块可加载 +（可选）远端 npm/GitHub。
// 用法：node tools/release/healthz.mjs [--from-dist] [--remote] [--serve]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, readJson, run, serveHealthz, PUBLISH_NAME } from './lib.mjs'

const args = process.argv.slice(2)
const remote = args.includes('--remote')
const serve = args.includes('--serve')
const checks = []
const add = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail })

const manifest = fs.existsSync(path.join(ROOT, 'dist', 'manifest.json')) ? readJson('dist/manifest.json') : null
if (!manifest) { console.error('FAIL no dist/manifest.json — run node tools/release/build.mjs first'); process.exit(2) }
const tarball = path.join(ROOT, 'dist', manifest.tarball)
add('artifact: tarball exists', fs.existsSync(tarball), manifest.tarball)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-health-'))
let info = { name: manifest.name, version: manifest.version, license: null, kernel: null, plugins: [] }
try {
  const x = run('tar', ['-xzf', tarball, '-C', tmp])
  add('artifact: extract', x.status === 0, (x.stderr || '').slice(0, 200))
  const pkgDir = path.join(tmp, 'package')
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  add('package: name is the published scope', pkg.name === PUBLISH_NAME, pkg.name)
  add('package: version matches manifest', pkg.version === manifest.version, `${pkg.version} vs ${manifest.version}`)
  add('package: AGPL license', pkg.license === 'AGPL-3.0-or-later', String(pkg.license))
  add('package: LICENSE-CORE shipped', fs.existsSync(path.join(pkgDir, 'LICENSE-CORE')))
  add('package: client half shipped', fs.existsSync(path.join(pkgDir, 'client.js')))
  add('package: dsh.client enabled', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client ?? null))
  add('package: bundle patch shipped', fs.existsSync(path.join(pkgDir, 'cordis.patch.yml')))
  add('package: no dist/node_modules inside', !fs.existsSync(path.join(pkgDir, 'dist')) && !fs.existsSync(path.join(pkgDir, 'node_modules')))

  const kernel = await import(pathToFileURL(path.join(pkgDir, 'src/kernel/index.mjs')).href)
  info.kernel = kernel.FANG_VERSION
  add('kernel: FANG_VERSION matches', kernel.FANG_VERSION === manifest.version, kernel.FANG_VERSION)

  const plugins = fs.readdirSync(path.join(pkgDir, 'src/plugins')).filter((f) => f.endsWith('.mjs') && f !== 'imports.mjs')
  for (const file of plugins) {
    const mod = await import(pathToFileURL(path.join(pkgDir, 'src/plugins', file)).href)
    if (typeof mod.apply !== 'function') add(`plugin: ${file} exports apply`, false)
    info.plugins.push({ file, name: mod.name ?? file })
  }
  add('plugins: all modules import on this node', info.plugins.length >= 10, `${info.plugins.length} modules`)
  info.license = pkg.license
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (remote) {
  const { retryHttpJson } = await import('./lib.mjs')
  // v3.1.19：npm / GitHub 的发布传播是最终一致的，单次请求会把「刚发完」误判为失败。
  // 默认 8 次、5s 起指数退避（5,10,20,40,60,60,60 ≈ 4 分钟），可用环境变量调参。
  const attempts = Number(process.env.FANG_HEALTHZ_ATTEMPTS ?? 8)
  const baseMs = Number(process.env.FANG_HEALTHZ_BACKOFF_MS ?? 5_000)
  const capMs = Number(process.env.FANG_HEALTHZ_MAX_DELAY_MS ?? 60_000)
  const backoff = { attempts, baseMs, capMs, log: (m) => console.log('WAIT  remote: ' + m) }

  const npmNamePath = manifest.name.replace('/', '%2F')
  const npm = await retryHttpJson(`https://registry.npmjs.org/${npmNamePath}/latest`, {
    ...backoff,
    predicate: (r) => r.status === 200 && r.data?.version === manifest.version,
  })
  add('remote: npm package published', npm.status === 200 && npm.data?.version === manifest.version,
    `status=${npm.status} version=${npm.data?.version ?? '(none)'} attempts=${npm.attempts}`)

  const gh = await retryHttpJson('https://api.github.com/repos/TwinsEarth/dsh-fang/releases/tags/v' + manifest.version, {
    ...backoff,
    predicate: (r) => r.status === 200,
  })
  add('remote: GitHub release exists', gh.status === 200, `status=${gh.status} attempts=${gh.attempts}`)
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(44)} ${c.detail}`)
const ok = checks.every((c) => c.ok)
const health = { ok, ...info, node: process.versions.node, at: new Date().toISOString(), checks }
if (serve) {
  serveHealthz(() => health)
  console.log('healthz: serving /healthz (Ctrl+C to stop)')
} else {
  console.log(`\n${ok ? 'HEALTHY' : 'UNHEALTHY'}  ${health.name}@${health.version}  (node ${health.node})`)
  process.exitCode = ok ? 0 : 1
}
