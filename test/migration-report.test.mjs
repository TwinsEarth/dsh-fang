// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MIGRATION_REPORT_MAX_CONFLICTS, readLatestMigrationReport } from '../src/lib/migration-report.mjs'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fang-migration-report-'))
}

function writeReport(root, name, report, at) {
  const dir = path.join(root, '_migration')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  if (at) fs.utimesSync(file, at, at)
  return file
}

function baseReport(overrides = {}) {
  return {
    stamp: '2026-11-24T10-00-00-000Z',
    apply: true,
    ok: true,
    target: 'D:\\ToFuture\\FangData',
    profile: 'desktop',
    dshHome: 'C:\\Users\\fangw\\.dsh',
    copied: 7,
    skipped: 2,
    conflicts: [],
    sources: [{ kind: 'dsh-home', dataDir: 'C:\\Users\\fangw\\.dsh\\fang\\desktop' }],
    files: {
      tasks: { path: 'D:\\ToFuture\\FangData\\mirror\\desktop\\tasks.json', count: 3 },
      targetFiles: 42,
      pointer: 'C:\\Users\\fangw\\.dsh\\fang\\fang-home.txt',
    },
    ...overrides,
  }
}

test('migration report reader returns the newest valid report and a bounded summary', () => {
  const root = tempRoot()
  const older = writeReport(root, 'migration-2026-11-23T10-00-00-000Z.json', baseReport({ copied: 1 }), new Date('2026-11-23T10:00:00Z'))
  const newer = writeReport(root, 'migration-2026-11-24T10-00-00-000Z.json', baseReport({ copied: 7, conflicts: ['a.txt', 'b.txt'] }), new Date('2026-11-24T10:00:00Z'))
  const out = readLatestMigrationReport(root)
  assert.equal(out.ok, true)
  assert.equal(out.found, true)
  assert.equal(out.path, newer)
  assert.equal(out.stamp, '2026-11-24T10-00-00-000Z')
  assert.equal(out.copied, 7)
  assert.equal(out.skipped, 2)
  assert.equal(out.conflictCount, 2)
  assert.deepEqual(out.conflicts, ['a.txt', 'b.txt'])
  assert.equal(out.files.tasksCount, 3)
  assert.equal(out.files.targetFiles, 42)
  assert.notEqual(out.path, older)
})

test('migration report reader falls back past a malformed newest file and caps conflicts', () => {
  const root = tempRoot()
  const valid = writeReport(root, 'migration-2026-11-24T09-00-00-000Z.json', baseReport({ conflicts: Array.from({ length: MIGRATION_REPORT_MAX_CONFLICTS + 1 }, (_, i) => `conflict-${i}.txt`) }), new Date('2026-11-24T09:00:00Z'))
  const broken = path.join(root, '_migration', 'migration-2026-11-24T11-00-00-000Z.json')
  fs.writeFileSync(broken, '{not-json')
  fs.utimesSync(broken, new Date('2026-11-24T11:00:00Z'), new Date('2026-11-24T11:00:00Z'))
  const out = readLatestMigrationReport(root)
  assert.equal(out.found, true)
  assert.equal(out.path, valid)
  assert.equal(out.conflicts.length, MIGRATION_REPORT_MAX_CONFLICTS)
  assert.equal(out.conflictCount, MIGRATION_REPORT_MAX_CONFLICTS + 1)
  assert.equal(out.truncatedConflicts, 1)
})

test('migration report reader stays quiet when the directory or files are absent', () => {
  const root = tempRoot()
  assert.equal(readLatestMigrationReport(root).found, false)
  assert.equal(readLatestMigrationReport('').found, false)
})
