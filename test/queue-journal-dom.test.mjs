// SPDX-License-Identifier: AGPL-3.0-or-later
// Queue journal: DSH QueueDock has hashed CSS classes; the stable anchor is
// [data-queue-dock] with <li> rows. This test proves the composer journal
// captures the whole queue list, not just the draft.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

let JSDOM = null
try { ({ JSDOM } = await import('jsdom')) } catch { /* optional */ }

if (!JSDOM) {
  test('queue-journal: skipped (jsdom not installed)', (t) => t.skip('jsdom not installed'))
} else {
  const source = fs.readFileSync(new URL('../queue-journal/client.js', import.meta.url), 'utf8')
  const waitFor = async (fn, { timeout = 3000, interval = 20 } = {}) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    throw new Error('waitFor timeout')
  }

  test('queue-journal: captures every row from DSH [data-queue-dock], not only the draft', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously' })
    const { window } = dom
    const posts = []
    window.fetch = async (url, init = {}) => {
      const target = String(url)
      if (target.includes('/fang/api/auth-token')) return { ok: true, status: 200, async json() { return { token: 'tok' } } }
      if (target.includes('/fang/api/composer/journal') && init.method === 'POST') {
        posts.push(JSON.parse(init.body || '{}'))
        return { ok: true, status: 200, async json() { return { ok: true } } }
      }
      return { ok: true, status: 200, async json() { return { ok: true } } }
    }
    let plugin = null
    window.__ModuleLoader__ = {
      load({ factory }) {
        const ReactStub = { createElement: (type, props, ...children) => ({ type, props, children }), useState: (v) => [v, () => {}], useEffect: () => {} }
        plugin = factory((name) => {
          if (name === 'react') return ReactStub
          throw new Error(`unexpected require: ${name}`)
        })
      },
    }
    window.eval(source)
    assert.ok(plugin, 'queue journal factory captured')
    const ctx = {
      slots: {
        inject(_name, cb) { cb(); return () => {} },
        register() { return () => {} },
      },
    }
    plugin.apply(ctx)

    const doc = window.document
    doc.body.innerHTML = `
      <div data-queue-dock=""><div>
        <ul>
          <li>第一条排队消息<button>插话发送</button></li>
          <li>第二条排队消息<button>删除排队消息</button></li>
        </ul>
      </div></div>
      <div contenteditable="true" id="composer">未发送草稿</div>
    `
    const input = doc.createElement('input')
    input.value = 'x'
    doc.body.append(input)
    const composer = doc.getElementById('composer')
    composer.dispatchEvent(new window.InputEvent('input', { bubbles: true }))

    const post = await waitFor(() => posts.find((item) => Array.isArray(item.queue) && item.queue.length > 0))
    assert.deepEqual(post.queue.map((item) => item.text), ['第一条排队消息', '第二条排队消息'])
    assert.equal(typeof post.draft, 'string')
    dom.window.close()
  })
}
