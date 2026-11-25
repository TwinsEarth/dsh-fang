// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpError, isTransientError, isTransientStatus, retryAfterMsFrom, retryOperation } from '../tools/release/net-retry.mjs'

test('classifies transient HTTP statuses and network errors', () => {
  assert.equal(isTransientStatus(502), true)
  assert.equal(isTransientStatus(429), true)
  assert.equal(isTransientStatus(404), false)
  assert.equal(isTransientError({ status: 503 }), true)
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true)
  assert.equal(isTransientError(new HttpError('bad gateway', { status: 502 })), true)
  assert.equal(isTransientError(new HttpError('not found', { status: 404 })), false)
  assert.equal(isTransientError(new Error('TypeError: fetch failed')), true)
})

test('reports Retry-After in milliseconds', () => {
  assert.equal(retryAfterMsFrom({ get: () => '3' }), 3000)
  assert.equal(retryAfterMsFrom({ get: () => '0' }), 0)
  assert.equal(retryAfterMsFrom({ get: () => null }), 0)
  const future = new Date(Date.now() + 5000).toUTCString()
  const value = retryAfterMsFrom({ get: () => future })
  assert.ok(value >= 3000 && value <= 6000)
})

test('retries transient failures with backoff and succeeds', async () => {
  const waits = []
  let calls = 0
  const result = await retryOperation(async () => {
    calls += 1
    if (calls < 3) throw new HttpError('temporary', { status: 503, retryAfterMs: 0 })
    return 'ok'
  }, {
    attempts: 4,
    baseMs: 100,
    capMs: 1000,
    random: () => 0,
    sleep: async (ms) => { waits.push(ms) },
    log: () => {},
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(waits, [100, 200])
})

test('does not retry final 4xx and stops after the attempt budget', async () => {
  let calls = 0
  await assert.rejects(() => retryOperation(async () => {
    calls += 1
    throw new HttpError('bad request', { status: 422 })
  }, { attempts: 3, sleep: async () => {}, log: () => {} }), /bad request/)
  assert.equal(calls, 1)

  calls = 0
  await assert.rejects(() => retryOperation(async () => {
    calls += 1
    throw new HttpError('server', { status: 500 })
  }, { attempts: 3, baseMs: 1, sleep: async () => {}, log: () => {} }), /server/)
  assert.equal(calls, 3)
})

test('honors Retry-After over exponential delay', async () => {
  const waits = []
  let calls = 0
  await retryOperation(async () => {
    calls += 1
    if (calls === 1) throw new HttpError('rate limited', { status: 429, retryAfterMs: 900 })
    return 'ok'
  }, {
    attempts: 2, baseMs: 10, capMs: 100, random: () => 0,
    sleep: async (ms) => { waits.push(ms) }, log: () => {},
  })
  assert.deepEqual(waits, [900])
})
