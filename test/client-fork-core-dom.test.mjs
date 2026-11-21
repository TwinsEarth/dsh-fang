// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 真机回归（v3.5.2）：面板「分身Core核心加速引擎」按钮在 accelerated.installed=true 时
// 必须真正发出 POST /fang/api/fork-core 并更新按钮状态；点击无效/只弹警告是服务端把
// 加速核判成未安装时的表现。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }
if (!JSDOM) {
  test('client-fork-core-dom: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  async text() { return JSON.stringify(body) },
  async json() { return body },
})

function makeHarness({ tasks = [] } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  window.TextDecoder = TextDecoder
  window.TextEncoder = TextEncoder
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0)
    window.cancelAnimationFrame = (id) => window.clearTimeout(id)
  }
  const calls = []
  const baseView = {
    ok: true, mode: 'stock', sessionMode: 'new', effectiveMode: 'stock', blocked: null,
    accelerated: { installed: true, version: '3.5.0', cliPath: 'D:\\ToFuture\\accel\\cli\\node_modules\\@twinsearth\\dsh\\lib\\bin.js', source: 'state', error: null, searched: [], installedAt: null, sizeBytes: 1, limitBytes: 2, requiresConfirmation: false, root: null },
    forks: { stock: 0, accelerated: 0 }, essence: 'stock', updatedAt: null, updatedBy: null,
  }
  window.fetch = async (url, init = {}) => {
    const u = String(url)
    const method = String(init.method ?? 'GET').toUpperCase()
    let body = null
    try { body = init.body ? JSON.parse(init.body) : null } catch { body = null }
    calls.push({ url: u, method, body })
    if (u.includes('/fang/api/fork-core') && method === 'POST') {
      return jsonResponse({ ...baseView, mode: body?.mode ?? 'stock', effectiveMode: body?.mode ?? 'stock', changed: true, updatedAt: new Date().toISOString(), updatedBy: 'panel' })
    }
    if (u.includes('/fang/api/fork-core')) return jsonResponse(baseView)
    if (u.includes('/fang/api/status')) return jsonResponse({ ok: true, version: '3.5.3', role: 'mother', profileTag: 'test', tasks: { ready: 0, total: 0, max: 8, list: [], capacity: { slots: 7, limit: 5, used: 0 } }, forks: { total: 0, running: 0, max: 8, list: [] }, mother: { profile: 'desktop' } })
    if (u.includes('/fang/api/tasks')) return jsonResponse({ ok: true, tasks })
    if (u.includes('/fang/api/essence/list')) return jsonResponse({ ok: true, officialId: null, defaultId: null, essences: [], staleCount: 0 })
    if (u.includes('/fang/api/sessions')) return jsonResponse({ ok: true, sessions: [], total: 0, degraded: [] })
    if (u.includes('/fang/api/auth-token')) return jsonResponse({ token: 't' })
    if (u.includes('/fang/api/decisions/events')) return jsonResponse({ ok: false }, 404)
    if (u.includes('/fang/api/decisions/ai')) return jsonResponse({ ok: true, configured: false, providers: [] })
    if (u.includes('/fang/api/decisions')) return jsonResponse({ ok: true, items: [], rev: 1, counts: {} })
    return jsonResponse({ ok: true })
  }
  const ReactStub = { useRef: (v) => ({ current: v }), useEffect: () => {}, createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const registrations = []
  const ctx = {
    slots: { inject(_name, callback) { callback(); return () => {} }, register(meta, render) { registrations.push({ meta, render }); return () => {} } },
    layout: { selectPanel() {} },
  }
  window.__ModuleLoader__ = { load({ factory }) { window.__plugin = factory((name) => { if (name === 'react') return ReactStub; throw new Error(`unexpected require: ${name}`) }) } }
  window.__FANG_TEST_HOOK__ = true
  window.eval(source)
  window.__plugin.apply(ctx)
  return { dom, window, registrations, calls }
}

function mountConsole(harness) {
  const { window } = harness
  const reg = harness.registrations.find((item) => item.meta?.name === 'main' && item.meta?.key === 'fang')
  assert.ok(reg, 'main slot registered')
  const element = typeof reg.render === 'function' ? reg.render({}) : reg.render
  const doc = window.document
  const shell = doc.createElement('div')
  shell.style.cssText = 'display:flex;flex-direction:column;min-height:0;height:900px;overflow:hidden;'
  const host = doc.createElement('div')
  for (const [key, value] of Object.entries(element.props.style ?? {})) host.style[key] = value
  shell.append(host)
  doc.body.append(shell)
  element.props.mount(host)
  return { host }
}

const waitFor = async (fn, { timeout = 3000, interval = 20 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

test('fork-core button: installed accelerated core → click sends POST and flips the label', async () => {
  const harness = makeHarness()
  mountConsole(harness)
  const doc = harness.window.document
  await waitFor(() => doc.querySelector('[data-fk="fork-core"]'))
  await waitFor(() => harness.calls.some((call) => call.url.includes('/fang/api/fork-core') && call.method === 'GET'))
  // 等 fork-core 数据落地（installed=true 时 title 以“当前：”开头）；整棵视图会重建，
  // 必须在落地后重新取节点，否则点到的是首帧旧节点（handler 里的闭包仍是 installed=false）。
  await waitFor(() => /^当前：/.test(doc.querySelector('[data-fk="fork-core"]')?.title ?? ''), { timeout: 5000 })
  const button = doc.querySelector('[data-fk="fork-core"]')
  assert.match(button.textContent, /官方/, 'stock mode label must render first')
  button.click()
  const post = await waitFor(() => harness.calls.find((call) => call.url.includes('/fang/api/fork-core') && call.method === 'POST'))
  assert.equal(post.body?.mode, 'accelerated', 'click must request the accelerated core')
  await waitFor(() => /一键加速/.test(doc.querySelector('[data-fk="fork-core"]')?.textContent ?? ''))
  harness.window.close()
})

test('fork-core button: no accel install → click is fail-closed (no POST, no silent switch)', async () => {
  const harness = makeHarness()
  // 覆盖 GET 响应：accelerated.installed=false
  const original = harness.window.fetch
  harness.window.fetch = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    if (String(url).includes('/fang/api/fork-core') && method === 'GET') {
      harness.calls.push({ url: String(url), method, body: null })
      return jsonResponse({ ok: true, mode: 'stock', sessionMode: 'new', effectiveMode: 'stock', blocked: null, accelerated: { installed: false, version: null, cliPath: null, source: null, error: 'accelerated-cli-missing', searched: [], installedAt: null, sizeBytes: 0, limitBytes: 1, requiresConfirmation: false, root: null }, forks: { stock: 0, accelerated: 0 }, essence: 'stock', updatedAt: null, updatedBy: null })
    }
    return original(url, init)
  }
  mountConsole(harness)
  const doc = harness.window.document
  const button = await waitFor(() => doc.querySelector('[data-fk="fork-core"]'))
  await waitFor(() => harness.calls.some((call) => call.url.includes('/fang/api/fork-core') && call.method === 'GET'))
  await waitFor(() => /加速核未安装/.test(doc.querySelector('[data-fk="fork-core"]')?.title ?? ''), { timeout: 5000 })
  button.click()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(harness.calls.some((call) => call.url.includes('/fang/api/fork-core') && call.method === 'POST'), false, 'must not POST when the accel core is not installed')
  assert.match(doc.querySelector('[data-fk="fork-core"]')?.textContent ?? '', /官方/, 'mode must stay stock')
  harness.window.close()
})

test('task card: 4-state status bar + 启动/一键修复 buttons render without breaking the panel', async () => {
  const task = {
    taskId: 'task_statusbar1',
    forkId: 'task_statusbar1',
    title: '状态栏测试分身',
    status: 'failed',
    phase: 'failed',
    health: { adapter: 'n/a', error: '' },
    adapter: { ok: false, version: '', protocol: 0, error: 'exited' },
    port: 18000,
    pid: null,
    coreMode: 'stock',
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
    projectBytes: 0,
    collaborators: [],
    actions: {},
  }
  const harness = makeHarness({ tasks: [task] })
  mountConsole(harness)
  const doc = harness.window.document
  const card = await waitFor(() => doc.querySelector('[data-task="task_statusbar1"]'))
  const status = card.querySelector('.fork-status')
  assert.ok(status, 'status bar must render on the fork card')
  assert.equal(status.getAttribute('data-state'), 'failed')
  assert.match(status.textContent, /故障/)
  assert.ok(card.querySelector('[data-fk="start:task_statusbar1"]'), '启动 action must render')
  assert.ok(card.querySelector('[data-fk="repair:task_statusbar1"]'), '一键修复 action must render')
  assert.match(card.textContent, /一键修复/)
  harness.window.close()
})

}
