// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyForkConfigLock, FORK_LOCKED_ENTRY_IDS } from '../src/lib/fork-config-lock.mjs'

const tmpProfile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-lock-'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n', 'utf8')
  return dir
}

test('fork-config-lock: 写入禁用条目且幂等', () => {
  const dir = tmpProfile()
  const first = applyForkConfigLock(dir)
  assert.equal(first.ok, true)
  assert.equal(first.entries, FORK_LOCKED_ENTRY_IDS.length)
  const text = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  for (const id of FORK_LOCKED_ENTRY_IDS) assert.match(text, new RegExp(`- id: ${id}\\n  disabled: true`))
  const second = applyForkConfigLock(dir)
  assert.equal(second.entries, 0, '第二次不得重复写入')
  assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), text)
})

test('fork-config-lock: DSH_FANG_FORK_CONFIG_LOCK=0 可关闭', () => {
  const dir = tmpProfile()
  const previous = process.env.DSH_FANG_FORK_CONFIG_LOCK
  process.env.DSH_FANG_FORK_CONFIG_LOCK = '0'
  try {
    const out = applyForkConfigLock(dir)
    assert.equal(out.skipped, true)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), '[]\n')
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_FORK_CONFIG_LOCK
    else process.env.DSH_FANG_FORK_CONFIG_LOCK = previous
  }
})
