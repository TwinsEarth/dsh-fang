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
  mod.apply(ctx)
  return { keydown: listeners.get('keydown'), captured }
}

function editableTarget() {
  return { closest: (selector) => (selector.includes('textarea') ? {} : null) }
}
function plainTarget() {
  return { closest: () => null }
}

test('Ctrl+X outside inputs captures; Ctrl+X inside input stays Cut', async () => {
  const { keydown, captured } = load()
  let prevented = 0
  const event = (target, shift) => ({
    key: 'x', ctrlKey: true, shiftKey: shift, altKey: false, metaKey: false, target,
    preventDefault: () => { prevented += 1 }, stopPropagation: () => {},
  })
  keydown(event(editableTarget(), false))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(prevented, 0, 'Ctrl+X in an input must stay Cut')
  assert.equal(captured.length, 0, 'Ctrl+X in an input must not capture')

  keydown(event(plainTarget(), false))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(prevented, 1)
  assert.equal(captured.length, 1)

  keydown(event(editableTarget(), true))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(captured.length, 2, 'Ctrl+Shift+X captures even in an input')
})

test('screenshot module id matches package and registers composer dock entry', () => {
  assert.match(source, /id: '@twinsearth\/dsh-fang-screenshot'/)
  assert.match(source, /conversation\.composer\.dock/)
  assert.match(source, /Ctrl\+Shift\+X/)
})
