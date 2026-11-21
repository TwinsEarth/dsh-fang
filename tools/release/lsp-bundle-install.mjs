#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// M3.2 母体 LSP 栈原型：把 lsp-provider/ 配置型 bundle 安装到 *测试 profile*，
// 真机 boot 一个隔离母体，校验：
//   1) 官方 LSP 能力缝 ctx.lsp 存在（且有 query）；
//   2) tools 服务可见，且（可选）已广告 lsp 工具。
//
// 不写用户 profile：所有安装都在临时 $DSH_HOME 的测试 profile 内。
// 用法：node tools/release/lsp-bundle-install.mjs [--stage <dir>] [--json] [--keep]
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const asJson = argv.includes('--json')
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const STAGE = arg('stage', process.env.FANG_E2E_LSP_STAGE || path.join(os.tmpdir(), 'fang-lsp-stage'))
const CLI_CANDIDATES = [
  process.env.DSH_CLI_PATH,
  // 2026-11 安装位置迁移：新安装根在 D:\DSH（旧 E:\DSH\DS 保留为兼容候选）。
  'D:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd',
  'E:\\DSH\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd',
  'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
].filter(Boolean)
const CLI = CLI_CANDIDATES.find((candidate) => { try { return fs.existsSync(candidate) } catch { return false } })
const checks = []
const check = (id, ok, detail = '') => { checks.push({ id, ok: Boolean(ok), detail }); if (!asJson) console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort(start = 18120) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const server = net.createServer()
      server.once('error', () => tryPort(port + 1))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(port)))
    }
    tryPort(start)
  })
}
function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ } }
function linkEntry(from, to) { try { if (!fs.existsSync(to)) fs.symlinkSync(from, to, 'junction') } catch { /* ignore */ } }

async function main() {
  if (!CLI) { console.error(JSON.stringify({ ok: false, error: 'dsh CLI not found' })); return 2 }
  if (!fs.existsSync(path.join(STAGE, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'))) {
    console.error(JSON.stringify({ ok: false, error: `language server missing in stage: ${STAGE}; run npm run setup:lsp-live first` }))
    return 2
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-lsp-probe-'))
  if (!asJson) console.log(`lsp-bundle-install: home=${home}`)
  const profileName = 'lsp-probe'
  const profileDir = path.join(home, 'profiles', profileName)
  const moduleDir = path.join(profileDir, 'node_modules')
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@twinsearth/dsh-fang-lsp'] } },
    dependencies: {},
  }, null, 2))
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n')

  // 1) "install" the bundle: package link + its staged dependency tree (npm install result).
  const bundleLink = path.join(moduleDir, '@twinsearth', 'dsh-fang-lsp')
  fs.mkdirSync(path.dirname(bundleLink), { recursive: true })
  linkEntry(path.join(ROOT, 'lsp-provider'), bundleLink)
  const staged = path.join(STAGE, 'node_modules')
  for (const entry of fs.readdirSync(staged, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      fs.mkdirSync(path.join(moduleDir, entry.name), { recursive: true })
      for (const sub of fs.readdirSync(path.join(staged, entry.name))) linkEntry(path.join(staged, entry.name, sub), path.join(moduleDir, entry.name, sub))
    } else {
      linkEntry(path.join(staged, entry.name), path.join(moduleDir, entry.name))
    }
  }
  check('bundle package linked into test profile', fs.existsSync(path.join(bundleLink, 'package.json')), bundleLink)

  // 2) boot probe plugin: records ctx.lsp / tools presence into <DSH_HOME>/lsp-probe.json.
  const probeDir = path.join(moduleDir, '@local', 'lsp-boot-probe')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(path.join(probeDir, 'package.json'), JSON.stringify({
    name: '@local/lsp-boot-probe', version: '0.0.0', private: true, type: 'module', main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  fs.writeFileSync(path.join(probeDir, 'cordis.patch.yml'), "- name: '@local/lsp-boot-probe'\n")
  fs.writeFileSync(path.join(probeDir, 'index.js'), [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'function service(ctx, name) {',
    '  const candidates = [ctx?.get?.(name), ctx?.reflect?.get?.(name), ctx?.root?.get?.(name)]',
    '  for (const value of candidates) { try { if (value) return value } catch { /* ignore */ } }',
    '  return null',
    '}',
    'export function apply(ctx) {',
    '  // Services are registered during the plugin tree boot; sample after the tree settles.',
    '  setTimeout(() => {',
    '    const lsp = service(ctx, \'lsp\')',
    '    const tools = service(ctx, \'tools\')',
    '    const probe = { at: Date.now(), lsp: Boolean(lsp), lspQuery: typeof lsp?.query === \'function\', tools: Boolean(tools), knownNames: null, toolNames: null }',
    '    try {',
    '      const view = tools?.view?.()',
    '      probe.knownNames = view?.knownNames ? [...view.knownNames] : null',
    '      probe.toolNames = tools?.definitions ? [...(tools.definitions(undefined, [])?.knownNames ?? [])] : null',
    '    } catch (error) { probe.toolsError = String(error?.message ?? error) }',
    "    try { fs.writeFileSync(path.join(process.env.DSH_HOME ?? process.cwd(), 'lsp-probe.json'), JSON.stringify(probe, null, 2)) } catch { /* ignore */ }",
    '  }, 6000)',
    '}',
    '',
  ].join('\n'))
  const profilePatch = '- insert:\n    - id: lsp-boot-probe\n      name: \'@local/lsp-boot-probe\'\n'
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), profilePatch)

  // 3) boot the isolated mother and wait for the probe file.
  const port = await freePort()
  const env = { ...process.env, DSH_HOME: home, DSH_PROFILE: profileName, DSH_PROFILE_DIR: profileDir }
  delete env.DSH_FANG_ROLE
  delete env.DSH_FANG_TASK_ID
  const child = spawn(CLI, ['--profile', profileName, '--port', String(port), '--no-open'], { cwd: home, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (chunk) => { output += String(chunk) })
  child.stderr?.on('data', (chunk) => { output += String(chunk) })
  const probeFile = path.join(home, 'lsp-probe.json')
  try {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline && !fs.existsSync(probeFile)) await sleep(500)
    check('test-profile mother booted (web banner)', /dsh web: https?:\/\//.test(output), output.slice(-200))
    const probe = fs.existsSync(probeFile) ? JSON.parse(fs.readFileSync(probeFile, 'utf8')) : null
    check('official LSP seam ctx.lsp present', probe?.lsp === true && probe?.lspQuery === true, JSON.stringify(probe))
    check('tools service visible in mother', probe?.tools === true, JSON.stringify({ tools: probe?.tools ?? null }))
    const toolNames = probe?.knownNames ?? probe?.toolNames ?? null
    if (Array.isArray(toolNames)) {
      check('model-facing lsp tool advertised in tools', toolNames.includes('lsp'), JSON.stringify(toolNames))
    } else {
      check('lsp tool check skipped (tools view unavailable)', true, 'optional check; ctx.lsp seam is authoritative')
    }
    fs.writeFileSync(path.join(home, 'boot-output.log'), output)
  } finally {
    killTree(child.pid)
    if (!argv.includes('--keep')) { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* junctions may resist */ } }
  }
  const failed = checks.filter((item) => !item.ok)
  if (asJson) console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
  console.log(`${failed.length ? 'RED' : 'GREEN'}  lsp-bundle-install  ${checks.length - failed.length}/${checks.length}`)
  return failed.length ? 1 : 0
}

main().then((code) => process.exit(code)).catch((error) => { console.error(String(error?.stack ?? error)); process.exit(1) })
