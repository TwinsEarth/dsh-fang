// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/preflight.mjs — 发布前门禁：版本一致、许可完整、全量测试、可选 e2e。
// 用法：node tools/release/preflight.mjs [--e2e] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readJson, readText, versionOf, nodeRun, listTestFiles, sha256File, PUBLISH_BASENAME } from './lib.mjs'

const args = process.argv.slice(2)
const wantE2e = args.includes('--e2e')
const jsonOnly = args.includes('--json')
const checks = []
const add = (id, ok, detail = '') => { checks.push({ id, ok: !!ok, detail }); if (!jsonOnly) console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(40)} ${detail}`) }

const version = versionOf()
const pkg = readJson('package.json')
const kernelTypes = readText('src/kernel/types.mjs')

add('version: package.json', /^\d+\.\d+\.\d+/.test(version), version)
add('version: kernel FANG_VERSION matches', kernelTypes.includes(`FANG_VERSION = '${version}'`), version)
add('version: CHANGELOG has a section', readText('docs/CHANGELOG.md').includes(`## v${version}`), `## v${version}`)
add('license: core AGPL text', readText('LICENSE-CORE').includes('GNU AFFERO GENERAL PUBLIC LICENSE'))
add('license: package.json AGPL', pkg.license === 'AGPL-3.0-or-later', String(pkg.license))
add('license: SDK MIT text', readText('LICENSE-SDK').includes('MIT License'))
add('license: commercial + CLA + NOTICE', ['LICENSE-COMMERCIAL', 'CLA.md', 'NOTICE'].every((f) => fs.existsSync(path.join(ROOT, f))))
// v3.0.10：源码声明必须保留浏览器 client half；发布 staging 曾删掉它导致 Web 面板不加载。
add('package: dsh.client enabled', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client ?? null))

// UI 半是浏览器模块，没有单元测试；至少保证它是一份可解析的 JS（v2.6.2 起纳入门禁）。
const clientParse = nodeRun(['--check', 'client.js'])
add('client half: node --check client.js', clientParse.status === 0, clientParse.status === 0 ? 'green' : (clientParse.stderr || clientParse.stdout).slice(-300))

// 防崩溃方案必须可回归：boot-guard / restart-guard / 分身监督 / role fail-closed /
// 未清洁启动检测的不变量逐项校验（v3.1.10 固化，失败即 RED）。
const crash = nodeRun(['tools/release/crash-safety.mjs', '--json'])
let crashReport = null
try { crashReport = JSON.parse(crash.stdout) } catch { crashReport = null }
const crashFailed = crashReport ? crashReport.checks.filter((check) => !check.ok).map((check) => check.id) : []
add('crash-safety: fail-safe invariants', crash.status === 0 && crashReport?.ok === true, crashReport
  ? `checks=${crashReport.checks.length} failed=${crashFailed.length}${crashFailed.length ? ':' + crashFailed.join(',') : ''}`
  : (crash.stderr || crash.stdout).slice(-300))

const lic = nodeRun(['test/licensing.test.mjs'])
add('license layering guard', lic.status === 0, lic.status === 0 ? 'green' : (lic.stderr || lic.stdout).slice(-300))

const allow = nodeRun(['tools/release/allowlist.mjs', '--json'])
let allowReport = null
try { allowReport = JSON.parse(allow.stdout) } catch { allowReport = null }
add('allow-list self-check', allow.status === 0 && allowReport?.ok === true, allowReport ? `routes=${allowReport.routes?.count ?? '?'} findings=${allowReport.findings?.length ?? '?'}` : (allow.stderr || allow.stdout).slice(-300))

// full suite
const files = listTestFiles()
const started = Date.now()
const suite = nodeRun(['--test', '--test-concurrency=1', ...files.map((f) => path.join('test', f))], { timeoutMs: 900000 })
const out = `${suite.stdout}\n${suite.stderr}`
const pass = Number((out.match(/ℹ pass (\d+)/) ?? [])[1] ?? -1)
const fail = Number((out.match(/ℹ fail (\d+)/) ?? [])[1] ?? -1)
const skip = Number((out.match(/ℹ skipped (\d+)/) ?? [])[1] ?? 0)
add('tests: full suite green', suite.status === 0 && fail === 0, `pass=${pass} fail=${fail} skip=${skip} (${((Date.now() - started) / 1000).toFixed(1)}s)`)

let e2e = null
if (wantE2e) {
  const t0 = Date.now()
  const r = nodeRun(['tools/e2e.mjs'], { timeoutMs: 900000 })
  const text = `${r.stdout}\n${r.stderr}`
  const m = text.match(/(\d+)\/(\d+) checks passed/)
  e2e = { status: r.status, passed: Number(m?.[1] ?? -1), total: Number(m?.[2] ?? -1), ms: Date.now() - t0 }
  add('e2e: real dsh mother + fork', r.status === 0 && e2e.passed === e2e.total && e2e.total > 0, `e2e=${e2e.passed}/${e2e.total} (${(e2e.ms / 1000).toFixed(1)}s)`)
} else {
  // v3.0.7 门禁修复：e2e 是发布必要条件；跳过 e2e 不得再发绿灯
  add('e2e: required for release green', false, 'e2e not run; pass --e2e')
}

// 若已存在 tarball，校验同目录 .sha256 与其一致（不存在/不匹配都失败）
const tarball = path.join(ROOT, 'dist', `${PUBLISH_BASENAME}-${version}.tgz`)
if (fs.existsSync(tarball)) {
  const sidecar = `${tarball}.sha256`
  let ok = false
  let detail = 'missing'
  if (fs.existsSync(sidecar)) {
    const expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]
    ok = expected === sha256File(tarball)
    detail = ok ? 'match' : 'mismatch'
  }
  add('artifact: sha256 sidecar', ok, detail)
}

const green = checks.every((c) => c.ok)
const report = { green, version, node: process.versions.node, at: new Date().toISOString(), checks, tests: { pass, fail, skip }, e2e }
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'dist', 'preflight.json'), JSON.stringify(report, null, 2))
if (jsonOnly) console.log(JSON.stringify(report, null, 2))
console.log(`\n${green ? 'GREEN' : 'RED'}  preflight ${version}  (report: dist/preflight.json)`)
process.exitCode = green ? 0 : 1
