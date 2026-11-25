// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — ai-secret-store：OS 钥匙串/DPAPI 持久化（不落明文）、backend 探测、失败降级。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAiSecretStore } from '../src/lib/ai-secret-store.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fang-ai-secret-'))

/** 模拟 Windows DPAPI：protect 在明文 base64 前加 ENC: 再 base64；unprotect 反向。 */
function dpapiRunner(command, args = [], input = '') {
  const script = String(args[args.length - 1] ?? '')
  if (command === 'powershell.exe') {
    if (script.includes('"ok"')) return { ok: true, status: 0, stdout: 'ok', stderr: '' }
    if (script.includes('Unprotect')) {
      const decoded = Buffer.from(input, 'base64').toString('utf8')
      const plain = decoded.startsWith('ENC:') ? decoded.slice(4) : decoded
      return { ok: true, status: 0, stdout: Buffer.from(plain, 'utf8').toString('base64'), stderr: '' }
    }
    if (script.includes('Protect')) {
      const raw = Buffer.from(input, 'base64').toString('utf8')
      return { ok: true, status: 0, stdout: Buffer.from('ENC:' + raw, 'utf8').toString('base64'), stderr: '' }
    }
  }
  return { ok: false, status: 1, stdout: '', stderr: 'unexpected command' }
}

test('ai-secret-store: DPAPI save/load/clear, never stores plaintext', () => {
  const dataDir = tmp()
  try {
    const store = createAiSecretStore({ dataDir, platform: 'win32', runner: dpapiRunner })
    assert.equal(store.available, true)
    assert.equal(store.backend, 'dpapi')
    const saved = store.save({
      provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key-0123456789abcdef',
    })
    assert.equal(saved.ok, true)
    assert.ok(fs.existsSync(path.join(dataDir, 'decision-ai-secret.json')))
    const blob = fs.readFileSync(path.join(dataDir, 'decision-ai-secret.enc'), 'utf8')
    assert.equal(blob.includes('test-key-0123456789abcdef'), false, 'blob must not contain the plaintext key')
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'decision-ai-secret.json'), 'utf8'))
    assert.equal(meta.backend, 'dpapi')
    assert.equal(meta.model, 'deepseek-flash')
    assert.equal(JSON.stringify(meta).includes('test-key-0123456789abcdef'), false, 'metadata must not contain the key')

    const loaded = store.load()
    assert.equal(loaded.apiKey, 'test-key-0123456789abcdef')
    assert.equal(loaded.provider, 'deepseek')
    assert.equal(loaded.model, 'deepseek-flash')
    assert.equal(loaded.source, 'os:dpapi')

    store.clear()
    assert.equal(fs.existsSync(path.join(dataDir, 'decision-ai-secret.json')), false)
    assert.equal(fs.existsSync(path.join(dataDir, 'decision-ai-secret.enc')), false)
    assert.equal(store.load(), null)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('ai-secret-store: unavailable backend keeps memory-only and never writes plaintext', () => {
  const dataDir = tmp()
  try {
    const store = createAiSecretStore({ dataDir, platform: 'darwin', runner: dpapiRunner })
    assert.equal(store.available, false)
    assert.equal(store.reason, 'keychain-not-implemented')
    const saved = store.save({ provider: 'deepseek', model: 'm', baseUrl: 'https://x', apiKey: 'secret-key-0123456789' })
    assert.equal(saved.ok, false)
    assert.equal(saved.reason, 'keychain-not-implemented')
    assert.equal(store.load(), null)
    assert.equal(fs.existsSync(path.join(dataDir, 'decision-ai-secret.json')), false)
    const capabilities = store.capabilities()
    assert.equal(capabilities.available, false)
    assert.equal(capabilities.encryptedAtRest, 'none')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('ai-secret-store: corrupt blob degrades to null instead of throwing', () => {
  const dataDir = tmp()
  try {
    const store = createAiSecretStore({ dataDir, platform: 'win32', runner: dpapiRunner })
    store.save({ provider: 'deepseek', model: 'm', baseUrl: 'https://x', apiKey: 'secret-key-0123456789' })
    fs.writeFileSync(path.join(dataDir, 'decision-ai-secret.enc'), 'not-a-valid-blob', 'utf8')
    assert.equal(store.load(), null)
    const brokenRunner = () => ({ ok: false, status: 1, stdout: '', stderr: 'boom' })
    const broken = createAiSecretStore({ dataDir, platform: 'win32', runner: brokenRunner })
    assert.equal(broken.load(), null, 'decrypt failure must not throw')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
