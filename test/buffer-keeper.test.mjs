// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T1 — buffer-keeper tests: watch/poll, three-state judgement, settle flush, baseline scan
// and disposer hygiene. Every temp dir is mkdtemp'd and removed with the kernel removeTree().
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AUDIT,
  BUFFER_STATE,
  SERVICE,
  bus,
  exists,
  removeTree,
} from '../src/kernel/index.mjs'
import * as bufferKeeper from '../src/plugins/buffer-keeper.mjs'
import { makeCtx } from './helpers.mjs'
// v2 deployment matrix: this plugin is fork-only; pin the role before apply().
process.env.DSH_FANG_ROLE = 'fork'

const tmpDirs = []
function tmp(prefix = 'fang-t1-buffer-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
function cleanupTmp() {
  for (const dir of tmpDirs.splice(0)) removeTree(dir)
}
after(cleanupTmp)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check, { timeout = 5000, step = 20 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start >= timeout) return null
    await wait(step)
  }
}
function newBuffer(config = {}) {
  const ctx = makeCtx()
  const service = bufferKeeper.apply(ctx, config)
  return { ctx, service }
}
function writeRel(dir, rel, content) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

test('module surface + config defaults, and an unstarted keeper answers settled', async () => {
  assert.equal(bufferKeeper.name, 'fang-buffer-keeper')
  assert.deepEqual(bufferKeeper.inject, [])
  assert.equal(typeof bufferKeeper.Config, 'function')
  assert.equal(typeof bufferKeeper.apply, 'function')
  const cfg = bufferKeeper.Config({})
  assert.equal(cfg.settleMs, 750)
  assert.equal(cfg.pollMs, 250)
  assert.equal(cfg.watch, true)
  assert.equal(cfg.root, '')

  const { ctx, service } = newBuffer()
  try {
    assert.equal(ctx.get(SERVICE.buffer), service)
    for (const method of ['start', 'stop', 'state', 'flush', 'scan', 'baseline']) {
      assert.equal(typeof service[method], 'function', `missing service.${method}`)
    }
    const st = service.state()
    assert.equal(st.state, BUFFER_STATE.SETTLED)
    assert.equal(st.dir, '')
    assert.deepEqual(st.pending, [])
    assert.equal(service.baseline().count, 0)
    const scan = service.scan()
    assert.deepEqual(scan.added, [])
    assert.deepEqual(scan.changed, [])
    assert.deepEqual(scan.removed, [])
    const flushed = await service.flush({ strictMs: 20 })
    assert.equal(flushed.state, 'settled')
    assert.equal(flushed.timedOut, false)
    assert.deepEqual(flushed.flushed, [])
    assert.equal(service.stop().ok, true)
  } finally {
    ctx.dispose()
  }
})

test('start creates the dir and reports the watch mode; stop disarms it', () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  const { ctx, service } = newBuffer()
  try {
    const started = service.start({ dir })
    assert.equal(started.ok, true)
    assert.equal(service.dir, path.resolve(dir))
    assert.ok(exists(dir), 'start must create the watched dir')
    assert.equal(service.mode, 'watch')

    const again = service.start({ dir })
    assert.equal(again.ok, true)
    assert.equal(again.already, true, 're-starting the same live dir is a no-op')

    const st = service.state()
    assert.equal(st.state, BUFFER_STATE.SETTLED)
    assert.equal(st.dir, path.resolve(dir))

    const stopped = service.stop()
    assert.equal(stopped.ok, true)
    assert.equal(stopped.dir, path.resolve(dir))
    assert.equal(service.state().state, BUFFER_STATE.SETTLED)
    assert.equal(service.state().dir, '')
    assert.equal(service.mode, 'idle')

    const noDir = service.start({})
    assert.equal(noDir.ok, false)
    assert.equal(noDir.error, 'no-dir')
  } finally {
    ctx.dispose()
  }
})

test('watching detects a write: pending list, writing state and scan baseline diff', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  const { ctx, service } = newBuffer({ settleMs: 120, pollMs: 25 })
  try {
    service.start({ dir })
    writeRel(dir, 'a.txt', 'one\n')
    const pending = await waitFor(() => {
      const st = service.state()
      return st.pending.length ? st : null
    })
    assert.ok(pending, 'watch must notice the new file')
    assert.deepEqual(pending.pending, ['a.txt'])
    assert.ok(
      [BUFFER_STATE.WRITING, BUFFER_STATE.PENDING_HIGH_RISK].includes(pending.state),
      `unexpected state ${pending.state}`,
    )
    const scan = service.scan()
    assert.deepEqual(scan.added, ['a.txt'])
    assert.deepEqual(scan.changed, [])
    assert.deepEqual(scan.removed, [])
    assert.equal(scan.count, 1)
  } finally {
    ctx.dispose()
  }
})

test('a quiet change becomes pending-high-risk, and cordis*.yml / package.json are flagged high-risk', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  const { ctx, service } = newBuffer({ settleMs: 80, pollMs: 20 })
  try {
    service.start({ dir })
    writeRel(dir, 'a.txt', 'plain\n')
    writeRel(dir, 'cordis.patch.yml', 'bundle: patched\n')
    assert.ok(await waitFor(() => service.state().pending.length === 2))
    const settledState = await waitFor(() => {
      const st = service.state()
      return st.state === BUFFER_STATE.PENDING_HIGH_RISK ? st : null
    })
    assert.ok(settledState, 'after settleMs of silence the state must be pending-high-risk')
    assert.ok(settledState.quietMs >= 80)
    assert.ok(settledState.highRisk.includes('cordis.patch.yml'))
    assert.equal(settledState.highRisk.includes('a.txt'), false)
    assert.equal(typeof settledState.lastEventAt, 'number')
    assert.equal(settledState.pending.length, 2)
  } finally {
    ctx.dispose()
  }
})

test('flush waits for silence, settles the tree, emits fang/buffer-settled and clears pending', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  const { ctx, service } = newBuffer({ settleMs: 500 })
  const events = []
  const off = bus.on('fang/buffer-settled', (payload) => events.push(payload))
  try {
    service.start({ dir })
    writeRel(dir, 'a.txt', 'one\n')
    assert.ok(await waitFor(() => service.state().pending.length === 1))

    const settled = await service.flush({ strictMs: 40 })
    assert.equal(settled.state, 'settled')
    assert.equal(settled.timedOut, false)
    assert.deepEqual(settled.flushed, ['a.txt'])
    assert.equal(service.state().state, BUFFER_STATE.SETTLED)
    assert.deepEqual(service.state().pending, [])
    assert.equal(events.length, 1)
    assert.equal(events[0].dir, path.resolve(dir))
    assert.deepEqual(events[0].changed, ['a.txt'])

    // scan() compares against baseline(), NOT against the last flush.
    assert.deepEqual(service.scan().added, ['a.txt'])
    assert.equal(service.baseline().count, 1)
    assert.deepEqual(service.scan().added, [])
    assert.deepEqual(service.scan().changed, [])

    writeRel(dir, 'a.txt', 'two\n')
    assert.ok(await waitFor(() => service.state().pending.length === 1))
    const modified = await service.flush({ strictMs: 40 })
    assert.deepEqual(modified.flushed, ['a.txt'])

    fs.rmSync(path.join(dir, 'a.txt'))
    assert.ok(await waitFor(() => service.state().pending.length === 1))
    const removed = await service.flush({ strictMs: 40 })
    assert.deepEqual(removed.flushed, ['a.txt'])
    assert.equal(service.state().state, BUFFER_STATE.SETTLED)

    const noop = await service.flush({ strictMs: 20 })
    assert.equal(noop.state, 'settled')
    assert.deepEqual(noop.flushed, [])
    assert.equal(noop.timedOut, false)
  } finally {
    off()
    ctx.dispose()
  }
})

test('flush gives up as pending-high-risk when the buffer never goes quiet', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  // Wide margins on purpose: three test files run concurrently under node --test, so the
  // churn interval can be dilated by CPU contention.
  const { ctx, service } = newBuffer({ settleMs: 300, pollMs: 20 })
  try {
    service.start({ dir })
    writeRel(dir, 'churn.txt', '0')
    assert.ok(await waitFor(() => service.state().pending.length > 0))
    const churn = setInterval(() => {
      try {
        writeRel(dir, 'churn.txt', String(Date.now()))
      } catch {
        /* dir may be removed at cleanup */
      }
    }, 10)
    let res
    try {
      res = await service.flush({ strictMs: 200 })
    } finally {
      clearInterval(churn)
    }
    assert.equal(res.timedOut, true)
    assert.equal(res.state, BUFFER_STATE.PENDING_HIGH_RISK)
    assert.deepEqual(res.flushed, [])
    assert.equal(service.state().state, BUFFER_STATE.PENDING_HIGH_RISK)

    const recovered = await service.flush({ strictMs: 50 })
    assert.equal(recovered.timedOut, false)
    assert.equal(recovered.state, 'settled')
  } finally {
    ctx.dispose()
  }
})

test('watch:false degrades to digest polling and still settles', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  const { ctx, service } = newBuffer({ watch: false, pollMs: 20, settleMs: 60 })
  try {
    const started = service.start({ dir })
    assert.equal(started.ok, true)
    assert.equal(service.mode, 'poll', 'watch:false must use the polling fallback')
    writeRel(dir, 'sub/nested.txt', 'nested\n')
    assert.ok(await waitFor(() => service.state().pending.includes('sub/nested.txt')))
    const res = await service.flush({ strictMs: 40 })
    assert.equal(res.state, 'settled')
    assert.ok(res.flushed.includes('sub/nested.txt'))
    assert.equal(service.state().state, BUFFER_STATE.SETTLED)
  } finally {
    ctx.dispose()
  }
})

test('ctx disposer closes the watcher and freezes the keeper (no leaked handles)', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  let opened = 0
  let closed = 0
  const originalWatch = fs.watch
  fs.watch = (...args) => {
    opened++
    const watcher = originalWatch(...args)
    const originalClose = watcher.close.bind(watcher)
    watcher.close = () => {
      closed++
      return originalClose()
    }
    return watcher
  }
  const { ctx, service } = newBuffer()
  try {
    service.start({ dir })
    assert.equal(opened, 1)
    writeRel(dir, 'a.txt', 'x')
    assert.ok(await waitFor(() => service.state().pending.length === 1))
  } finally {
    ctx.dispose()
    fs.watch = originalWatch
  }
  assert.equal(closed, 1, 'disposer must close fs.watch')
  assert.equal(service.dir, '')
  assert.equal(service.mode, 'idle')

  // A write after dispose cannot wake the keeper up: its state stays settled and empty.
  writeRel(dir, 'after-dispose.txt', 'x')
  await wait(150)
  assert.equal(service.state().state, BUFFER_STATE.SETTLED)
  assert.deepEqual(service.state().pending, [])
})

test('flush audits through fangAudit when present and survives a broken auditor', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  const calls = []
  const ctx = makeCtx({
    services: {
      [SERVICE.auditor]: {
        append(kind, data) {
          calls.push({ kind, data })
          return { kind, data }
        },
      },
    },
  })
  const service = bufferKeeper.apply(ctx, {})
  try {
    service.start({ dir })
    writeRel(dir, 'a.txt', 'x')
    assert.ok(await waitFor(() => service.state().pending.length === 1))
    await service.flush({ strictMs: 30 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].kind, AUDIT.BUFFER_FLUSH)
    assert.deepEqual(calls[0].data.changed, ['a.txt'])
    assert.equal(calls[0].data.dir, path.resolve(dir))
  } finally {
    ctx.dispose()
  }

  const brokenCtx = makeCtx({
    services: {
      [SERVICE.auditor]: {
        append() {
          throw new Error('audit down')
        },
      },
    },
  })
  const broken = bufferKeeper.apply(brokenCtx, {})
  const dir2 = path.join(root, 'buffer2')
  try {
    broken.start({ dir: dir2 })
    writeRel(dir2, 'b.txt', 'x')
    assert.ok(await waitFor(() => broken.state().pending.length === 1))
    const res = await broken.flush({ strictMs: 30 })
    assert.equal(res.state, 'settled')
    assert.ok(res.flushed.includes('b.txt'))
  } finally {
    brokenCtx.dispose()
  }
})

test('concurrent flushes are serialized (no interleaved digest bookkeeping)', async () => {
  const root = tmp()
  const dir = path.join(root, 'buffer')
  const { ctx, service } = newBuffer({ settleMs: 100, pollMs: 20 })
  try {
    service.start({ dir })
    writeRel(dir, 'a.txt', 'x')
    assert.ok(await waitFor(() => service.state().pending.length === 1))
    const [first, second] = await Promise.all([
      service.flush({ strictMs: 30 }),
      service.flush({ strictMs: 30 }),
    ])
    assert.equal(first.state, 'settled')
    assert.deepEqual(first.flushed, ['a.txt'])
    assert.equal(second.state, 'settled')
    assert.deepEqual(second.flushed, [], 'the second flush finds nothing left to settle')
    assert.equal(service.state().state, BUFFER_STATE.SETTLED)
  } finally {
    ctx.dispose()
  }
})
