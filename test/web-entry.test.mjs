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

test('web entry links to dsh-fang://open and renders no fang panel', () => {
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  assert.match(source, /dsh-fang:\/\/open/)
  assert.match(source, /plugins\.bundle\.config/)
  assert.match(source, /sidebar\.panellist/)
  assert.equal(source.includes('/fang/api/'), false)
  assert.equal(source.includes('mountPanel'), false)
})

test('client half registers the sidebar entry and the plugin-config entry', () => {
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  let loaded = null
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (value) => { loaded = value } } },
    console,
  })
  assert.ok(loaded)
  assert.equal(loaded.id, '@twinsearth/dsh-fang-web-entry')
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), useEffect: (fn) => fn() }
  const mod = loaded.factory((name) => { assert.equal(name, 'react'); return React })
  const registrations = []
  const ctx = {
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => { registrations.push({ options, component }) },
    },
  }
  mod.apply(ctx)
  const sidebar = registrations.find((r) => r.options.name === 'sidebar.panellist')
  const main = registrations.find((r) => r.options.name === 'main')
  const config = registrations.find((r) => r.options.name === 'plugins.bundle.config')
  assert.ok(sidebar)
  assert.equal(sidebar.options.id, 'fang-sidebar-entry')
  assert.ok(main)
  assert.equal(main.options.key, 'fang-sidebar-entry')
  assert.equal(JSON.stringify(main.component()).includes('正在打开瓮城桌面'), true)
  assert.ok(config)
  assert.equal(config.options.key, '@twinsearth/dsh-fang')
  assert.equal(JSON.stringify(config.component()).includes('打开瓮城控制台'), true)
})
