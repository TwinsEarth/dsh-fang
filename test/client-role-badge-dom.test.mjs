// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Client DOM test (v3.1.12): the sidebar brand row shows the current Web identity
// (母体 / 元主 / 分身) in red, appended after the shipped wordmark rather than
// replacing the host's brand slot.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }
if (!JSDOM) {
  test('client-role-badge-dom: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
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

/** jsdom harness: only the sidebar skeleton + fetch replies the badge needs. */
function makeHarness(mode) {
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
      if (mode === 'mother') return jsonResponse({ ok: true, role: 'mother', version: '3.1.12' })
      return jsonResponse({ ok: false, error: 'http-404' }, 404)
    }
    if (target.includes('/fang/adapter/hello')) {
      if (mode === 'essence') return jsonResponse({ ok: true, role: 'fork', taskId: 'rt-official-dev', kind: 'essence', version: '3.1.12' })
      if (mode === 'essence-prefix-fallback') return jsonResponse({ ok: true, role: 'fork', taskId: 'rt-official-dev', version: '3.1.12' })
      return jsonResponse({ ok: true, role: 'fork', taskId: 'task_abc', kind: 'fork', version: '3.1.12' })
    }
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

  // Host sidebar brand row, exactly the shape DSH's sidebar CSS module renders.
  const doc = window.document
  const brandRow = doc.createElement('div')
  brandRow.className = 'wtg9ga_brand'
  brandRow.innerHTML = '<div class="wtg9ga_brandIdentity"><div class="wtg9ga_brandMark"></div><div class="wtg9ga_brandName"></div></div>'
  doc.body.append(brandRow)
  const brandName = brandRow.querySelector('.wtg9ga_brandName')
  return { dom, window, doc, brandName, plugin: window.__plugin }
}

async function expectBadge(mode, expected) {
  const harness = makeHarness(mode)
  const badge = () => harness.doc.getElementById('fang-web-role-badge')
  const dispose = harness.plugin.__mountWebRoleBadge()
  try {
    const element = await waitFor(() => {
      const node = badge()
      return node && node.textContent === expected ? node : null
    })
    assert.equal(element.textContent, expected, `${mode} badge label`)
    assert.equal(element.dataset.fangWebRole, mode === 'mother' ? 'mother' : (expected === '元主' ? 'essence' : 'fork'))
    assert.equal(element.className, 'fang-web-role')
    assert.equal(element.parentElement.className, 'wtg9ga_brandIdentity', 'badge is appended inside the brand identity row')
    assert.equal(element.previousElementSibling, harness.brandName, 'badge sits immediately right of the wordmark')
    assert.equal(element.getAttribute('aria-label'), `当前 Web 端：${expected}`)
    const styles = [...harness.doc.querySelectorAll('style')].map((node) => node.textContent).join('\n')
    assert.match(styles, /\.fang-web-role\{[^}]*color:#C8102E/)
    // The host re-render can drop the node: mounting again must not duplicate it.
    ;[...harness.doc.querySelectorAll('.fang-web-role')].forEach((node) => node.remove())
    await waitFor(() => badge() && badge().textContent === expected)
    assert.equal(harness.doc.querySelectorAll('.fang-web-role').length, 1, 'exactly one badge after a host re-render')
    dispose()
    assert.equal(badge(), null, 'dispose removes the badge')
  } finally {
    harness.window.close()
  }
}

test('client role badge: mother Web shows 母体 in red beside the brand wordmark', async () => {
  await expectBadge('mother', '母体')
})

test('client role badge: essence runtime Web shows 元主', async () => {
  await expectBadge('essence', '元主')
})

test('client role badge: essence runtime fallback uses the rt- fork id prefix', async () => {
  await expectBadge('essence-prefix-fallback', '元主')
})

test('client role badge: task fork Web shows 分身', async () => {
  await expectBadge('fork', '分身')
})

test('client role badge: hello kind is emitted by the adapter', () => {
  const adapter = fs.readFileSync(new URL('../src/plugins/adapter.mjs', import.meta.url), 'utf8')
  assert.match(adapter, /kind:\s*role === 'mother'/)
  assert.match(adapter, /DSH_FANG_ESSENCE/)
  const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  assert.match(orchestrator, /DSH_FANG_ESSENCE: '1'/)
})

}
