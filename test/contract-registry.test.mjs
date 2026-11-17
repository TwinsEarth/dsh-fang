// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// M1：能力注册表（fang 委托层）+ hello 广告（按注册 handler）+ 版本裁剪 + 错误码表。
// 注意：vendored contract SDK 保持 1.1.0 逐字节不变；委托方法与错误码属于 fang 层。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTRACT_VERSION,
  METHODS,
  METHOD_VERSION,
  createContractServer,
  helloPayload,
  negotiate,
} from '../src/contract/index.js'
import {
  CAPABILITY_CATALOG,
  DEFAULT_READ_ALLOW,
  DELEGATE_ERROR,
  capabilityCatalog,
  checkDelegation,
} from '../src/lib/contract-delegation.mjs'

test('M1 registry: fang delegation catalog is append-only and whitelist-consistent', () => {
  // vendored contract SDK 未被手改（保持 1.1.0）
  assert.equal(CONTRACT_VERSION, '1.1.0')
  // 委托方法注册在 fang 层注册表；只读能力进默认白名单，写能力（tool.invoke）需显式放行
  assert.ok(CAPABILITY_CATALOG.length >= 6)
  const readCatalog = CAPABILITY_CATALOG.filter((item) => item.kind === 'read')
  assert.ok(readCatalog.length >= 6)
  assert.ok(readCatalog.every((item) => item.approval === 'none'))
  const writeCatalog = CAPABILITY_CATALOG.filter((item) => item.kind === 'write')
  assert.deepEqual(writeCatalog.map((item) => item.method), ['fang.tool.invoke'])
  assert.equal(writeCatalog[0].approval, 'required')
  const catalogReadMethods = readCatalog.map((item) => item.method).sort()
  assert.deepEqual([...DEFAULT_READ_ALLOW].sort(), catalogReadMethods)
  assert.ok(!DEFAULT_READ_ALLOW.includes('fang.tool.invoke'), 'write capability must not be allowed by default')
  // 未登记能力默认拒绝
  const unknown = checkDelegation({ method: 'fang.unknown.capability', config: {} })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error, DELEGATE_ERROR.UNSUPPORTED)
})

test('M1 error codes: fang delegation codes are a unique, stable append-only table', () => {
  const codes = Object.values(DELEGATE_ERROR)
  assert.deepEqual(codes.sort(), [
    'contract-approval-required',
    'contract-invalid-request',
    'contract-timeout',
    'contract-unauthorized',
    'contract-unavailable',
    'contract-unsupported',
  ])
  assert.equal(new Set(codes).size, codes.length)
})

test('M1 hello advertises fang-layer handlers registered on the contract server', () => {
  const handler = async () => ({ ok: true })
  const server = createContractServer({
    role: 'mother',
    instanceId: 'unit',
    handlers: {
      'fang.capability.list': handler,
      'fang.session.list': handler,
      'fang.orchestrator.status': handler,
    },
  })
  const hello = server.hello()
  assert.equal(hello.contractVersion, CONTRACT_VERSION)
  assert.ok(hello.methods.includes('fang.capability.list'))
  assert.ok(hello.methods.includes('fang.session.list'))
  assert.ok(!hello.methods.includes('fang.fork.spawn'), 'unregistered methods are not advertised')
})

test('M1 version trimming: a 1.0 peer is not offered 1.1 methods', () => {
  const local = helloPayload({ role: 'mother', version: '1.1.0', methods: Object.values(METHODS) })
  const remote = helloPayload({ role: 'fork', version: '1.0.0', methods: Object.values(METHODS) })
  const out = negotiate(local, remote)
  assert.equal(out.ok, true)
  assert.equal(out.version, '1.0.0')
  assert.ok(out.methods.includes(METHODS.SESSION_LIST), '1.0 methods stay')
  assert.ok(!out.methods.includes(METHODS.RELAY_PUBLISH), '1.1 relay methods are trimmed for a 1.0 peer')
})

test('M1 version trimming: a 1.1 peer sees 1.1 methods', () => {
  const local = helloPayload({ role: 'mother', version: '1.1.0', methods: Object.values(METHODS) })
  const remote = helloPayload({ role: 'fork', version: '1.1.0', methods: Object.values(METHODS) })
  const out = negotiate(local, remote)
  assert.equal(out.ok, true)
  assert.equal(out.version, '1.1.0')
  assert.ok(out.methods.includes(METHODS.RELAY_PUBLISH))
  assert.equal(METHOD_VERSION[METHODS.RELAY_PUBLISH], '1.1')
})
