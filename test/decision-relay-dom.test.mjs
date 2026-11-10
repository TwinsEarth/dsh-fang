// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Client DOM test (v3.1.13): per-conversation decision relay — a right-side floating
// “待选” button that opens a right-to-left decision drawer, resolves via A/B/C/D options
// or a free-text decision.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }
if (!JSDOM) {
  test('decision-relay-dom: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  async text() { return JSON.stringify(body) },
  async json() { return body },
})

const waitFor = async (fn, { timeout = 2500, interval = 15 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

function makeHarness({ role = 'mother' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  window.TextDecoder = TextDecoder
  window.TextEncoder = TextEncoder
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0)
    window.cancelAnimationFrame = (id) => window.clearTimeout(id)
  }
  window.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/fang/api/auth-token')) return jsonResponse({ token: 'test-token' })
    if (target.includes('/fang/api/status')) {
      return role === 'mother' ? jsonResponse({ ok: true, role: 'mother', version: '3.1.13' }) : jsonResponse({ ok: false, error: 'http-404' }, 404)
    }
    if (target.includes('/fang/adapter/hello')) return jsonResponse({ ok: true, role: 'fork', kind: 'fork', taskId: 'task_x', version: '3.1.13' })
    return jsonResponse({ ok: true })
  }
  const ReactStub = {
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  }
  window.__ModuleLoader__ = { load({ factory }) { window.__plugin = factory((name) => { if (name === 'react') return ReactStub; throw new Error(`unexpected require: ${name}`) }) } }
  window.__FANG_TEST_HOOK__ = true
  window.eval(source)
  return { dom, window, doc: window.document, plugin: window.__plugin }
}

function makeStore(initialTickets = []) {
  const listeners = new Set()
  const calls = { resolve: [], custom: [] }
  const tickets = initialTickets.map((ticket) => ({ status: 'pending', ...ticket }))
  const emit = () => { for (const fn of [...listeners]) { try { fn() } catch { /* ignore */ } } }
  const store = {
    pending: () => tickets.filter((ticket) => ticket.status === 'pending'),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async resolve(id, option) {
      calls.resolve.push({ id, option })
      const ticket = tickets.find((item) => item.id === id)
      if (!ticket) return { ok: false, reason: 'not-found' }
      ticket.status = 'resolved'
      emit()
      return { ok: true }
    },
    async resolveCustom(id, text) {
      calls.custom.push({ id, text })
      const ticket = tickets.find((item) => item.id === id)
      if (!ticket) return { ok: false, reason: 'not-found' }
      ticket.status = 'resolved'
      emit()
      return { ok: true }
    },
    async refresh() {},
  }
  return { store, calls, tickets }
}

function mount(harness, store, sessionId = 'session-1') {
  const host = harness.doc.createElement('div')
  harness.doc.body.append(host)
  const dispose = harness.plugin.__mountDecisionRelay(host, store, sessionId)
  return { host, dispose }
}

const ticket = (over = {}) => ({
  id: 'dec_1', level: 'yellow', title: '选择执行路径',
  context: '两个方案都可以，请决定', options: [{ value: 'a', label: '方案 A' }, { value: 'b', label: '方案 B' }],
  source: { sessionId: 'session-1' }, ...over,
})

test('decision relay: pending session shows a right-side 待选 button and A/B options', async () => {
  const harness = makeHarness()
  const { store, calls } = makeStore([ticket()])
  const { dispose } = mount(harness, store)
  try {
    const fab = await waitFor(() => {
      const node = harness.doc.querySelector('.fang-relay-fab')
      return node && node.hidden === false ? node : null
    })
    assert.match(fab.textContent, /待选/)
    assert.equal(harness.doc.querySelector('.fang-relay-count').textContent, '1')
    fab.click()
    const panel = await waitFor(() => {
      const node = harness.doc.querySelector('.fang-relay-panel.is-open')
      return node || null
    })
    assert.ok(panel, 'drawer opens')
    assert.ok(harness.doc.querySelector('.fang-relay-backdrop.is-open'), 'backdrop opens')
    const keys = [...panel.querySelectorAll('.fang-relay-option .fang-relay-key')].map((node) => node.textContent)
    assert.deepEqual(keys, ['A', 'B'])
    panel.querySelector('[data-option-key="A"]').click()
    await waitFor(() => calls.resolve.length === 1)
    assert.deepEqual(calls.resolve[0], { id: 'dec_1', option: 'a' })
    await waitFor(() => harness.doc.querySelector('.fang-relay-empty'))
    assert.equal(harness.doc.querySelector('.fang-relay-fab').hidden, true, 'button hides when nothing is pending')
    dispose()
    assert.equal(harness.doc.querySelector('.fang-relay-fab'), null, 'dispose removes the relay chrome')
  } finally {
    harness.window.close()
  }
})

test('decision relay: free-text decision resolves the same ticket', async () => {
  const harness = makeHarness()
  const { store, calls } = makeStore([ticket({ id: 'dec_2' })])
  const { dispose } = mount(harness, store)
  try {
    const fab = await waitFor(() => {
      const node = harness.doc.querySelector('.fang-relay-fab')
      return node && node.hidden === false ? node : null
    })
    fab.click()
    const input = await waitFor(() => harness.doc.querySelector('.fang-relay-input'))
    input.value = '按 B 方案处理，先灰度 10%'
    input.dispatchEvent(new harness.window.Event('input', { bubbles: true }))
    harness.doc.querySelector('.fang-relay-submit').click()
    await waitFor(() => calls.custom.length === 1)
    assert.deepEqual(calls.custom[0], { id: 'dec_2', text: '按 B 方案处理，先灰度 10%' })
    await waitFor(() => harness.doc.querySelector('.fang-relay-empty'))
    dispose()
  } finally {
    harness.window.close()
  }
})

test('decision relay: tickets from other sessions are ignored; no pending means no button', async () => {
  const harness = makeHarness()
  const { store } = makeStore([ticket({ id: 'dec_other', source: { sessionId: 'session-other' } })])
  const { dispose } = mount(harness, store, 'session-1')
  try {
    const fab = await waitFor(() => harness.doc.querySelector('.fang-relay-fab'))
    assert.equal(fab.hidden, true)
    assert.equal(harness.doc.querySelectorAll('.fang-relay-ticket').length, 0)
    dispose()
  } finally {
    harness.window.close()
  }
})

test('decision relay: fork web never mounts the relay (decisions live in the mother)', async () => {
  const harness = makeHarness({ role: 'fork' })
  const { store } = makeStore([ticket()])
  const { dispose } = mount(harness, store)
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(harness.doc.querySelector('.fang-relay-fab'), null)
    dispose()
  } finally {
    harness.window.close()
  }
})

test('decision relay: socket wiring exposes the relay and custom resolve API', () => {
  const clientText = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(clientText, /conversation\.session\.header\.utilities/)
  assert.match(clientText, /fang-relay-fab/)
  assert.match(clientText, /resolveCustom\(id, text\)/)
  const center = fs.readFileSync(new URL('../src/plugins/decision-center.mjs', import.meta.url), 'utf8')
  assert.match(center, /customInput/)
  assert.match(center, /useCustom/)
})

}
