// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/install-drill.mjs — 干净 profile 真实安装 drill（不触碰现有实例）。
// 用法：node tools/release/install-drill.mjs [--no-popup] [--tarball <path>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const CLI = ['E:/DS/resources/runtime/cli/bin/dsh.cmd', 'E:/DS/resources/runtime/cli/bin/dsh.exe']
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
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@twinsearth/dsh-fang'] } },
  }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  check('tarball installed into clean profile', fs.existsSync(path.join(pkgDir, 'src', 'index.mjs')))
  child = spawn(CLI, ['--profile', 'drill', '--port', String(await freePort()), '--no-open'], { env, cwd: home, shell: true, windowsHide: true })
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
  check('16 fang-* rows composed', rows.length >= 16, `rows=${rows.length}`)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  check('browser client half disabled', pkg.dsh?.client === undefined)

  if (!NO_POPUP) {
    const choiceFile = path.join(home, 'choice.txt')
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show('干净 profile 已启动。请点击「打开母体」验证页面，然后回来点「完成」。','dsh-Fang drill',[System.Windows.Forms.MessageBoxButtons]::YesNoCancel); Set-Content -Path '${choiceFile.replace(/'/g, "''")}' -Value $r`
    spawn('powershell.exe', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore' }).unref()
    console.log('popup: 打开母体=Yes（默认）/ 完成=No / 中止=Cancel；请到桌面点击')
    for (let i = 0; i < 300; i += 1) {
      if (fs.existsSync(choiceFile)) {
        const choice = fs.readFileSync(choiceFile, 'utf8').trim()
        check('popup choice recorded', choice.length > 0, choice)
        if (/Cancel/i.test(choice)) throw new Error('aborted by user')
        if (/Yes/i.test(choice)) { try { execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' }) } catch { /* ignore */ } }
        break
      }
      await sleep(200)
    }
  } else {
    console.log('popup skipped (--no-popup)')
  }
} catch (error) {
  check('drill completed', false, String(error?.message ?? error))
} finally {
  if (child && !child.killed) { try { child.kill() } catch { /* ignore */ } }
  const failed = checks.filter((c) => !c.ok).length
  console.log(`\n${failed ? 'RED' : 'GREEN'}  install drill ${checks.length - failed}/${checks.length}`)
  console.log('home:', home)
  if (!failed) { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ } }
  process.exit(failed ? 1 : 0)
}
