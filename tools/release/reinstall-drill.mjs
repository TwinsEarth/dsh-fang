// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/reinstall-drill.mjs — 重装/重启韧性 drill：同一个 DSH_HOME 连续 boot 两次，
// 中间保留 profile、覆盖安装 tarball、并注入“看起来像毒数据”的持久化文件。
// 目的：验证不需要删除 .dsh 就能恢复（除非 profile 本身被外部破坏）。
// 用法：node tools/release/reinstall-drill.mjs [--no-popup] [--tarball <path>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const CLI = [
  process.env.DSH_CLI_PATH,
  'E:/DS/resources/runtime/cli/bin/dsh.cmd',
  'E:/DSH/DS/resources/runtime/cli/bin/dsh.cmd',
  'C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd',
].filter(Boolean).find((p) => fs.existsSync(p))
if (!CLI) { console.error('SKIP reinstall-drill: dsh CLI not found'); process.exit(2) }
const tarballArg = process.argv.indexOf('--tarball')
const tarball = tarballArg > 0
  ? path.resolve(process.argv[tarballArg + 1])
  : path.join(ROOT, 'dist', fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => /^dsh-fang-.*\.tgz$/.test(f)).sort().pop())
if (!fs.existsSync(tarball)) { console.error('FAIL tarball missing:', tarball); process.exit(1) }
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-reinstall-'))
const profile = path.join(home, 'profiles', 'drill')
const pkgDir = path.join(profile, 'node_modules', '@twinsearth', 'dsh-fang')
const dataDir = path.join(home, 'fang', 'drill')
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
})
const killTree = (pid) => { try { execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }) } catch { /* gone */ } }
const install = () => {
  fs.rmSync(pkgDir, { recursive: true, force: true })
  fs.mkdirSync(pkgDir, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', pkgDir, '--strip-components=1'], { stdio: 'pipe' })
}
const writeProfile = () => {
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-reinstall', private: true,
    dependencies: { '@twinsearth/dsh-fang': version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@twinsearth/dsh-fang'] } },
  }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
}
async function boot(port) {
  const env = { ...process.env, DSH_HOME: home, DSH_PROFILE: 'drill', DSH_PROFILE_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_FANG_ROLE
  const child = spawn(CLI, ['--profile', 'drill', '--port', String(port), '--no-open'], { env, cwd: home, shell: true, windowsHide: true })
  let stdout = ''
  let stderr = ''
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), 150000)
    child.stdout.on('data', (d) => {
      stdout += String(d)
      const m = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(stdout)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('exit', (code) => { clearTimeout(timer); resolve('') })
  })
  return { child, url, stdout, stderr }
}
async function readJson(url, headers = {}) {
  try { const res = await fetch(url, { headers }); return { status: res.status, body: await res.json().catch(() => null) } } catch { return { status: 0, body: null } }
}
async function fangStatus() {
  const tokenFile = path.join(dataDir, 'fang-auth.json')
  const token = (() => { try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token ?? '' } catch { return '' } })()
  return readJson(`http://127.0.0.1:${portForStatus}/fang/api/status`, token ? { 'x-fang-auth': token } : {})
}
let portForStatus = 0

try {
  fs.mkdirSync(path.join(profile, 'node_modules', '@twinsearth'), { recursive: true })
  install()
  writeProfile()
  check('first install materialized package', fs.existsSync(path.join(pkgDir, 'src', 'index.mjs')))
  // v3.3.0 主城门禁（安装）：重装 drill 也必须先过 profile/磁盘/运行时防线。
  try {
    execFileSync(process.execPath, [
      path.join(ROOT, 'tools/gate/main-city.mjs'),
      '--target', 'install', '--home', home, '--profile', 'drill',
      '--profile-dir', profile, '--package-dir', pkgDir, '--json',
    ], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
    check('main-city gate (install) PASS', true)
  } catch (error) {
    let detail = String(error?.message ?? error)
    try { const parsed = JSON.parse(String(error.stdout ?? '{}')); detail = (parsed.blockers ?? []).map((item) => item.id + ': ' + item.detail).join(' | ') } catch { /* keep */ }
    check('main-city gate (install) PASS', false, detail.slice(0, 400))
  }

  // ── 第一次 boot ────────────────────────────────────────────────
  portForStatus = await freePort()
  const first = await boot(portForStatus)
  check('first boot reaches Web URL', first.url.length > 0, first.url ? `port=${new URL(first.url).port}` : (first.stderr || first.stdout).slice(-300))
  check('first boot status version matches', (await fangStatus()).body?.version === version)
  killTree(first.child.pid)
  await sleep(800)

  // ── 模拟“重装客户端”：保留 .dsh/profile，只替换包；同时注入毒数据 ──
  install()
  check('reinstall over existing profile (no .dsh delete)', fs.existsSync(path.join(pkgDir, 'package.json')))
  fs.mkdirSync(dataDir, { recursive: true })
  const poisons = {
    'forks.json': 'not-json{',
    'tasks.json': 'not-json{',
    'ports.json': 'not-json{',
    'decision-center.json': 'not-json{',
    'decision-session-usage.json': 'not-json{',
    'dsh-approval-pending.json': 'not-json{',
    'dsh-approval-status.json': 'not-json{',
    'dsh-approval-decisions.jsonl': 'not-json{\n',
    'dsh-approval-journal.jsonl': '{"type":"request","id":"apr_bad"}\nnot-json{\n',
    'composer-journal.json': 'not-json{',
    'default-essence.json': 'not-json{',
    'deleted-essences.json': 'not-json{',
    'fork-supervision.json': 'not-json{',
    'fang.pid': '999999',
  }
  for (const [name, content] of Object.entries(poisons)) fs.writeFileSync(path.join(dataDir, name), content, 'utf8')
  fs.mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'snapshots', 'index.json'), 'not-json{', 'utf8')
  fs.mkdirSync(path.join(dataDir, 'restart', 'approved'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'restart', 'approved', 'bad.json'), 'not-json{', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'restart', 'state.json'), 'not-json{', 'utf8')
  fs.mkdirSync(path.join(dataDir, 'mirror'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'mirror', 'meta.json'), 'not-json{', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'mirror', 'backups.json'), 'not-json{', 'utf8')
  check('poison files written (stale/corrupt persistence)', true)

  // ── 第二次 boot：同一个 home/profile，不删除任何 .dsh 数据 ─────────
  portForStatus = await freePort()
  const second = await boot(portForStatus)
  check('second boot reaches Web URL after reinstall + poison', second.url.length > 0, second.url ? `port=${new URL(second.url).port}` : (second.stderr || second.stdout).slice(-800))
  const secondStatus = await fangStatus()
  check('second boot /fang/api/status OK', secondStatus.status === 200 && secondStatus.body?.version === version, `status=${secondStatus.status} version=${secondStatus.body?.version}`)
  killTree(second.child.pid)
  await sleep(500)
} catch (error) {
  check('reinstall drill completed', false, String(error?.message ?? error))
} finally {
  try { if (!checks.every((c) => c.ok) && fs.existsSync(home)) console.log('home kept for debug:', home) } catch { /* ignore */ }
  const failed = checks.filter((c) => !c.ok).length
  console.log(`\n${failed ? 'RED' : 'GREEN'}  reinstall drill ${checks.length - failed}/${checks.length}`)
  if (!failed) { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ } }
  process.exit(failed ? 1 : 0)
}
