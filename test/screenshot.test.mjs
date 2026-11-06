// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'screenshot', 'client.js'), 'utf8')

function load() {
  let loaded = null
  const listeners = new Map()
  const captured = []
  const window = {
    __ModuleLoader__: { load: (value) => { loaded = value } },
    fangShell: { captureScreen: async () => { captured.push(Date.now()); return { ok: true, width: 10, height: 10 } } },
    dispatchEvent: () => true,
    addEventListener: () => {},
  }
  const document = {
    addEventListener: (type, fn) => { listeners.set(type, fn) },
    removeEventListener: (type) => { listeners.delete(type) },
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, getContext: () => ({ drawImage: () => {} }), click: () => {}, toBlob: (cb) => cb(null) }),
  }
  vm.runInNewContext(source, { window, document, navigator: {}, console, setTimeout, clearTimeout, URL, CustomEvent: class {} })
  assert.ok(loaded)
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const mod = loaded.factory((name) => { assert.equal(name, 'react'); return React })
  const ctx = { slots: { inject: (slot, cb) => cb(), register: () => () => {} } }
  const dispose = mod.apply(ctx)
  return { keydown: listeners.get('keydown'), dispose, captured }
}

test('screenshot shortcut is Ctrl+Shift+X, never Ctrl+X', async () => {
  const { keydown, captured } = load()
  assert.equal(typeof keydown, 'function')
  let prevented = 0
  const ctrlX = { key: 'x', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault: () => { prevented += 1 }, stopPropagation: () => {} }
  keydown(ctrlX)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(prevented, 0, 'Ctrl+X must stay Cut')
  assert.equal(captured.length, 0, 'Ctrl+X must not capture')

  const capture = { key: 'X', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, preventDefault: () => { prevented += 1 }, stopPropagation: () => {} }
  keydown(capture)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(prevented, 1)
  assert.equal(captured.length, 1)
})

test('screenshot module id matches package and registers composer dock entry', () => {
  assert.match(source, /id: '@twinsearth\/dsh-fang-screenshot'/)
  assert.match(source, /conversation\.composer\.dock/)
  assert.match(source, /Ctrl\+Shift\+X/)
})
