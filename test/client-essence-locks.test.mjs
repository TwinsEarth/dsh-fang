// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.23：元主 Web 界面收敛（隐藏工作区/新会话、默认落地插件页、元主不执行会话与指令）的 jsdom 回归。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const waitFor = async (fn, { timeout = 4000, interval = 10 } = {}) => {
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

function makeHarness({ role = 'essence' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' })
  const { window } = dom
  let plugin = null
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/fang/api/status')) return role === 'mother' ? jsonResponse({ ok: true, role: 'mother' }) : jsonResponse({ error: 'http-404' }, 404)
    if (path.includes('/fang/adapter/identity')) return jsonResponse({ ok: true, kind: role })
    return jsonResponse({ ok: true })
  }
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => ({ createElement: () => null, useEffect: () => {}, useRef: (v) => ({ current: v }) })) } }
  window.__FANG_TEST_HOOK__ = true
  window.eval(source)
  return { window, dom, plugin }
}

function seedSidebar(window) {
  const doc = window.document
  const nav = doc.createElement('aside')
  nav.className = 'sidebar'
  for (const label of ['插件', '工作区', '新会话Ctrl+Alt+N', '自动化任务']) {
    const button = doc.createElement('button')
    button.className = 'wtg9ga_panelRow'
    button.textContent = label
    button.dataset.clicks = '0'
    button.addEventListener('click', () => { button.dataset.clicks = String(Number(button.dataset.clicks) + 1) })
    nav.appendChild(button)
  }
  doc.body.appendChild(nav)
  const composer = doc.createElement('div')
  composer.className = 'composer'
  const textarea = doc.createElement('textarea')
  textarea.placeholder = '发消息或创建任务'
  composer.appendChild(textarea)
  const send = doc.createElement('button')
  send.setAttribute('aria-label', '发送')
  send.textContent = '发送'
  composer.appendChild(send)
  doc.body.appendChild(composer)
  return { nav, composer, textarea, send }
}

if (!JSDOM) {
  test('client-essence-locks: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {
  test('essence locks: workspace/new-session hidden, plugin page opened once', async () => {
    const { window, plugin } = makeHarness({ role: 'essence' })
    const { nav } = seedSidebar(window)
    const dispose = plugin.__mountEssenceUiLocks()
    try {
      await waitFor(() => window.document.documentElement.getAttribute('data-fang-essence-locks') === 'applied')
      await waitFor(() => {
        const buttons = [...nav.querySelectorAll('button')]
        return buttons.find((b) => b.textContent === '工作区')?.hidden && buttons.find((b) => b.textContent === '新会话Ctrl+Alt+N')?.hidden
      })
      const buttons = [...nav.querySelectorAll('button')]
      const pluginNav = buttons.find((b) => b.textContent === '插件')
      assert.equal(pluginNav.hidden, false, 'plugin nav must stay visible')
      await waitFor(() => Number(pluginNav.dataset.clicks) >= 1)
      assert.equal(window.document.documentElement.getAttribute('data-fang-essence-landing'), 'plugins')
    } finally { dispose() }
  })

  test('essence locks: composer and send button hidden; Enter swallowed', async () => {
    const { window, plugin } = makeHarness({ role: 'essence' })
    const nodes = seedSidebar(window)
    const dispose = plugin.__mountEssenceUiLocks()
    try {
      await waitFor(() => window.document.documentElement.getAttribute('data-fang-essence-locks') === 'applied')
      await waitFor(() => nodes.composer.hidden === true)
      assert.equal(nodes.send.hidden, true, 'send button must be hidden')
      const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      nodes.textarea.dispatchEvent(event)
      assert.equal(event.defaultPrevented, true, 'Enter inside composer must be swallowed')
      assert.ok(window.document.getElementById('fang-essence-notice'), 'notice banner must be present')
    } finally { dispose() }
  })

  test('essence locks: click on hidden workspace row is swallowed', async () => {
    const { window, plugin } = makeHarness({ role: 'essence' })
    const { nav } = seedSidebar(window)
    const dispose = plugin.__mountEssenceUiLocks()
    try {
      await waitFor(() => window.document.documentElement.getAttribute('data-fang-essence-locks') === 'applied')
      const workspace = [...nav.querySelectorAll('button')].find((b) => b.textContent === '工作区')
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
      workspace.dispatchEvent(event)
      assert.equal(event.defaultPrevented, true, 'click on workspace row must be swallowed')
    } finally { dispose() }
  })

  test('essence locks: no-op for fork role', async () => {
    const { window, plugin } = makeHarness({ role: 'fork' })
    const { nav } = seedSidebar(window)
    const dispose = plugin.__mountEssenceUiLocks()
    try {
      await new Promise((r) => setTimeout(r, 500))
      assert.equal(window.document.documentElement.getAttribute('data-fang-essence-locks'), null, 'locks must not apply for fork')
      assert.equal(Boolean([...nav.querySelectorAll('button')].find((b) => b.textContent === '工作区')?.hidden), false)
    } finally { dispose() }
  })
}
