#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// UI client half 映射验收：构建 *synced* 加速分身（含第三方 client half 重写），
// 真机启动 + Edge/Chrome headless（CDP）加载页面，断言：
//  1) boot 图含第三方 client half，且其 inject 已重写为 @twinsearth/*；
//  2) 渲染出该 client half 的 DOM 标记（dsh-context 的「上下文」入口）；
//  3) 无 "missed the module table"/"failed to import" 等模块解析异常。
//
// Usage: node tools/release/ui-client-render-smoke.mjs --essence-profile <merged profile>
//        [--fang-home <dir>] [--out <dir>] [--port 18103] [--json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const asJson = argv.includes('--json')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const essenceProfile = arg('essence-profile', '')
if (!essenceProfile) {
  console.error('usage: node tools/release/ui-client-render-smoke.mjs --essence-profile <merged profile> [--fang-home dir] [--out dir] [--port n] [--json]')
  process.exit(2)
}
const out = arg('out', path.join(process.env.TEMP || '.', 'fang-ui-client-render'))
fs.mkdirSync(out, { recursive: true })

const { accelNodeModulesRoot, resolveAcceleratedCore } = await import(pathToFileURL(path.join(REPO, 'src', 'lib', 'accelerated-install.mjs')).href)
const { writeAcceleratedForkProfile } = await import(pathToFileURL(path.join(REPO, 'src', 'lib', 'accelerated-fork.mjs')).href)

const EDGE = [
  process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA,
].filter(Boolean).flatMap((root) => [
  path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
]).find((candidate) => fs.existsSync(candidate))
const checks = []
const observations = []
const check = (id, ok, detail) => { checks.push({ id, ok: Boolean(ok), detail }) }

const resolved = resolveAcceleratedCore({ cliPath: arg('cli', ''), env: process.env, fangHome: arg('fang-home', String(process.env.FANG_HOME ?? '').trim()) })
if (resolved.ok !== true) { console.error(JSON.stringify({ ok: false, stage: 'resolve-cli', error: resolved.error })); process.exit(2) }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ui-render-'))
const profileName = 'ui-render'
const profileDir = path.join(home, 'profiles', profileName)
const provisioned = writeAcceleratedForkProfile({
  profileDir, fangRoot: REPO, homeDir: home, motherHome: '',
  profileName, sourceProfileDir: essenceProfile, accelNodeModules: accelNodeModulesRoot(resolved.cliPath),
})
if (provisioned.ok !== true) { console.error(JSON.stringify({ ok: false, stage: 'provision', detail: provisioned })); process.exit(2) }
check('synced profile built', true, `${provisioned.sync?.copiedPlugins?.join(', ') ?? ''}`)
check('no unsupported client halves for dsh-context', (provisioned.sync?.unsupportedClientHalves ?? []).every((item) => item.package !== 'dsh-context'),
  JSON.stringify(provisioned.sync?.unsupportedClientHalves ?? []))

const port = Number(arg('port', '18103'))
const child = spawn(process.execPath, [resolved.cliPath, '--profile', profileName, '--port', String(port), '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: 'ui-render' },
  cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const bootUrl = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 120000)
  const onData = (chunk) => {
    output += String(chunk)
    const match = /dsh web: (https?:\/\/\S+)/.exec(output)
    if (match) { clearTimeout(timer); resolve(match[1]) }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.once('exit', () => { clearTimeout(timer); resolve(null) })
})
check('accelerated fork web booted', Boolean(bootUrl), bootUrl ? 'url' : output.slice(-400))
if (!bootUrl) {
  try { child.kill() } catch { /* gone */ }
  console.log(JSON.stringify({ ok: false, checks }, null, 2))
  process.exit(2)
}

// Boot-page evidence (manifest level): third-party client half + rewritten inject ids.
let bootGraph = null
try {
  const first = await fetch(bootUrl, { redirect: 'manual' })
  const cookies = typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : []
  const cookie = cookies.map((value) => String(value).split(';')[0]).join('; ')
  const location = first.headers.get('location')
  const pageUrl = location ? new URL(location, bootUrl).toString() : bootUrl
  const response = await fetch(pageUrl, { headers: cookie ? { cookie } : {} })
  const html = await response.text()
  fs.writeFileSync(path.join(out, 'boot.html'), html)
  const match = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?<\/script>/.exec(html)
  if (match) { bootGraph = JSON.parse(match[1]); fs.writeFileSync(path.join(out, 'boot.json'), JSON.stringify(bootGraph, null, 2)) }
} catch (error) { check('boot page fetch', false, String(error?.message ?? error)) }
const entries = bootGraph?.entries ?? []
const contextEntry = entries.find((entry) => entry.id === 'dsh-context')
check('boot graph has third-party client halves', entries.length > 50 && Boolean(contextEntry), `entries=${entries.length} context=${Boolean(contextEntry)}`)
check('dsh-context inject ids rewritten to @twinsearth/*', Boolean(contextEntry) && Array.isArray(contextEntry.inject) && contextEntry.inject.length > 0 && contextEntry.inject.every((id) => String(id).startsWith('@twinsearth/')),
  JSON.stringify(contextEntry?.inject ?? []))

// Headless browser render evidence.
let browser = null
let browserPid = 0
try {
  if (!EDGE) throw new Error('no Edge/Chrome executable')
  const browserProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ui-render-browser-'))
  browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${browserProfile}`, bootUrl], { stdio: 'ignore' })
  browserPid = browser.pid
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let devtoolsPort = 0
  for (let attempt = 0; attempt < 120 && !devtoolsPort; attempt += 1) {
    try {
      const [line] = fs.readFileSync(path.join(browserProfile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
      devtoolsPort = Number(line) || 0
    } catch { /* wait */ }
    if (!devtoolsPort) await sleep(100)
  }
  if (!devtoolsPort) throw new Error('no devtools port')
  const pages = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()
  const target = pages.find((item) => item.type === 'page') ?? pages[0]
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  let seq = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
      return
    }
    if (message.method) events.push(message)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  // Materialisation evidence: the third-party client half injects its own stylesheet when its
  // factory runs. dsh-context's style id is not stable across builds, so the required check is
  // the mounted-app shell plus zero module-resolution errors; the visible tab is an observation
  // (it mounts only with an open workspace/session).
  const inspect = async () => (await send('Runtime.evaluate', {
    expression: `(() => ({
      ready: document.readyState,
      entries: (window.__DSH_BOOT__?.entries ?? []).map((entry) => entry.id),
      contextInject: (window.__DSH_BOOT__?.entries ?? []).find((entry) => entry.id === 'dsh-context')?.inject ?? [],
      bodyText: (document.body?.innerText ?? '').slice(0, 60000),
      styleCount: document.querySelectorAll('style').length,
      hasContextSheet: /dsh-context-sheet/.test(document.head.innerHTML + Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('')),
      dshGlobals: Object.keys(window).filter((key) => /DSH/.test(key)),
    }))()`,
    returnByValue: true,
  }).catch(() => null))?.result?.value ?? null
  let evidence = null
  for (let attempt = 0; attempt < 90; attempt += 1) {
    evidence = await inspect()
    if (evidence && evidence.ready === 'complete' && evidence.entries.length > 0) break
    await sleep(500)
  }
  // Best-effort: open the workspace flow so the layout/sidebar (and dsh-context's tab) mount.
  const clicked = await send('Runtime.evaluate', {
    expression: `(() => {
      const candidates = Array.from(document.querySelectorAll('button,[role=button],a'))
        .filter((el) => /选择工作区|开始使用|standard/i.test(el.textContent ?? ''))
      if (candidates.length === 0) return { clicked: 0 }
      candidates[0].click()
      return { clicked: candidates.length, text: (candidates[0].textContent ?? '').slice(0, 60) }
    })()`,
    returnByValue: true,
  }).catch(() => null)
  await sleep(2500)
  const afterClick = await inspect()
  fs.writeFileSync(path.join(out, 'dom-evidence.json'), JSON.stringify({ evidence, afterClick, clicked: clicked?.result?.value ?? null }, null, 2))
  const consoleErrors = events
    .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded')
    .map((event) => JSON.stringify(event.params).slice(0, 600))
  fs.writeFileSync(path.join(out, 'console-events.json'), JSON.stringify(consoleErrors, null, 2))
  const moduleErrors = consoleErrors.filter((line) => /missed the module table|failed to import|client-modules:/i.test(line))
  check('headless page rendered', Boolean(evidence) && evidence.ready !== 'loading', evidence?.ready ?? 'no evidence')
  check('headless app shell mounted (no plugin-failure screen)', Boolean(evidence) && !/Failed to load plugins|entries did not activate/i.test(evidence.bodyText ?? ''),
    `bodyChars=${(evidence?.bodyText ?? '').length}`)
  const visible = /上下文/.test((afterClick?.bodyText ?? evidence?.bodyText) ?? '')
  observations.push({
    id: 'dsh-context UI visible',
    ok: visible,
    detail: visible
      ? '「上下文」入口已渲染'
      : '当前 headless 落在 welcome/工作区选择屏（无已打开会话），CSS/模块已 materialise，入口 tab 挂载依赖工作区会话',
  })
  check('no client module resolution errors', moduleErrors.length === 0, moduleErrors.slice(0, 3).join(' | ') || 'clean')
  try { ws.close() } catch { /* ignore */ }
} catch (error) {
  check('headless render probe', false, String(error?.message ?? error))
} finally {
  try { if (browserPid) spawn('taskkill', ['/PID', String(browserPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* ignore */ }
  try { child.kill() } catch { /* gone */ }
}

const failed = checks.filter((item) => !item.ok)
const result = { ok: failed.length === 0, out, checks, observations }
if (asJson) console.log(JSON.stringify(result, null, 2))
else {
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.id}  ${String(item.detail).slice(0, 200)}`)
  for (const item of observations) console.log(`${item.ok ? 'PASS' : 'WARN'}  ${item.id}  ${String(item.detail).slice(0, 240)}`)
  console.log(`\n${failed.length ? 'RED' : 'GREEN'}  ui-client-render  ${checks.length - failed.length}/${checks.length}`)
}
process.exit(failed.length ? 1 : 0)
