// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve(import.meta.dirname, '..', 'web-entry')

test('web entry manifest declares a client half only', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')
})

test('web entry registers only the plugin-config link and backup action', () => {
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  assert.match(source, /dsh-fang:\/\/open/)
  assert.match(source, /plugins\.bundle\.config/)
  assert.equal(source.includes('sidebar.panellist'), false)
  assert.equal(source.includes("name: 'main'"), false)
  assert.equal(source.includes('mountPanel'), false)
})

test('client half renders the link and backup button', () => {
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  let loaded = null
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (value) => { loaded = value } } },
    console,
  })
  assert.ok(loaded)
  assert.equal(loaded.id, '@twinsearth/dsh-fang-web-entry')
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useEffect: (fn) => fn(),
    useState: (initial) => [initial, () => {}],
  }
  const mod = loaded.factory((name) => { assert.equal(name, 'react'); return React })
  const registrations = []
  const ctx = { slots: { inject: (slot, cb) => cb(), register: (options, component) => { registrations.push({ options, component }) } } }
  mod.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'plugins.bundle.config')
  assert.equal(registrations[0].options.key, '@twinsearth/dsh-fang')
  const tree = JSON.stringify(registrations[0].component())
  assert.equal(tree.includes('打开瓮城桌面'), true)
  assert.equal(tree.includes('备份母体'), true)
})
