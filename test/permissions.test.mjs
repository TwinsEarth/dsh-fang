// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.4 — 三层权限契约：矩阵、fail-closed、Guard 抛错、UI 能力摘要。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ENV_TYPE,
  PERMISSION_DENIED,
  PermissionDeniedError,
  checkPermission,
  createEnvironmentGuard,
  describePermissions,
  resolveEnvType,
} from '../src/lib/permissions.mjs'

test('permissions: 矩阵三类环境的插件/会话能力', () => {
  assert.deepEqual(describePermissions('mirror'), { envType: 'mirror', installPlugins: false, openSessions: false, known: true })
  assert.deepEqual(describePermissions('essence'), { envType: 'essence', installPlugins: true, openSessions: false, known: true })
  assert.deepEqual(describePermissions('derived'), { envType: 'derived', installPlugins: false, openSessions: true, known: true })
})

test('permissions: 母体拒绝装插件与开会话', () => {
  assert.equal(checkPermission('mirror', 'plugin-install').allowed, false)
  assert.equal(checkPermission('mirror', 'session-create').allowed, false)
  assert.equal(checkPermission('mirror', 'plugin-install').code, PERMISSION_DENIED)
})

test('permissions: 原身允许装插件、拒绝开会话', () => {
  assert.equal(checkPermission('essence', 'plugin-install').allowed, true)
  assert.equal(checkPermission('essence', 'plugin-uninstall').allowed, true)
  assert.equal(checkPermission('essence', 'session-create').allowed, false)
  assert.equal(checkPermission('essence', 'agent-run').allowed, false)
})

test('permissions: 分身允许会话、拒绝改插件', () => {
  assert.equal(checkPermission('derived', 'session-create').allowed, true)
  assert.equal(checkPermission('derived', 'chat-send').allowed, true)
  assert.equal(checkPermission('derived', 'plugin-install').allowed, false)
})

test('permissions: 未知环境 / 未知动作 fail-closed', () => {
  assert.equal(resolveEnvType('prod'), 'unknown')
  assert.equal(checkPermission('prod', 'session-create').allowed, false)
  assert.equal(checkPermission(undefined, 'plugin-install').allowed, false)
  assert.equal(checkPermission('mirror', 'delete-everything').allowed, false)
})

test('permissions: guard 的 can/check/assert', () => {
  const essence = createEnvironmentGuard(ENV_TYPE.ESSENCE)
  assert.equal(essence.can('plugin-install'), true)
  assert.equal(essence.can('session-create'), false)
  assert.throws(() => essence.assert('session-create'), (error) => {
    assert.ok(error instanceof PermissionDeniedError)
    assert.equal(error.code, PERMISSION_DENIED)
    assert.equal(error.envType, 'essence')
    assert.equal(error.action, 'session-create')
    return true
  })
  assert.equal(essence.assert('plugin-install').action, 'plugin-install')

  const unknown = createEnvironmentGuard('nope')
  assert.equal(unknown.can('session-create'), false)
  assert.throws(() => unknown.assert('session-create'), /未知环境类型/)
})

test('permissions: 错误信息带环境中文名和动作类别', () => {
  assert.match(checkPermission('mirror', 'plugin-install').message, /母体版.*插件/)
  assert.match(checkPermission('mirror', 'session-create').message, /母体版.*会话/)
  assert.match(checkPermission('derived', 'plugin-install').message, /分身版.*插件/)
  assert.match(checkPermission('essence', 'session-create').message, /原身版.*会话/)
})
