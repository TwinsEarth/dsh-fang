// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Client DOM test (v3.1.14): the sidebar brand row shows the current Web identity
// (母体 red / 元主 blue / 分身 green) appended after the shipped wordmark, never
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

const ROLE_LABEL = { mother: '母体', essence: '元主', fork: '分身' }

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
      if (mode === 'mother') return jsonResponse({ ok: true, role: 'mother', version: '3.1.14' })
      return jsonResponse({ ok: false, error: 'http-404' }, 404)
    }
    if (target.includes('/fang/adapter/identity')) {
      // v3.1.14: public, unauthenticated identity route (no taskId/token).
      if (mode === 'essence') return jsonResponse({ ok: true, role: 'fork', kind: 'essence', version: '3.1.14' })
      if (mode === 'fork') return jsonResponse({ ok: true, role: 'fork', kind: 'fork', version: '3.1.14' })
      return jsonResponse({ ok: false, error: 'http-404' }, 404)
    }
    if (target.includes('/fang/adapter/hello')) {
      // Legacy fallback: old fork hosts only have the Bearer-protected hello.
      if (mode === 'essence-prefix-fallback') return jsonResponse({ ok: true, role: 'fork', taskId: 'rt-official-dev', version: '3.1.13' })
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401)
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

async function expectBadge(mode, expectedKind) {
  const harness = makeHarness(mode)
  const badge = () => harness.doc.getElementById('fang-web-role-badge')
  const dispose = harness.plugin.__mountWebRoleBadge()
  try {
    const element = await waitFor(() => {
      const node = badge()
      return node && node.textContent === ROLE_LABEL[expectedKind] ? node : null
    })
    assert.equal(element.textContent, ROLE_LABEL[expectedKind], `${mode} badge label`)
    assert.equal(element.dataset.fangWebRole, expectedKind)
    assert.ok(element.classList.contains('fang-web-role'), 'base badge class')
    assert.ok(element.classList.contains('fang-web-role--' + expectedKind), `color variant for ${expectedKind}`)
    assert.equal(element.parentElement.className, 'wtg9ga_brandIdentity', 'badge is appended inside the brand identity row')
    assert.equal(element.previousElementSibling, harness.brandName, 'badge sits immediately right of the wordmark')
    assert.equal(element.getAttribute('aria-label'), `当前 Web 端：${ROLE_LABEL[expectedKind]}`)
    const styles = [...harness.doc.querySelectorAll('style')].map((node) => node.textContent).join('\n')
    assert.match(styles, /\.fang-web-role--mother\{[^}]*color:#C8102E/, 'mother is red')
    assert.match(styles, /\.fang-web-role--essence\{[^}]*color:#0A6BE0/, 'essence is blue')
    assert.match(styles, /\.fang-web-role--fork\{[^}]*color:#17803D/, 'fork is green')
    // The host re-render can drop the node: mounting again must not duplicate it.
    ;[...harness.doc.querySelectorAll('.fang-web-role')].forEach((node) => node.remove())
    await waitFor(() => badge() && badge().textContent === ROLE_LABEL[expectedKind])
    assert.equal(harness.doc.querySelectorAll('.fang-web-role').length, 1, 'exactly one badge after a host re-render')
    dispose()
    assert.equal(badge(), null, 'dispose removes the badge')
  } finally {
    harness.window.close()
  }
}

test('client role badge: mother Web shows red 母体 beside the brand wordmark', async () => {
  await expectBadge('mother', 'mother')
})

test('client role badge: essence runtime Web shows blue 元主 via the public identity route', async () => {
  await expectBadge('essence', 'essence')
})

test('client role badge: legacy essence runtime falls back to the rt- fork id prefix', async () => {
  await expectBadge('essence-prefix-fallback', 'essence')
})

test('client role badge: task fork Web shows green 分身 via the public identity route', async () => {
  await expectBadge('fork', 'fork')
})

test('client role badge: identity contract is wired in the adapter and client', () => {
  const adapter = fs.readFileSync(new URL('../src/plugins/adapter.mjs', import.meta.url), 'utf8')
  assert.match(adapter, /export function identityKind/)
  assert.match(adapter, /ADAPTER_ROUTE\.IDENTITY/)
  assert.match(adapter, /DSH_FANG_ESSENCE/)
  const types = fs.readFileSync(new URL('../src/kernel/types.mjs', import.meta.url), 'utf8')
  assert.match(types, /IDENTITY: '\/adapter\/identity'/)
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /fang-web-role--essence/)
  assert.match(client, /fang-web-role--fork/)
  assert.match(client, /\/fang\/adapter\/identity/)
})

}
