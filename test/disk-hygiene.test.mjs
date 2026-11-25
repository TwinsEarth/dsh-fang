// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanupBrowserCaches, findBrowserCacheDirs, scanDiskHygiene } from '../src/lib/disk-hygiene.mjs'

function makeProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-disk-'))
  const home = path.join(root, 'task')
  const profile = path.join(home, 'browser-profile')
  fs.mkdirSync(path.join(profile, 'Default', 'Cache'), { recursive: true })
  fs.mkdirSync(path.join(profile, 'Default', 'Code Cache'), { recursive: true })
  fs.mkdirSync(path.join(profile, 'Default', 'Network'), { recursive: true })
  fs.mkdirSync(path.join(profile, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'Default', 'Cache', 'cache.bin'), Buffer.alloc(4096, 1))
  fs.writeFileSync(path.join(profile, 'Default', 'Code Cache', 'code.bin'), Buffer.alloc(2048, 2))
  fs.writeFileSync(path.join(profile, 'Default', 'Network', 'Cookies'), 'session-cookie')
  fs.writeFileSync(path.join(profile, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'login-state')
  return { root, home, profile }
}

test('disk hygiene reports browser cache size without touching cookies or local storage', () => {
  const { root, home } = makeProfile()
  const report = scanDiskHygiene({ taskHomes: [{ taskId: 'task-a', homeDir: home }] })
  assert.equal(report.browserProfiles.length, 1)
  assert.equal(report.browserProfiles[0].cacheBytes, 4096 + 2048)
  assert.deepEqual(report.browserProfiles[0].caches.map((row) => row.name).sort(), ['Cache', 'Code Cache'])
  assert.ok(fs.existsSync(path.join(home, 'browser-profile', 'Default', 'Network', 'Cookies')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('cleanup requires confirmation and moves only cache directories into recycle', () => {
  const { root, home, profile } = makeProfile()
  const recycle = path.join(root, 'recycle')
  assert.equal(cleanupBrowserCaches(home, { taskId: 'task-a', recycleDir: recycle }).error, 'confirmation-required')
  const out = cleanupBrowserCaches(home, { taskId: 'task-a', recycleDir: recycle, confirm: true })
  assert.equal(out.ok, true)
  assert.equal(out.moved, 2)
  assert.equal(out.bytes, 4096 + 2048)
  assert.equal(fs.existsSync(path.join(profile, 'Default', 'Cache')), false)
  assert.equal(fs.existsSync(path.join(profile, 'Default', 'Code Cache')), false)
  assert.ok(fs.existsSync(path.join(profile, 'Default', 'Network', 'Cookies')))
  assert.ok(fs.existsSync(path.join(profile, 'Default', 'Local Storage', 'leveldb', '000003.log')))
  assert.ok(fs.existsSync(path.join(out.recycleDir, 'Default', 'Cache', 'cache.bin')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('cache discovery stops at known cache dirs and ignores symlink-like noise', () => {
  const { root, profile } = makeProfile()
  const dirs = findBrowserCacheDirs(profile)
  assert.equal(dirs.length, 2)
  assert.ok(dirs.every((row) => row.bytes > 0))
  fs.rmSync(root, { recursive: true, force: true })
})
