// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.7.0 — ForkSseClient 网络层模糊测试：
//   性质：401 致命不重试 / 409、410 触发 resetCursor / 心跳无害 / 断连后无重复且 since 正确；
//   随机：事件序列 × 分块策略 × 断连策略（无断/单断/多断/心跳）。
import { pathToFileURL } from 'node:url'
import { createAdapterClient } from '../../src/lib/adapter-client.mjs'
import { XorShift128 } from './sse-rng.mjs'
import { MockSseServer, sleep } from './sse-client-mock.mjs'
import {
  SSE_CLIENT_STRATEGIES,
  expectedSinceFor,
  generateCase,
} from './sse-client-generators.mjs'

const DEFAULT_TIMEOUT_MS = 1500

const clientOptions = (server) => ({
  url: server.baseUrl,
  adapterToken: 'fuzz-token',
  reconnect: { baseMs: 5, maxMs: 20 },
  timeoutMs: 2000,
})

function cursorsOf(events) {
  return events.map((event) => String(event.cursor))
}

function isComplete(received, expected) {
  const seen = new Set(received.map((event) => String(event.cursor)))
  return expected.length > 0 && seen.size === expected.length && expected.every((cursor) => seen.has(cursor))
}

async function waitFor(predicate, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 5) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

async function stopClient(client) {
  try {
    client.stop()
  } catch {
    /* ignore */
  }
  await Promise.race([client.pumpDone.catch(() => null), sleep(150)])
}

function compareCursors(expected, actual) {
  if (expected.length !== actual.length) {
    return { equal: false, reason: `cursor count ${actual.length} vs ${expected.length}` }
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) {
      return { equal: false, reason: `cursor[${i}]: ${actual[i]} vs ${expected[i]}` }
    }
  }
  return { equal: true }
}

function compareQueries(expected, actual) {
  const n = Math.min(expected.length, actual.length)
  for (let i = 0; i < n; i += 1) {
    if (expected[i] !== actual[i]) {
      return { equal: false, reason: `request[${i}].since: ${actual[i]} vs ${expected[i]}` }
    }
  }
  if (actual.length < expected.length) {
    return { equal: false, reason: `only ${actual.length}/${expected.length} event requests` }
  }
  return { equal: true }
}

// ── 性质测试 ────────────────────────────────────────────────────────────────

async function withServer(run) {
  const server = new MockSseServer({ sessionId: 's-fuzz-1', lastCursor: '0' })
  await server.start()
  try {
    return await run(server)
  } finally {
    await server.stop()
  }
}

function makeClient(server) {
  return createAdapterClient(clientOptions(server))
}

async function assert401IsFatal() {
  await withServer(async (server) => {
    server.configure({ frames: [], plans: [{ status: 401 }] })
    const client = makeClient(server)
    let disconnect = null
    client.onDisconnect((payload) => {
      disconnect = payload
    })
    try {
      const result = await client.connect()
      if (result.ok !== false || result.code !== 'unauthorized' || result.fatal !== true) {
        throw new Error(`401 should be fatal, got ${JSON.stringify(result)}`)
      }
      await sleep(80)
      if (server.queries.length !== 1) throw new Error(`401 must not retry (requests=${server.queries.length})`)
      if (!disconnect || disconnect.fatal !== true) throw new Error('401 must emit fatal disconnect')
    } finally {
      await stopClient(client)
    }
  })
}

async function assertErrorResets(errorStatus, expectedCode) {
  await withServer(async (server) => {
    server.configure({
      sessionId: 's-fuzz-1',
      lastCursor: '0',
      frames: [
        { cursor: '1', chunks: ['id: 1\nevent: adapter\ndata: {"cursor":"1","event":{"kind":"audit"}}\n\n'] },
        { cursor: '2', chunks: ['id: 2\nevent: adapter\ndata: {"cursor":"2","event":{"kind":"audit"}}\n\n'] },
      ],
      plans: [{ status: errorStatus }, { serve: 'all', ending: 'hold' }],
    })
    const client = makeClient(server)
    const received = []
    let resetSeen = false
    client.onEvent((event) => received.push(event))
    client.onReconnect((payload) => {
      if (payload?.resetCursor === true) resetSeen = true
    })
    try {
      const result = await client.connect()
      if (result.ok !== false || result.code !== expectedCode) {
        throw new Error(`${errorStatus} connect result mismatch: ${JSON.stringify(result)}`)
      }
      const covered = await waitFor(() => isComplete(received, ['1', '2']))
      if (!covered) throw new Error(`${errorStatus} did not recover (cursors=${cursorsOf(received).join(',')})`)
      if (!resetSeen) throw new Error(`${errorStatus} did not emit resetCursor=true`)
      const cmp = compareQueries(['0', '0'], server.queries.map((q) => q.since))
      if (!cmp.equal) throw new Error(`${errorStatus} requests: ${cmp.reason}`)
      if (server.stateRequests < 2) throw new Error(`${errorStatus} must resync /state`)
    } finally {
      await stopClient(client)
    }
  })
}

async function assertHeartbeatsAreHarmless() {
  await withServer(async (server) => {
    const frames = ['1', '2', '3'].map((cursor) => ({
      cursor,
      chunks: [`id: ${cursor}\nevent: adapter\ndata: {"cursor":"${cursor}","event":{"kind":"audit"}}\n\n`],
    }))
    server.configure({ frames, plans: [{ serve: 'all', ending: 'hold', heartbeat: true }] })
    const client = makeClient(server)
    const received = []
    client.onEvent((event) => received.push(event))
    try {
      await client.connect()
      if (!(await waitFor(() => isComplete(received, ['1', '2', '3'])))) {
        throw new Error(`heartbeats prevented delivery: ${cursorsOf(received).join(',')}`)
      }
      await sleep(30)
      const cmp = compareCursors(['1', '2', '3'], cursorsOf(received))
      if (!cmp.equal) throw new Error(`heartbeat frame leaked: ${cmp.reason}`)
      if (client.lastCursor !== '3') throw new Error(`lastCursor=${client.lastCursor}, expected 3`)
    } finally {
      await stopClient(client)
    }
  })
}

async function assertReconnectNoDuplicateAndCorrectSince() {
  await withServer(async (server) => {
    const frames = ['1', '2', '3', '4'].map((cursor) => ({
      cursor,
      chunks: [`id: ${cursor}\nevent: adapter\ndata: {"cursor":"${cursor}","event":{"kind":"audit"}}\n\n`],
    }))
    server.configure({
      frames,
      plans: [
        { serve: 2, ending: 'destroy' },
        { serve: 'all', ending: 'hold' },
      ],
    })
    const client = makeClient(server)
    const received = []
    client.onEvent((event) => received.push(event))
    try {
      await client.connect()
      if (!(await waitFor(() => isComplete(received, ['1', '2', '3', '4'])))) {
        throw new Error(`reconnect incomplete: ${cursorsOf(received).join(',')}`)
      }
      await sleep(30)
      const cmp = compareCursors(['1', '2', '3', '4'], cursorsOf(received))
      if (!cmp.equal) throw new Error(`duplicate/gap after reconnect: ${cmp.reason}`)
      const queries = server.queries.map((q) => q.since)
      if (queries[0] !== '0') throw new Error(`first since=${queries[0]}, expected 0`)
      if (queries[1] !== '2') throw new Error(`reconnect since=${queries[1]}, expected 2`)
    } finally {
      await stopClient(client)
    }
  })
}

/** 性质测试入口：全部通过则 resolve，失败抛错。 */
export async function runSseClientProperties() {
  await assert401IsFatal()
  await assertErrorResets(409, 'session-changed')
  await assertErrorResets(410, 'cursor-expired')
  await assertHeartbeatsAreHarmless()
  await assertReconnectNoDuplicateAndCorrectSince()
}

// ── 随机模糊 ────────────────────────────────────────────────────────────────

function recordFailure(failures, seed, iteration, testCase, reason, received, queries) {
  failures.push({
    seed,
    iteration,
    strategy: testCase.strategy,
    description: testCase.description,
    reason,
    expectedCursors: cursorsOf(testCase.events),
    actualCursors: cursorsOf(received),
    queries,
  })
}

/**
 * @param {{iterations?:number, seed?:number}} [options]
 * @returns {Promise<{seed:number,totalIterations:number,failures:object[],strategyCounts:Record<string,number>}>}
 */
export async function runSseClientFuzz({ iterations = 100, seed } = {}) {
  const server = new MockSseServer({ sessionId: 's-fuzz-1', lastCursor: '0' })
  await server.start()
  const total = Math.max(0, Math.floor(Number(iterations) || 0))
  const baseSeed = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : (Date.now() & 0x7fffffff)
  const failures = []
  const strategyCounts = Object.fromEntries(SSE_CLIENT_STRATEGIES.map((strategy) => [strategy, 0]))
  let completed = 0

  try {
    for (let i = 0; i < total; i += 1) {
      const iterationSeed = (baseSeed + Math.imul(i, 0x9e3779b1)) >>> 0
      const rng = new XorShift128(iterationSeed)
      const testCase = generateCase(rng)
      server.configure({
        frames: testCase.frames,
        plans: testCase.plans,
        sessionId: 's-fuzz-1',
        lastCursor: '0',
      })

      const client = makeClient(server)
      const received = []
      client.onEvent((event) => received.push(event))
      try {
        const result = await client.connect()
        if (result.ok !== true) {
          recordFailure(failures, iterationSeed, i, testCase, `connect failed: ${result.code ?? 'unknown'}`, received, [...server.queries])
        } else if (!(await waitFor(() => isComplete(received, cursorsOf(testCase.events))))) {
          recordFailure(failures, iterationSeed, i, testCase, 'timed out waiting for all cursors', received, [...server.queries])
        } else {
          await sleep(15)
          const expectedCursors = cursorsOf(testCase.events)
          const cmp = compareCursors(expectedCursors, cursorsOf(received))
          if (!cmp.equal) {
            recordFailure(failures, iterationSeed, i, testCase, cmp.reason, received, [...server.queries])
          } else {
            const expectedQueries = expectedSinceFor(testCase.frames, testCase.plans)
            const queryCmp = compareQueries(
              expectedQueries,
              server.queries.map((query) => query.since),
            )
            if (!queryCmp.equal) {
              recordFailure(failures, iterationSeed, i, testCase, queryCmp.reason, received, [...server.queries])
            } else {
              strategyCounts[testCase.strategy] += 1
            }
          }
        }
      } catch (e) {
        recordFailure(failures, iterationSeed, i, testCase, `threw: ${String(e?.message ?? e)}`, received, [...server.queries])
      } finally {
        await stopClient(client)
      }
      completed += 1
    }
  } finally {
    await server.stop()
  }

  return { seed: baseSeed, totalIterations: completed, failures, strategyCounts }
}

export function formatFailure(failure) {
  return [
    '=== SSE CLIENT FAILURE ===',
    `iterationSeed: ${failure.seed}`,
    `iteration: ${failure.iteration}`,
    `strategy: ${failure.strategy}`,
    `description: ${failure.description}`,
    `reason: ${failure.reason}`,
    `expectedCursors: ${failure.expectedCursors.join(',')}`,
    `actualCursors:   ${failure.actualCursors.join(',')}`,
    `requests: ${JSON.stringify(failure.queries)}`,
  ].join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  const getArg = (name, fallback) => {
    const at = argv.indexOf(name)
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
  }

  try {
    await runSseClientProperties()
    console.log('[sse-properties] all passed')
  } catch (e) {
    console.error(`[sse-properties] FAILED: ${String(e?.message ?? e)}`)
    return 2
  }

  const iterations = Number(getArg('--iterations', '100'))
  const seedArg = getArg('--seed', '')
  const result = await runSseClientFuzz({
    iterations,
    seed: seedArg === '' ? undefined : Number(seedArg),
  })
  console.log(
    `[sse-fuzz] seed=${result.seed} iterations=${result.totalIterations} failures=${result.failures.length}`,
  )
  console.log('[sse-fuzz] strategies:')
  for (const [strategy, count] of Object.entries(result.strategyCounts)) {
    console.log(`  ${strategy}: ${count}`)
  }
  if (result.failures.length === 0) return 0
  for (const failure of result.failures.slice(0, 5)) console.error(`\n${formatFailure(failure)}`)
  console.error(`\nReproduce: node tools/fuzz/sse-client-fuzz.mjs --iterations 1 --seed ${result.failures[0].seed}`)
  return 1
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  process.exitCode = await main()
}
