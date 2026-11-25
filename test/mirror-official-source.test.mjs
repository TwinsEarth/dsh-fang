// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — 官方源 manifest adapter：URL 安全、manifest 解析、安全落盘。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createManifestOfficialSource,
  safeRelativePath,
  validateOfficialSourceUrl,
} from '../src/lib/mirror-official-source.mjs'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return typeof body === 'string' ? body : JSON.stringify(body) } }
}

test('official-source: URL validation requires https for remote and rejects userinfo', () => {
  assert.equal(validateOfficialSourceUrl('http://evil.example.com').reason, 'https-required-for-remote-endpoint')
  assert.equal(validateOfficialSourceUrl('https://user:pass@example.com').reason, 'base-url-userinfo-forbidden')
  assert.equal(validateOfficialSourceUrl('').reason, 'base-url-required')
  assert.equal(validateOfficialSourceUrl('http://127.0.0.1:8080').ok, true)
  assert.equal(validateOfficialSourceUrl('https://mirror.example.com/v1').url, 'https://mirror.example.com/v1')
})

test('official-source: safeRelativePath rejects traversal/absolute/UNC/NUL', () => {
  assert.equal(safeRelativePath('../x'), null)
  assert.equal(safeRelativePath('a/../../x'), null)
  assert.equal(safeRelativePath('/etc/passwd'), null)
  assert.equal(safeRelativePath('C:/x'), null)
  assert.equal(safeRelativePath('\\\\server\\x'), null)
  assert.equal(safeRelativePath('a\0b'), null)
  assert.equal(safeRelativePath('profile/package.json'), 'profile/package.json')
})

test('official-source: fetches manifest and writes files into staging', async () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-official-'))
  const calls = []
  try {
    const source = createManifestOfficialSource({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: async (url) => {
        calls.push(url)
        return response({ version: '3.2.0', files: { 'package.json': '{"name":"profile"}', 'cordis.patch.yml': 'insert: []\n' } })
      },
      token: 'source-token',
    })
    assert.equal(await source.getLatestVersion(), '3.2.0')
    const result = await source.download('3.2.0', staging)
    assert.equal(result.files, 2)
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8')).name, 'profile')
    assert.equal(fs.readFileSync(path.join(staging, 'cordis.patch.yml'), 'utf8'), 'insert: []\n')
    assert.match(calls[0], /\/manifest\.json$/)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
})

test('official-source: rejects version mismatch and path traversal in manifest', async () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-official-bad-'))
  try {
    const mismatch = createManifestOfficialSource({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: async () => response({ version: '9.9.9', files: { 'a.txt': 'x' } }),
    })
    await assert.rejects(() => mismatch.download('3.2.0', staging), /version mismatch/)

    const traversal = createManifestOfficialSource({
      baseUrl: 'http://127.0.0.1:9999',
      fetchImpl: async () => response({ version: '3.2.0', files: { '../escape.txt': 'x' } }),
    })
    await assert.rejects(() => traversal.download('3.2.0', staging), /unsafe path/)
    assert.equal(fs.existsSync(path.join(staging, '..', 'escape.txt')), false)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
})
