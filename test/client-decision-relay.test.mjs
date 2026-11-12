// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.24：决策中继浮窗改造——底部 1/3 高度、不遮挡工作区、选完/点外部自动收起为小浮标。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const styleText = (source.match(/style\.textContent = `([\s\S]*?)`\n/) || [])[1] || ''

const waitFor = async (fn, { timeout = 3000, interval = 10 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error('waitFor timeout')
}

function makeHarness({ role = 'mother' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' })
  const { window } = dom
  let plugin = null
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/fang/api/status')) return role === 'mother' ? json({ ok: true, role: 'mother' }) : json({ error: 'http-404' }, 404)
    if (path.includes('/fang/adapter/identity')) return json({ ok: true, kind: role })
    return json({ ok: true })
  }
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => ({ createElement: () => null, useEffect: () => {}, useRef: (v) => ({ current: v }) })) } }
  window.__FANG_TEST_HOOK__ = true
  window.eval(source)
  return { window, dom, plugin }
}

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body }, async text() { return JSON.stringify(body) } }
}

function makeStore(tickets) {
  return {
    pending: () => tickets,
    subscribe: () => () => {},
    refresh: async () => {},
    resolve: async () => ({ ok: true }),
    resolveCustom: async () => ({ ok: true }),
    unread: () => tickets.length,
    state: {},
  }
}

if (!JSDOM) {
  test('decision relay: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {
  test('decision relay: panel is bottom-anchored at 1/3 height and has no blocking backdrop', () => {
    assert.match(styleText, /\.fang-relay-panel\{[^}]*height:33vh/)
    assert.match(styleText, /\.fang-relay-panel\{[^}]*bottom:12px/)
    assert.match(styleText, /\.fang-relay-backdrop\{display:none\}/)
  })

  test('decision relay: opens from FAB, collapses when clicking outside', async () => {
    const { window, plugin } = makeHarness()
    const doc = window.document
    const tickets = [{ id: 'dec_test_1', level: 'yellow', title: '测试决策', options: [{ value: 'a', label: 'A' }], source: { sessionId: 'session-test' } }]
    const dispose = plugin.__mountDecisionRelay(doc.body, makeStore(tickets), 'session-test')
    try {
      await waitFor(() => doc.querySelector('.fang-relay-fab') && !doc.querySelector('.fang-relay-fab').hidden)
      const panel = doc.querySelector('.fang-relay-panel')
      assert.equal(panel.classList.contains('is-open'), false)
      doc.querySelector('.fang-relay-fab').click()
      await waitFor(() => panel.classList.contains('is-open'))
      // 点面板外部（body 其他区域）→ 收起
      doc.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
      await waitFor(() => panel.classList.contains('is-open') === false)
    } finally { dispose() }
  })

  test('decision relay: choosing an option collapses back to the FAB', async () => {
    const { window, plugin } = makeHarness()
    const doc = window.document
    let resolved = false
    const tickets = [{ id: 'dec_test_2', level: 'red', title: '阻塞决策', options: [{ value: 'ok', label: 'OK' }], source: { sessionId: 'session-test' } }]
    const store = makeStore(tickets)
    store.resolve = async () => { resolved = true; return { ok: true } }
    const dispose = plugin.__mountDecisionRelay(doc.body, store, 'session-test')
    try {
      await waitFor(() => doc.querySelector('.fang-relay-fab') && !doc.querySelector('.fang-relay-fab').hidden)
      doc.querySelector('.fang-relay-fab').click()
      const panel = doc.querySelector('.fang-relay-panel')
      await waitFor(() => panel.classList.contains('is-open'))
      await waitFor(() => panel.querySelector('.fang-relay-option'))
      panel.querySelector('.fang-relay-option').click()
      await waitFor(() => resolved)
      await waitFor(() => panel.classList.contains('is-open') === false)
    } finally { dispose() }
  })
}
