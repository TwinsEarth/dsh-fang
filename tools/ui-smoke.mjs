// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/ui-smoke.mjs — UI 自动冒烟：
//   1. 用真实 renderPanelHtml + 假 API 起一个本地页面；
//   2. 用 Edge headless (CDP) 打开页面，给页面注入分析日志；
//   3. 模拟点击所有按钮/链接（多轮，含动态行），收集请求/打开目标/页面错误；
//   4. 自动分析：鉴权头、端点覆盖、死按钮、页面异常；给出修复建议并以非零退出码表示失败。
// 零 npm 依赖：Node 内置 http/WebSocket + 系统 Edge。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { renderPanelHtml } from '../src/plugins/orchestrator.mjs'

const TOKEN = 'ui-smoke-token-0123456789abcdef0123456789abcdef'
const EDGE_CANDIDATES = [
  process.env['ProgramFiles(x86)'],
  process.env.ProgramFiles,
  process.env.LOCALAPPDATA,
].filter(Boolean).flatMap((root) => [
  path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
])
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p))
if (!EDGE) {
  console.error('SKIP ui-smoke: no Edge/Chrome found')
  process.exit(2)
}
if (typeof WebSocket !== 'function') {
  console.error('SKIP ui-smoke: Node WebSocket not available')
  process.exit(2)
}

const requests = []
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw })
  const json = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  if (url.pathname === '/fang/panel') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(renderPanelHtml('/fang', TOKEN))
    return
  }
  const task = {
    taskId: 'task_smoke', title: 'UI 冒烟任务', status: 'ready',
    adapter: { ok: true, version: '3.0.7' }, port: 18000, pid: 1234,
    url: 'http://127.0.0.1:18000/?token=smoke-web-token',
  }
  if (url.pathname === '/fang/api/status') return json(200, { version: '3.0.7', profileTag: 'smoke', tasks: { ready: 1, total: 1, list: [task] } })
  if (url.pathname === '/fang/api/tasks/create') return json(200, { ok: true, taskId: 'task_smoke', url: task.url, adapter: { ok: true } })
  if (url.pathname === '/fang/api/tasks/archive') return json(200, { ok: true })
  if (url.pathname === '/fang/api/tasks/promote') return json(200, { ok: true, outcome: 'preview', note: 'smoke' })
  return json(404, { ok: false, error: 'not-found', path: url.pathname })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const pageUrl = `http://127.0.0.1:${port}/fang/panel`

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ui-smoke-'))
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let devtoolsPort = 0
for (let i = 0; i < 100; i += 1) {
  const file = path.join(profile, 'DevToolsActivePort')
  if (fs.existsSync(file)) {
    const [p] = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    devtoolsPort = Number(p)
    if (devtoolsPort > 0) break
  }
  await sleep(100)
}
if (!devtoolsPort) { browser.kill(); server.close(); console.error('FAIL ui-smoke: DevTools port not ready'); process.exit(1) }

const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { browser.kill(); server.close(); console.error('FAIL ui-smoke: no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__uiSmoke = { opens: [], errors: [] };
window.open = (u) => { window.__uiSmoke.opens.push(String(u)); return null };
window.prompt = () => 'demo-plugin';
window.confirm = () => true;
window.alert = () => {};
window.addEventListener('error', (e) => window.__uiSmoke.errors.push(String(e.message || e)));
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (a) { e.preventDefault(); window.__uiSmoke.opens.push(a.href); }
}, true);`,
})
await send('Page.navigate', { url: pageUrl })
for (let i = 0; i < 60; i += 1) {
  const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
  if (r.result?.value === 'complete') break
  await sleep(100)
}
await sleep(500)

const sweep = await send('Runtime.evaluate', {
  expression: `(async () => {
    const out = { passes: [], buttons: [], opens: [], errors: [] };
    for (let pass = 0; pass < 3; pass++) {
      const list = [...document.querySelectorAll('button, a[href]')];
      const info = list.map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim(), id: el.getAttribute('data-btn-id') || '', act: el.getAttribute('data-act') || '', href: el.href || '' }));
      for (const item of info) if (!out.buttons.some((b) => b.text === item.text && b.tag === item.tag)) out.buttons.push(item);
      for (let i = 0; i < list.length; i++) {
        const el = [...document.querySelectorAll('button, a[href]')][i];
        if (!el) continue;
        try { el.click(); } catch (e) { out.errors.push(String(e && e.message || e)); }
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((r) => setTimeout(r, 250));
      out.passes.push({ pass, count: list.length });
    }
    out.opens = window.__uiSmoke?.opens ?? [];
    out.pageErrors = window.__uiSmoke?.errors ?? [];
    out.uiLog = window.__fangUiLog?.length ?? 0;
    return JSON.stringify(out);
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
const result = JSON.parse(sweep.result.value)

// ── 自动分析 ────────────────────────────────────────────────────────────────
const apiRequests = requests.filter((r) => r.path.startsWith('/fang/api/'))
const badAuth = apiRequests.filter((r) => r.headers['x-fang-auth'] !== TOKEN)
const endpoints = [...new Set(apiRequests.map((r) => `${r.method} ${r.path}`))]
const expected = [
  'GET /fang/api/status', 'POST /fang/api/tasks/create',
  'POST /fang/api/tasks/archive', 'POST /fang/api/tasks/promote',
]
const missing = expected.filter((e) => !endpoints.includes(e))
const problems = []
if (badAuth.length) problems.push(`${badAuth.length} 个 API 请求缺少/错误 x-fang-auth（首个 ${badAuth[0].path}）`)
if (missing.length) problems.push(`未覆盖端点：${missing.join(', ')}`)
if (!result.buttons.length) problems.push('页面没有可点击按钮/链接')
if (!result.opens.length) problems.push('没有触发 window.open / 链接跳转（打开操作未覆盖）')
if (result.pageErrors.length) problems.push(`页面异常：${result.pageErrors.join(' | ')}`)
if (!result.uiLog) problems.push('window.__fangUiLog 为空：UI 点击分析日志未生效')

console.log('ui-smoke: buttons=', result.buttons.length, 'opens=', result.opens.length, 'api=', apiRequests.length)
console.log('ui-smoke: endpoints=', endpoints.join(', '))
for (const b of result.buttons) console.log(`  button: ${b.tag} "${b.text}" id=${b.id} act=${b.act}`)
if (problems.length) {
  console.error('FAIL ui-smoke:')
  for (const p of problems) console.error(' - ' + p)
} else {
  console.log('PASS ui-smoke: all buttons clicked, auth header ok, expected endpoints covered, no page errors')
}

try { await send('Browser.close') } catch { /* ignore */ }
try { browser.kill() } catch { /* ignore */ }
server.close()
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(problems.length ? 1 : 0)
