// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/ui-rich-smoke.mjs — 富面板 UI 冒烟（Edge headless + 本地假 API）。
// 加载 desktop panel/index.html → 断言 data-mounted → 收集/点击 data-btn-id → 写 dist/ui-cases.json。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(path.dirname(ROOT), 'dsh-fang-desktop')
const EDGE = [
  process.env['ProgramFiles(x86)'],
  process.env.ProgramFiles,
  process.env.LOCALAPPDATA,
].filter(Boolean).flatMap((r) => [
  path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
]).find((p) => fs.existsSync(p))
if (!EDGE) { console.error('SKIP ui-rich-smoke: no Edge/Chrome'); process.exit(2) }

const requests = []
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  let body = ''
  for await (const c of req) body += c
  requests.push({ method: req.method, path: url.pathname, headers: req.headers, body })
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
  const file = url.pathname === '/dsh-fang/client.js'
    ? path.join(ROOT, 'client.js')
    : url.pathname === '/dsh-fang-desktop/panel/index.html'
      ? path.join(DESKTOP, 'panel', 'index.html')
      : null
  if (file) {
    try {
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(file))
    } catch { res.writeHead(404); res.end('not found') }
    return
  }
  if (url.pathname === '/fang/api/status') return json({ ok: true, version: '3.0.7', role: 'mother', profileTag: 'smoke', tasks: { ready: 1, total: 1, max: 5, list: [], capacity: { slots: 7, limit: 5, used: 1 } } })
  if (url.pathname === '/fang/api/tasks') return json({ ok: true, tasks: [{
    taskId: 'task_smoke', title: 'UI 冒烟分身', status: 'running', phase: 'paused',
    health: { adapter: 'ok' }, adapter: { ok: true, version: '3.0.7' }, port: 18000, pid: 1,
    url: 'http://127.0.0.1:18000/?token=t', sessionTitle: '冒烟会话',
    startedAt: Date.now() - 60000, updatedAt: Date.now(), projectBytes: 1024,
    actions: {}, blocks: [],
  }] })
  if (url.pathname === '/fang/api/essence/list') return json({ ok: true, officialId: 'essence-official-dev', defaultId: 'essence-official-dev', essences: [
    { id: 'essence-official-dev', name: '官方推荐', locked: true, official: true, pluginCount: 11 },
    { id: 'essence-demo', name: '冒烟元主', locked: false, official: false, pluginCount: 2 },
  ], capacity: { slots: 7, defaultLimit: 5, used: 2 } })
  if (url.pathname === '/fang/api/sessions') return json({ ok: true, sessions: [] })
  if (url.pathname === '/fang/api/tasks/rename') return json({ ok: true })
  if (url.pathname === '/fang/api/essence/rename') return json({ ok: true })
  json({ ok: true })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const pageUrl = `http://127.0.0.1:${port}/dsh-fang-desktop/panel/index.html`

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-rich-'))
const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let dport = 0
for (let i = 0; i < 100 && !dport; i += 1) {
  try {
    const [p] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    dport = Number(p) || 0
  } catch { /* wait */ }
  if (!dport) await sleep(100)
}
if (!dport) { browser.kill(); server.close(); console.error('FAIL no devtools port'); process.exit(1) }
const pages = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()
const page = pages.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })) })

await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__uiSmoke={errors:[],opens:[]};window.addEventListener('error',e=>window.__uiSmoke.errors.push(String(e.message)));window.open=u=>{window.__uiSmoke.opens.push(String(u));return null};document.addEventListener('click',e=>{const a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(a){e.preventDefault();e.stopPropagation();window.__uiSmoke.opens.push(a.href)}},true);` })
await send('Page.navigate', { url: pageUrl })
for (let i = 0; i < 80; i += 1) {
  const r = await send('Runtime.evaluate', { expression: 'document.body.dataset.mounted || document.body.dataset.mountError || ""', returnByValue: true })
  if (r.result?.value) break
  await sleep(150)
}
await sleep(600)
const evalr = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
const state = await evalr(`JSON.stringify({
  mounted: document.body.dataset.mounted || '',
  mountError: document.body.dataset.mountError || '',
  errors: window.__uiSmoke?.errors ?? [],
  buttons: [...document.querySelectorAll('[data-btn-id]')].map(el => ({ id: el.getAttribute('data-btn-id'), zone: el.closest('[data-zone]')?.getAttribute('data-zone') || '', state: el.closest('[data-state]')?.getAttribute('data-state') || '' })),
  zones: [...document.querySelectorAll('[data-zone]')].map(el => el.getAttribute('data-zone')),
  slots: [...document.querySelectorAll('[data-slot]')].map(el => el.getAttribute('data-slot')),
})`)
const s = JSON.parse(state)
// 注意：批量点击所有按钮会在部分面板实现中触发导航/重建，先做静态与交互断言，
// 不再无条件点击全部按钮（点击由各用例显式指定选择器）。
const api = requests.filter((r) => r.path.startsWith('/fang/api/'))
const endpoints = [...new Set(api.map((r) => `${r.method} ${r.path}`))]
const ui = await evalr(`(async () => {
  const q = (s) => document.querySelector(s);
  const mother = q('[data-btn-id="mother"]');
  mother?.click();
  const paletteOpen = !!q('[data-zone="palette"]');
  mother?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const opensAfter = (window.__uiSmoke?.opens || []).length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const paletteAfterEsc = !!q('[data-zone="palette"]');
  const slots = [...document.querySelectorAll('[data-slot]')].map((el) => ({
    slot: el.getAttribute('data-slot'), enabled: el.getAttribute('data-enabled'), reason: el.getAttribute('data-reason') || '',
  }));
  const header = document.body.textContent || '';
  return JSON.stringify({ paletteOpen, opensAfter, paletteAfterEsc, slots, header });
})()`)
const u = JSON.parse(ui)
const cases = [
  { id: 'UI-11', ok: s.buttons.length > 0 && s.buttons.every((b) => b.id), evidence: `${s.buttons.length} buttons` },
  { id: 'UI-06', ok: s.buttons.some((b) => b.state) || s.zones.includes('derived'), evidence: `zones=${s.zones.join(',')}` },
  { id: 'UI-01', ok: /母体/.test(u.header) && /元主/.test(u.header) && /分身/.test(u.header), evidence: u.header.slice(0, 80).replace(/\n/g, ' ') },
  { id: 'UI-mounted', ok: s.mounted === '1' && !s.mountError, evidence: `mounted=${s.mounted} error=${s.mountError}` },
  { id: 'UI-02', ok: u.paletteOpen, evidence: `palette=${u.paletteOpen}` },
  { id: 'UI-03', ok: u.opensAfter > 0, evidence: `opens=${u.opensAfter}` },
  { id: 'UI-04', ok: !u.paletteAfterEsc, evidence: `afterEsc=${u.paletteAfterEsc}` },
  { id: 'UI-05', ok: u.slots.length === 7 && u.slots.filter((x) => x.enabled === 'false').every((x) => x.reason), evidence: `slots=${u.slots.length}` },
]
const failures = cases.filter((c) => !c.ok)
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'dist', 'ui-cases.json'), JSON.stringify({ cases, buttons: s.buttons, endpoints, errors: s.errors }, null, 2))
for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.evidence}`)
console.log('endpoints:', endpoints.join(', ') || 'none')
console.log(`${failures.length ? 'RED' : 'GREEN'}  rich UI smoke ${cases.length - failures.length}/${cases.length}`)
try { await send('Browser.close') } catch { /* ignore */ }
try { browser.kill() } catch { /* ignore */ }
server.close()
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0)
