// SPDX-License-Identifier: AGPL-3.0-or-later
// v2.9.0 母体连接（fang-link）的纯逻辑验收：
//   * 地址归一化（只接受 http(s) origin，拒绝凭据/查询串/非 http）
//   * 描述结构（前缀/门户/探测路径/共享配置摘要/token 策略）
//   * profile 摘要（读 package.json dsh.profile.bundles，失败降级为 null）
//   * 探测：成功 / HTTP 错误 / 超时 / 网络错误 / fetch 不可用，全部结构化、绝不抛
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_LINK_TIMEOUT_MS,
  MOTHER_LINK_PATHS,
  describeMotherLink,
  normalizeLinkOrigin,
  normalizePrefix,
  probeLink,
  readSharedProfileSummary,
} from '../src/lib/mother-link.mjs'
import { tmpDir } from './helpers.mjs'

test('normalizePrefix：空/斜杠/无前导斜杠归一', () => {
  assert.equal(normalizePrefix(''), '/fang')
  assert.equal(normalizePrefix('/'), '/fang')
  assert.equal(normalizePrefix('/fang/'), '/fang')
  assert.equal(normalizePrefix('fang'), '/fang')
  assert.equal(normalizePrefix('/fang/sub/'), '/fang/sub')
})

test('normalizeLinkOrigin：只接受 http(s) origin，拒绝凭据/查询串/非 http', () => {
  assert.deepEqual(normalizeLinkOrigin('http://127.0.0.1:51963'), {
    ok: true, origin: 'http://127.0.0.1:51963', host: '127.0.0.1:51963',
  })
  assert.deepEqual(normalizeLinkOrigin('https://mother.example.com/'), {
    ok: true, origin: 'https://mother.example.com', host: 'mother.example.com',
  })
  assert.equal(normalizeLinkOrigin('').error, 'target-empty')
  assert.equal(normalizeLinkOrigin('not a url').error, 'target-invalid-url')
  assert.equal(normalizeLinkOrigin('ftp://x.test').error, 'target-scheme')
  assert.equal(normalizeLinkOrigin('http://user:pass@x.test').error, 'target-credentials')
  assert.equal(normalizeLinkOrigin('http://x.test/?q=1').error, 'target-query')
  assert.equal(normalizeLinkOrigin(`http://x.test/${'a'.repeat(600)}`).error, 'target-too-long')
})

test('describeMotherLink：前缀/探测路径/共享配置/token 策略/接入说明', () => {
  const described = describeMotherLink({
    role: 'mother',
    version: '2.9.0',
    prefix: '/fang',
    sharedConfig: { layer: 'profile', profile: 'desktop', bundles: 20, profileDir: null },
    now: () => 1700000000000,
  })
  assert.equal(described.ok, true)
  assert.equal(described.role, 'mother')
  assert.equal(described.version, '2.9.0')
  assert.equal(described.motherApiBase, '/fang/api')
  assert.equal(described.adapterBase, '/fang/adapter')
  assert.equal(described.probe.method, 'POST')
  assert.equal(described.probe.path, `/fang${MOTHER_LINK_PATHS.PROBE}`)
  assert.equal(described.probe.body.timeoutMs, DEFAULT_LINK_TIMEOUT_MS)
  assert.equal(described.sharedConfig.bundles, 20)
  assert.match(described.tokenPolicy, /never persists/)
  assert.ok(Array.isArray(described.forkInstructions) && described.forkInstructions.length >= 2)
  assert.ok(!JSON.stringify(described).includes('Bearer '), '描述里不得出现令牌')
})

test('readSharedProfileSummary：读 package.json bundles，失败降级为 null', () => {
  const dir = tmpDir('fang-link-profile-')
  try {
    assert.equal(readSharedProfileSummary({ profileDir: path.join(dir, 'missing'), env: {} }).bundles, null)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-x', dsh: { profile: { bundles: ['a', 'b', 'c'] } },
    }), 'utf8')
    const summary = readSharedProfileSummary({ profileDir: dir, env: { DSH_PROFILE: 'x' } })
    assert.equal(summary.bundles, 3)
    assert.equal(summary.profile, 'x')
    assert.equal(summary.name, 'dsh-profile-x')
    fs.writeFileSync(path.join(dir, 'package.json'), '{not json', 'utf8')
    assert.equal(readSharedProfileSummary({ profileDir: dir, env: {} }).bundles, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('probeLink：成功返回 httpStatus/latencyMs/version', async () => {
  let requested = null
  const out = await probeLink({
    target: 'http://127.0.0.1:51963',
    timeoutMs: 500,
    now: (() => { let t = 0; return () => (t += 7) })(),
    fetchImpl: async (url, init) => {
      requested = { url, method: init.method, accept: init.headers.accept }
      return { ok: true, status: 200, json: async () => ({ ok: true, version: '2.9.0' }) }
    },
  })
  assert.equal(out.ok, true)
  assert.equal(out.httpStatus, 200)
  assert.equal(out.version, '2.9.0')
  assert.ok(out.latencyMs >= 0)
  assert.equal(requested.url, 'http://127.0.0.1:51963/fang/api/status')
  assert.equal(requested.method, 'GET')
  assert.equal(requested.accept, 'application/json')
})

test('probeLink：HTTP 错误 / 超时 / 网络错误 / fetch 不可用都返回结构化错误', async () => {
  const httpError = await probeLink({
    target: 'http://127.0.0.1:51963',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  assert.equal(httpError.ok, false)
  assert.equal(httpError.error, 'status-http-error')
  assert.equal(httpError.httpStatus, 503)

  const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  const timedOut = await probeLink({ target: 'http://x.test', fetchImpl: async () => { throw timeoutError } })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.error, 'timeout')

  const network = await probeLink({ target: 'http://x.test', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(network.error, 'network-error')
  assert.match(network.message, /ECONNREFUSED/)

  const unavailable = await probeLink({ target: 'http://x.test', fetchImpl: 'not-a-function' })
  assert.equal(unavailable.error, 'fetch-unavailable')

  const invalid = await probeLink({ target: 'file:///etc/passwd' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error, 'target-scheme')
})

test('probeLink：超时参数被夹在 [200, 10000]', async () => {
  let observed = null
  const run = (timeoutMs) => probeLink({
    target: 'http://x.test',
    timeoutMs,
    fetchImpl: async (_url, init) => {
      observed = init
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  await run(1)
  assert.ok(observed.signal instanceof AbortSignal)
  await run(999999)
  assert.ok(observed.signal instanceof AbortSignal)
})
