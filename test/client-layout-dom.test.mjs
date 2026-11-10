// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Client layout regression (v3.1.9): with many essences and forks the two console
// columns must each be a fixed-height scroll area (wheel + draggable scrollbar), and
// the middle handle is the size splitter.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// jsdom is a devDependency; a clean CI checkout may not have it. Skip, don't fail the suite.
let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }
if (!JSDOM) {
  test('client-layout-dom: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  async text() { return JSON.stringify(body) },
  async json() { return body },
})

const now = Date.now()
const essences = Array.from({ length: 24 }, (_, i) => ({
  id: `essence-${i}`, name: `元主 ${i + 1}`, locked: i === 0, official: i === 0, pluginCount: 2,
  tier: 'free', status: 'ready', archived: false, stale: false, createdAt: now - i * 1000, updatedAt: now,
  lastMergedAt: now, lastSyncAt: now, sessions: { used: 1, limit: 10, over: false },
  quota: { sessions: { used: 1, limit: 10, over: false } }, runtime: { running: false, pid: null, port: null },
  actions: {}, blocks: [],
}))
const tasks = Array.from({ length: 24 }, (_, i) => ({
  taskId: `task_${i}`, forkId: `task_${i}`, title: `分身 ${i + 1}`, taskTitle: `分身 ${i + 1}`,
  status: 'ready', phase: 'running', health: { adapter: 'ok', error: '' }, actions: {}, blocks: [],
  sessionTitle: '', startedAt: now, updatedAt: now, projectBytes: 1, essenceId: essences[0].id,
  sessions: { count: 0, violation: false }, essenceDeleted: false,
  branch: { activeBranchId: 'main', sessionId: `s${i}`, count: 1 },
  pid: 100 + i, port: 18000 + i, url: `http://127.0.0.1:${18000 + i}/`, homeDir: 'h', profile: 'p',
  createdAt: now, restarts: 0, adapter: { ok: true, version: '3.1.9', protocol: 3, error: '' },
  collaborators: [], seed: null, importedSession: null, archivedAt: null, archiveRemote: null,
}))

function makeHarness() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true })
  const { window } = dom
  window.TextDecoder = TextDecoder
  window.TextEncoder = TextEncoder
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0)
    window.cancelAnimationFrame = (id) => window.clearTimeout(id)
  }
  window.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/fang/api/status')) return jsonResponse({ ok: true, version: '3.1.9', role: 'mother', profileTag: 'test',
      tasks: { ready: 24, total: 24, max: 8, list: [], capacity: { slots: 7, limit: 5, used: 5 } },
      forks: { total: 24, running: 24, max: 8, list: [] }, mother: { profile: 'desktop' } })
    if (u.includes('/fang/api/tasks/sessions')) return jsonResponse({ ok: true, sessions: [], total: 0, degraded: [] })
    if (u.includes('/fang/api/tasks')) return jsonResponse({ ok: true, tasks })
    if (u.includes('/fang/api/essence/list')) return jsonResponse({ ok: true, officialId: essences[0].id, defaultId: essences[0].id, essences, staleCount: 0 })
    if (u.includes('/fang/api/sessions')) return jsonResponse({ ok: true, sessions: [], total: 0, degraded: [] })
    if (u.includes('/fang/api/auth-token')) return jsonResponse({ token: 't' })
    if (u.includes('/fang/api/decisions/events')) return jsonResponse({ ok: false }, 404)
    if (u.includes('/fang/api/decisions/ai')) return jsonResponse({ ok: true, configured: false, providers: [] })
    if (u.includes('/fang/api/decisions')) return jsonResponse({ ok: true, items: [], rev: 1, counts: {} })
    return jsonResponse({ ok: true })
  }
  const ReactStub = {
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  }
  const registrations = []
  const ctx = {
    slots: {
      inject(_name, callback) { callback(); return () => {} },
      register(meta, render) { registrations.push({ meta, render }); return () => {} },
    },
    layout: { selectPanel() {} },
  }
  window.__ModuleLoader__ = { load({ factory }) { window.__plugin = factory((name) => { if (name === 'react') return ReactStub; throw new Error(`unexpected require: ${name}`) }) } }
  window.__FANG_TEST_HOOK__ = true
  window.eval(source)
  window.__plugin.apply(ctx)
  return { dom, window, registrations }
}

/** Mount the console into a DSH-like main panel: fixed height, flex column, overflow hidden. */
function mountConsole(harness) {
  const { window } = harness
  const reg = harness.registrations.find((item) => item.meta?.name === 'main' && item.meta?.key === 'fang')
  assert.ok(reg, 'main slot must be registered for the fang panel')
  const element = typeof reg.render === 'function' ? reg.render({}) : reg.render
  assert.ok(element?.props?.mount, 'main slot must expose a DOM mount')
  const doc = window.document
  const shell = doc.createElement('div')
  shell.style.cssText = 'display:flex;flex-direction:column;min-height:0;height:900px;overflow:hidden;'
  const host = doc.createElement('div')
  for (const [key, value] of Object.entries(element.props.style ?? {})) host.style[key] = value
  shell.append(host)
  doc.body.append(shell)
  element.props.mount(host)
  return { host, shell }
}

const waitFor = async (fn, { timeout = 2500, interval = 20 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor timeout')
}

test('client layout: the main slot fills a DSH-like fixed-height panel and both columns scroll', async () => {
  const harness = makeHarness()
  const { host } = mountConsole(harness)
  const doc = harness.window.document

  // The mount node must stretch inside the host's flex-column main panel.
  assert.equal(host.style.display, 'flex')
  assert.equal(host.style.flexDirection, 'column')
  assert.equal(host.style.flex, '1 1 auto')
  assert.ok(host.style.minHeight === '0' || host.style.minHeight === '0px', `min-height:0 expected, got ${host.style.minHeight}`)

  await waitFor(() => doc.querySelectorAll('.panel-scroll[data-sk]').length === 2
    && doc.querySelectorAll('.panel-scroll[data-sk="left"] .essence-card').length === essences.length)
  const consoleEl = doc.querySelector('.fang-console')
  const body = doc.querySelector('.fang-body')
  const panels = [...doc.querySelectorAll('.panel')]
  assert.ok(consoleEl && body, 'console and body must render')
  assert.equal(panels.length, 2, 'one panel per work zone')
  const [left, right] = panels
  const leftScroll = left.querySelector(':scope > .panel-scroll[data-sk="left"]')
  const rightScroll = right.querySelector(':scope > .panel-scroll[data-sk="right"]')
  assert.ok(leftScroll, 'the mother panel owns one left scroll area')
  assert.ok(rightScroll, 'the fork panel owns one right scroll area')

  // Many essences must live *inside* the left scroll area — never as a sibling that
  // would squash the session list (the v3.1.8 “can't select many mothers” bug).
  const essenceList = leftScroll.querySelector('[data-zone="essence-list"]')
  assert.ok(essenceList, 'essence cards render inside the left scroll area')
  assert.equal(essenceList.querySelectorAll('.essence-card').length, essences.length)
  assert.equal(left.querySelector(':scope > [data-zone="essence-list"]'), null, 'essence list is not outside the scroller')
  assert.ok(rightScroll.querySelectorAll('.fork-card').length > 0, 'fork cards render inside the right scroll area')
  assert.equal(right.querySelector(':scope > .panel-scroll[data-sk="right"]') === rightScroll, true)

  // The injected stylesheet must pin the height chain and expose a draggable scrollbar.
  const css = [...doc.querySelectorAll('style')].map((node) => node.textContent).join('\n')
  assert.match(css, /\.fang-console\{[^}]*height:100%[^}]*overflow:hidden/)
  assert.match(css, /\.fang-body\{[^}]*align-items:stretch[^}]*height:100%[^}]*overflow:hidden/)
  assert.match(css, /\.panel\{[^}]*height:100%[^}]*max-height:100%/)
  assert.match(css, /\.panel-scroll\{[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/)
  assert.match(css, /\.panel-scroll::-webkit-scrollbar\{width:12px/)
  assert.match(css, /@media \(max-width:1100px\)\{[^}]*\.panel\{height:auto;max-height:62vh\}/)

  harness.window.close()
})

test('client layout: the middle split handle is registered for width resizing', async () => {
  const harness = makeHarness()
  const { host } = mountConsole(harness)
  const doc = harness.window.document
  await waitFor(() => doc.querySelector('.fang-split-handle'))
  const handle = doc.querySelector('.fang-split-handle')
  assert.ok(handle, 'the middle split handle exists')
  assert.equal(handle.getAttribute('role') ?? '', 'separator')
  // The splitter persists the chosen ratio; the grid is driven by CSS variables/inline columns.
  assert.ok(doc.querySelector('.fang-body'), 'body grid exists for the splitter')
  assert.ok(host.querySelector('.fang-body'))
  harness.window.close()
})

}
