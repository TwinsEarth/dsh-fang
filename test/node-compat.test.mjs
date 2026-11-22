// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeFetchDescriptor } from '../src/lib/node-compat.mjs'

test('normalizeFetchDescriptor turns an accessor fetch into a data property', () => {
  const original = globalThis.fetch
  try {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      enumerable: true,
      get() { return original },
    })
    const result = normalizeFetchDescriptor(globalThis)
    assert.equal(result.ok, true)
    assert.equal(result.changed, true)
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
    assert.equal(typeof descriptor.get, 'undefined')
    assert.equal(descriptor.value, original)
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: original, writable: true, configurable: true, enumerable: true })
  }
})
