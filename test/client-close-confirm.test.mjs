// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.19：元主/分身 Web 关闭前二次确认（beforeunload）回归。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const waitFor = async (fn, { timeout = 3000 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor timeout')
}
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body }, async text() { return JSON.stringify(body) } })

function makeHarness(role) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously' })
  const { window } = dom
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/fang/api/status')) return role === 'mother' ? jsonResponse({ ok: true, role: 'mother' }) : jsonResponse({ error: 'http-404' }, 404)
    if (path.includes('/fang/adapter/identity')) return jsonResponse({ ok: true, kind: role })
    if (path.includes('/fang/api/auth-token')) return jsonResponse({ token: 't' })
    return jsonResponse({ ok: true })
  }
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => ({ createElement: () => null, useEffect: () => {}, useRef: (v) => ({ current: v }) })) } }
  window.__FANG_TEST_HOOK__ = true
  let plugin = null
  window.eval(source)
  return { window, plugin }
}

if (!JSDOM) {
  test('client-close-confirm: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {
  test('client-close-confirm: essence and fork register a beforeunload confirm', async () => {
    for (const role of ['essence', 'fork']) {
      const { window, plugin } = makeHarness(role)
      let fired = 0
      const dispose = plugin.__mountCloseConfirm()
      try {
        await waitFor(() => window.__fangCloseGuardArmed === true || true)
        await new Promise((r) => setTimeout(r, 200))
        const event = new window.Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        fired = event.defaultPrevented ? 1 : 0
        assert.equal(fired, 1, `${role} must show the confirm dialog (defaultPrevented)`)
      } finally { dispose() }
      // 卸载后不再拦截
      const after = new window.Event('beforeunload', { cancelable: true })
      window.dispatchEvent(after)
      assert.equal(after.defaultPrevented, false, `${role} disposer must remove the guard`)
    }
  })

  test('client-close-confirm: mother does not intercept closing', async () => {
    const { window, plugin } = makeHarness('mother')
    const dispose = plugin.__mountCloseConfirm()
    try {
      await new Promise((r) => setTimeout(r, 250))
      const event = new window.Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      assert.equal(event.defaultPrevented, false, 'mother must close without a confirm dialog')
    } finally { dispose() }
  })
}
