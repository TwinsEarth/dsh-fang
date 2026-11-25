// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { repairCoreUiPatchFile } from '../src/lib/core-ui-profile.mjs'
import { parsePatchEntries } from '../src/lib/essence.mjs'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-core-ui-profile-'))
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, JSON.stringify([
    { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', config: { fontSize: 17 }, disabled: true },
    { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout', disabled: true },
    { id: 'other', name: 'dsh-better-sidebar', disabled: true },
  ], null, 2), 'utf8')
  return { dir, file }
}

test('profile repair dry-run reports disabled core rows without writing', () => {
  const { dir, file } = fixture()
  const before = fs.readFileSync(file, 'utf8')
  const out = repairCoreUiPatchFile(file)
  assert.equal(out.ok, true)
  assert.equal(out.forced, 2)
  assert.equal(out.changed, false)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('profile repair applies with backup and keeps theme config', () => {
  const { dir, file } = fixture()
  const out = repairCoreUiPatchFile(file, { apply: true, now: new Date('2026-11-25T10:00:00Z') })
  assert.equal(out.ok, true)
  assert.equal(out.changed, true)
  assert.ok(out.backup && fs.existsSync(out.backup))
  const rows = parsePatchEntries(fs.readFileSync(file, 'utf8')).entries
  const theme = rows.find((row) => row.name === '@deepseek-ai/dsh-client-ui-theme')
  assert.equal(theme.disabled, false)
  assert.deepEqual(theme.config, { fontSize: 17 })
  assert.equal(rows.find((row) => row.name === 'dsh-better-sidebar').disabled, true)
  assert.equal(repairCoreUiPatchFile(file).forced, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('profile repair fails closed when the patch file is missing', () => {
  const out = repairCoreUiPatchFile('/no/such/cordis.patch.yml', { apply: true })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'patch-file-missing')
  assert.equal(out.changed, false)
})
