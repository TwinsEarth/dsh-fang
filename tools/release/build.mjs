// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/build.mjs — 构建可发布产物：npm tarball + manifest（零第三方依赖，用系统 tar）。
// 用法：node tools/release/build.mjs [--skip-preflight]
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readJson, versionOf, run, sha256File, selectFilesFromManifest } from './lib.mjs'

const args = process.argv.slice(2)
const skipPreflight = args.includes('--skip-preflight')
const version = versionOf()
const pkg = readJson('package.json')

if (!skipPreflight) {
  const pre = run(process.execPath, ['tools/release/preflight.mjs', '--json'], { timeoutMs: 900000 })
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
    text = text.split('@local/dsh-fang').join('dsh-fang')
    fs.writeFileSync(dest, text, 'utf8')
  } else {
    fs.copyFileSync(src, dest)
  }
}

const stagedPkg = {
  ...pkg,
  name: 'dsh-fang',
  version,
  private: false,
  license: 'AGPL-3.0-or-later',
  description: 'dsh-Fang (瓮城) — mother/fork plugin development environment for DeepSeek Harness: one readonly mother, a disposable child dsh-Web per task.',
  repository: { type: 'git', url: 'git+https://github.com/TwinsEarth/dsh-fang.git' },
  homepage: 'https://github.com/TwinsEarth/dsh-fang#readme',
  bugs: { url: 'https://github.com/TwinsEarth/dsh-fang/issues' },
  engines: { node: '>=22' },
  bin: { fangctl: './tools/fangctl.mjs' },
  files: undefined,
  scripts: { test: pkg.scripts?.test ?? 'node --test --test-concurrency=1 "test/*.test.mjs"' },
}
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n', 'utf8')

const tarball = path.join(ROOT, 'dist', `dsh-fang-${version}.tgz`)
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
  name: 'dsh-fang',
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

console.log(`PASS  build dsh-fang@${version}`)
console.log(`      tarball : dist/${path.basename(tarball)} (${manifest.size} bytes, ${manifest.entries} entries)`)
console.log(`      sha256  : ${manifest.sha256}`)
console.log('      manifest: dist/manifest.json')
