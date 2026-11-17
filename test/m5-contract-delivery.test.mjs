// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// M5（房主回流对端）交付自检：vendored 契约包 + VENDOR.json + orchestrator 两处可识别注册 + 回流语义。
// 房主侧等价验收：`node scripts/fang-relay-probe.mjs --peer fang --fang-dir <解包目录>`。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONTRACT_DIR = path.join(ROOT, 'src', 'contract')
const VENDORED_FILES = ['index.js', 'constants.js', 'envelope.js', 'negotiate.js', 'server.js', 'relay.js', 'transports.js', 'client.js']
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('M5 vendored contract: loads from file URL (ESM, relative imports) and exports the relay server + version', async () => {
  for (const name of VENDORED_FILES) assert.ok(fs.existsSync(path.join(CONTRACT_DIR, name)), `missing ${name}`)
  const module = await import(pathToFileURL(path.join(CONTRACT_DIR, 'index.js')).href)
  assert.equal(typeof module.createRelayContractServer, 'function')
  assert.equal(typeof module.CONTRACT_VERSION, 'string')
  assert.match(module.CONTRACT_VERSION, /^\d+\.\d+\.\d+$/)
  assert.equal(module.CONTRACT_VERSION, '1.2.0', 'VENDOR.json version must match the vendored bytes')
  // 房主按解包目录的 file URL 直接加载：每个文件只能用相对 import。
  for (const name of VENDORED_FILES) {
    const source = fs.readFileSync(path.join(CONTRACT_DIR, name), 'utf8')
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const spec of specifiers) {
      if (spec.startsWith('node:')) continue // 内置模块可直接解析
      assert.match(spec, /^\.\/[a-z0-9.-]+$/, `${name} imports non-relative '${spec}'`)
    }
  }
})

test('M5 VENDOR.json: version + per-file sha256 are self-consistent (房主逐文件重算)', () => {
  const vendor = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, 'VENDOR.json'), 'utf8'))
  assert.equal(vendor.version, '1.2.0')
  assert.deepEqual(Object.keys(vendor.sha256).sort(), [...VENDORED_FILES].sort())
  for (const [name, expected] of Object.entries(vendor.sha256)) {
    assert.equal(sha256(path.join(CONTRACT_DIR, name)), String(expected).toLowerCase(), `${name} drift`)
  }
})

test('M5 relay semantics: hello negotiates fang.relay.* and status carries the peer provenance fields', async () => {
  const contract = await import(pathToFileURL(path.join(CONTRACT_DIR, 'index.js')).href)
  const { server, store } = contract.createRelayContractServer({ role: 'mother', instanceId: 'm5-test', peerLabel: 'dsh-fang-bundle' })
  const hello = server.hello()
  assert.equal(hello.contractVersion, contract.CONTRACT_VERSION)
  assert.ok(hello.methods.includes('fang.relay.publish'))
  assert.ok(hello.methods.includes('fang.relay.status'))
  const status = store.status()
  assert.equal(status.available, true)
  assert.equal(status.peer, 'dsh-fang-bundle', 'peer must be the fang self-reported label')
  assert.equal(status.contractVersion, contract.CONTRACT_VERSION)
  for (const key of ['cursor', 'accepted', 'duplicates', 'rejected', 'batches']) assert.equal(typeof status[key], 'number', key)
})

test('M5 relay idempotency: first accepted=N/cursor+N, replay accepted=0/duplicates=N/cursor unchanged', async () => {
  const contract = await import(pathToFileURL(path.join(CONTRACT_DIR, 'index.js')).href)
  const { server } = contract.createRelayContractServer({ role: 'mother', instanceId: 'm5-idem', peerLabel: 'dsh-fang-bundle' })
  const events = Array.from({ length: 3 }, (_, index) => ({ id: `m5-dup-${index}`, type: 'cost:event', at: 1, payload: { index } }))
  const publish = (batchId) => server.invoke(contract.createEnvelope({ method: 'fang.relay.publish', params: { batchId, events }, source: 'm5-test' }))
  const first = await publish('batch-1')
  const replay = await publish('batch-1')
  const a = first.result
  const b = replay.result
  assert.equal(a.accepted, events.length)
  assert.equal(a.duplicates, 0)
  assert.equal(b.accepted, 0)
  assert.equal(b.duplicates, events.length)
  assert.equal(b.cursor, a.cursor)
})

test('M5 runtime wiring: orchestrator declares peerLabel inside createRelayStore({…}) and calls relayHandlers(relayStore)', () => {
  const source = read('src/plugins/orchestrator.mjs')
  const label = /createRelayStore\(\{[\s\S]{0,400}?peerLabel:\s*'([^']+)'/u.exec(source)
  assert.ok(label, 'createRelayStore({ … peerLabel }) must be recognizable within 400 chars')
  assert.equal(label[1], 'dsh-fang-bundle', '房主按此判定已与真实瓮城对接（自报标识，不参与鉴权）')
  assert.match(source, /relayHandlers\(\s*relayStore\s*\)/u, 'relayHandlers(relayStore) must be registered')
  // M5 合同口径的批次默认值（vendored 库默认 maxBatch=128；运行时按房主约定收敛，不改 vendor 实现）
  assert.match(source, /maxBatch:\s*32/u)
  assert.match(source, /maxPayloadBytes:\s*512000/u)
})

test('M5 HTTP surface: hello/invoke are token-guarded, health is public and returns {ok,role,version,peer,accepted}', () => {
  const source = read('src/plugins/orchestrator.mjs')
  assert.match(source, /route\('POST', `\$\{contractPath\}\/hello`/u)
  assert.match(source, /route\('POST', `\$\{contractPath\}\/invoke`/u)
  assert.match(source, /route\('GET', `\$\{contractPath\}\/health`/u)
  assert.match(source, /peer: relayStatus\?\.peer \?\? null/u)
  assert.match(source, /accepted: Number\(relayStatus\?\.accepted \?\? 0\)/u)
  assert.match(source, /version: CONTRACT_VERSION/u)
  assert.match(source, /contractAuthorized\(req\)/u)
})
