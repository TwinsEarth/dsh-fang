// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/install-drill.mjs — 干净 profile 真实安装 drill（不触碰现有实例）。
// 用法：node tools/release/install-drill.mjs [--no-popup] [--tarball <path>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const CLI = [process.env.DSH_CLI_PATH, 'E:/DS/resources/runtime/cli/bin/dsh.cmd', 'E:/DSH/DS/resources/runtime/cli/bin/dsh.cmd', 'C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd']
  .filter(Boolean)
  .find((p) => fs.existsSync(p))
if (!CLI) { console.error('SKIP install-drill: dsh CLI not found'); process.exit(2) }
const NO_POPUP = process.argv.includes('--no-popup')
const tarballArg = process.argv.indexOf('--tarball')
const tarball = tarballArg > 0
  ? path.resolve(process.argv[tarballArg + 1])
  : path.join(ROOT, 'dist', fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => /^dsh-fang-.*\.tgz$/.test(f)).sort().pop())
if (!fs.existsSync(tarball)) { console.error('FAIL tarball missing:', tarball); process.exit(1) }
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-drill-'))
const profile = path.join(home, 'profiles', 'drill')
const pkgDir = path.join(profile, 'node_modules', '@twinsearth', 'dsh-fang')
let drillPort = 0

let child = null
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port
    probe.close(() => resolve(port))
  })
})

try {
  const env = { ...process.env, DSH_HOME: home, DSH_PROFILE: 'drill', DSH_PROFILE_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_FANG_ROLE
  // 干净安装：按 e2e 同构的 profile 布局（bundles: base + web-app + fang），
  // 把本地 tarball 解包到 profile 的 node_modules（不依赖 pnpm，也不碰 desktop profile）。
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.mkdirSync(profile, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', pkgDir, '--strip-components=1'], { stdio: 'pipe' })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-drill', private: true,
    // 与 pnpm add 落盘一致：客户端半只按 profile 依赖物化，缺依赖时 boot 不会分发 client.js。
    dependencies: { '@twinsearth/dsh-fang': version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@twinsearth/dsh-fang'] } },
  }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  check('tarball installed into clean profile', fs.existsSync(path.join(pkgDir, 'src', 'index.mjs')))
  // 启动前自检：bundle 行/模块解析/隔离 import 冒烟；失败时 install drill 直接红。
  try {
    const guard = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'boot-guard.mjs'), '--profile-dir', profile, '--json'], { encoding: 'utf8', timeout: 120000 })
    const parsed = JSON.parse(guard)
    check('boot-guard precheck PASS', parsed.ok === true, `checked=${parsed.checked ?? '?'} findings=${(parsed.findings ?? []).length}`)
  } catch (error) {
    let detail = String(error?.message ?? error)
    try { detail = String(JSON.parse(String(error.stdout ?? '{}')).findings?.map((f) => f.code).join(',')) } catch { /* keep */ }
    check('boot-guard precheck PASS', false, detail.slice(0, 300))
  }
  drillPort = await freePort()
  child = spawn(CLI, ['--profile', 'drill', '--port', String(drillPort), '--no-open'], { env, cwd: home, shell: true, windowsHide: true })
  let stdout = ''
  let stderr = ''
  let exitCode = null
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), 150000)
    child.stdout.on('data', (d) => {
      stdout += String(d)
      const m = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(stdout)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('exit', (code) => { exitCode = code; clearTimeout(timer); resolve('') })
  })
  check('clean profile boots with a Web URL', url.length > 0, url ? `port=${new URL(url).port}` : `exit=${exitCode} ${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`)
  if (!url) { console.error(stderr.slice(-2000) || stdout.slice(-2000)); throw new Error('boot failed') }

  const token = new URL(url).searchParams.get('token') ?? ''
  const port = new URL(url).port
  // v3.0.10：干净安装后 Web boot 必须包含主面板 client half；这是 v3.0.9 的发包回归门禁。
  // Node fetch 没有 cookie jar：先取 302 的 set-cookie，再带 cookie 请求首页（浏览器行为）。
  const bootHtml = async () => {
    const first = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } })
    if (first.status === 200) return await first.text()
    const jar = typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : []
    const cookie = jar.map((value) => value.split(';')[0]).join('; ')
    const location = new URL(first.headers.get('location') ?? '/', url).href
    const page = await fetch(location, { redirect: 'manual', headers: { cookie, accept: 'text/html' } })
    return await page.text()
  }
  let boot = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    boot = await bootHtml().catch(() => '')
    if (boot.includes('@twinsearth/dsh-fang/client.js')) break
    await sleep(500)
  }
  check('clean boot lists the fang client half', boot.includes('@twinsearth/dsh-fang/client.js'), boot ? '' : 'boot page unavailable')
  // B1：先同源 bootstrap 安装级 token，再带 x-fang-auth 访问 API
  const authToken = await fetch(`http://127.0.0.1:${port}/fang/api/auth-token?token=${encodeURIComponent(token)}`)
    .then((r) => r.json()).then((b) => b?.token ?? '').catch(() => '')
  const api = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}?token=${encodeURIComponent(token)}`, {
      headers: { 'content-type': 'application/json', ...(authToken ? { 'x-fang-auth': authToken } : {}) },
    })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 200) } }
    return { status: res.status, body }
  }
  const status = await api('/fang/api/status')
  check('status version matches', status.body?.version === version, `${status.body?.version ?? status.body?.error}`)
  const panelRes = await fetch(`http://127.0.0.1:${port}/fang/panel?token=${encodeURIComponent(token)}`).catch(() => null)
  check('browser panel route absent (404)', panelRes?.status === 404, `status=${panelRes?.status ?? 'n/a'}`)

  const dump = execFileSync(CLI, ['--profile', 'drill', '--dump-config'], { env, encoding: 'utf8', cwd: home, shell: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  const rows = [...new Set([...dump.matchAll(/\bid:\s*['"]?(fang-[a-z0-9-]+)/g)].map((m) => m[1]))]
  check('19 fang-* rows composed (>=17)', rows.length >= 17, `rows=${rows.length}`)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  check('browser client half enabled', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client ?? null))

  if (!NO_POPUP) {
    const choiceFile = path.join(home, 'choice.txt')
    let popupChoice = ''
    const ps = `$c = Read-Host '瓮城 drill：1=打开母体 2=完成 3=中止'; Set-Content -Path '${choiceFile.replace(/'/g, "''")}' -Value $c`
    spawn('powershell.exe', ['-NoProfile', '-NoExit', '-Command', ps], { detached: true, stdio: 'ignore' }).unref()
    console.log('popup: 请到新开的 PowerShell 窗口输入 1（打开母体）/ 2（完成）/ 3（中止）')
    for (let i = 0; i < 300; i += 1) {
      if (fs.existsSync(choiceFile)) {
        popupChoice = fs.readFileSync(choiceFile, 'utf8').trim()
        if (popupChoice === '3' || /Cancel|中止/i.test(popupChoice)) throw new Error('aborted by user')
        if (popupChoice === '1' || /Yes|是|打开/i.test(popupChoice)) { try { execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' }) } catch { /* ignore */ } }
        break
      }
      await sleep(200)
    }
    check('popup choice recorded', popupChoice.length > 0, popupChoice || 'timeout')
    if (!popupChoice) throw new Error('popup timeout: no choice entered')
  } else {
    console.log('popup skipped (--no-popup)')
  }
} catch (error) {
  check('drill completed', false, String(error?.message ?? error))
} finally {
  if (child && !child.killed) {
    // Windows: spawn(shell:true) 的 child 是 cmd.exe，必须杀进程树，否则 Electron 宿主会残留。
    if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* already gone */ } }
    try { child.kill() } catch { /* already gone */ }
  }
  const failedBeforeCleanup = checks.filter((c) => !c.ok).length
  if (!failedBeforeCleanup) {
    // 零残留：成功后删除临时 home，并确认 drill 端口已释放（进程树 kill 后 300ms）。
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
    await sleep(300)
    check('zero-residue: temp home removed', !fs.existsSync(home), home)
    const portFree = await new Promise((resolve) => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.listen(drillPort, '127.0.0.1', () => probe.close(() => resolve(true)))
      setTimeout(() => resolve(false), 1500).unref?.()
    })
    check('zero-residue: drill port released', portFree, String(drillPort))
  }
  const failed = checks.filter((c) => !c.ok).length
  console.log(`\n${failed ? 'RED' : 'GREEN'}  install drill ${checks.length - failed}/${checks.length}`)
  console.log('home:', home)
  process.exit(failed ? 1 : 0)
}
