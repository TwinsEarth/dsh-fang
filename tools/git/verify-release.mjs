// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/git/verify-release.mjs — 发布完整性断言：tag 必须落在 main 的 first-parent 上，且证据齐全。
//
// 背景：v2.8.3…v3.0.7 的标签都打在特性分支上（不在 origin/main），这正是「重复历史」的根因：
// 发布物与 main 各存在一份。这个脚本把那条教训变成一条会失败的检查。
//
// 用法：
//   node tools/git/verify-release.mjs --tag v3.0.8                     # 发布前（本地/CI guard job）
//   node tools/git/verify-release.mjs --tag v3.0.8 --no-artifact       # tag 刚打、还没构建
//   node tools/git/verify-release.mjs --tag v3.0.8 --remote --private  # 发布后复核 npm/GitHub/私有镜像
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

export function sha256File (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function git (args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function node (args, { timeoutMs = 900000 } = {}) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }
}

export function firstParentHas (branch, sha) {
  const chain = git(['rev-list', '--first-parent', branch], { allowFail: true })
  if (chain.status !== 0) return false
  return chain.out.split('\n').includes(sha)
}

export function collect ({ tag, base = 'main' }) {
  const version = tag.replace(/^v/, '')
  // CI 里 checkout 的是 tag（detached），本地通常没有 main 分支：优先用 origin/main。
  const baseRef = git(['rev-parse', '--verify', base], { allowFail: true }).status === 0
    ? base
    : (git(['rev-parse', '--verify', 'origin/main'], { allowFail: true }).status === 0 ? 'origin/main' : base)
  const tagSha = git(['rev-parse', '--verify', `${tag}^{commit}`], { allowFail: true })
  const tagObject = git(['cat-file', '-t', tag], { allowFail: true })
  const baseSha = git(['rev-parse', '--verify', baseRef], { allowFail: true })
  const previous = tagSha.status === 0
    ? git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`], { allowFail: true }).out
    : ''
  const pkg = exists('package.json') ? JSON.parse(read('package.json')) : {}
  const kernel = exists('src/kernel/types.mjs') ? read('src/kernel/types.mjs') : ''
  const changelog = exists('docs/CHANGELOG.md') ? read('docs/CHANGELOG.md') : ''
  const merges = tagSha.status === 0 && previous
    ? git(['log', '--merges', '--format=%h', `${previous}..${tag}`], { allowFail: true }).out.split('\n').filter(Boolean)
    : []
  let preflight = null
  if (exists('dist/preflight.json')) {
    try { preflight = JSON.parse(read('dist/preflight.json')) } catch { preflight = null }
  }
  return {
    tag,
    version,
    tagSha: tagSha.status === 0 ? tagSha.out : '',
    annotated: tagObject.out === 'tag',
    onMain: tagSha.status === 0 && baseSha.status === 0 ? firstParentHas(baseRef, tagSha.out) : false,
    base: baseRef,
    previous,
    merges,
    pkgVersion: String(pkg.version || ''),
    kernelVersion: (kernel.match(/FANG_VERSION\s*=\s*'([^']+)'/) || [])[1] || '',
    changelogHeading: changelog.includes(`## v${version}`),
    auditExists: exists(`docs/AUDIT-v${version}.md`),
    preflight,
  }
}

export function runChecks (facts, { requireArtifact = true } = {}) {
  const checks = []
  const add = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail })
  const { version, tag, tagSha, preflight } = facts

  add('tag: 存在', !!tagSha, tagSha ? tagSha.slice(0, 8) : `${tag} 未找到`)
  add('tag: 是 annotated tag', facts.annotated, facts.annotated ? 'tag object' : 'lightweight tag（发布请用 git tag -a）')
  add('tag: 在 main 的 first-parent 上', facts.onMain, facts.onMain ? 'yes' : 'NO —— 这就是 v3.0.7 的错误，禁止在特性分支打版本标签')
  add('tag: 名称 = package 版本', facts.pkgVersion === version, `${facts.pkgVersion} vs ${version}`)
  add('version: kernel FANG_VERSION', facts.kernelVersion === version, facts.kernelVersion || '(missing)')
  add('docs: CHANGELOG 段', facts.changelogHeading, `## v${version}`)
  add('docs: AUDIT-v<版本>.md', facts.auditExists, `docs/AUDIT-v${version}.md`)
  add('history: 距上一版无 merge（线性）', facts.merges.length === 0, facts.merges.length ? facts.merges.join(', ') : (facts.previous || 'first release'))

  add('preflight: 报告存在', !!preflight, 'dist/preflight.json')
  add('preflight: GREEN', preflight?.green === true, preflight ? String(preflight.green) : 'missing')
  add('preflight: 版本一致', preflight?.version === version, `${preflight?.version ?? '?'} vs ${version}`)
  add('preflight: e2e 真跑过', Number(preflight?.e2e?.total ?? 0) > 0, preflight?.e2e ? `${preflight.e2e.passed}/${preflight.e2e.total}` : 'e2e=null')
  add('preflight: 0 失败用例', preflight?.tests?.fail === 0, preflight?.tests ? `pass=${preflight.tests.pass} fail=${preflight.tests.fail}` : 'missing')

  if (requireArtifact) {
    const tarball = path.join(ROOT, 'dist', `dsh-fang-${version}.tgz`)
    const sidecar = `${tarball}.sha256`
    add('artifact: tarball 存在', fs.existsSync(tarball), path.basename(tarball))
    let match = false
    let detail = 'missing sidecar'
    if (fs.existsSync(tarball) && fs.existsSync(sidecar)) {
      const expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]
      match = expected === sha256File(tarball)
      detail = match ? 'match' : `mismatch ${expected.slice(0, 12)}`
    }
    add('artifact: sha256 一致', match, detail)
  } else {
    add('artifact: 跳过（--no-artifact）', true, 'tag 刚打，产物由 release.yml 构建')
  }
  return checks
}

function main () {
  const argv = process.argv.slice(2)
  const opt = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const flag = (n) => argv.includes(n)
  const tag = opt('--tag')
  const base = opt('--base', 'main')
  const jsonOnly = flag('--json')
  const noWrite = flag('--no-write')
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error('usage: node tools/git/verify-release.mjs --tag v3.0.8 [--no-artifact] [--remote] [--private] [--json]')
    process.exitCode = 2
    return
  }

  const facts = collect({ tag, base })
  const checks = runChecks(facts, { requireArtifact: !flag('--no-artifact') })

  if (flag('--remote')) {
    const r = node(['tools/release/healthz.mjs', '--remote'])
    checks.push({ id: 'remote: healthz --remote', ok: r.status === 0, detail: r.out.split('\n').slice(-3).join(' / ') })
  }
  if (flag('--private')) {
    const r = node(['tools/release/sync-private.mjs', 'verify', '--tag', tag, '--json'])
    let ok = false
    try { ok = JSON.parse(r.out.slice(r.out.indexOf('{'))).ok === true } catch { ok = false }
    checks.push({ id: 'private: 私有镜像 verify', ok, detail: ok ? 'verified' : r.out.split('\n').slice(-3).join(' / ') })
  }

  const green = checks.every((c) => c.ok)
  const report = { green, tag, version: facts.version, base, at: new Date().toISOString(), previous: facts.previous, checks }
  if (!noWrite) {
    fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'dist', 'release-verify.json'), JSON.stringify(report, null, 2))
  }
  if (jsonOnly) console.log(JSON.stringify(report, null, 2))
  else {
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(34)} ${c.detail}`)
    console.log(`\n${green ? 'GREEN' : 'RED'}  verify-release ${tag}（上一版 ${facts.previous || 'none'}）`)
    if (!noWrite) console.log('report: dist/release-verify.json')
  }
  process.exitCode = green ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
