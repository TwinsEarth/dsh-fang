// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// M1：能力注册表（contract 1.2 append-only）+ hello 广告 + 版本裁剪 + 错误码注册。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTRACT_VERSION,
  ERROR_CODES,
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

test('M1 registry: contract 1.2 delegation methods are append-only and versioned', () => {
  assert.equal(CONTRACT_VERSION, '1.2.0')
  assert.equal(METHODS.CAPABILITY_LIST, 'fang.capability.list')
  assert.equal(METHODS.DECISION_LIST, 'fang.decision.list')
  assert.equal(METHODS.APPROVALS_LIST, 'fang.approvals.list')
  assert.equal(METHOD_VERSION[METHODS.CAPABILITY_LIST], '1.2')
  assert.equal(METHOD_VERSION[METHODS.DECISION_LIST], '1.2')
  assert.equal(METHOD_VERSION[METHODS.APPROVALS_LIST], '1.2')
  // 旧方法版本不变（append-only）
  assert.equal(METHOD_VERSION[METHODS.SESSION_LIST], '1.0')
  assert.equal(METHOD_VERSION[METHODS.RELAY_PUBLISH], '1.1')
  // 委托错误码注册进 contract SDK
  assert.equal(ERROR_CODES.CONTRACT_UNAVAILABLE, 'contract-unavailable')
  assert.equal(ERROR_CODES.CONTRACT_APPROVAL_REQUIRED, 'contract-approval-required')
  assert.equal(ERROR_CODES.CONTRACT_RATE_LIMITED, 'contract-rate-limited')
})

test('M1 registry: delegation catalog is append-only and whitelist-consistent', () => {
  assert.ok(CAPABILITY_CATALOG.length >= 8)
  const readCatalog = CAPABILITY_CATALOG.filter((item) => item.kind === 'read')
  assert.ok(readCatalog.every((item) => item.approval === 'none'))
  const writeCatalog = CAPABILITY_CATALOG.filter((item) => item.kind === 'write')
  assert.deepEqual(writeCatalog.map((item) => item.method).sort(), ['fang.chat.import', 'fang.tool.invoke'])
  assert.ok(writeCatalog.every((item) => item.approval === 'required'))
  const catalogReadMethods = readCatalog.map((item) => item.method).sort()
  assert.deepEqual([...DEFAULT_READ_ALLOW].sort(), catalogReadMethods)
  assert.ok(!DEFAULT_READ_ALLOW.includes('fang.tool.invoke'), 'write capability must not be allowed by default')
  assert.ok(!DEFAULT_READ_ALLOW.includes('fang.chat.import'), 'write capability must not be allowed by default')
  const unknown = checkDelegation({ method: 'fang.unknown.capability', config: {} })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error, DELEGATE_ERROR.UNSUPPORTED)
})

test('M1 error codes: delegation codes are registered in the contract SDK, unique and stable', () => {
  const registered = new Set(Object.values(ERROR_CODES))
  for (const code of Object.values(DELEGATE_ERROR)) assert.ok(registered.has(code), `unregistered delegation code: ${code}`)
  const codes = Object.values(DELEGATE_ERROR)
  assert.deepEqual(codes.sort(), [
    'contract-approval-required',
    'contract-invalid-request',
    'contract-rate-limited',
    'contract-timeout',
    'contract-unauthorized',
    'contract-unavailable',
    'contract-unsupported',
  ])
  assert.equal(new Set(codes).size, codes.length)
})

test('M1 hello advertises registered methods (including 1.2 delegated capabilities)', () => {
  const handler = async () => ({ ok: true })
  const server = createContractServer({
    role: 'mother',
    instanceId: 'unit',
    handlers: {
      [METHODS.CAPABILITY_LIST]: handler,
      [METHODS.SESSION_LIST]: handler,
      [METHODS.ORCHESTRATOR_STATUS]: handler,
    },
  })
  const hello = server.hello()
  assert.equal(hello.contractVersion, CONTRACT_VERSION)
  assert.ok(hello.methods.includes(METHODS.CAPABILITY_LIST))
  assert.ok(hello.methods.includes(METHODS.SESSION_LIST))
  assert.ok(!hello.methods.includes(METHODS.FORK_SPAWN), 'unregistered methods are not advertised')
})

test('M1 version trimming: a 1.1 peer is not offered 1.2 methods', () => {
  const local = helloPayload({ role: 'mother', version: '1.2.0', methods: Object.values(METHODS) })
  const remote = helloPayload({ role: 'fork', version: '1.1.0', methods: Object.values(METHODS) })
  const out = negotiate(local, remote)
  assert.equal(out.ok, true)
  assert.equal(out.version, '1.1.0')
  assert.ok(out.methods.includes(METHODS.SESSION_LIST))
  assert.ok(out.methods.includes(METHODS.RELAY_PUBLISH))
  assert.ok(!out.methods.includes(METHODS.CAPABILITY_LIST), '1.2 methods must be trimmed for a 1.1 peer')
  assert.ok(!out.methods.includes(METHODS.DECISION_LIST))
})

test('M1 version trimming: a 1.2 peer sees 1.2 methods', () => {
  const local = helloPayload({ role: 'mother', version: '1.2.0', methods: Object.values(METHODS) })
  const remote = helloPayload({ role: 'fork', version: '1.2.0', methods: Object.values(METHODS) })
  const out = negotiate(local, remote)
  assert.equal(out.ok, true)
  assert.equal(out.version, '1.2.0')
  assert.ok(out.methods.includes(METHODS.CAPABILITY_LIST))
  assert.ok(out.methods.includes(METHODS.DECISION_LIST))
  assert.ok(out.methods.includes(METHODS.APPROVALS_LIST))
})

test('M1 version trimming: a 1.0 peer still loses 1.1 relay methods', () => {
  const local = helloPayload({ role: 'mother', version: '1.2.0', methods: Object.values(METHODS) })
  const remote = helloPayload({ role: 'fork', version: '1.0.0', methods: Object.values(METHODS) })
  const out = negotiate(local, remote)
  assert.equal(out.ok, true)
  assert.equal(out.version, '1.0.0')
  assert.ok(out.methods.includes(METHODS.SESSION_LIST))
  assert.ok(!out.methods.includes(METHODS.RELAY_PUBLISH))
})
