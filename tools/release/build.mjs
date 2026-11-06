// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/build.mjs — 构建可发布产物：npm tarball + manifest（零第三方依赖，用系统 tar）。
// 用法：node tools/release/build.mjs [--skip-preflight]
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readJson, versionOf, run, sha256File, selectFilesFromManifest, PUBLISH_NAME, PUBLISH_BASENAME } from './lib.mjs'

const args = process.argv.slice(2)
const skipPreflight = args.includes('--skip-preflight')
const version = versionOf()
const pkg = readJson('package.json')
// 构建前清掉同版本旧产物与校验和，避免 preflight 校验到过期 sidecar
const tarballPath = path.join(ROOT, 'dist', `${PUBLISH_BASENAME}-${version}.tgz`)
fs.rmSync(tarballPath, { force: true })
fs.rmSync(`${tarballPath}.sha256`, { force: true })

if (!skipPreflight) {
  const pre = run(process.execPath, ['tools/release/preflight.mjs', '--json', '--e2e'], { timeoutMs: 900000 })
  if (pre.status !== 0) {
    console.error('FAIL preflight is not GREEN:\n' + (pre.stderr || pre.stdout).slice(-2000))
    process.exit(pre.status ?? 1)
  }
  console.log('preflight: GREEN')
}

const stage = path.join(ROOT, 'dist', 'npm')
const pkgDir = path.join(stage, 'package')
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(pkgDir, { recursive: true })

const files = selectFilesFromManifest(pkg)
for (const rel of files) {
  const src = path.join(ROOT, rel)
  const dest = path.join(pkgDir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (/\.(mjs|js|json|yml|yaml|md|txt)$/.test(rel)) {
    let text = fs.readFileSync(src, 'utf8')
    // The published package is `dsh-fang`, so bundle row names and client ids must match it.
    text = text.split('@local/dsh-fang').join(PUBLISH_NAME)
    fs.writeFileSync(dest, text, 'utf8')
  } else {
    fs.copyFileSync(src, dest)
  }
}

// v3.0.10：发布包必须保留 dsh.client —— Web 端「瓮城」主面板由 client half 提供；
// 桌面壳复用同一 ./client 入口。删掉它会让 npm 安装只剩设置页入口（v3.0.9 事故）。
const stagedDsh = pkg.dsh && typeof pkg.dsh === 'object' ? { ...pkg.dsh } : {}
if (stagedDsh.client === undefined) {
  console.error('FAIL package.json declares no dsh.client; the Web client half cannot load')
  process.exit(1)
}

const stagedPkg = {
  ...pkg,
  name: PUBLISH_NAME,
  version,
  private: false,
  license: 'AGPL-3.0-or-later',
  description: 'dsh-Fang (瓮城) — mother/fork plugin development environment for DeepSeek Harness: one readonly mother, a disposable child dsh-Web per task.',
  repository: { type: 'git', url: 'git+https://github.com/TwinsEarth/dsh-fang.git' },
  homepage: 'https://github.com/TwinsEarth/dsh-fang#readme',
  bugs: { url: 'https://github.com/TwinsEarth/dsh-fang/issues' },
  engines: { node: '>=22' },
  bin: { fangctl: './tools/fangctl.mjs' },
  dsh: stagedDsh,
  files: undefined,
  scripts: { test: pkg.scripts?.test ?? 'node --test --test-concurrency=1 "test/*.test.mjs"' },
}
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n', 'utf8')

const tarball = tarballPath
fs.rmSync(tarball, { force: true })
const tgz = run('tar', ['-czf', tarball, '-C', stage, 'package'])
if (tgz.status !== 0) { console.error('FAIL tar: ' + (tgz.stderr || tgz.stdout)); process.exit(1) }
const listing = run('tar', ['-tzf', tarball])
const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
const fileEntries = entries.filter((e) => !e.endsWith('/') && e.endsWith('/') === false)
if (!entries.includes('package/package.json')) { console.error('FAIL tarball missing package/package.json'); process.exit(1) }
if (entries.some((e) => e.startsWith('package/dist/') || e.startsWith('package/node_modules/'))) {
  console.error('FAIL tarball contains dist/ or node_modules/')
  process.exit(1)
}

const manifest = {
  name: PUBLISH_NAME,
  version,
  at: new Date().toISOString(),
  node: process.versions.node,
  tarball: path.basename(tarball),
  size: fs.statSync(tarball).size,
  sha256: sha256File(tarball),
  entries: entries.length,
  files: entries.filter((e) => e !== 'package/' && !e.endsWith('/')),
  stagedPackageJson: stagedPkg,
  preflight: fs.existsSync(path.join(ROOT, 'dist', 'preflight.json')) ? readJson('dist/preflight.json') : null,
}
fs.writeFileSync(path.join(ROOT, 'dist', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
// 发布物校验和：与 tarball 同目录、内容 `<sha256>  <basename>`
const checksumFile = `${tarball}.sha256`
fs.writeFileSync(checksumFile, `${manifest.sha256}  ${path.basename(tarball)}\n`, 'utf8')

// v3.0.7 门禁：tarball 可安装性冒烟（解包、入口/插件导出、client 归一、行数、sha256）
const smoke = run(process.execPath, ['tools/release/package-smoke.mjs', tarball], { timeoutMs: 120000 })
if (smoke.status !== 0) {
  console.error('FAIL package smoke:\n' + (smoke.stderr || smoke.stdout).slice(-2000))
  process.exit(smoke.status ?? 1)
}
console.log('PASS  package smoke (tarball installability)')

const allow = run(process.execPath, ['tools/release/allowlist.mjs', '--with-manifest', '--json'], { timeoutMs: 120000 })
if (allow.status !== 0) {
  console.error('FAIL allow-list (package):\n' + (allow.stderr || allow.stdout).slice(-1500))
  process.exit(1)
}
console.log('PASS  allow-list (package)')

console.log(`PASS  build ${PUBLISH_NAME}@${version}`)
console.log(`      tarball : dist/${path.basename(tarball)} (${manifest.size} bytes, ${manifest.entries} entries)`)
console.log(`      sha256  : ${manifest.sha256}`)
console.log(`      checksum: dist/${path.basename(checksumFile)}`)
console.log('      manifest: dist/manifest.json')
