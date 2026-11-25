// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T4 — 分身看护持久化设置：默认值、写读、部分更新、非法 patch。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readForkSupervisionSettings,
  supervisionSettingsFile,
  writeForkSupervisionSettings,
} from '../src/lib/fork-supervision-settings.mjs'

test('fork-supervision-settings: defaults, write/read and partial patch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-supervision-settings-'))
  try {
    const initial = readForkSupervisionSettings(dir)
    assert.equal(initial.autostartForks, true)
    assert.equal(initial.supervise, false)
    assert.equal(initial.exists, false)

    const written = writeForkSupervisionSettings(dir, { supervise: true })
    assert.equal(written.ok, true)
    assert.equal(written.supervise, true)
    assert.equal(written.autostartForks, true, 'partial patch keeps the other flag')
    assert.equal(fs.existsSync(supervisionSettingsFile(dir)), true)

    const read = readForkSupervisionSettings(dir)
    assert.equal(read.supervise, true)
    assert.equal(read.autostartForks, true)
    assert.equal(read.exists, true)
    assert.ok(read.updatedAt > 0)

    writeForkSupervisionSettings(dir, { autostartForks: false })
    const next = readForkSupervisionSettings(dir)
    assert.equal(next.autostartForks, false)
    assert.equal(next.supervise, true, 'previous supervise preserved')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fork-supervision-settings: non-boolean patch values are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-supervision-settings-'))
  try {
    writeForkSupervisionSettings(dir, { autostartForks: 'yes', supervise: 1 })
    const read = readForkSupervisionSettings(dir)
    assert.equal(read.autostartForks, true)
    assert.equal(read.supervise, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
