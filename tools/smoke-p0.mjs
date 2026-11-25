// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/smoke-p0.mjs — 把 TEST-PLAN 的 P0 项映射到真实冒烟证据，输出覆盖报告。
// 覆盖：SEC-01..14、ESS-01..09、DRV-01/05/06/07、CMP-01/02/03、PKG-03/04/05/06/09、UI 物化。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args, timeout = 900000) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout }) }
  } catch (error) {
    return { ok: false, out: `${error?.stdout ?? ''}\n${error?.stderr ?? ''}` }
  }
}

// 1) 全量单测（覆盖 SEC/ESS/CMP/UI-10/11 的服务端语义）
const testFiles = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`)
const suite = run(process.execPath, ['--test', '--test-concurrency=1', ...testFiles])
const pass = Number((suite.out.match(/ℹ pass (\d+)/) ?? [])[1] ?? -1)
const fail = Number((suite.out.match(/ℹ fail (\d+)/) ?? [])[1] ?? -1)
const unitOk = suite.ok && fail === 0 && pass > 0

// 2) 真机 e2e（DRV/PKG/UI 物化/token 落盘）
const e2e = run(process.execPath, ['tools/e2e.mjs'], 600000)
const e2eOk = e2e.ok && /(\d+)\/(\d+) checks passed/.test(e2e.out) && !/failed:/.test(e2e.out)
const hasE2E = (needle) => e2e.out.includes(needle)

// 3) tarball 可安装性 + sha256（PKG-05/09）
const dist = path.join(ROOT, 'dist')
const tgz = fs.readdirSync(dist).filter((f) => /^dsh-fang-.*\.tgz$/.test(f)).sort().pop()
const pkgSmoke = tgz ? run(process.execPath, ['tools/release/package-smoke.mjs', path.join(dist, tgz)], 120000) : { ok: false, out: 'no tarball' }
const sidecar = tgz && fs.existsSync(path.join(dist, `${tgz}.sha256`))
const manifest = fs.existsSync(path.join(dist, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')) : null

// 4) 门禁配置静态断言（PKG-03/04/06）
const preflightSrc = fs.readFileSync(path.join(ROOT, 'tools/release/preflight.mjs'), 'utf8')
const buildSrc = fs.readFileSync(path.join(ROOT, 'tools/release/build.mjs'), 'utf8')
const releaseSrc = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
const gateStatic = preflightSrc.includes('e2e: required for release green') &&
  preflightSrc.includes('artifact: sha256 sidecar') &&
  buildSrc.includes("'--e2e'") &&
  releaseSrc.includes('build with preflight --e2e') &&
  releaseSrc.includes('runs-on: [self-hosted, windows]')
const preflightReport = fs.existsSync(path.join(dist, 'preflight.json')) ? JSON.parse(fs.readFileSync(path.join(dist, 'preflight.json'), 'utf8')) : null
const routeDetail = String(preflightReport?.checks?.find((c) => String(c.id).startsWith('allow-list'))?.detail ?? '')
const routes = Number((routeDetail.match(/routes=(\d+)/) ?? [])[1] ?? NaN)

const rows = []
const add = (ids, ok, evidence) => { for (const id of ids) rows.push({ id, ok: !!ok, evidence }) }

add(['SEC-01', 'SEC-02', 'SEC-03', 'SEC-05', 'SEC-06', 'SEC-08', 'SEC-09', 'SEC-10', 'SEC-13', 'SEC-14'], unitOk, `unit suite pass=${pass} fail=${fail}`)
add(['SEC-07'], unitOk && hasE2E('no token persisted in tasks/forks json') && hasE2E('open-url returns tokenized url'), 'unit + e2e disk token')
add(['ESS-01', 'ESS-02', 'ESS-03', 'ESS-04', 'ESS-05', 'ESS-06', 'ESS-07', 'ESS-08', 'ESS-09'], unitOk, 'essence-crud/official-essence tests')
add(['DRV-01'], e2eOk && hasE2E('POST /fang/api/tasks/create accepted') && hasE2E('adapter handshake succeeded'), 'e2e real fork')
add(['DRV-05'], e2eOk && hasE2E('open-url returns tokenized url (memory only)'), 'e2e open-url')
add(['DRV-06', 'DRV-07'], e2eOk && hasE2E('fork home removed after delete-archive'), 'e2e archive/delete')
add(['CMP-01', 'CMP-02', 'CMP-03'], unitOk && routes === 62, `compat suite + routes=${Number.isFinite(routes) ? routes : 'n/a'}`)
add(['PKG-03', 'PKG-04', 'PKG-06'], gateStatic, 'preflight/build/release gate static checks')
add(['PKG-05', 'PKG-09'], pkgSmoke.ok && sidecar, `package smoke + ${tgz}.sha256`)
add(['UI-物化'], e2eOk && hasE2E('client half registers @local/dsh-fang') && hasE2E('client half materializes apply()') && hasE2E('no inactive plugin entries'), 'e2e loader/materialization')

const missing = rows.filter((r) => !r.ok)
for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.id.padEnd(10)} ${row.evidence}`)
const report = { at: new Date().toISOString(), unit: { pass, fail }, e2eOk, tarball: tgz ?? null, sidecar, routes: Number.isFinite(routes) ? routes : null, missing: missing.map((m) => m.id), rows }
fs.mkdirSync(dist, { recursive: true })
fs.writeFileSync(path.join(dist, 'smoke-p0.json'), JSON.stringify(report, null, 2))
console.log(`\n${missing.length ? 'RED' : 'GREEN'}  smoke P0 coverage: ${rows.length - missing.length}/${rows.length}`)
if (missing.length) console.error('missing:', missing.map((m) => m.id).join(', '))
process.exit(missing.length ? 1 : 0)
