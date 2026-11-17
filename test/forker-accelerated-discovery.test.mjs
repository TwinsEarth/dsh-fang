// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 回归测试（v3.5.2 真机问题）：forker 在「未显式配置 dataRoot」时也必须能从
// FANG_HOME / fang-home.txt 发现加速核安装，否则：
//   * GET /fang/api/fork-core 报 accelerated.installed=false → 面板按钮点击只弹“未安装”；
//   * 派生加速分身直接 409 accelerated-cli-missing → 无法启动。
// 同时锁定：加速档绝不把母体 stock CLI（opts.cliPath）当作加速核候选。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as forker from '../src/plugins/forker.mjs'
import { makeCtx } from './helpers.mjs'

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 假 FANG_HOME：<root>/accel/state.json + 可被 resolveAcceleratedCore 接受的 JS 入口。 */
function fakeFangHome(root, { banner = false } = {}) {
  const cliPath = path.join(root, 'accel', 'cli', 'node_modules', '@twinsearth', 'dsh', 'lib', 'bin.js')
  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  if (banner) {
    // 只有拿到 ELECTRON_RUN_AS_NODE=1 才打印 web banner：用来锁定“Electron 宿主里 JS 入口
    // 必须补回该环境变量”的回归（真机表现为加速分身 exit 0、无输出）。
    fs.writeFileSync(cliPath, [
      "if (process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(0)",
      "process.stdout.write('dsh web: http://127.0.0.1:18081/?token=test-token\\n')",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
  } else {
    fs.writeFileSync(cliPath, '// fake accelerated core entry\n')
  }
  writeJson(path.join(root, 'accel', 'cli', 'node_modules', '@twinsearth', 'dsh', 'package.json'), {
    name: '@twinsearth/dsh', version: '3.5.0', type: 'module', exports: { '.': './lib/bin.js' },
  })
  writeJson(path.join(root, 'accel', 'state.json'), {
    version: '3.5.0', cliPath, installedAt: new Date().toISOString(), spec: '@twinsearth/dsh@3.5.0',
  })
  return { root, cliPath }
}

function withEnv(vars, fn) {
  const saved = {}
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  try { return fn() } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** 母体 stock CLI 的假文件（`.cmd`，绝不能被当成加速核入口）。 */
function fakeStockCli(root) {
  const file = path.join(root, 'bin', 'dsh.cmd')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '@echo off\n')
  return file
}

test('forker: without dataRoot it still discovers the accelerated core from FANG_HOME', () => {
  const fangHome = temp('fang-home-accel-')
  const dshHome = temp('fang-home-dsh-')
  const accel = fakeFangHome(fangHome)
  withEnv({ FANG_HOME: fangHome, DSH_HOME: dshHome }, () => {
    const service = forker.apply(makeCtx(), { forkSeed: { enabled: false }, acceleratedCliPath: '' })
    assert.ok(service, 'forker service must register')
    const status = service.coreStatus()
    assert.equal(status.accelerated.installed, true, JSON.stringify(status.accelerated))
    assert.equal(status.accelerated.cliPath, accel.cliPath)
    assert.equal(status.accelerated.source, 'state', 'state.json under FANG_HOME must be discovered')
    service.dispose?.()
  })
})

test('forker: accelerated spawn ignores the mother stock CLI passed as opts.cliPath', async () => {
  const fangHome = temp('fang-home-accel-')
  const dshHome = temp('fang-home-dsh-')
  const root = temp('fang-home-work-')
  const accel = fakeFangHome(fangHome)
  const stockCli = fakeStockCli(root)
  await withEnv({ FANG_HOME: fangHome, DSH_HOME: dshHome }, async () => {
    const service = forker.apply(makeCtx(), {
      forkSeed: { enabled: false },
      acceleratedCliPath: '',
      allocatePorts: false,
      startTimeoutMs: 800,
    })
    const homeDir = path.join(root, 'homes', 'f')
    const provisioned = service.provision({ forkId: 'f', homeDir, profile: 'accel', coreMode: 'accelerated' })
    assert.equal(provisioned.ok, true, JSON.stringify(provisioned))
    const started = await service.spawn({
      forkId: 'f', homeDir, profile: 'accel', coreMode: 'accelerated',
      cliPath: stockCli, // 真实 orchestrator 会这样传；旧实现会报 not-a-js-entry → 409
    })
    assert.equal(started.ok, false)
    assert.notEqual(started.error, 'accelerated-cli-missing', `stock CLI must never be used as the accelerated candidate: ${JSON.stringify(started)}`)
    assert.equal(started.coreMode ?? 'accelerated', 'accelerated')
    service.dispose?.()
  })
})

test('forker: JS-entry accelerated child gets ELECTRON_RUN_AS_NODE=1 so it can boot under the desktop shell', async () => {
  const fangHome = temp('fang-home-accel-banner-')
  const dshHome = temp('fang-home-dsh-')
  const root = temp('fang-home-work-')
  fakeFangHome(fangHome, { banner: true })
  await withEnv({ FANG_HOME: fangHome, DSH_HOME: dshHome }, async () => {
    const service = forker.apply(makeCtx(), { forkSeed: { enabled: false }, acceleratedCliPath: '', allocatePorts: false, startTimeoutMs: 5000 })
    const homeDir = path.join(root, 'homes', 'fb')
    const provisioned = service.provision({ forkId: 'fb', homeDir, profile: 'accel-b', coreMode: 'accelerated' })
    assert.equal(provisioned.ok, true, JSON.stringify(provisioned))
    const started = await service.spawn({ forkId: 'fb', homeDir, profile: 'accel-b', coreMode: 'accelerated' })
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.match(String(started.url), /^http:\/\/127\.0\.0\.1:18081\//)
    service.stop('fb')
    service.dispose?.()
  })
})

test('forker: no accelerated install keeps the explicit fail-closed error', () => {
  const fangHome = temp('fang-home-empty-')
  const dshHome = temp('fang-home-dsh-')
  withEnv({ FANG_HOME: fangHome, DSH_HOME: dshHome }, () => {
    const service = forker.apply(makeCtx(), { forkSeed: { enabled: false }, acceleratedCliPath: '' })
    const status = service.coreStatus()
    assert.equal(status.accelerated.installed, false)
    assert.equal(status.accelerated.error, 'accelerated-cli-missing')
    service.dispose?.()
  })
})
