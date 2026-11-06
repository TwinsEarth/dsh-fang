// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T7 — forker v2 tests: deterministic port pool + clean fork template + role gate.
//
// Hard rule: a real `dsh web` is NEVER spawned here. Every test child is
// test/fixtures/t1/fake-dsh-cli.mjs, which prints the banner announced by `--port N`
// (or FAKE_DSH_PORT) and/or exits.
// Temp dirs are mkdtemp'd and removed with the junction-safe kernel removeTree().
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUDIT,
  FORK_STATUS,
  SERVICE,
  bus,
  exists,
  isLink,
  readJson,
  removeTree,
  writeJsonAtomic,
} from '../src/kernel/index.mjs'
import * as forker from '../src/plugins/forker.mjs'
import { makeCtx } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures', 't1')
const FAKE_CLI = path.join(FIXTURES, 'fake-dsh-cli.mjs')
const TEMPLATE_SRC = path.join(FIXTURES, 'mother-profile')

const tmpDirs = []
function tmp(prefix = 'fang-t7-forker-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}
function cleanupTmp() {
  for (const dir of tmpDirs.splice(0)) removeTree(dir)
}
after(cleanupTmp)

/** Build a throw-away mother profile in the temp dir (the fixture dir itself stays read-only). */
function makeTemplate(root) {
  const dir = path.join(root, 'mother-profile')
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml', 'README.md']) {
    fs.copyFileSync(path.join(TEMPLATE_SRC, name), path.join(dir, name))
  }
  fs.writeFileSync(path.join(dir, 'node_modules', 'mother-dep.txt'), 'mother-only\n')
  return dir
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check, { timeout = 5000, step = 25 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start >= timeout) return null
    await wait(step)
  }
}
function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function deadPid() {
  const child = spawnChild(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
  const pid = child.pid
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  return pid
}
function newForkContext(config = {}) {
  const ctx = makeCtx()
  const service = forker.apply(ctx, config)
  return { ctx, service }
}
const readFile = (file) => fs.readFileSync(file, 'utf8')
function readPorts(dataRoot) {
  const raw = readJson(path.join(dataRoot, 'ports.json'), null)
  if (!raw || typeof raw !== 'object') return {}
  return raw.ports && typeof raw.ports === 'object' ? raw.ports : raw
}

/** Bind test for a single port on loopback (mirrors the forker's probe contract). */
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const done = (free) => {
      if (settled) return
      settled = true
      try {
        server.close(() => {})
      } catch {
        /* ignore */
      }
      resolve(free)
    }
    server.once('error', () => done(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => done(true))
  })
}
/** Find `count` consecutive free ports inside the 18000–18100 pool. */
async function findFreeRange(count, { from = 18000, to = 18100 } = {}) {
  for (let start = from; start + count - 1 <= to; start++) {
    let ok = true
    for (let i = 0; i < count; i++) {
      if (!(await portIsFree(start + i))) {
        ok = false
        break
      }
    }
    if (ok) return start
  }
  return null
}
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(server))
  })
}
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

test('module surface + pure helpers (Config defaults / buildSpawnArgs / classifyExit / parseWebUrl)', () => {
  assert.equal(forker.name, 'fang-forker')
  assert.deepEqual(forker.inject, [])
  assert.equal(typeof forker.Config, 'function')
  assert.equal(typeof forker.apply, 'function')
  assert.equal(typeof forker.parseWebUrl, 'function')

  // v2 config contract (§5.5)
  const defaults = forker.Config({})
  assert.deepEqual(defaults.portPool, { start: 18000, end: 18100 })
  assert.equal(defaults.allocatePorts, true)
  assert.equal(defaults.cleanTemplate, true)
  assert.equal(defaults.bundleName, '@local/dsh-fang')
  assert.equal(defaults.forkProfileTag, 'web-base')

  assert.deepEqual(forker.resolvePortPool({ start: 18000, end: 18100 }), { start: 18000, end: 18100 })
  assert.equal(forker.resolvePortPool({ start: 18010, end: 18000 }), null)
  assert.equal(forker.resolvePortPool(undefined), null)

  const cleanPkg = forker.buildTemplatePackageJson({})
  assert.equal(cleanPkg.private, true)
  assert.deepEqual(cleanPkg.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@local/dsh-fang',
  ])
  assert.equal(forker.buildTemplatePackageJson({ forkProfileTag: 'alt-tag' }).name, 'dsh-fang-fork-alt-tag')

  // v1 fallback argv is preserved exactly (`--port 0`).
  assert.deepEqual(forker.buildSpawnArgs({ profile: 'web' }), ['--profile', 'web', '--port', '0', '--no-open'])
  // v2 deterministic argv.
  assert.deepEqual(forker.buildSpawnArgs({ profile: 'web', port: 18042 }), [
    '--profile', 'web', '--port', '18042', '--no-open',
  ])
  assert.equal(forker.buildSpawnArgs({ profile: 'web', noOpen: false }).includes('--no-open'), false)
  assert.deepEqual(forker.buildSpawnArgs({ profile: 'dev', port: 0 }), ['--profile', 'dev', '--port', '0', '--no-open'])

  const normal = forker.classifyExit(0)
  assert.equal(normal.kind, 'normal')
  assert.equal(normal.restartRequested, false)
  const restart = forker.classifyExit(75)
  assert.equal(restart.kind, 'restart-request')
  assert.equal(restart.restartRequested, true)
  assert.equal(restart.code, 75)
  assert.equal(forker.classifyExit(3).kind, 'crash')
  assert.equal(forker.classifyExit(null, 'SIGKILL').kind, 'crash')

  const parsed = forker.parseWebUrl('boot\ndsh web: http://127.0.0.1:60001/?token=abc\n')
  assert.ok(parsed)
  assert.equal(parsed.url, 'http://127.0.0.1:60001/?token=abc')
  assert.equal(parsed.port, 60001)
  assert.equal(parsed.token, 'abc')
  assert.equal(forker.parseWebUrl('no banner here'), null)
  assert.equal(forker.parseWebUrl('dsh web: http://127.0.0.1:1/ no-token'), null, 'a tokenless banner is not usable')
})

test('launch spec: .cmd needs shell:true, .exe spawns directly, .mjs goes through node', () => {
  // Pure assertions only — a .cmd launcher is never executed in tests.
  assert.equal(forker.isShellLauncher('C:\\bin\\dsh.cmd'), true)
  assert.equal(forker.isShellLauncher('C:\\bin\\dsh.BAT'), true)
  assert.equal(forker.isShellLauncher('C:\\bin\\dsh.exe'), false)
  assert.equal(forker.isShellLauncher('C:\\bin\\dsh.mjs'), false)

  const args = forker.buildSpawnArgs({ profile: 'web' })
  const cmd = forker.buildLaunchSpec({ cliPath: 'C:\\bin\\dsh.cmd', profile: 'web' })
  assert.equal(cmd.shell, true)
  assert.equal(cmd.command, 'C:\\bin\\dsh.cmd')
  assert.deepEqual(cmd.args, args)
  assert.equal(cmd.windowsHide, true)

  const exe = forker.buildLaunchSpec({ cliPath: 'C:\\bin\\dsh.exe', profile: 'web' })
  assert.equal(exe.shell, false)
  assert.equal(exe.command, 'C:\\bin\\dsh.exe')
  assert.deepEqual(exe.args, args)

  const viaNode = forker.buildLaunchSpec({ cliPath: 'C:\\bin\\dsh.mjs', profile: 'web' })
  assert.equal(viaNode.shell, false)
  assert.equal(viaNode.command, process.execPath)
  assert.equal(viaNode.args[0], 'C:\\bin\\dsh.mjs')
  assert.deepEqual(viaNode.args.slice(1), args)

  // v2: the allocated pool port is what reaches argv.
  const viaNodePort = forker.buildLaunchSpec({ cliPath: 'C:\\bin\\dsh.mjs', profile: 'web', port: 18042 })
  assert.deepEqual(viaNodePort.args.slice(1), ['--profile', 'web', '--port', '18042', '--no-open'])
})

test('fake CLI echoes --port N, reports fork identity env, and stays scan-safe', async () => {
  // `node --test` (bare) discovers every file under test/, fixture scripts included.
  // Without the scan guard the always-alive fake CLI would hang the whole test scan.
  const bare = await new Promise((resolve) => {
    const child = spawnChild(process.execPath, [FAKE_CLI], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.once('error', () => resolve({ code: null, out }))
    child.once('exit', (code) => resolve({ code, out }))
  })
  assert.equal(bare.code, 0, 'a discovered fixture must never keep the test scan alive')
  assert.match(bare.out, /not launched by fang-forker/)

  // Launched the way the forker does it: echo the deterministic --port and the injected env.
  const child = spawnChild(
    process.execPath,
    [FAKE_CLI, '--profile', 'web', '--port', '18042', '--no-open'],
    {
      env: { ...process.env, FAKE_DSH_MODE: 'ok', FAKE_DSH_PORT: undefined, DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: 'task-x' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
  })
  try {
    const seen = await waitFor(() => out.includes('dsh web:'))
    assert.ok(seen, `banner was not printed; output: ${out}`)
    assert.match(out, /dsh web: http:\/\/127\.0\.0\.1:18042\/\?token=fake-token/)
    assert.match(out, /fake-dsh role=fork task=task-x/)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }
})

test('roleGate: forker is mother-only — no service and no directories in a fork', () => {
  const root = tmp()
  const dataRoot = path.join(root, 'data')
  const previous = process.env.DSH_FANG_ROLE
  try {
    // fork role (env wins): apply() must return before registering anything.
    process.env.DSH_FANG_ROLE = 'fork'
    const forkCtx = makeCtx()
    const forkService = forker.apply(forkCtx, { dataRoot })
    assert.equal(forkService, undefined)
    assert.equal(forkCtx.get(SERVICE.forker), undefined, 'a fork must never register the mother-only forker')
    assert.equal(exists(dataRoot), false, 'a fork must not create the mother data dir')
    forkCtx.dispose()

    // config-level role also gates when no env override is present.
    delete process.env.DSH_FANG_ROLE
    const cfgRoleCtx = makeCtx()
    assert.equal(forker.apply(cfgRoleCtx, { role: 'fork', dataRoot }), undefined)
    assert.equal(cfgRoleCtx.get(SERVICE.forker), undefined)
    cfgRoleCtx.dispose()

    // mother role: registers normally.
    const motherCtx = makeCtx()
    const service = forker.apply(motherCtx, { dataRoot })
    assert.ok(service)
    assert.equal(service.role, 'mother')
    assert.equal(motherCtx.get(SERVICE.forker), service)
    motherCtx.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
})

test('apply registers fangForker and an empty registry reports clean failures', () => {
  const root = tmp()
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot })
  try {
    assert.equal(ctx.get(SERVICE.forker), service)
    for (const method of [
      'provision', 'spawn', 'stop', 'reap', 'status', 'list', 'logs', 'adapterToken',
      'getToken', 'onTokenRefresh',
      'allocatePort', 'releasePort', 'ensureTemplate', 'health', 'recover',
    ]) {
      assert.equal(typeof service[method], 'function', `missing service.${method}`)
    }
    assert.equal(service.role, 'mother')
    assert.deepEqual(service.portPool(), { start: 18000, end: 18100 })
    assert.deepEqual(service.ports(), {})
    assert.deepEqual(service.list(), [])
    assert.equal(service.status('missing').running, false)
    assert.equal(service.status('missing').error, 'not-found')
    assert.equal(service.logs('missing'), '')
    assert.equal(service.stop('missing').ok, false)
    assert.equal(service.reap('missing').ok, false)
    // apply() must not write the registry or the port table eagerly.
    assert.equal(exists(path.join(dataRoot, 'forks.json')), false)
    assert.equal(exists(path.join(dataRoot, 'ports.json')), false)
  } finally {
    ctx.dispose()
  }
})

test('provision in cleanTemplate mode builds the fork profile from a forker-owned clean template', () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const { ctx, service } = newForkContext()
  try {
    const result = service.provision({
      forkId: 'f-clean',
      taskTitle: 'clean fork',
      homeDir,
      profile: 'web',
      profileTemplate: template,
    })
    assert.equal(result.ok, true)
    assert.equal(result.forkId, 'f-clean')
    assert.equal(result.profile, 'web')
    assert.equal(result.template, path.join(homeDir, 'templates', 'web-base'), 'clean template lives inside the fork home')
    assert.ok(exists(result.template))
    assert.deepEqual(fs.readdirSync(result.template).sort(), ['cordis.patch.yml', 'cordis.yml', 'node_modules', 'package.json'])
    assert.deepEqual(result.warnings, [])

    const pkg = JSON.parse(readFile(path.join(result.profileDir, 'package.json')))
    assert.equal(pkg.private, true)
    assert.equal(typeof pkg.name, 'string')
    assert.deepEqual(pkg.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@local/dsh-fang',
    ])
    assert.equal(pkg.dependencies, undefined, 'mother dependencies must never leak into a clean fork profile')
    assert.equal(readFile(path.join(result.profileDir, 'cordis.yml')).trim(), '[]')
    const forkPatch = readFile(path.join(result.profileDir, 'cordis.patch.yml'))
    assert.match(forkPatch, /^# fang: fork is production-only/)
    assert.doesNotMatch(forkPatch, /^\s*\[\s*\]\s*$/m, '空数组必须被移除，否则 YAML 非法')
    assert.match(forkPatch, /id: plugin-manager/)
    assert.match(forkPatch, /id: ui-settings/)
    assert.equal(isLink(path.join(result.profileDir, 'node_modules')), true, 'node_modules must be a junction to the mother modules')
    assert.equal(exists(path.join(result.profileDir, 'README.md')), false, 'only package.json + cordis*.yml are cloned')
    assert.ok(result.cloned.includes('package.json'))
    assert.ok(result.cloned.includes('cordis.yml'))
    assert.ok(result.cloned.includes('cordis.patch.yml'))
    assert.ok(result.bufferDir && exists(result.bufferDir), 'bufferDir must exist')

    // The mother profile is read, never written.
    assert.equal(JSON.parse(readFile(path.join(template, 'package.json'))).name, 'mother-profile-fixture')
    assert.equal(exists(path.join(template, 'cordis.yml')), false)

    // Re-provisioning the same fork is idempotent.
    const again = service.provision({ forkId: 'f-clean', homeDir, profile: 'web', profileTemplate: template })
    assert.equal(again.ok, true)
    assert.equal(again.template, result.template)
    assert.equal(service.list().length, 1)
    assert.equal(service.status('f-clean').template, result.template)
  } finally {
    ctx.dispose()
  }
})

test('provision with cleanTemplate=false keeps the v1 clone-from-profileTemplate behaviour', () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const { ctx, service } = newForkContext({ cleanTemplate: false })
  try {
    const result = service.provision({
      forkId: 'f-legacy',
      taskTitle: 'legacy fork',
      homeDir,
      profile: 'web',
      profileTemplate: template,
    })
    assert.equal(result.ok, true)
    assert.equal(result.template, path.resolve(template), 'legacy mode clones straight from profileTemplate')
    assert.equal(JSON.parse(readFile(path.join(result.profileDir, 'package.json'))).name, 'mother-profile-fixture')
    assert.equal(exists(path.join(result.profileDir, 'README.md')), false)
    assert.equal(isLink(path.join(result.profileDir, 'node_modules')), true)
    assert.deepEqual(result.warnings, [])
    assert.ok(result.cloned.includes('package.json'))
    assert.ok(result.cloned.includes('cordis.patch.yml'))

    const again = service.provision({ forkId: 'f-legacy', homeDir, profile: 'web', profileTemplate: template })
    assert.equal(again.ok, true)
    assert.equal(again.profileDir, result.profileDir)
    assert.equal(service.list().length, 1)
    assert.equal(service.status('f-legacy').status, FORK_STATUS.PROVISIONING)
  } finally {
    ctx.dispose()
  }
})

test('provision failure paths + node_modules degradation in both template modes', () => {
  const root = tmp()
  const template = makeTemplate(root)
  const bare = path.join(root, 'bare-profile')
  fs.mkdirSync(bare, { recursive: true })
  fs.writeFileSync(path.join(bare, 'package.json'), '{"name":"bare"}\n')

  const legacy = newForkContext({ cleanTemplate: false })
  try {
    assert.equal(legacy.service.provision({ profileTemplate: template }).error, 'no-home-dir')
    assert.equal(legacy.service.provision({ homeDir: path.join(root, 'h') }).error, 'no-profile-template')
    const missing = legacy.service.provision({ homeDir: path.join(root, 'h2'), profileTemplate: path.join(root, 'nope') })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'profile-template-missing')

    const degraded = legacy.service.provision({
      forkId: 'f-degraded',
      homeDir: path.join(root, 'home-legacy'),
      profile: 'dev',
      profileTemplate: bare,
    })
    assert.equal(degraded.ok, true)
    assert.equal(degraded.node_modules, null)
    assert.ok(degraded.warnings.includes('node-modules-missing'))
    assert.equal(exists(path.join(degraded.profileDir, 'package.json')), true)
    assert.equal(JSON.parse(readFile(path.join(degraded.profileDir, 'package.json'))).name, 'bare')
  } finally {
    legacy.ctx.dispose()
  }

  const clean = newForkContext()
  try {
    const degraded = clean.service.provision({
      forkId: 'f-clean-degraded',
      homeDir: path.join(root, 'home-clean'),
      profile: 'dev',
      profileTemplate: bare,
    })
    assert.equal(degraded.ok, true, 'missing node_modules source still provisions (warning only)')
    assert.equal(degraded.node_modules, null)
    assert.deepEqual(degraded.warnings, ['node-modules-source-missing'])
    assert.equal(isLink(path.join(degraded.profileDir, 'node_modules')), false)
    assert.deepEqual(
      JSON.parse(readFile(path.join(degraded.profileDir, 'package.json'))).dsh.profile.bundles,
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-fang'],
    )
  } finally {
    clean.ctx.dispose()
  }
})

test('ensureTemplate writes the clean profile contract and is idempotent', () => {
  const root = tmp()
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot, bundleName: '@local/custom-bundle' })
  try {
    const modules = path.join(root, 'modules-src')
    fs.mkdirSync(modules, { recursive: true })
    fs.writeFileSync(path.join(modules, 'dep.txt'), 'x\n')
    const dir = path.join(root, 'clean-template')

    const out = service.ensureTemplate({ templateDir: dir, nodeModulesSource: modules })
    assert.equal(out.ok, true)
    assert.equal(out.dir, path.resolve(dir))
    assert.deepEqual(out.files, ['package.json', 'cordis.yml', 'cordis.patch.yml', 'node_modules'])
    assert.deepEqual(out.warnings, [])

    const pkg = JSON.parse(readFile(path.join(dir, 'package.json')))
    assert.equal(pkg.private, true)
    assert.equal(typeof pkg.name, 'string')
    assert.deepEqual(pkg.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@local/custom-bundle',
    ])
    assert.equal(readFile(path.join(dir, 'cordis.yml')).trim(), '[]')
    assert.equal(readFile(path.join(dir, 'cordis.patch.yml')).trim(), '[]')
    assert.equal(isLink(path.join(dir, 'node_modules')), true)
    assert.equal(
      path.resolve(fs.realpathSync(path.join(dir, 'node_modules'))).toLowerCase(),
      path.resolve(fs.realpathSync(modules)).toLowerCase(),
      'node_modules must junction to nodeModulesSource',
    )

    // Idempotent: the same call is a no-op success (no nested junction, no throw).
    const again = service.ensureTemplate({ templateDir: dir, nodeModulesSource: modules })
    assert.equal(again.ok, true)
    assert.equal(isLink(path.join(dir, 'node_modules')), true)
    assert.equal(JSON.parse(readFile(path.join(dir, 'package.json'))).private, true)

    // Absent node_modules source degrades with the contract warning.
    const bareOut = service.ensureTemplate({ templateDir: path.join(root, 'template-no-modules') })
    assert.equal(bareOut.ok, true)
    assert.deepEqual(bareOut.warnings, ['node-modules-source-missing'])
    assert.equal(bareOut.files.includes('node_modules'), false)

    // No templateDir is a hard error.
    const noDir = service.ensureTemplate({})
    assert.equal(noDir.ok, false)
    assert.equal(noDir.error, 'no-template-dir')

    // forkProfileTag drives the clean package name.
    const alt = newForkContext({ forkProfileTag: 'alt-tag' })
    try {
      const altOut = alt.service.ensureTemplate({ templateDir: path.join(root, 'alt-template') })
      assert.equal(altOut.ok, true)
      assert.equal(JSON.parse(readFile(path.join(altOut.dir, 'package.json'))).name, 'dsh-fang-fork-alt-tag')
    } finally {
      alt.ctx.dispose()
    }
  } finally {
    ctx.dispose()
  }
})

test('allocatePort hands out unique in-pool ports, persists the table and releases on demand', async () => {
  const root = tmp()
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot })
  try {
    const a = await service.allocatePort()
    const b = await service.allocatePort()
    const c = await service.allocatePort()
    for (const res of [a, b, c]) {
      assert.equal(res.ok, true)
      assert.equal(Number.isInteger(res.port), true)
      assert.ok(res.port >= 18000 && res.port <= 18100, `port ${res.port} must be inside the pool`)
      assert.equal(res.reason, '')
    }
    assert.equal(new Set([a.port, b.port, c.port]).size, 3, 'allocated ports must be unique')

    assert.ok(exists(path.join(dataRoot, 'ports.json')))
    const saved = readPorts(dataRoot)
    assert.equal(Object.keys(saved).length, 3)
    for (const res of [a, b, c]) {
      const row = saved[String(res.port)]
      assert.equal(row.pid, null)
      assert.equal(typeof row.at, 'string')
      assert.ok('forkId' in row)
    }

    const released = service.releasePort(b.port)
    assert.equal(released.ok, true)
    assert.equal(released.port, b.port)
    assert.equal(released.released, true)
    assert.equal(Object.keys(readPorts(dataRoot)).length, 2)
    assert.equal(service.releasePort(b.port).released, false, 'releasing twice is idempotent')

    const d = await service.allocatePort()
    assert.equal(d.ok, true)
    assert.ok(d.port >= 18000 && d.port <= 18100)
    assert.notEqual(d.port, a.port)
    assert.notEqual(d.port, c.port)

    assert.equal(service.releasePort('not-a-port').ok, false)
    assert.equal(service.releasePort(a.port).released, true)
    assert.equal(service.releasePort(c.port).released, true)
    assert.equal(service.releasePort(d.port).released, true)
    assert.deepEqual(readPorts(dataRoot), {})
  } finally {
    ctx.dispose()
  }
})

test('allocatePort skips an OS-occupied port and reports port-exhausted', async () => {
  const root = tmp()
  const dataRoot = path.join(root, 'data')
  const base = await findFreeRange(1)
  assert.ok(base, 'needs one free port inside 18000–18100')
  const held = await listenOn(base)
  const { ctx, service } = newForkContext({ dataRoot, portPool: { start: base, end: base } })
  try {
    const busy = await service.allocatePort()
    assert.equal(busy.ok, false, 'a port that cannot be bound must not be allocated')
    assert.equal(busy.error, 'port-exhausted')
    assert.equal(busy.port, null)
    assert.deepEqual(busy.pool, { start: base, end: base })

    await closeServer(held)
    const free = await service.allocatePort()
    assert.equal(free.ok, true)
    assert.equal(free.port, base)

    // The single-port pool is now registered: the next attempt is exhausted without probing.
    const again = await service.allocatePort()
    assert.equal(again.ok, false)
    assert.equal(again.error, 'port-exhausted')
    assert.equal(service.releasePort(free.port).released, true)
  } finally {
    ctx.dispose()
    await closeServer(held)
  }
})

test('startup reclaims ports held by dead / pid-less entries and keeps live ones', async () => {
  const root = tmp()
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(dataRoot, { recursive: true })
  const base = await findFreeRange(3)
  assert.ok(base, 'needs three free ports inside 18000–18100')
  const dead = await deadPid()
  assert.ok(dead > 0)
  const at = new Date().toISOString()
  writeJsonAtomic(path.join(dataRoot, 'ports.json'), {
    [String(base)]: { forkId: 'dead-fork', pid: dead, at },
    [String(base + 1)]: { forkId: 'pending-fork', pid: null, at },
    [String(base + 2)]: { forkId: 'alive-fork', pid: process.pid, at },
  })

  const { ctx, service } = newForkContext({ dataRoot, portPool: { start: base, end: base + 2 } })
  try {
    const alloc = await service.allocatePort()
    assert.equal(alloc.ok, true)
    assert.equal(alloc.port, base, 'the lowest reclaimed port is reused')

    const saved = readPorts(dataRoot)
    assert.equal(saved[String(base + 1)], undefined, 'a pid-less reservation from a dead mother is reclaimed')
    assert.equal(saved[String(base)].forkId, '')
    assert.equal(saved[String(base + 2)].forkId, 'alive-fork', 'a live process keeps its port')
    assert.equal(service.releasePort(base).released, true)
  } finally {
    ctx.dispose()
  }
})

test('spawn allocates a pool port, passes --port N, validates the URL port and releases on stop', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot })
  const started = []
  const off = bus.on('fang/fork-started', (payload) => started.push(payload))
  try {
    assert.equal(service.provision({ forkId: 'f-alloc', homeDir, profile: 'web', profileTemplate: template }).ok, true)
    const res = await service.spawn({
      forkId: 'f-alloc',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, true)
    assert.equal(res.forkId, 'f-alloc')
    assert.ok(res.pid > 0)
    assert.equal(Number.isInteger(res.port), true)
    assert.ok(res.port >= 18000 && res.port <= 18100, `allocated port ${res.port} must be inside the pool`)
    assert.equal(res.allocatedPort, res.port)
    assert.equal(res.token, 'fake-token')
    assert.equal(res.url, `http://127.0.0.1:${res.port}/?token=fake-token`)

    const status = service.status('f-alloc')
    assert.equal(status.running, true)
    assert.equal(status.port, res.port)
    assert.equal(status.template, path.join(homeDir, 'templates', 'web-base'))
    const text = service.logs('f-alloc', 10)
    assert.ok(text.includes(`--profile web --port ${res.port} --no-open`), 'the deterministic --port must reach the child')
    assert.ok(text.includes('fake-dsh role=fork task=f-alloc'), 'fork identity env must reach the child')
    assert.ok(text.includes(`home=${homeDir}`), 'DSH_HOME must reach the child env')

    const saved = readPorts(dataRoot)
    assert.ok(saved[String(res.port)], 'the running fork owns a persisted pool slot')
    assert.equal(saved[String(res.port)].forkId, 'f-alloc')
    assert.equal(saved[String(res.port)].pid, res.pid)

    assert.equal(started.length, 1)
    assert.deepEqual(started[0], { forkId: 'f-alloc', pid: res.pid, port: res.port })

    const stopped = service.stop('f-alloc')
    assert.equal(stopped.ok, true)
    assert.equal(stopped.killed, true)
    assert.equal(service.status('f-alloc').running, false)
    assert.equal(Object.prototype.hasOwnProperty.call(readPorts(dataRoot), String(res.port)), false, 'stop releases the port')
    assert.equal(await waitFor(() => !isPidAlive(res.pid)), true, 'stopped child must really exit')
  } finally {
    off()
    ctx.dispose()
  }
})

test('allocatePorts=false keeps the v1 --port 0 behaviour and never touches the pool', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot, allocatePorts: false })
  try {
    assert.equal(service.provision({ forkId: 'f-v1port', homeDir, profile: 'web', profileTemplate: template }).ok, true)
    const res = await service.spawn({
      forkId: 'f-v1port',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok', FAKE_DSH_PORT: '54321' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, true)
    assert.equal(res.port, 54321)
    assert.equal(res.allocatedPort, undefined, 'no deterministic port is claimed in v1 mode')
    assert.ok(service.logs('f-v1port', 10).includes('--profile web --port 0 --no-open'))
    assert.equal(exists(path.join(dataRoot, 'ports.json')), false, 'the v1 fallback never writes the port table')
    service.stop('f-v1port')
    assert.equal(await waitFor(() => !isPidAlive(res.pid)), true)
  } finally {
    ctx.dispose()
  }
})

test('spawn honours an explicit port option and reserves it until stop', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const explicitPort = await findFreeRange(1)
  assert.ok(explicitPort, 'needs one free port inside 18000–18100')
  const { ctx, service } = newForkContext({ dataRoot })
  try {
    assert.equal(service.provision({ forkId: 'f-explicit', homeDir, profile: 'web', profileTemplate: template }).ok, true)
    const res = await service.spawn({
      forkId: 'f-explicit',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      port: explicitPort,
      env: { FAKE_DSH_MODE: 'ok' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, true)
    assert.equal(res.port, explicitPort)
    assert.equal(res.allocatedPort, explicitPort)
    const saved = readPorts(dataRoot)
    assert.equal(saved[String(explicitPort)].pid, res.pid)
    service.stop('f-explicit')
    assert.equal(Object.prototype.hasOwnProperty.call(readPorts(dataRoot), String(explicitPort)), false)
    assert.equal(await waitFor(() => !isPidAlive(res.pid)), true)
  } finally {
    ctx.dispose()
  }
})

test('spawn detects a URL port that contradicts --port and stops the child (port-mismatch)', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot })
  try {
    assert.equal(service.provision({ forkId: 'f-mismatch', homeDir, profile: 'web', profileTemplate: template }).ok, true)
    const res = await service.spawn({
      forkId: 'f-mismatch',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok', FAKE_DSH_PORT: '54399' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'port-mismatch')
    assert.equal(Number.isInteger(res.expectedPort), true)
    assert.ok(res.expectedPort >= 18000 && res.expectedPort <= 18100)
    assert.equal(res.port, 54399, 'the port the child actually printed')
    assert.ok(res.pid > 0)
    assert.equal(service.status('f-mismatch').running, false)
    assert.equal(service.status('f-mismatch').lastError, 'port-mismatch')
    assert.equal(
      Object.prototype.hasOwnProperty.call(readPorts(dataRoot), String(res.expectedPort)),
      false,
      'a mismatched fork must release its reserved pool port',
    )
    assert.equal(await waitFor(() => !isPidAlive(res.pid)), true, 'a mismatched child must be stopped')
  } finally {
    ctx.dispose()
  }
})

test('spawn parses a banner that is split across stdout chunks', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const { ctx, service } = newForkContext({ allocatePorts: false })
  try {
    service.provision({ forkId: 'f-split', homeDir, profile: 'web', profileTemplate: template })
    const res = await service.spawn({
      forkId: 'f-split',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'split', FAKE_DSH_PORT: '54322' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, true)
    assert.equal(res.port, 54322)
    assert.match(res.url, /token=split-token$/)
    assert.equal(res.token, 'split-token')
    service.stop('f-split')
  } finally {
    ctx.dispose()
  }
})

test('spawn timeout kills the child, releases its pool port and returns {ok:false,error:"timeout"}', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot })
  try {
    service.provision({ forkId: 'f-timeout', homeDir, profile: 'web', profileTemplate: template })
    const started = Date.now()
    const res = await service.spawn({
      forkId: 'f-timeout',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'silent' },
      timeoutMs: 300,
    })
    const elapsed = Date.now() - started
    assert.equal(res.ok, false)
    assert.equal(res.error, 'timeout')
    assert.equal(res.timeoutMs, 300)
    assert.ok(res.pid > 0)
    assert.ok(elapsed >= 250, `timeout must actually wait (elapsed=${elapsed}ms)`)
    assert.equal(service.status('f-timeout').running, false)
    assert.equal(service.status('f-timeout').lastError, 'timeout')
    assert.deepEqual(readPorts(dataRoot), {}, 'a timed-out fork must release its reserved port')
    assert.equal(await waitFor(() => !isPidAlive(res.pid)), true, 'timed-out child must be killed')
  } finally {
    ctx.dispose()
  }
})

test('spawn reports crash / guard-request exits through classifyExit and the event bus', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const { ctx, service } = newForkContext()
  const crashed = []
  const off = bus.on('fang/fork-crashed', (payload) => crashed.push(payload))
  try {
    service.provision({ forkId: 'f-crash', homeDir, profile: 'web', profileTemplate: template })
    const crash = await service.spawn({
      forkId: 'f-crash',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'crash' },
      timeoutMs: 8000,
    })
    assert.equal(crash.ok, false)
    assert.equal(crash.error, 'exited')
    assert.equal(crash.code, 3)
    assert.equal(crash.kind, 'crash')
    const crashStatus = service.status('f-crash')
    assert.equal(crashStatus.running, false)
    assert.equal(crashStatus.status, FORK_STATUS.CRASHED)
    assert.equal(crashStatus.exit.kind, 'crash')

    service.provision({ forkId: 'f-restart', homeDir, profile: 'web', profileTemplate: template })
    const restart = await service.spawn({
      forkId: 'f-restart',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'restart' },
      timeoutMs: 8000,
    })
    assert.equal(restart.ok, false)
    assert.equal(restart.code, 75)
    assert.equal(restart.kind, 'restart-request')

    assert.equal(crashed.length, 2)
    assert.equal(crashed[0].forkId, 'f-crash')
    assert.equal(crashed[0].kind, 'crash')
    assert.equal(crashed[1].kind, 'restart-request')
  } finally {
    off()
    ctx.dispose()
  }
})

test('spawn rejects missing CLI/home, duplicate running forks and maxForks overflow', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ maxForks: 1, dataRoot })
  try {
    service.provision({ forkId: 'f-limit', homeDir, profile: 'web', profileTemplate: template })
    const noCli = await service.spawn({ forkId: 'f-limit', homeDir, profile: 'web', cliPath: '' })
    assert.equal(noCli.ok, false)
    assert.equal(noCli.error, 'no-cli-path')
    const noHome = await service.spawn({ homeDir: '', profile: 'web', cliPath: FAKE_CLI })
    assert.equal(noHome.ok, false)
    assert.equal(noHome.error, 'no-home-dir')

    // Occupy the only slot with a silent child; its spawn promise stays pending until killed.
    const pending = service.spawn({
      forkId: 'f-slot',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'silent' },
      timeoutMs: 30000,
    })
    assert.ok(await waitFor(() => service.status('f-slot').pid > 0))
    const duplicate = await service.spawn({
      forkId: 'f-slot',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' },
      timeoutMs: 3000,
    })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error, 'already-running')
    const overflow = await service.spawn({
      forkId: 'f-second',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' },
      timeoutMs: 3000,
    })
    assert.equal(overflow.ok, false)
    assert.equal(overflow.error, 'max-forks')
    assert.equal(overflow.limit, 1)

    service.stop('f-slot')
    const first = await pending
    assert.equal(first.ok, false)
    assert.equal(first.error, 'exited')
    assert.equal(service.status('f-slot').status, FORK_STATUS.STOPPED)

    const badCli = await service.spawn({
      forkId: 'f-badcli',
      homeDir,
      profile: 'web',
      cliPath: path.join(root, 'no-such-cli.exe'),
      timeoutMs: 3000,
    })
    assert.equal(badCli.ok, false)
    assert.equal(badCli.error, 'spawn-error')
    assert.deepEqual(readPorts(dataRoot), {}, 'failed launches must release their pool port')
  } finally {
    ctx.dispose()
  }
})

test('reap stops the child, releases its port, removes the home tree and preserves the mother node_modules', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const motherDep = path.join(template, 'node_modules', 'mother-dep.txt')
  const { ctx, service } = newForkContext({ dataRoot })
  try {
    service.provision({ forkId: 'f-reap', homeDir, profile: 'web', profileTemplate: template })
    const res = await service.spawn({
      forkId: 'f-reap',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, true)
    assert.ok(exists(homeDir))
    assert.ok(readPorts(dataRoot)[String(res.port)])
    const reaped = service.reap('f-reap')
    assert.equal(reaped.ok, true)
    assert.equal(reaped.removed, true)
    assert.equal(exists(homeDir), false, 'reap must remove the whole fork home (clean template included)')
    assert.ok(exists(motherDep), 'removeTree must never follow the node_modules junction into the mother')
    assert.ok(exists(template))
    assert.equal(Object.prototype.hasOwnProperty.call(readPorts(dataRoot), String(res.port)), false, 'reap releases the port')
    assert.deepEqual(service.list(), [])
    assert.equal(service.status('f-reap').error, 'not-found')
    assert.equal(await waitFor(() => !isPidAlive(res.pid)), true)
  } finally {
    ctx.dispose()
  }
})

test('dataRoot persists the registry; a fresh instance sees stopped forks and can reap them', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  let port = null
  const first = newForkContext({ dataRoot })
  try {
    first.service.provision({ forkId: 'f-persist', homeDir, profile: 'web', profileTemplate: template })
    const res = await first.service.spawn({
      forkId: 'f-persist',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, true)
    port = res.port
    assert.ok(exists(path.join(dataRoot, 'forks.json')))
    const saved = readJson(path.join(dataRoot, 'forks.json'))
    assert.equal(saved.forks.length, 1)
    assert.equal(saved.forks[0].forkId, 'f-persist')
    first.service.stop('f-persist')
  } finally {
    first.ctx.dispose()
  }

  const second = newForkContext({ dataRoot })
  try {
    const rows = second.service.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].forkId, 'f-persist')
    assert.equal(rows[0].running, false, 'a restored fork can never be "running"')
    assert.equal(rows[0].port, port, 'the restored fork keeps its historical port for diagnostics')
    assert.equal(second.service.status('f-persist').homeDir, homeDir)
    const reaped = second.service.reap('f-persist')
    assert.equal(reaped.ok, true)
    assert.equal(reaped.removed, true)
    assert.equal(exists(homeDir), false)
    assert.deepEqual(second.service.list(), [])
  } finally {
    second.ctx.dispose()
  }
})

test('plugin dispose cancels an in-flight spawn, kills its child and releases its port', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const { ctx, service } = newForkContext({ dataRoot })
  service.provision({ forkId: 'f-dispose', homeDir, profile: 'web', profileTemplate: template })
  const pending = service.spawn({
    forkId: 'f-dispose',
    homeDir,
    profile: 'web',
    cliPath: FAKE_CLI,
    env: { FAKE_DSH_MODE: 'silent' },
    timeoutMs: 30000,
  })
  const pid = await waitFor(() => service.status('f-dispose').pid)
  assert.ok(pid > 0)
  assert.equal(Object.keys(readPorts(dataRoot)).length, 1, 'the in-flight spawn holds a pool slot')
  ctx.dispose()
  const res = await pending
  assert.equal(res.ok, false)
  assert.equal(res.error, 'disposed')
  assert.equal(await waitFor(() => !isPidAlive(pid)), true)
  assert.deepEqual(readPorts(dataRoot), {}, 'dispose must release pool ports (no leak on unload)')
})

test('cross-plugin auditing is tolerant and uses the kernel AUDIT kinds', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home')
  const calls = []
  const ctx = makeCtx({
    services: {
      [SERVICE.auditor]: {
        append(kind, data) {
          calls.push({ kind, data })
          return { kind, data }
        },
      },
    },
  })
  const service = forker.apply(ctx, {})
  try {
    service.provision({ forkId: 'f-audit', homeDir, profile: 'web', profileTemplate: template })
    const res = await service.spawn({
      forkId: 'f-audit',
      homeDir,
      profile: 'web',
      cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' },
      timeoutMs: 8000,
    })
    assert.equal(res.ok, true)
    service.reap('f-audit')
    const kinds = calls.map((call) => call.kind)
    assert.ok(kinds.includes(AUDIT.FORK_CREATED))
    assert.ok(kinds.includes(AUDIT.FORK_STARTED))
    assert.ok(kinds.includes(AUDIT.FORK_REAPED))
    const created = calls.find((call) => call.kind === AUDIT.FORK_CREATED)
    assert.equal(created.data.forkId, 'f-audit')
    assert.equal(created.data.profile, 'web')
    assert.ok(String(created.data.template).length > 0, 'the provision audit records the template used')
    const started = calls.find((call) => call.kind === AUDIT.FORK_STARTED)
    assert.equal(started.data.port, res.port)
  } finally {
    ctx.dispose()
  }

  // A broken auditor must never break fork lifecycle.
  const brokenCtx = makeCtx({
    services: {
      [SERVICE.auditor]: {
        append() {
          throw new Error('audit storage is down')
        },
      },
    },
  })
  const broken = forker.apply(brokenCtx, {})
  try {
    const result = broken.provision({
      forkId: 'f-audit-broken',
      homeDir: path.join(root, 'home-broken-audit'),
      profile: 'web',
      profileTemplate: template,
    })
    assert.equal(result.ok, true)
  } finally {
    brokenCtx.dispose()
  }
})

test('v3: adapterToken 每次 spawn 重新生成、只存内存、经 env 注入分身、stop 后作废', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home-token')
  const dataRoot = path.join(root, 'data-token')
  const { ctx, service } = newForkContext({ dataRoot })
  try {
    assert.equal(service.provision({ forkId: 'f-token', homeDir, profile: 'web', profileTemplate: template }).ok, true)
    assert.equal(service.adapterToken('f-token'), '', 'spawn 前没有 token')
    assert.equal(service.adapterToken('missing'), '', '未知 fork 返回空串')

    const first = await service.spawn({
      forkId: 'f-token', homeDir, profile: 'web', cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' }, timeoutMs: 8000,
    })
    assert.equal(first.ok, true)
    const token = service.adapterToken('f-token')
    assert.match(token, /^[0-9a-f]{48}$/, '24 随机字节 = 48 hex 字符')
    assert.ok(service.logs('f-token', 40).includes('adapter-token=set'), 'token 必须进子进程环境')

    // 不落盘、不外泄：forks.json / status / list / fang-meta.json 都不含 token
    const registry = readJson(path.join(dataRoot, 'forks.json'), null)
    assert.ok(registry, 'spawn 后 registry 已写盘')
    assert.equal(JSON.stringify(registry).includes(token), false, 'token 绝不进 forks.json')
    assert.equal(JSON.stringify(service.status('f-token')).includes(token), false, 'status() 不得泄露 token')
    assert.equal(JSON.stringify(service.list()).includes(token), false, 'list() 不得泄露 token')
    assert.equal(readFile(path.join(homeDir, 'fang-meta.json')).includes(token), false, 'fang-meta.json 不含 token')

    service.stop('f-token')
    assert.equal(service.adapterToken('f-token'), '', 'stop 后旧 token 立即作废')

    const second = await service.spawn({
      forkId: 'f-token', homeDir, profile: 'web', cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' }, timeoutMs: 8000,
    })
    assert.equal(second.ok, true)
    const token2 = service.adapterToken('f-token')
    assert.match(token2, /^[0-9a-f]{48}$/)
    assert.notEqual(token2, token, '每次 spawn 都换新 token')
    service.stop('f-token')
  } finally {
    ctx.dispose()
  }
})

test('v3: onTokenRefresh 广播每次 spawn 的 token；getToken 是 adapterToken 的别名；异常隔离 + disposer', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home-refresh')
  const dataRoot = path.join(root, 'data-refresh')
  const { ctx, service } = newForkContext({ dataRoot })
  const seen = []
  const offBoom = service.onTokenRefresh(() => { throw new Error('boom') })
  const off = service.onTokenRefresh((forkId, token) => seen.push({ forkId, token }))
  try {
    assert.equal(service.provision({ forkId: 'f-refresh', homeDir, profile: 'web', profileTemplate: template }).ok, true)
    const first = await service.spawn({
      forkId: 'f-refresh', homeDir, profile: 'web', cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' }, timeoutMs: 8000,
    })
    assert.equal(first.ok, true)
    const token1 = service.adapterToken('f-refresh')
    assert.equal(service.getToken('f-refresh'), token1, 'getToken 与 adapterToken 一致')
    assert.equal(seen.length, 1, '首次派生也广播 token 生成')
    assert.equal(seen[0].forkId, 'f-refresh')
    assert.equal(seen[0].token, token1)

    service.stop('f-refresh')
    const second = await service.spawn({
      forkId: 'f-refresh', homeDir, profile: 'web', cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' }, timeoutMs: 8000,
    })
    assert.equal(second.ok, true)
    const token2 = service.adapterToken('f-refresh')
    assert.notEqual(token2, token1)
    assert.equal(seen.length, 2, '重启再次广播新 token')
    assert.equal(seen[1].token, token2)

    off()
    service.stop('f-refresh')
    await service.spawn({
      forkId: 'f-refresh', homeDir, profile: 'web', cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'ok' }, timeoutMs: 8000,
    })
    assert.equal(seen.length, 2, 'disposer 后不再广播')
    service.stop('f-refresh')
  } finally {
    off()
    offBoom()
    ctx.dispose()
  }
})

test('v2.7.3: supervise 放弃重启时 emit fang/fork-restart-failed (terminal=true)', async () => {
  const root = tmp()
  const template = makeTemplate(root)
  const homeDir = path.join(root, 'fork-home-giveup')
  const dataRoot = path.join(root, 'data-giveup')
  const { ctx, service } = newForkContext({ dataRoot, supervise: true, maxRestarts: 0 })
  const events = []
  const off = bus.on('fang/fork-restart-failed', (payload) => events.push(payload))
  try {
    assert.equal(service.provision({ forkId: 'f-giveup', homeDir, profile: 'web', profileTemplate: template }).ok, true)
    const res = await service.spawn({
      forkId: 'f-giveup', homeDir, profile: 'web', cliPath: FAKE_CLI,
      env: { FAKE_DSH_MODE: 'crash' }, timeoutMs: 8000,
    })
    assert.equal(res.ok, false)
    assert.equal(await waitFor(() => events.length > 0), true, 'give-up must emit restart-failed')
    assert.equal(events[0].forkId, 'f-giveup')
    assert.equal(events[0].terminal, true)
    assert.match(String(events[0].error), /restart-given-up|crash/i)
  } finally {
    off()
    ctx.dispose()
  }
})
