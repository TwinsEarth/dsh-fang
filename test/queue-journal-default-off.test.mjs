// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 2026-11-22: queue-journal 是可选子插件，默认关闭，必须由用户手动点开。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const disabledRow = /id: fang-queue-journal[\s\S]{0,240}?disabled:\s*true/

test('queue-journal sub-plugin defaults to disabled in both bundle layers', () => {
  assert.match(read('cordis.patch.yml'), disabledRow, 'parent fang bundle must disable fang-queue-journal')
  assert.match(read('queue-journal/cordis.patch.yml'), disabledRow, 'the sub-package itself must also default to disabled when installed standalone')
})
