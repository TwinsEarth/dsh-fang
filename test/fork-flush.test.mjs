// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 关闭浏览器前 fork 会话落盘调用的 pure 测试：Bearer 鉴权 + saved/警告语义。
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveFlushEndpoint, flushResultFromResponse, flushRequestHeaders, unsavedCloseWarning } from '../src/lib/fork-flush.mjs'

test('flushRequestHeaders: adapter 只认 Authorization Bearer，不透传 query token', () => {
  assert.equal(flushRequestHeaders('secret-token').authorization, 'Bearer secret-token')
  assert.equal(flushRequestHeaders('').authorization, undefined)
  assert.deepEqual(Object.keys(flushRequestHeaders('t')).sort(), ['accept', 'authorization'])
})

test('resolveFlushEndpoint: 不把 fork URL 的 Web token 带进落盘请求', () => {
  const endpoint = resolveFlushEndpoint('http://127.0.0.1:4567/?token=web-page-token', '/fang/adapter/flush-session')
  assert.equal(endpoint.pathname, '/fang/adapter/flush-session')
  assert.equal(endpoint.searchParams.get('token'), null)
})

test('resolveFlushEndpoint: 路径自带查询参数时保留路径自己的参数', () => {
  const endpoint = resolveFlushEndpoint('http://127.0.0.1:4567/?token=web', '/fang/adapter/flush-session?mode=close')
  assert.equal(endpoint.searchParams.get('mode'), 'close')
  assert.equal(endpoint.searchParams.get('token'), null)
})

test('flushResultFromResponse: 只有显式 saved:true 才算已落盘', () => {
  assert.equal(flushResultFromResponse({ ok: true, status: 200 }, { ok: true, saved: true }).saved, true)
  assert.equal(flushResultFromResponse({ ok: true, status: 200 }, { ok: true }).saved, false)
  assert.equal(flushResultFromResponse({ ok: true, status: 204 }, null).saved, false, '空 2xx 不能推断为已保存')
  assert.equal(flushResultFromResponse({ ok: false, status: 409 }, { ok: false, saved: false }).ok, false)
  assert.equal(flushResultFromResponse({ ok: true, status: 200 }, { ok: false, saved: false }).ok, false)
})

test('unsavedCloseWarning: saved 才静默，否则必须出现“未保存强杀”并带证据', () => {
  assert.equal(unsavedCloseWarning({ saved: true, at: 1 }), null)
  const warning = unsavedCloseWarning({
    saved: false,
    at: 1,
    forkFlush: { ok: false, status: 401, saved: false, error: null, detail: 'unauthorized' },
  })
  assert.equal(warning.code, 'unsaved-force-close')
  assert.equal(warning.message, '未保存强杀')
  assert.equal(warning.detail, 'unauthorized')
  assert.equal(warning.forkFlush.status, 401)
})
