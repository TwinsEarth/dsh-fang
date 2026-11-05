// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.5/B1 — HTTP 鉴权：token 文件、loopback Host、Origin/CSRF、写请求 content-type。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  AUTH_HEADER, AUTH_TOKEN_FILE, authErrorBody, checkRequestAuth, createHttpGuard,
  isAllowedOrigin, isLoopbackHost, loadAuthToken,
} from '../src/lib/http-auth.mjs'
import { tmpDir } from './helpers.mjs'

const TOKEN = 'a'.repeat(64)

function req(options = {}) {
  return {
    method: options.method ?? 'GET',
    headers: {
      host: options.host ?? '127.0.0.1:53472',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.site === undefined ? {} : { 'sec-fetch-site': options.site }),
      ...(options.token === undefined ? {} : { [AUTH_HEADER]: options.token }),
      ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
    },
  }
}

test('http-auth: token 文件创建为 0600 且幂等', () => {
  const dir = tmpDir('fang-auth-')
  const first = loadAuthToken(dir, '')
  assert.ok(first.length >= 32)
  const file = path.join(dir, AUTH_TOKEN_FILE)
  assert.equal(fs.existsSync(file), true)
  const second = loadAuthToken(dir, '')
  assert.equal(second, first)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('http-auth: 合法 token + loopback Host 通过', () => {
  assert.equal(checkRequestAuth(req({ token: TOKEN }), { token: TOKEN }).ok, true)
  assert.equal(checkRequestAuth(req({ token: TOKEN, site: 'same-origin' }), { token: TOKEN }).ok, true)
})

test('http-auth: 缺 token / 错 token → 401', () => {
  assert.equal(checkRequestAuth(req(), { token: TOKEN }).status, 401)
  assert.equal(checkRequestAuth(req({ token: 'b'.repeat(64) }), { token: TOKEN }).status, 401)
})

test('http-auth: 非 loopback Host → bad-host；跨站 Origin/Sec-Fetch-Site → 403', () => {
  assert.equal(checkRequestAuth(req({ token: TOKEN, host: 'evil.example:80' }), { token: TOKEN }).code, 'bad-host')
  assert.equal(checkRequestAuth(req({ token: TOKEN, origin: 'https://evil.example' }), { token: TOKEN }).code, 'bad-origin')
  assert.equal(checkRequestAuth(req({ token: TOKEN, site: 'cross-site' }), { token: TOKEN }).code, 'cross-site')
})

test('http-auth: 写请求非 JSON content-type → 415；JSON 通过', () => {
  const text = checkRequestAuth(req({ method: 'POST', token: TOKEN, contentType: 'text/plain' }), { token: TOKEN })
  assert.equal(text.status, 415)
  const json = checkRequestAuth(req({ method: 'POST', token: TOKEN, contentType: 'application/json' }), { token: TOKEN })
  assert.equal(json.ok, true)
})

test('http-auth: publicRoute 仅跳过 token，不跳过 Host/Origin/Sec-Fetch-Site', () => {
  const pub = req({ host: '127.0.0.1:1' })
  assert.equal(checkRequestAuth(pub, { token: TOKEN, publicRoute: true }).ok, true)
  assert.equal(checkRequestAuth(req({ host: 'evil.example:1' }), { token: TOKEN, publicRoute: true }).status, 403)
  assert.equal(checkRequestAuth(req({ site: 'cross-site' }), { token: TOKEN, publicRoute: true }).status, 403)
})

test('http-auth: loopback 判定与 Origin 白名单', () => {
  for (const host of ['localhost', 'localhost:8080', '127.0.0.1:1', '[::1]:1', '[::1]', '::1']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['evil.example', '192.168.1.1:80', '']) assert.equal(isLoopbackHost(host), false, host)
  assert.equal(isAllowedOrigin(''), true)
  assert.equal(isAllowedOrigin('http://localhost:56071'), true)
  assert.equal(isAllowedOrigin('dsh-app://app'), true)
  assert.equal(isAllowedOrigin('https://evil.example'), false)
})

test('http-auth: Host 解析不接受带尾随垃圾的 loopback 前缀（DNS rebinding 绕过）', () => {
  for (const host of [
    '[::1]evil.example',
    '[::1]:3080evil',
    '[::1]:99999',
    '127.0.0.1:3080@evil.example',
    '127.0.0.1.evil.example',
    'localhost.evil.example:3080',
    'localhost:3080:evil',
  ]) {
    assert.equal(isLoopbackHost(host), false, host)
    assert.equal(
      checkRequestAuth(req({ token: TOKEN, host }), { token: TOKEN }).code,
      'bad-host',
      `${host} must be rejected as a non-loopback Host`,
    )
  }
})

test('http-auth: createHttpGuard 统一 token/env/dataDir 解析并保留 Host/Origin 校验', () => {
  const dir = tmpDir('fang-guard-')
  const guard = createHttpGuard({ dataDir: dir, token: TOKEN })
  assert.equal(guard.enabled, true)
  assert.equal(guard.token, TOKEN)
  assert.equal(guard.check(req({ token: TOKEN })).ok, true)
  assert.equal(guard.check(req()).status, 401)
  assert.equal(guard.check(req({ token: TOKEN, host: 'evil.example' })).code, 'bad-host')
  assert.equal(guard.check(req({ token: TOKEN, site: 'cross-site' })).code, 'cross-site')

  const disabled = createHttpGuard({ dataDir: dir, enabled: false })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.check(req()).ok, true, 'disabled only skips the token, not Host/Origin')
  assert.equal(disabled.check(req({ host: 'evil.example' })).code, 'bad-host')

  const explicitOnly = createHttpGuard({ token: TOKEN })
  assert.equal(explicitOnly.check(req({ token: TOKEN })).ok, true)
  assert.equal(authErrorBody({ status: 403, code: 'bad-origin' }).code, 'bad-origin')
})
