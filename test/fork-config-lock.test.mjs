// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.30 回归：分身配置锁不得阻断 DSH 引导；派生必须且只能导入一个会话。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PROFILE_CONFIG_FILES,
  READONLY_LOCKED_FILES,
  applyForkConfigLock,
  setProfileConfigReadonly,
} from '../src/lib/fork-config-lock.mjs'

function withProfile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-lock-'))
  try {
    for (const name of PROFILE_CONFIG_FILES) fs.writeFileSync(path.join(dir, name), '{"name":"x"}\n', 'utf8')
    return fn(dir)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('fork-config-lock: locking must NOT make package.json read-only (DSH rewrites it on boot)', () => {
  // v3.1.28 及以前：启动时重写 package.json → EPERM → 子进程立即退出 → spawn-failed
  withProfile((dir) => {
    setProfileConfigReadonly(dir, true)
    for (const name of PROFILE_CONFIG_FILES) {
      const file = path.join(dir, name)
      const mode = fs.statSync(file).mode
      assert.notEqual(mode & 0o222, 0, `${name} must stay writable so dsh can bootstrap`)
    }
    assert.deepEqual([...READONLY_LOCKED_FILES], [], 'no profile file may be forced read-only')
  })
})

test('fork-config-lock: unlock path repairs a legacy read-only profile', () => {
  withProfile((dir) => {
    // 模拟历史版本留下的 0444
    for (const name of PROFILE_CONFIG_FILES) fs.chmodSync(path.join(dir, name), 0o444)
    const result = setProfileConfigReadonly(dir, false)
    assert.equal(result.ok, true)
    assert.ok(result.repaired.includes('package.json'), 'legacy readonly package.json must be repaired')
    for (const name of PROFILE_CONFIG_FILES) {
      assert.notEqual(fs.statSync(path.join(dir, name)).mode & 0o222, 0, `${name} must be writable after repair`)
    }
  })
})

test('fork-config-lock: behaviour lock still disables plugin manager entries', () => {
  withProfile((dir) => {
    const result = applyForkConfigLock(dir)
    const text = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(result.ok !== false, 'applyForkConfigLock must succeed')
    assert.match(text, /tool-plugin-manager/)
    assert.match(text, /ui-settings-plugin-inventory/)
    // 行为锁不能触碰文件权限
    assert.notEqual(fs.statSync(path.join(dir, 'package.json')).mode & 0o222, 0)
  })
})
