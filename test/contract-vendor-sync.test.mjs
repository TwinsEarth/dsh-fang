// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.35：vendored 契约副本必须是 @twinsearth/dsh-fang-contract@1.1.0 的逐字节副本。
// 接口包升级了而内嵌副本没跟上，会让房主探测到旧方法表——用 hash 钉死。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const contractDir = path.join(here, '..', 'src', 'contract')
const vendor = JSON.parse(fs.readFileSync(path.join(contractDir, 'VENDOR.json'), 'utf8'))

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('vendored contract: pinned to @twinsearth/dsh-fang-contract@1.1.0', () => {
  assert.equal(vendor.package, '@twinsearth/dsh-fang-contract')
  assert.equal(vendor.version, '1.1.0')
  assert.equal(vendor.fileCount, 8, '1.1.0 ships 8 source files (1.0.0 had 7)')
})

test('vendored contract: every file matches the pinned sha256 byte-for-byte', () => {
  const pinned = vendor.sha256 ?? {}
  assert.deepEqual(Object.keys(pinned).sort(), Object.keys(vendor.sha256).sort())
  for (const [name, expected] of Object.entries(pinned)) {
    const file = path.join(contractDir, name)
    assert.equal(fs.existsSync(file), true, `${name} must exist in src/contract`)
    assert.equal(sha256(file), expected, `${name} drifted from contract@${vendor.version} — re-sync, do not hand-edit`)
  }
})

test('vendored contract: relay.js is present (the 1.1 addition)', () => {
  assert.equal(fs.existsSync(path.join(contractDir, 'relay.js')), true, 'relay.js must be part of the vendored copy')
  const source = fs.readFileSync(path.join(contractDir, 'relay.js'), 'utf8')
  assert.match(source, /export function createRelayStore/)
  assert.match(source, /export function relayHandlers/)
})

test('vendored contract: no stray .js files outside the pinned set', () => {
  const actual = fs.readdirSync(contractDir).filter((name) => name.endsWith('.js')).sort()
  const pinned = Object.keys(vendor.sha256 ?? {}).sort()
  assert.deepEqual(actual, pinned, 'src/contract must contain exactly the pinned file set')
})
