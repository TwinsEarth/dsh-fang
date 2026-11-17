// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 回归测试：原身派生的「加速核心」分身必须同步插件面（v3.5.2 曾因 ReferenceError 静默退回 minimal）。
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

/** 最小假加速核：<root>/accel/cli/node_modules/@twinsearth/dsh/lib/bin.js */
function fakeAccelInstall(root) {
  const cliDir = path.join(root, 'accel', 'cli')
  const bin = path.join(cliDir, 'node_modules', '@twinsearth', 'dsh', 'lib', 'bin.js')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '// fake accelerated core entry\n')
  writeJson(path.join(cliDir, 'node_modules', '@twinsearth', 'dsh', 'package.json'), {
    name: '@twinsearth/dsh', version: '3.5.0', type: 'module', exports: { '.': './lib/bin.js' },
  })
  // 一个加速核侧的 client 包，供别名桩/客户端重写使用
  const localeDir = path.join(cliDir, 'node_modules', '@twinsearth', 'dsh-client-locale')
  writeJson(path.join(localeDir, 'package.json'), {
    name: '@twinsearth/dsh-client-locale', version: '3.5.0', type: 'module',
    exports: { '.': './lib/index.js', './client': './lib/client.js' },
  })
  fs.mkdirSync(path.join(localeDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(localeDir, 'lib', 'index.js'), 'export const locale = true\n')
  fs.writeFileSync(path.join(localeDir, 'lib', 'client.js'), 'export const client = true\n')
  writeJson(path.join(root, 'accel', 'state.json'), { version: '3.5.0', cliPath: bin, installedAt: new Date().toISOString() })
  return { root, cliDir, bin }
}

/** 最小“原身 merged profile”：带一个第三方插件，客户端 bundle 引用 @deepseek-ai/*。 */
function fakeSourceProfile(root) {
  const profileDir = path.join(root, 'source', 'merged', 'profile')
  writeJson(path.join(profileDir, 'package.json'), {
    name: 'dsh-profile-source',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-fang', 'third-party-plugin'] } },
  })
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: third-party-plugin\n      name: third-party-plugin\n')
  const pluginDir = path.join(profileDir, 'node_modules', 'third-party-plugin')
  writeJson(path.join(pluginDir, 'package.json'), {
    name: 'third-party-plugin',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.js', './client': './lib/client.js' },
    dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-locale'] } },
  })
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export function apply() {}\n')
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'lib', 'client.js'), "require('@deepseek-ai/dsh-client-locale')\n")
  return profileDir
}

function newService(root, cliPath) {
  const ctx = makeCtx()
  return forker.apply(ctx, {
    dataRoot: path.join(root, 'data'),
    coreMode: 'accelerated',
    acceleratedCliPath: cliPath,
    allocatePorts: false,
    startTimeoutMs: 30000,
    forkSeed: { enabled: false },
  })
}

test('forker.provision: essence-derived accelerated fork syncs the plugin surface (regression)', () => {
  const root = temp('fang-accel-sync-')
  const accel = fakeAccelInstall(root)
  const sourceProfileDir = fakeSourceProfile(root)
  const service = newService(root, accel.bin)
  const provisioned = service.provision({
    forkId: 'f-sync',
    homeDir: path.join(root, 'homes', 'f-sync'),
    profile: 'accel-sync',
    coreMode: 'accelerated',
    sourceProfileDir,
    nodeModulesSource: path.join(sourceProfileDir, 'node_modules'),
    cleanTemplate: false,
  })
  assert.equal(provisioned.ok, true, JSON.stringify(provisioned))
  assert.ok(provisioned.accelerated?.sync, 'accelerated.sync must not be null (v3.5.2 bug: silently minimal)')
  assert.deepEqual(provisioned.accelerated.sync.copiedPlugins, ['third-party-plugin'])
  const clientAlias = provisioned.accelerated.sync.clientAliases.find((item) => item.package === 'third-party-plugin')
  assert.ok(clientAlias, 'client half must be rewritten for the copied third-party plugin')
  assert.deepEqual(clientAlias.mapped.map((item) => item.to), ['@twinsearth/dsh-client-locale'])
  const forkPlugin = JSON.parse(fs.readFileSync(path.join(provisioned.profileDir, 'node_modules', 'third-party-plugin', 'package.json'), 'utf8'))
  assert.deepEqual(forkPlugin.dsh.client.inject, ['@twinsearth/dsh-client-locale'], 'inject declaration rewritten to the accelerated scope')
  const bundles = JSON.parse(fs.readFileSync(path.join(provisioned.profileDir, 'package.json'), 'utf8')).dsh.profile.bundles
  assert.ok(bundles.includes('third-party-plugin') && bundles.includes('@local/dsh-fang'), bundles.join(','))
})

test('forker.provision: source profile without a resolvable accelerated tree fails explicitly (no silent minimal)', () => {
  const root = temp('fang-accel-sync-miss-')
  const sourceProfileDir = fakeSourceProfile(root)
  // acceleratedCliPath 指向一个不存在的 JS 入口 → 解析不到加速核模块树
  const service = newService(root, path.join(root, 'nope', 'bin.js'))
  const provisioned = service.provision({
    forkId: 'f-miss',
    homeDir: path.join(root, 'homes', 'f-miss'),
    profile: 'accel-miss',
    coreMode: 'accelerated',
    sourceProfileDir,
    nodeModulesSource: path.join(sourceProfileDir, 'node_modules'),
    cleanTemplate: false,
  })
  assert.equal(provisioned.ok, false)
  assert.equal(provisioned.error, 'accelerated-sync-unavailable')
})

test('forker.provision: minimal accelerated profile (no source) still works', () => {
  const root = temp('fang-accel-min-')
  const accel = fakeAccelInstall(root)
  const service = newService(root, accel.bin)
  const provisioned = service.provision({
    forkId: 'f-min',
    homeDir: path.join(root, 'homes', 'f-min'),
    profile: 'accel-min',
    coreMode: 'accelerated',
  })
  assert.equal(provisioned.ok, true, JSON.stringify(provisioned))
  assert.equal(provisioned.accelerated.sync, null)
  assert.equal(provisioned.accelerated.bundles[0], '@twinsearth/dsh-base')
})
