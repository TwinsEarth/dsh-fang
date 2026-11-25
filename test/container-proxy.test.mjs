// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T8 — declared write proxy tests (pure logic + real temp-dir writes).
//
// Covers: NDJSON framing (encodeFrame/parseFrames), path-escape rejection (dot-dot,
// absolute drive, UNC/namespace, NUL, ADS), declared-manifest prefix matching, the
// 1 MiB size cap, junction/symlink escape detection via the parent chain, real writes
// inside a temp buffer root, and the buffer-keeper proxy surface (role gate, config,
// setDeclared, proxyWrite audit/log). No container/PowerShell is involved here.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AUDIT, SERVICE, removeTree } from '../src/kernel/index.mjs'
import * as bufferKeeper from '../src/plugins/buffer-keeper.mjs'
import {
  DEFAULT_MAX_BYTES,
  WRITE_PROXY_OPS,
  applyWriteRequest,
  encodeFrame,
  normalizeDeclared,
  parseFrames,
  validateWriteRequest,
} from '../src/lib/container/index.mjs'
import { makeCtx } from './helpers.mjs'

// bufferKeeper is MATRIX fork-only and the role gate is strict (contract §1), so the
// harness role has to be explicit before any apply() in this file.
const ORIGINAL_ROLE = process.env.DSH_FANG_ROLE
process.env.DSH_FANG_ROLE = 'fork'

const tmpDirs = []
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-t8-'))
  tmpDirs.push(dir)
  return dir
}
function writeRel(dir, rel, content) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}
function withForkRole(fn) {
  const prev = process.env.DSH_FANG_ROLE
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = prev
  }
}
function newKeeper(config = {}, extraCtx = {}) {
  const ctx = makeCtx(extraCtx)
  const service = bufferKeeper.apply(ctx, config)
  return { ctx, service }
}

after(() => {
  if (ORIGINAL_ROLE === undefined) delete process.env.DSH_FANG_ROLE
  else process.env.DSH_FANG_ROLE = ORIGINAL_ROLE
  for (const dir of tmpDirs.splice(0)) removeTree(dir)
})

// ---------------------------------------------------------------------------
// NDJSON framing
// ---------------------------------------------------------------------------

test('framing: encodeFrame/parseFrames roundtrip, chunk splitting, CRLF and junk lines', () => {
  assert.deepEqual([...WRITE_PROXY_OPS], ['write', 'ping', 'stat'])
  assert.equal(Object.isFrozen(WRITE_PROXY_OPS), true, 'WRITE_PROXY_OPS must be frozen')

  const one = encodeFrame({ op: 'write', reqId: 'r1', path: 'plug/a.js', data: 'aGk=' })
  const two = encodeFrame({ op: 'ping', reqId: 'r2' })
  assert.equal(typeof one, 'string')
  assert.equal(one.endsWith('\n'), true, 'a frame is one NDJSON line')

  const first = parseFrames(one + two)
  assert.equal(first.frames.length, 2)
  assert.deepEqual(first.frames[0], { op: 'write', reqId: 'r1', path: 'plug/a.js', data: 'aGk=' })
  assert.equal(first.rest, '', 'complete lines leave no rest')

  // A frame split across two reads is only emitted after its newline arrives.
  const splitAt = two.length - 5
  const split = parseFrames(one + two.slice(0, splitAt))
  assert.equal(split.frames.length, 1)
  assert.equal(split.rest, two.slice(0, splitAt))
  const resumed = parseFrames(split.rest + two.slice(splitAt))
  assert.equal(resumed.frames.length, 1)
  assert.equal(resumed.frames[0].op, 'ping')

  // CRLF, blank lines and junk are tolerated (junk is reported, never thrown).
  const messy = parseFrames('\r\n' + one.replace('\n', '\r\n') + 'not-json\n' + '[1,2]\n\n')
  assert.equal(messy.frames.length, 1)
  assert.equal(messy.frames[0].reqId, 'r1')
  assert.equal(messy.errors.length, 2, 'invalid JSON and non-object JSON are reported')
  assert.match(messy.errors[0].error, /JSON|Unexpected|position|token/i)

  // Buffer input is accepted; empty/unknown input degrades to an empty result.
  const fromBuffer = parseFrames(Buffer.from(two, 'utf8'))
  assert.equal(fromBuffer.frames.length, 1)
  assert.deepEqual(parseFrames(''), { frames: [], rest: '', errors: [] })
  assert.deepEqual(parseFrames(null), { frames: [], rest: '', errors: [] })

  assert.throws(() => encodeFrame('nope'), TypeError)
  assert.throws(() => encodeFrame(null), TypeError)
})

// ---------------------------------------------------------------------------
// Path escapes
// ---------------------------------------------------------------------------

test('validateWriteRequest rejects dot-dot, absolute drives, UNC/namespace, NUL and ADS paths', () => {
  const root = tmp()
  const declared = [{ path: 'plug', reason: 'plugin dir' }]
  const base = { bufferRoot: root, declared }

  const cases = [
    ['../escape.txt', 'dotdot-segment'],
    ['plug/../../escape.txt', 'dotdot-segment'],
    ['..\\escape.txt', 'dotdot-segment'],
    ['C:\\Windows\\evil.txt', 'absolute-path'],
    ['C:evil.txt', 'absolute-path'],
    ['/etc/passwd', 'absolute-path'],
    ['\\\\server\\share\\evil.txt', 'unc-path'],
    ['//server/share/evil.txt', 'unc-path'],
    ['\\\\?\\C:\\Windows\\evil.txt', 'unc-path'],
    ['\\\\.\\pipe\\evil', 'unc-path'],
  ]
  for (const [p, reason] of cases) {
    const res = validateWriteRequest({ ...base, req: { op: 'write', path: p, data: 'x' } })
    assert.equal(res.ok, false, `path must be rejected: ${p}`)
    assert.equal(res.reason, reason, `reason for ${p}`)
  }
  assert.equal(validateWriteRequest({ ...base, req: { op: 'write', path: 'a\0b', data: 'x' } }).reason, 'bad-path')
  assert.equal(validateWriteRequest({ ...base, req: { op: 'write', path: '', data: 'x' } }).reason, 'bad-path')
  assert.equal(validateWriteRequest({ ...base, req: { op: 'write', path: 42, data: 'x' } }).reason, 'bad-path')
  assert.equal(validateWriteRequest({ ...base, req: { op: 'write', path: 'plug/a.txt:stream', data: 'x' } }).reason, 'ads-path')
  // Non-write ops are not write requests.
  assert.equal(validateWriteRequest({ ...base, req: { op: 'read', path: 'plug/a.txt' } }).reason, 'unsupported-op:read')
  assert.equal(validateWriteRequest({ ...base, req: null }).reason, 'bad-request')
  // An empty buffer root can never be written into.
  assert.equal(
    validateWriteRequest({ bufferRoot: '', declared, req: { op: 'write', path: 'plug/a.txt', data: 'x' } }).reason,
    'no-buffer-root',
  )
})

// ---------------------------------------------------------------------------
// Declared allowlist (prefix matching)
// ---------------------------------------------------------------------------

test('declared manifest is a boundary-aware prefix allowlist (and declarations normalise)', () => {
  const root = tmp()
  const declared = [
    { path: 'plug', reason: 'plugin tree' },
    { path: 'docs\\api/', reason: 'api docs' },
    { path: '..\\escape', reason: 'must be dropped' },
    { path: 'C:\\absolute', reason: 'must be dropped' },
    'single.txt',
  ]
  const norm = normalizeDeclared(declared)
  assert.deepEqual(norm.map((d) => d.path), ['plug', 'docs/api', 'single.txt'])
  assert.equal(norm[0].reason, 'plugin tree')

  const ok = (p) => validateWriteRequest({ bufferRoot: root, declared, req: { op: 'write', path: p, data: 'x' } })
  const exact = ok('plug')
  assert.equal(exact.ok, true)
  assert.equal(exact.path, 'plug')
  assert.equal(exact.declaredPath, 'plug')
  assert.equal(ok('plug/sub/deep/a.js').ok, true, 'descendant of a declared dir is allowed')
  assert.equal(ok('docs/api/readme.md').ok, true, 'backslashes in declarations normalise')
  assert.equal(ok('single.txt').ok, true, 'a declared file matches itself')
  assert.equal(ok('plugin/x.js').reason, 'not-declared', 'prefix must stop at a path boundary')
  assert.equal(ok('other.txt').reason, 'not-declared')
  assert.equal(ok('docs/apix/y.md').reason, 'not-declared')
  assert.equal(ok('../escape/x').reason, 'dotdot-segment')
  // Escaping declarations can never be matched by a safe request.
  assert.deepEqual(normalizeDeclared('nope'), [])
  assert.deepEqual(normalizeDeclared(null), [])
})

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

test('single request size cap (default 1 MiB and per-call maxBytes)', () => {
  assert.equal(DEFAULT_MAX_BYTES, 1048576)
  const root = tmp()
  const declared = [{ path: 'plug' }]
  const base = { bufferRoot: root, declared, req: { op: 'write', path: 'plug/a.txt' } }

  assert.equal(validateWriteRequest({ ...base, req: { ...base.req, data: 'x'.repeat(10) }, maxBytes: 9 }).reason, 'too-large')
  assert.equal(validateWriteRequest({ ...base, req: { ...base.req, data: 'x'.repeat(10) }, maxBytes: 10 }).ok, true)
  // base64 payloads are capped on the DECODED size, and oversized strings are rejected early.
  const b64 = Buffer.from('0123456789').toString('base64')
  assert.equal(
    validateWriteRequest({ ...base, req: { op: 'write', path: 'plug/a.bin', data: b64, encoding: 'base64' }, maxBytes: 9 }).reason,
    'too-large',
  )
  assert.equal(
    validateWriteRequest({ ...base, req: { op: 'write', path: 'plug/a.bin', data: b64, encoding: 'base64' }, maxBytes: 10 }).ok,
    true,
  )
  assert.equal(
    validateWriteRequest({ ...base, req: { op: 'write', path: 'plug/a.txt', data: '!!!!', encoding: 'base64' } }).reason,
    'bad-base64',
  )
  assert.equal(
    validateWriteRequest({ ...base, req: { op: 'write', path: 'plug/a.txt', data: 'x', encoding: 'hex' } }).reason,
    'bad-encoding',
  )
  // A 1 MiB-1 payload passes the default cap; 1 MiB+1 does not.
  assert.equal(validateWriteRequest({ ...base, req: { ...base.req, data: 'y'.repeat(DEFAULT_MAX_BYTES - 1) } }).ok, true)
  assert.equal(validateWriteRequest({ ...base, req: { ...base.req, data: 'y'.repeat(DEFAULT_MAX_BYTES + 1) } }).reason, 'too-large')
})

// ---------------------------------------------------------------------------
// Junction / symlink escape
// ---------------------------------------------------------------------------

test('junction under the buffer root is refused by the lstat/realpath parent-chain check', (t) => {
  const root = tmp()
  const outside = tmp()
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside')
  const link = path.join(root, 'link')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch (e) {
    t.skip(`cannot create junction/symlink on this host: ${e.message}`)
    return
  }
  const request = { op: 'write', path: 'link/evil.txt', data: 'pwned' }
  const declared = [{ path: 'link' }]
  const check = validateWriteRequest({ bufferRoot: root, declared, req: request })
  assert.equal(check.ok, false)
  assert.equal(check.reason, 'symlink-ancestor')
  assert.equal(check.path, 'link/evil.txt')

  const applied = applyWriteRequest({ bufferRoot: root, declared, req: request })
  assert.equal(applied.ok, false)
  assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false, 'nothing may be written through the junction')
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside', 'junction target untouched')
})

// ---------------------------------------------------------------------------
// applyWriteRequest — real writes into a temp buffer root
// ---------------------------------------------------------------------------

test('applyWriteRequest performs real atomic writes inside the buffer root only', () => {
  const root = tmp()
  const declared = [{ path: 'plug', reason: 'plugin tree' }]

  const utf8 = applyWriteRequest({
    bufferRoot: root,
    declared,
    req: { op: 'write', path: 'plug/sub/index.js', data: 'export const v = 1\n' },
  })
  assert.equal(utf8.ok, true)
  assert.equal(fs.readFileSync(utf8.target, 'utf8'), 'export const v = 1\n')
  assert.equal(utf8.target.startsWith(path.resolve(root)), true, 'target must stay inside the root')
  assert.equal(utf8.bytes, 'export const v = 1\n'.length)

  const raw = Buffer.from([0, 1, 2, 255])
  const bin = applyWriteRequest({
    bufferRoot: root,
    declared,
    req: { op: 'write', path: 'plug/sub/blob.bin', data: raw.toString('base64'), encoding: 'base64' },
  })
  assert.equal(bin.ok, true)
  assert.deepEqual([...fs.readFileSync(bin.target)], [...raw], 'base64 payload is decoded byte-for-byte')

  // Kernel-fsx style injection is preferred over the local fallback.
  const calls = []
  const viaFsx = applyWriteRequest({
    bufferRoot: root,
    declared,
    req: { op: 'write', path: 'plug/via-fsx.txt', data: 'fsx' },
    fsx: {
      writeFileAtomic(file, data) {
        calls.push([file, String(data)])
      },
    },
  })
  assert.equal(viaFsx.ok, true)
  assert.equal(calls.length, 1, 'injected fsx.writeFileAtomic is used')
  assert.equal(calls[0][1], 'fsx')

  // Invalid requests never create anything (validated again inside apply).
  const bad = applyWriteRequest({
    bufferRoot: root,
    declared,
    req: { op: 'write', path: '../t8-escape-outside.txt', data: 'nope' },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'dotdot-segment')
  assert.equal(fs.existsSync(path.join(root, '..', 't8-escape-outside.txt')), false)
  assert.equal(applyWriteRequest({ bufferRoot: root, declared, req: { op: 'write', path: 'plug/x', data: 'x' }, maxBytes: 0 }).ok, false)
})

// ---------------------------------------------------------------------------
// buffer-keeper — role gate + v1 surface preserved
// ---------------------------------------------------------------------------

test('roleGate: bufferKeeper activates only in fork and keeps the v1 surface intact', () => {
  withForkRole(() => {
    const motherCtx = makeCtx()
    process.env.DSH_FANG_ROLE = 'mother'
    try {
      const ret = bufferKeeper.apply(motherCtx, {})
      assert.equal(ret, undefined, 'mother role: apply returns without building a service')
      assert.equal(motherCtx.get(SERVICE.buffer), undefined, 'mother role: fangBuffer must not be registered')
    } finally {
      motherCtx.dispose()
      process.env.DSH_FANG_ROLE = 'fork'
    }
  })

  const { ctx, service } = newKeeper()
  try {
    assert.equal(ctx.get(SERVICE.buffer), service)
    // v1 methods: unchanged and still functions.
    for (const method of ['start', 'stop', 'state', 'flush', 'scan', 'baseline']) {
      assert.equal(typeof service[method], 'function', `v1 method preserved: ${method}`)
    }
    // v2 append-only methods.
    for (const method of ['proxyState', 'setDeclared', 'proxyWrite', 'proxyLog']) {
      assert.equal(typeof service[method], 'function', `v2 proxy method present: ${method}`)
    }
    // Config keeps the v1 defaults and adds proxy defaults.
    const cfg = bufferKeeper.Config({})
    assert.equal(cfg.settleMs, 750)
    assert.equal(cfg.watch, true)
    assert.deepEqual({ ...cfg.proxy }, { enabled: false, maxBytes: 1048576 })
    // Unstarted keeper still reports the v1 settled state and an empty proxy state.
    assert.equal(service.state().state, 'settled')
    assert.deepEqual(service.proxyState(), {
      enabled: false,
      bufferRoot: '',
      declaredCount: 0,
    })
    assert.deepEqual(service.proxyWrite({ op: 'write', path: 'plug/a.txt', data: 'x' }), { ok: false, reason: 'proxy-disabled' })
    assert.deepEqual(service.proxyLog().length, 1)
  } finally {
    ctx.dispose()
  }
})

// ---------------------------------------------------------------------------
// buffer-keeper — proxyWrite: rejects, audit, log, real write
// ---------------------------------------------------------------------------

test('proxyWrite: disabled/undeclared/escape/oversize are refused, logged and audited; a declared write lands', () => {
  const root = tmp()
  const bufferDir = path.join(root, 'buffer')
  const calls = []
  const { ctx, service } = newKeeper(
    { proxy: { enabled: true, maxBytes: 8 } },
    {
      services: {
        [SERVICE.auditor]: {
          append(kind, data) {
            calls.push({ kind, data })
            return { kind, data }
          },
        },
      },
    },
  )
  try {
    service.start({ dir: bufferDir })
    const state = service.proxyState()
    assert.equal(state.enabled, true)
    assert.equal(state.bufferRoot, path.resolve(bufferDir))
    assert.equal(state.declaredCount, 0)
    assert.equal(service.config.proxy.maxBytes, 8, 'maxBytes is exposed through config, not proxyState')

    assert.deepEqual(service.setDeclared([{ path: 'plug', reason: 'plugin' }]), { ok: true, count: 1 })
    assert.equal(service.proxyState().declaredCount, 1)
    assert.deepEqual(service.setDeclared('nope'), { ok: false, count: 1, reason: 'bad-declared' })

    assert.deepEqual(service.proxyWrite({ op: 'write', path: 'other.txt', data: 'x' }), {
      ok: false,
      reason: 'not-declared',
    })
    assert.deepEqual(service.proxyWrite({ op: 'write', path: '../t8-proxy-escape.txt', data: 'x' }), {
      ok: false,
      reason: 'dotdot-segment',
    })
    assert.deepEqual(service.proxyWrite({ op: 'write', path: 'C:\\Windows\\t8.txt', data: 'x' }), {
      ok: false,
      reason: 'absolute-path',
    })
    assert.deepEqual(service.proxyWrite({ op: 'write', path: 'plug/big.txt', data: 'x'.repeat(9) }), {
      ok: false,
      reason: 'too-large',
    })
    assert.equal(fs.existsSync(path.join(root, 't8-proxy-escape.txt')), false, 'escape attempt left no file')

    const written = service.proxyWrite({ op: 'write', path: 'plug/sub/app.js', data: 'hello\n', reqId: 'w1' })
    assert.equal(written.ok, true)
    assert.equal(written.bytes, 6)
    assert.equal(written.target.startsWith(path.resolve(bufferDir)), true)
    assert.equal(fs.readFileSync(written.target, 'utf8'), 'hello\n')

    // audit: denials are AUDIT.ROUTE decisions, the applied write is AUDIT.BUFFER_FLUSH.
    const denials = calls.filter((c) => c.kind === AUDIT.ROUTE)
    assert.equal(denials.length, 4, 'one ROUTE denial per refused request')
    assert.ok(denials.every((c) => c.data.decision === 'deny' && typeof c.data.reason === 'string'))
    const applied = calls.filter((c) => c.kind === AUDIT.BUFFER_FLUSH)
    assert.equal(applied.length, 1)
    assert.equal(applied[0].data.path, 'plug/sub/app.js')
    assert.equal(applied[0].data.bytes, 6)
    assert.equal(applied[0].data.reqId, 'w1')

    // proxyLog: newest first, includes refusals and the success.
    const log = service.proxyLog()
    assert.equal(log.length, 5, 'four refusals + one applied write')
    assert.equal(log[0].ok, true)
    assert.equal(log[0].path, 'plug/sub/app.js')
    assert.equal(log[0].bytes, 6)
    assert.equal(log[0].reason, undefined)
    assert.equal(log[log.length - 1].reason, 'not-declared', 'the first refusal is the oldest entry')
    assert.equal(log[log.length - 1].path, 'other.txt')
    assert.equal(service.proxyLog({ limit: 2 }).length, 2)
    assert.equal(service.proxyLog({ limit: 2 })[0].path, 'plug/sub/app.js')
    assert.equal(typeof service.proxyLog({ limit: 2 })[0].at, 'string')
  } finally {
    ctx.dispose()
  }
})

test('proxyWrite refuses when no buffer root is known (not started and no config root)', () => {
  const { ctx, service } = newKeeper({ proxy: { enabled: true } })
  try {
    assert.equal(service.proxyState().bufferRoot, '')
    const res = service.proxyWrite({ op: 'write', path: 'plug/a.txt', data: 'x' })
    assert.deepEqual(res, { ok: false, reason: 'no-buffer-root' })
    assert.equal(service.proxyLog()[0].reason, 'no-buffer-root')
  } finally {
    ctx.dispose()
  }
})

test('proxy uses cfg.root when the keeper has not been start()ed (config-root mode)', () => {
  const root = tmp()
  const { ctx, service } = newKeeper({ root, proxy: { enabled: true } })
  try {
    assert.equal(service.proxyState().bufferRoot, path.resolve(root))
    service.setDeclared(['plug'])
    const res = service.proxyWrite({ op: 'write', path: 'plug/a.js', data: 'cfg-root' })
    assert.equal(res.ok, true)
    assert.equal(fs.readFileSync(res.target, 'utf8'), 'cfg-root')
  } finally {
    ctx.dispose()
  }
})

test('proxyWrite survives a throwing auditor (audit must never block a write)', () => {
  const root = tmp()
  const { ctx, service } = newKeeper(
    { root, proxy: { enabled: true } },
    {
      services: {
        [SERVICE.auditor]: {
          append() {
            throw new Error('audit down')
          },
        },
      },
    },
  )
  try {
    service.setDeclared(['plug'])
    const res = service.proxyWrite({ op: 'write', path: 'plug/a.js', data: 'ok' })
    assert.equal(res.ok, true, 'a broken auditor must not break the write proxy')
    assert.equal(fs.readFileSync(res.target, 'utf8'), 'ok')
    assert.equal(service.proxyLog()[0].ok, true)
  } finally {
    ctx.dispose()
  }
})
