// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.1 — 镜像状态条件 GET：ETag 稳定性 + If-None-Match 匹配 + 304 响应。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMirrorStatusResponse,
  computeMirrorStatusEtag,
  ifNoneMatchMatches,
} from '../src/lib/mirror-etag.mjs'

function makeStatus(over = {}) {
  return {
    ok: true,
    currentVersion: '2.9.9',
    officialLatest: null,
    updateAvailable: false,
    meta: {
      version: '2.9.9', installedAt: 0, backupIntervalHours: 24,
      lastBackupAt: 1000, nextBackupAt: 2000,
    },
    backups: [],
    activeEssenceCount: 2,
    activeSessionCount: 5,
    diskUsageBytes: 1_000_000,
    ...over,
  }
}

test('etag: 同一稳定状态 → 相同 ETag', () => {
  assert.equal(computeMirrorStatusEtag(makeStatus()), computeMirrorStatusEtag(makeStatus({ diskUsageBytes: 9_999_999 })))
})

test('etag: diskUsageBytes 变化不改变 ETag', () => {
  const a = computeMirrorStatusEtag(makeStatus({ diskUsageBytes: 1 }))
  const b = computeMirrorStatusEtag(makeStatus({ diskUsageBytes: 2 }))
  assert.equal(a, b)
})

test('etag: 版本/备份/计数变化会改变 ETag', () => {
  const base = computeMirrorStatusEtag(makeStatus())
  assert.notEqual(base, computeMirrorStatusEtag(makeStatus({ currentVersion: '2.9.10' })))
  assert.notEqual(base, computeMirrorStatusEtag(makeStatus({
    backups: [{ id: 'b1', label: null, createdAt: 1, sizeBytes: 2, version: '2.9.9', kind: 'auto', bucket: 'backup' }],
  })))
  assert.notEqual(base, computeMirrorStatusEtag(makeStatus({ activeSessionCount: 6 })))
  assert.notEqual(base, computeMirrorStatusEtag(makeStatus({
    meta: { version: '2.9.9', installedAt: 0, backupIntervalHours: 6, lastBackupAt: 1000, nextBackupAt: 2000 },
  })))
})

test('etag: 格式为带引号的强校验器', () => {
  const etag = computeMirrorStatusEtag(makeStatus())
  assert.match(etag, /^"[0-9a-f]{24}"$/)
})

test('etag: If-None-Match 暴露多值与通配', () => {
  const etag = computeMirrorStatusEtag(makeStatus())
  assert.equal(ifNoneMatchMatches(etag, etag), true)
  assert.equal(ifNoneMatchMatches(`"other", ${etag}`, etag), true)
  assert.equal(ifNoneMatchMatches('*', etag), true)
  assert.equal(ifNoneMatchMatches(`W/${etag}`, etag), true)
  assert.equal(ifNoneMatchMatches('"other"', etag), false)
  assert.equal(ifNoneMatchMatches(undefined, etag), false)
  assert.equal(ifNoneMatchMatches('', etag), false)
})

test('etag: 未匹配 → 200 + body + ETag/Content-Length', () => {
  const status = makeStatus()
  const out = buildMirrorStatusResponse(status, undefined)
  assert.equal(out.statusCode, 200)
  assert.equal(out.notModified, false)
  assert.equal(out.etag, computeMirrorStatusEtag(status))
  assert.equal(out.headers.ETag, out.etag)
  assert.equal(out.headers['Cache-Control'], 'no-cache, must-revalidate')
  assert.equal(Number(out.headers['Content-Length']), Buffer.byteLength(out.body))
  assert.deepEqual(JSON.parse(out.body), status)
})

test('etag: 匹配 → 304 无 body（即使 diskUsageBytes 变了）', () => {
  const etag = computeMirrorStatusEtag(makeStatus())
  const out = buildMirrorStatusResponse(makeStatus({ diskUsageBytes: 42 }), etag)
  assert.equal(out.statusCode, 304)
  assert.equal(out.notModified, true)
  assert.equal(out.body, null)
  assert.equal(out.headers.ETag, etag)
})
