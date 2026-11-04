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
  assert.equal(source.includes('/fang/api/'), false)
  assert.equal(source.includes('mountPanel'), false)
})

test('client half registers the plugins.bundle.config entry and renders the link', () => {
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  let loaded = null
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (value) => { loaded = value } } },
    console,
  })
  assert.ok(loaded)
  assert.equal(loaded.id, '@twinsearth/dsh-fang-web-entry')
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const mod = loaded.factory((name) => { assert.equal(name, 'react'); return React })
  let registration = null
  const ctx = {
    slots: {
      inject: (slot, callback) => { assert.equal(slot, 'plugins.bundle.config'); callback() },
      register: (options, component) => { registration = { options, component } },
    },
  }
  mod.apply(ctx)
  assert.equal(registration.options.name, 'plugins.bundle.config')
  assert.equal(registration.options.key, '@twinsearth/dsh-fang')
  const tree = registration.component()
  assert.equal(JSON.stringify(tree).includes('dsh-fang://open'), true)
  assert.equal(JSON.stringify(tree).includes('打开瓮城控制台'), true)
})

