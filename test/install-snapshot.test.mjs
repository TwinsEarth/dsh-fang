// SPDX-License-Identifier: AGPL-3.0-or-later
// P2：每版本不可变 DSH 安装快照（fork 使用自己的 CLI 路径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ensureInstallSnapshot, installRootOf } from '../src/lib/install-snapshot.mjs'

test('install snapshot gives a stable per-version CLI and survives source replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-install-snapshot-'))
  try {
    const bin = path.join(root, 'resources', 'runtime', 'cli', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), '@echo off\n')
    fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'v1')
    fs.writeFileSync(path.join(root, 'DeepSeek Harness.exe'), 'exe')
    assert.equal(installRootOf(path.join(bin, 'dsh.cmd')), root)

    const first = ensureInstallSnapshot({ cliPath: path.join(bin, 'dsh.cmd'), version: '1.0.0' })
    assert.equal(first.ok, true)
    assert.notEqual(first.cliPath, path.join(bin, 'dsh.cmd'))
    assert.equal(fs.existsSync(first.cliPath), true)
    assert.equal(fs.readFileSync(path.join(first.root, 'resources', 'app.asar'), 'utf8'), 'v1')

    // 模拟安装升级：替换源文件（新 inode），旧快照必须仍解析 v1。
    fs.rmSync(path.join(root, 'resources', 'app.asar'))
    fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'v2')
    assert.equal(fs.readFileSync(path.join(first.root, 'resources', 'app.asar'), 'utf8'), 'v1')
    const second = ensureInstallSnapshot({ cliPath: path.join(bin, 'dsh.cmd'), version: '1.0.1' })
    assert.equal(second.ok, true)
    assert.notEqual(second.root, first.root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
