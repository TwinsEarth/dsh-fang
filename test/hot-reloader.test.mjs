// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — fangHotReloader（CONTRACTS §5.8）
// Real ESM swap tests: every fixture below is a real file imported through `?rev=<contentHash>`
// (no mocks of `import()`), so these tests prove byte-level version switching + rollback.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { makeCtx } from './helpers.mjs'
import { SERVICE, sha256File } from '../src/kernel/index.mjs'
import {
  Config,
  apply,
  inject,
  name as pluginName,
} from '../src/plugins/hot-reloader.mjs'

// v2 deployment matrix: this plugin is fork-only; pin the role before apply().
process.env.DSH_FANG_ROLE = 'fork'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 't4')
const fixture = (file) => path.join(FIXTURES, file)
const REV1 = fixture('rev1.mjs')
const REV2 = fixture('rev2.mjs')
const BAD = fixture('bad.mjs')
const LEAK = fixture('leak.mjs')
const MISSING = fixture('does-not-exist.mjs')
const HASH1 = sha256File(REV1)
const HASH2 = sha256File(REV2)

const trace = () => globalThis.__fangT4Trace ?? []
const countEvents = (list, event, marker) =>
  list.filter(e => e.event === event && (!marker || e.marker === marker)).length
const clearLeaks = () => {
  for (const t of globalThis.__fangT4Leaks ?? []) clearInterval(t)
  globalThis.__fangT4Leaks = []
}

function setup(t, config = { healthWindowMs: 50, healthMaxNewHandles: 2 }) {
  const ctx = makeCtx()
  apply(ctx, config)
  t.after(() => {
    clearLeaks()
    try { ctx.dispose() } catch { /* ignore */ }
  })
  return { ctx, reloader: ctx.get(SERVICE.hotReloader) }
}

test('plugin shape: name/inject/Config/apply and SERVICE.hotReloader registration', async (t) => {
  assert.equal(pluginName, 'fang-hot-reloader')
  assert.ok(Array.isArray(inject), 'inject must be an array')
  assert.deepEqual(inject, [], 'T4 sub-plugin has no hard service dependency')
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
  assert.ok(globalThis.__fangT4Trace === undefined || Array.isArray(globalThis.__fangT4Trace))

  // schema defaults must match CONTRACTS (§5.8: 健康窗默认 300ms, healthMaxNewHandles 默认 2)
  const defaults = Config({})
  assert.equal(defaults.healthWindowMs, 300)
  assert.equal(defaults.healthMaxNewHandles, 2)
  assert.throws(() => Config({ healthWindowMs: 10 }), /healthWindowMs/)

  const { reloader } = setup(t)
  assert.ok(reloader, 'ctx.get(SERVICE.hotReloader) must be registered')
  for (const fn of ['swap', 'unload', 'health']) assert.equal(typeof reloader[fn], 'function')
  const health = reloader.health()
  assert.equal(health.windowMs, 50)
  assert.equal(health.samples, 0)
  assert.equal(health.lastDiff, null)
  assert.deepEqual(health.loaded, [])

  // direct apply() must validate its own config too (not only the host Loader)
  assert.throws(() => apply(makeCtx(), { healthWindowMs: 10 }), /config invalid/)
})

test('swap loads real ESM bytes by content hash, then disposes the old fiber only after healthy', async (t) => {
  const { reloader } = setup(t)
  const before = trace().length

  // fresh name => no old fiber
  const r1 = await reloader.swap({ name: 'demo', file: REV1, config: { flavor: 'one' } })
  assert.equal(r1.ok, true)
  assert.equal(r1.phase, 'swapped')
  assert.equal(r1.from, null)
  assert.equal(r1.to, HASH1, 'rev must be the content hash of rev1.mjs')
  assert.equal(r1.fiber.rev, HASH1)
  assert.ok(r1.url.includes(`?rev=${HASH1}`), `import URL must cache-bust with ?rev=, got ${r1.url}`)
  assert.equal(r1.health.windowMs, 50)
  assert.equal(typeof r1.health.leakedRefed, 'number')
  assert.equal(r1.disposedOld, null, 'nothing to dispose on first load')
  const applied1 = trace().slice(before).filter(e => e.event === 'apply' && e.marker === 'rev1')
  assert.equal(applied1.length, 1, 'rev1 code must actually have been initialized')
  assert.deepEqual(applied1[0].pluginConfig, { flavor: 'one' }, 'swap config must reach the plugin apply()')

  // second swap => new bytes, old fiber disposed only after the health window passed
  const mid = trace().length
  const r2 = await reloader.swap({ name: 'demo', file: REV2, config: { flavor: 'two' } })
  assert.equal(r2.ok, true)
  assert.equal(r2.phase, 'swapped')
  assert.equal(r2.from, HASH1)
  assert.equal(r2.to, HASH2)
  assert.notEqual(HASH1, HASH2, 'different files must hash differently')
  assert.equal(r2.url, pathToFileURL(REV2).href + `?rev=${HASH2}`)
  assert.equal(r2.disposedOld, true, 'old fiber must be disposed on a successful swap')

  const after = trace().slice(mid)
  assert.equal(countEvents(after, 'apply', 'rev2'), 1, 'rev2 code must actually have been initialized')
  assert.equal(countEvents(after, 'disposed', 'rev1'), 1, 'rev1 fiber must be disposed exactly once')
  assert.equal(countEvents(after, 'disposed', 'rev2'), 0, 'rev2 fiber must still be mounted')
  assert.ok(
    after.findIndex(e => e.event === 'apply' && e.marker === 'rev2') <
      after.findIndex(e => e.event === 'disposed' && e.marker === 'rev1'),
    'new code must be applied before the old fiber is disposed',
  )
  assert.equal(reloader.health().samples, 2)
})

test('?rev=<contentHash>: identical bytes reuse the same ESM module, apply still reruns per mount', async (t) => {
  const { reloader } = setup(t)
  const evaluationsBefore = countEvents(trace(), 'evaluate', 'rev1')

  const r1 = await reloader.swap({ name: 'same', file: REV1 })
  const r2 = await reloader.swap({ name: 'same', file: REV1 })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.to, HASH1)
  assert.equal(r2.from, HASH1, 'swapping the same bytes keeps the same rev')
  assert.equal(countEvents(trace(), 'evaluate', 'rev1'), evaluationsBefore, 'same ?rev must reuse the ESM module (no re-evaluation)')
  const applies = trace().filter(e => e.event === 'apply' && e.marker === 'rev1')
  assert.ok(applies.length >= 2, 'each mount must call apply(), even when the module instance is reused')
  assert.equal(reloader.health().samples, 2)
})

test('init failure (apply throws) returns init-failed and never touches the previous fiber', async (t) => {
  const { reloader } = setup(t)
  const ok = await reloader.swap({ name: 'demo', file: REV1 })
  assert.equal(ok.ok, true)
  const mark = trace().length

  const bad = await reloader.swap({ name: 'demo', file: BAD })
  assert.equal(bad.ok, false)
  assert.equal(bad.phase, 'init-failed')
  assert.equal(bad.reason, 'mount-failed')
  assert.match(bad.error, /t4-bad: init failed on purpose/)
  assert.equal(bad.from, HASH1)
  assert.equal(bad.to, sha256File(BAD), 'the failure report still names the attempted rev')
  assert.equal(reloader.health().samples, 1, 'a failed init does not enter the health window')

  const events = trace().slice(mark)
  assert.equal(countEvents(events, 'apply-threw', 'bad'), 1, 'the bad module was really initialized and really threw')
  assert.equal(countEvents(events, 'disposed', 'rev1'), 0, 'previous fiber must NOT be disposed on init failure')

  // proof the old fiber is still the mounted one: unloading it now disposes rev1
  const unload = await reloader.unload({ name: 'demo' })
  assert.equal(unload.ok, true)
  assert.equal(unload.from, HASH1)
  assert.equal(countEvents(trace().slice(mark), 'disposed', 'rev1'), 1)
  const again = await reloader.unload({ name: 'demo' })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'not-loaded')
})

test('import failure (missing file) returns init-failed and keeps the old fiber', async (t) => {
  const { reloader } = setup(t)
  assert.equal((await reloader.swap({ name: 'demo', file: REV1 })).ok, true)
  const mark = trace().length

  const missing = await reloader.swap({ name: 'demo', file: MISSING })
  assert.equal(missing.ok, false)
  assert.equal(missing.phase, 'init-failed')
  assert.equal(missing.reason, 'import-failed')
  assert.ok(missing.error, 'import error must be reported, not swallowed')
  assert.equal(countEvents(trace().slice(mark), 'disposed', 'rev1'), 0, 'old fiber untouched on import failure')
  assert.equal(reloader.health().samples, 1)
  assert.equal((await reloader.unload({ name: 'demo' })).ok, true)
})

test('health window: leakedRefed > healthMaxNewHandles rolls back the new fiber, old one survives', async (t) => {
  // tolerance 1 leaves room for environment noise; leak.mjs leaks 2 ref'd intervals => deterministic trip
  const { reloader } = setup(t, { healthWindowMs: 50, healthMaxNewHandles: 1 })
  const first = await reloader.swap({ name: 'demo', file: REV1 })
  assert.equal(first.ok, true, `initial load must be healthy, leakedRefed=${first.health?.leakedRefed}`)
  assert.ok(first.health.leakedRefed <= 1)
  const mark = trace().length

  const leak = await reloader.swap({ name: 'demo', file: LEAK })
  assert.equal(leak.ok, false)
  assert.equal(leak.phase, 'rolled-back')
  assert.equal(leak.rolledBack, true)
  assert.equal(leak.reason, 'health-window')
  assert.ok(leak.health.leakedRefed >= 2, `expected >=2 leaked ref'd handles, got ${leak.health.leakedRefed}`)
  assert.equal(leak.health.windowMs, 50)
  assert.equal(leak.from, HASH1)
  assert.equal(leak.to, sha256File(LEAK))

  const events = trace().slice(mark)
  assert.equal(countEvents(events, 'apply', 'leak'), 1, 'leaking code did run inside the health window')
  assert.equal(countEvents(events, 'disposed', 'leak'), 1, 'the unhealthy new fiber must be disposed')
  assert.equal(countEvents(events, 'disposed', 'rev1'), 0, 'the old fiber must survive a rollback')
  assert.equal((globalThis.__fangT4Leaks ?? []).length, 0, 'rollback disposal must release the leaked timers it can see')

  const health = reloader.health()
  assert.equal(health.samples, 2)
  assert.equal(health.rollbacks, 1)
  assert.equal(health.swaps, 1)
  assert.ok(health.lastDiff.leakedRefed >= 2)
  assert.equal(health.loaded.length, 1, 'the map still points at the previous fiber')

  // the guard is usable again: unload the surviving old fiber
  assert.equal((await reloader.unload({ name: 'demo' })).ok, true)
  assert.equal(countEvents(trace(), 'disposed', 'rev1'), countEvents(trace().slice(0, mark), 'disposed', 'rev1') + 1)
})

test('health() reports loaded snapshots and unload releases them', async (t) => {
  const { reloader } = setup(t)
  assert.deepEqual(reloader.health().loaded, [])
  const r = await reloader.swap({ name: 'alpha', file: REV1 })
  const health = reloader.health()
  assert.equal(health.loaded.length, 1)
  assert.equal(health.loaded[0].name, 'alpha')
  assert.equal(health.loaded[0].rev, r.to)
  assert.ok(health.loaded[0].url.includes('?rev='))

  const unload = await reloader.unload({ name: 'alpha' })
  assert.equal(unload.ok, true)
  assert.equal(unload.phase, 'unloaded')
  assert.equal(unload.from, HASH1)
  assert.deepEqual(reloader.health().loaded, [])
  assert.equal((await reloader.unload({ name: 'alpha' })).ok, false)
})

test('bad requests fail cleanly instead of throwing', async (t) => {
  const { reloader } = setup(t)
  const empty = await reloader.swap({})
  assert.equal(empty.ok, false)
  assert.equal(empty.phase, 'init-failed')
  assert.equal(empty.reason, 'bad-request')
  const noFile = await reloader.swap({ name: 'x' })
  assert.equal(noFile.ok, false)
  assert.equal(noFile.reason, 'bad-request')
  assert.equal(reloader.health().samples, 0)
})

test('ctx disposal disposes mounted fibers (ctx.effect cleanup)', async (t) => {
  const ctx = makeCtx()
  apply(ctx, { healthWindowMs: 50, healthMaxNewHandles: 2 })
  const reloader = ctx.get(SERVICE.hotReloader)
  const mark = trace().length
  assert.equal((await reloader.swap({ name: 'demo', file: REV1 })).ok, true)
  ctx.dispose()
  assert.equal(countEvents(trace().slice(mark), 'disposed', 'rev1'), 1, 'plugin cleanup must dispose the mounted fiber')
  clearLeaks()
})
