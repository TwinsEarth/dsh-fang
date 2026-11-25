// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.19：分身 Web 界面收敛（隐藏「插件」入口 + 「启动」无操作）的 jsdom 回归。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const waitFor = async (fn, { timeout = 3000, interval = 10 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitFor timeout')
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body }, async text() { return JSON.stringify(body) } }
}

function makeHarness({ role = 'fork' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously' })
  const { window } = dom
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/fang/api/status')) {
      return role === 'mother' ? jsonResponse({ ok: true, role: 'mother' }) : jsonResponse({ error: 'http-404' }, 404)
    }
    if (path.includes('/fang/adapter/identity')) return jsonResponse({ ok: true, kind: role })
    if (path.includes('/fang/api/auth-token')) return jsonResponse({ token: 'test-token' })
    if (path.includes('/fang/adapter/client-report')) return jsonResponse({ ok: true })
    return jsonResponse({ ok: true })
  }
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => ({ createElement: () => null, useEffect: () => {}, useRef: (v) => ({ current: v }) })) } }
  window.__FANG_TEST_HOOK__ = true
  let plugin = null
  window.eval(source)
  return { window, dom, plugin }
}

if (!JSDOM) {
  test('client-fork-locks: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {
  test('client-fork-locks: fork hides the sidebar 插件 entry and keeps it hidden after re-render', async () => {
    const { window, plugin } = makeHarness({ role: 'fork' })
    const doc = window.document

    const nav = doc.createElement('button')
    nav.className = 'wtg9ga_panelRow'
    nav.textContent = '插件'
    doc.body.append(nav)

    const dispose = plugin.__mountForkUiLocks()
    try {
      await waitFor(() => nav.hidden === true)
      assert.equal(nav.hidden, true, '插件 nav must be hidden for fork')
      assert.equal(nav.getAttribute('aria-hidden'), 'true')

      // 模拟宿主重渲染：一个新的「插件」按钮出现，也必须被隐藏
      const nav2 = doc.createElement('button')
      nav2.className = 'wtg9ga_panelRow'
      nav2.textContent = '插件'
      doc.body.append(nav2)
      await waitFor(() => nav2.hidden === true)
      assert.equal(nav2.hidden, true, 're-rendered nav must be hidden too')
    } finally { dispose() }

    // 卸载后恢复
    assert.equal(nav.hidden, false, 'disposer must restore the entry')
  })

  test('client-fork-locks: fork swallows clicks on 启动 buttons (no host handler, no alert)', async () => {
    const { window, plugin } = makeHarness({ role: 'fork' })
    const doc = window.document

    let hostHandlerCalls = 0
    const start = doc.createElement('button')
    start.textContent = '启动'
    start.addEventListener('click', () => { hostHandlerCalls += 1 })
    doc.body.append(start)

    const alert = doc.createElement('div')
    alert.setAttribute('role', 'alert')
    alert.textContent = '启动失败：未配置凭据'
    alert.style.display = 'block'
    doc.body.append(alert)

    const dispose = plugin.__mountForkUiLocks()
    try {
      await waitFor(() => true)
      await new Promise((r) => setTimeout(r, 120))
      start.click()
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(hostHandlerCalls, 0, 'host click handler must not run for 启动 in fork')
      assert.equal(alert.style.display, 'none', 'error alert must be hidden in fork')
    } finally { dispose() }
    assert.equal(alert.style.display, 'block', 'disposer restores the alert element style')
  })

  test('client-fork-locks: mother keeps the 插件 entry and 启动 behaviour', async () => {
    const { window, plugin } = makeHarness({ role: 'mother' })
    const doc = window.document
    const nav = doc.createElement('button')
    nav.className = 'wtg9ga_panelRow'
    nav.textContent = '插件'
    doc.body.append(nav)

    let calls = 0
    const start = doc.createElement('button')
    start.textContent = '启动'
    start.addEventListener('click', () => { calls += 1 })
    doc.body.append(start)

    const dispose = plugin.__mountForkUiLocks()
    try {
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(nav.hidden, false, 'mother must keep the 插件 entry')
      start.click()
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(calls, 1, 'mother click handler must still run')
    } finally { dispose() }
  })

  test('client-fork-locks: hides the entry even when the host drops the panelRow class', async () => {
    const { window, plugin } = makeHarness({ role: 'fork' })
    const doc = window.document
    const sidebar = doc.createElement('nav')
    doc.body.append(sidebar)
    const btn = doc.createElement("button")
    btn.textContent = '插件'
    sidebar.append(btn)

    const dispose = plugin.__mountForkUiLocks()
    try {
      await waitFor(() => btn.hidden === true || window.getComputedStyle(btn).display === 'none')
      assert.ok(btn.hidden === true || window.getComputedStyle(btn).display === 'none', 'entry inside <nav> must be hidden')
      assert.equal(doc.documentElement.getAttribute('data-fang-fork-locks'), 'applied', 'diagnostic attribute must be set')
    } finally { dispose() }
  })
}
