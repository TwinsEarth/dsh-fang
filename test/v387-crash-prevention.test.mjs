// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'

import * as orchestrator from '../src/plugins/orchestrator.mjs'
import { classifyCloseReason, CLOSE_REASON_KINDS } from '../src/lib/browser-close-reason.mjs'
import { probeForkHealth, evaluateForkHealth } from '../src/lib/fork-health.mjs'

const root = new URL('..', import.meta.url)
const orchestratorSource = fs.readFileSync(new URL('./src/plugins/orchestrator.mjs', root), 'utf8')
const clientSource = fs.readFileSync(new URL('./client.js', root), 'utf8')

test('v3.8.7: health thresholds, flush budget and browser crash window defaults are explicit', () => {
  const cfg = orchestrator.Config({})
  assert.equal(cfg.forkHealthMaxSessionMB, 500)
  assert.equal(cfg.forkHealthMaxEvents, 1_000_000)
  assert.equal(cfg.forkFlushTimeoutMs, 3000)
  assert.equal(cfg.browserCrashWindowMs, 600000)
  assert.equal(cfg.browserCrashThreshold, 2)
  assert.equal(cfg.forkFlushPath, '', 'flush 路径由 routes.prefix 推导，调用前再实测')
})

test('v3.8.13: pagefile boot policy is advisory and never forces Safe Mode', () => {
  const healthyCommit = { ok: true, pagefileMissing: true, hasPageFile: false, pageFileMB: 0, commitFreeMB: 8192, physicalFreeMB: 8192 }
  const policy = orchestrator.decidePagefileBootPolicy(healthyCommit, { hostCriticalFreeMB: 4096 })
  assert.equal(policy.safeMode, false)
  assert.equal(policy.singleForkOnly, false)
  assert.equal(policy.reason, 'pagefile-missing-advisory')
  assert.equal(policy.advisory, 'pagefile-missing')

  const lowFree = { ...healthyCommit, physicalFreeMB: 500, commitFreeMB: 500 }
  const low = orchestrator.decidePagefileBootPolicy(lowFree, { hostCriticalFreeMB: 4096 })
  assert.equal(low.safeMode, false)
  assert.equal(low.reason, 'pagefile-missing-low-free')
  assert.equal(low.lowFree, true)

  const withPagefile = { ...healthyCommit, pagefileMissing: false, hasPageFile: true, pageFileMB: 4096 }
  assert.equal(orchestrator.decidePagefileBootPolicy(withPagefile).safeMode, false)
  assert.equal(orchestrator.decidePagefileBootPolicy(withPagefile).singleForkOnly, false)
})

test('v3.9.10: close reasons include capacity and collapse to operator-visible kinds', () => {
  assert.deepEqual(CLOSE_REASON_KINDS, ['user', 'idle', 'capacity', 'browser-oom', 'dom-limit', 'host-panic', 'crash-loop'])
  assert.equal(classifyCloseReason('user'), 'user')
  assert.equal(classifyCloseReason('idle-hidden'), 'idle')
  assert.equal(classifyCloseReason('max-open-fork-browsers'), 'capacity')
  assert.equal(classifyCloseReason('browser-memory-limit'), 'browser-oom')
  assert.equal(classifyCloseReason('browser-heap-limit'), 'browser-oom')
  assert.equal(classifyCloseReason('browser-dom-limit'), 'dom-limit')
  assert.equal(classifyCloseReason('host-panic:commit'), 'host-panic')
  assert.equal(classifyCloseReason('browser-crash-loop'), 'crash-loop')
})

test('v3.8.7: health probe reports port latency and open writes browser-health.jsonl', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, adapter: { ok: true }, session: { events: 10 } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const probe = await probeForkHealth(port, { path: '/api/health', fallbackPaths: [], timeoutMs: 1000 })
    assert.equal(probe.ok, true)
    assert.equal(typeof probe.latencyMs, 'number')
    assert.ok(probe.latencyMs >= 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.match(orchestratorSource, /browser-health\.jsonl/)
  assert.match(orchestratorSource, /latencyMs: http\.latencyMs/)
})

test('v3.8.7: remote health events and largest session are both hard limits', () => {
  const base = { ok: true, session: { events: 10, largestBytes: 1024 * 1024 } }
  const ok = evaluateForkHealth({ http: { ok: true, data: base }, adapter: { ok: true }, limits: { maxSessionMB: 20, maxEvents: 20000 } })
  assert.equal(ok.ok, true)
  const tooMany = evaluateForkHealth({ http: { ok: true, data: { ...base, session: { ...base.session, events: 1_000_001 } } }, adapter: { ok: true }, limits: { maxSessionMB: 500, maxEvents: 1_000_000 } })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.error, /events-limit/)
  const tooBig = evaluateForkHealth({ http: { ok: true, data: { ...base, session: { ...base.session, largestBytes: 501 * 1024 * 1024 } } }, adapter: { ok: true }, limits: { maxSessionMB: 500, maxEvents: 1_000_000 } })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /hard-limit/)
})

test('v3.8.7: flush verifies the real adapter endpoint within the 3s budget and records unsupported', () => {
  assert.match(orchestratorSource, /cfg\.forkFlushTimeoutMs/)
  assert.match(orchestratorSource, /AbortSignal\.timeout\(remaining\)/)
  assert.match(orchestratorSource, /forkFlushDefaultPath/)
  assert.doesNotMatch(orchestratorSource, /'\/api\/session\/flush'/)
  assert.doesNotMatch(orchestratorSource, /'\/api\/session\/save'/)
  assert.match(orchestratorSource, /source: 'adapter-route'/)
  assert.match(orchestratorSource, /code: 'flush-unsupported'/)
  assert.match(orchestratorSource, /if \(result\.saved === true\) return/)
  assert.doesNotMatch(orchestratorSource, /AbortSignal\.timeout\(5000\)/)
})

test('v3.8.7: browser crashes log raw exit/OOM/last metrics and 10m twice quarantines', () => {
  assert.match(orchestratorSource, /browser-crashes\.jsonl/)
  assert.match(orchestratorSource, /rawCode: exit\.code/)
  assert.match(orchestratorSource, /unsignedCode: exit\.unsignedCode/)
  assert.match(orchestratorSource, /lastMetrics: last/)
  assert.match(orchestratorSource, /reason: 'browser-crash-loop'/)
  assert.match(orchestratorSource, /evaluateCrashLoop\(crashes\.map/)
  assert.match(orchestratorSource, /exit\.kind !== 'normal'/)
})

test('v3.9.10: status exposes pagefile fields without hard-limiting browsers or forks', () => {
  assert.match(orchestratorSource, /pageFileMB: Number\(memorySnapshot\?\.pageFileMB\) \|\| 0/)
  assert.match(orchestratorSource, /hasPageFile: memorySnapshot\?\.hasPageFile === true/)
  assert.match(orchestratorSource, /const max = effectiveMaxOpenForkBrowsers\(\)/)
  assert.equal(orchestratorSource.includes('Native pagefile policy outranks maxOpenForkBrowsers'), false)
  assert.ok(clientSource.includes('未启用页面文件 · 仅提醒，不限制分身'))
  assert.equal(clientSource.includes('未启用页面文件，已强制单分身'), false)
  assert.equal(clientSource.includes('最多只保留 1 个活跃分身'), false)
})

test('v3.8.7: task card surfaces the last browser crash and classified close reason', () => {
  assert.match(clientSource, /上次崩溃于 OOM/)
  assert.match(clientSource, /上次崩溃于 exit/)
  assert.match(orchestratorSource, /browserCrash: t\.browserCrash \?\? null/)
  assert.match(orchestratorSource, /closeReason: t\.closeReason \?\? null/)
  assert.match(orchestratorSource, /reasonKind: closeKind/)
})
