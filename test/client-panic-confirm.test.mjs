// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

test('global Panic requires a typed second confirmation', () => {
  const start = source.indexOf('function confirmPanic()')
  const end = source.indexOf('const app = {', start)
  const fn = source.slice(start, end)
  assert.ok(fn.length > 0)
  assert.match(fn, /strong:\s*true/)
  assert.match(fn, /expected:\s*'PANIC'/)
  assert.match(fn, /confirmVerb:\s*'释放全部内存'/)
  assert.match(fn, /confirmLabel:\s*'确认释放'/)
  assert.match(fn, /api\('/)
})

test('header Panic button opens the confirmation instead of firing directly', () => {
  const at = source.indexOf("button('释放全部内存'")
  assert.ok(at > 0)
  const block = source.slice(at, at + 600)
  assert.match(block, /onClick:\s*\(\)\s*=>\s*app\.confirmPanic\(\)/)
  assert.doesNotMatch(block, /api\('/)
})
