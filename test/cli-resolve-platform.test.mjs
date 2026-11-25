// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v3.1.33 回归：CLI 解析必须平台感知（macOS .app 的 Contents/Resources/dsh）。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

import { resolveCliPath } from '../src/plugins/orchestrator.mjs'

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('resolveCliPath: honours an explicit path that exists', () => {
  const dir = tempDir('fang-cli-')
  try {
    const fake = path.join(dir, 'dsh')
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    assert.equal(resolveCliPath(fake, {}, process.execPath), fake)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('resolveCliPath: finds a POSIX launcher on PATH (no .cmd suffix)', () => {
  const dir = tempDir('fang-cli-path-')
  try {
    const fake = path.join(dir, 'dsh')
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    const resolved = resolveCliPath('', { PATH: dir, Path: dir }, process.execPath)
    assert.equal(resolved, fake, 'must resolve the extension-less shim used on macOS/Linux')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('resolveCliPath: resolves the macOS .app Resources layout', () => {
  const root = tempDir('fang-cli-mac-')
  try {
    // <app>/Contents/MacOS/DeepSeek Harness 与 <app>/Contents/Resources/runtime/cli/bin/dsh
    const contents = path.join(root, 'DeepSeek Harness.app', 'Contents')
    const macos = path.join(contents, 'MacOS')
    const bin = path.join(contents, 'Resources', 'runtime', 'cli', 'bin')
    fs.mkdirSync(macos, { recursive: true })
    fs.mkdirSync(bin, { recursive: true })
    const exe = path.join(macos, 'DeepSeek Harness')
    fs.writeFileSync(exe, '')
    const cli = path.join(bin, 'dsh')
    fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n')

    const resolved = resolveCliPath('', { PATH: '' }, exe)
    // Windows 文件系统大小写不敏感，会用 resources；macOS 用真实的 Resources —— 两者等价。
    assert.equal(
      resolved.toLowerCase(),
      cli.toLowerCase(),
      'must walk up to Contents/Resources and find the extension-less dsh',
    )
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resolveCliPath: falls back to bare dsh instead of a Windows-only path', () => {
  const resolved = resolveCliPath('', { PATH: '' }, '/nonexistent/host/binary')
  // 允许落到 PATH 探测到的真实 dsh，或裸 'dsh'；绝不能返回 .cmd 硬编码盘符
  assert.doesNotMatch(resolved, /\.cmd$/i, 'must not fall back to a Windows-only .cmd path')
})
