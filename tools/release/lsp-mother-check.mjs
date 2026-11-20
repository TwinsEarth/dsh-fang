#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 母体正式 profile 的 LSP 安装前/后自检（只读：不安装、不改 profile、不重启进程）。
// 回答三个问题：
//   1) fang 插件版本是否已具备 LSP 委托（>= 3.5.0）；
//   2) lsp-provider bundle 是否已装进 profile，patch 行是否齐全；
//   3) 语言服务器可执行文件在哪；若不在 PATH，打印 profile patch 覆盖片段（绝对路径）。
// 可选 --base：探测运行中的母体 contract capability.list / 一次真实 definition。
//
// 用法：
//   node tools/release/lsp-mother-check.mjs [--profile-dir <dir>] [--base http://127.0.0.1:50895]
//        [--token-file <dataDir>/fang-auth.json] [--definition-file a.ts --line 2 --character 13 --workspace-root <abs>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.resolve(arg('profile-dir', path.join(dshHome, 'profiles', 'desktop')))
const dataDir = path.resolve(arg('data-dir', path.join(dshHome, 'fang', path.basename(profileDir))))
const tokenFile = arg('token-file', path.join(dataDir, 'fang-auth.json'))
const base = arg('base', 'http://127.0.0.1:50895').replace(/\/+$/, '')
const results = []
const record = (id, status, detail) => { results.push({ id, status, detail }); console.log(`${status.padEnd(5)} ${id.padEnd(52)} ${detail}`) }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
function versionAtLeast(version, minimum) {
  const parse = (v) => String(v ?? '').replace(/^[^\d]*/, '').split('.').slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [a, b] = [parse(version), parse(minimum)]
  for (let index = 0; index < 3; index++) { if (a[index] !== b[index]) return a[index] > b[index] }
  return true
}

// 1) profile + fang plugin version (LSP delegation landed in 3.5.0)
if (!fs.existsSync(profileDir)) {
  record('profile exists', 'FAIL', profileDir)
  finish()
}
record('profile exists', 'PASS', profileDir)
const profilePkg = readJson(path.join(profileDir, 'package.json')) ?? {}
const profileDeps = profilePkg.dependencies ?? {}
const profileBundles = profilePkg.dsh?.profile?.bundles ?? []
const fangVersion = profileDeps['@twinsearth/fang-dsh-plugin'] ?? (readJson(path.join(profileDir, 'node_modules', '@twinsearth', 'fang-dsh-plugin', 'package.json'))?.version ?? '')
if (!fangVersion) record('fang plugin installed', 'TODO', 'not found in profile dependencies; install/upgrade @twinsearth/fang-dsh-plugin@3.5.0 first')
else if (!versionAtLeast(fangVersion, '3.5.0')) record('fang plugin supports LSP delegation (>=3.5.0)', 'TODO', `installed=${fangVersion}; upgrade to 3.5.0 first (LSP handler landed there)`)
else record('fang plugin supports LSP delegation (>=3.5.0)', 'PASS', `installed=${fangVersion}`)

// 2) lsp-provider bundle installed in the profile
const bundleName = '@twinsearth/dsh-fang-lsp'
const bundleDir = path.join(profileDir, 'node_modules', '@twinsearth', 'dsh-fang-lsp')
const bundleInstalled = fs.existsSync(path.join(bundleDir, 'package.json'))
const bundleListed = profileBundles.includes(bundleName)
if (!bundleInstalled) {
  record('lsp-provider bundle installed', 'TODO', `missing ${bundleDir} — Plugins → Add plugin → select ${path.join(repoRoot, 'lsp-provider')}`)
} else {
  const bundlePatchFile = path.join(bundleDir, 'cordis.patch.yml')
  const patchText = fs.existsSync(bundlePatchFile) ? fs.readFileSync(bundlePatchFile, 'utf8') : ''
  const rows = [...patchText.matchAll(/id:\s*(fang-lsp-[a-z-]+)/g)].map((match) => match[1])
  const expected = ['fang-lsp-fs-local', 'fang-lsp-subprocess-local', 'fang-lsp-seam', 'fang-lsp-stdio', 'fang-lsp-tool']
  const missingRows = expected.filter((row) => !rows.includes(row))
  record('lsp-provider bundle installed', 'PASS', `${bundleDir}${bundleListed ? ' (listed in profile bundles)' : ' (NOT listed in profile bundles → add it)'}`)
  record('bundle patch rows complete', missingRows.length === 0 ? 'PASS' : 'FAIL', missingRows.length ? `missing: ${missingRows.join(',')}` : rows.join(','))
}

// 3) language server binary: find it and, when not on PATH, print the absolute override
const candidates = [
  path.join(profileDir, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
  path.join(profileDir, 'node_modules', '.bin', 'typescript-language-server.cmd'),
  path.join(profileDir, 'node_modules', '.bin', 'typescript-language-server'),
]
const tls = candidates.find((candidate) => { try { return fs.existsSync(candidate) } catch { return false } })
if (!tls) {
  record('typescript-language-server available', 'TODO', 'not installed in profile; bundle dependencies (typescript-language-server@6.1.0) must be installed by the plugin installer')
} else {
  const cli = /\.m?js$/.test(tls) ? tls : path.join(profileDir, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')
  record('typescript-language-server available', 'PASS', cli)
  console.log('\n# 若语言服务器不在 PATH（推荐直接覆盖为绝对路径），在 profile 的 cordis.patch.yml 追加：\n')
  console.log('- id: fang-lsp-stdio\n  config:\n    servers:\n      typescript:\n        command: ' + JSON.stringify(process.execPath) + '\n        args:\n          - ' + JSON.stringify(cli) + '\n          - \'--stdio\'\n        extensionToLanguage:\n          \'.ts\': typescript\n          \'.tsx\': typescriptreact\n          \'.js\': javascript\n          \'.jsx\': javascriptreact\n')
}

// 4) optional live probe against the running mother
async function probe() {
  let token = arg('token', '')
  if (!token) { try { token = readJson(tokenFile)?.token ?? '' } catch { token = '' } }
  if (!token) { record('running mother LSP probe', 'TODO', `no token (${tokenFile}); pass --token-file/--token`); return }
  const headers = { 'x-fang-auth': token, authorization: '', 'content-type': 'application/json' }
  const call = async (pathname, options = {}) => {
    try { const response = await fetch(`${base}${pathname}`, { ...options, signal: AbortSignal.timeout(15000) }); const body = await response.json().catch(() => null); return { status: response.status, body } } catch (error) { return { status: 0, body: null, error: String(error?.message ?? error) } }
  }
  const health = await call('/fang/api/contract/health', { headers })
  if (health.status === 401) { record('running mother probe', 'TODO', `401 unauthorized at ${base} — pass the production token via --token/--token-file (config token may override ${tokenFile})`); return }
  if (health.status !== 200) { record('running mother probe', 'TODO', `${base} status=${health.status} ${health.error ?? '(not running / different port — pass --base)'}`); return }
  const methods = Array.isArray(health.body?.methods) ? health.body.methods : []
  record('running mother reachable', 'PASS', `version=${health.body?.version ?? '?'} methods=${methods.length}`)
  if (!methods.includes('fang.capability.list')) { record('delegation capability methods', 'TODO', 'mother lacks delegation methods; upgrade/restart fang 3.5.0'); return }
  let sequence = 0
  const invoke = async (method, params = null) => {
    const envelope = { protocol: 'fang-master', protocolVersion: 1, id: `lsp-check-${Date.now().toString(36)}-${++sequence}`, method, params, meta: { at: Date.now(), delegate: true, source: 'lsp-mother-check' } }
    return call('/fang/api/contract/invoke', { method: 'POST', headers, body: JSON.stringify(envelope) })
  }
  const caps = await invoke('fang.capability.list')
  const lspProvider = caps.body?.result?.lspProvider ?? null
  if (!lspProvider) record('capability.list lsp provider', 'FAIL', `status=${caps.status} no lspProvider (older build?)`)
  else if (lspProvider.available !== true) record('capability.list lsp provider', 'TODO', `provider unavailable: install lsp-provider bundle and restart (providers=${JSON.stringify(lspProvider.providers)})`)
  else record('capability.list lsp provider', 'PASS', `default=${lspProvider.default} actions=${(lspProvider.actions ?? []).join(',')}`)
  const definitionFile = arg('definition-file', '')
  const workspaceRoot = arg('workspace-root', '')
  if (definitionFile && workspaceRoot) {
    const line = Number.parseInt(arg('line', '0'), 10) || 0
    const character = Number.parseInt(arg('character', '0'), 10) || 0
    const params = { tool: 'lsp', action: 'definition', file: definitionFile, line, character, workspaceRoot }
    const definition = await invoke('fang.tool.invoke', params)
    record('real definition via delegation', definition.status === 200 && definition.body?.ok === true ? 'PASS' : 'FAIL', JSON.stringify(definition.body?.result ?? definition.body?.error ?? { status: definition.status }).slice(0, 320))
    const hover = await invoke('fang.tool.invoke', { ...params, action: 'hover' })
    record('real hover via delegation', hover.status === 200 && hover.body?.ok === true ? 'PASS' : 'FAIL', JSON.stringify(hover.body?.result ?? hover.body?.error ?? { status: hover.status }).slice(0, 320))
  }
}

await probe()
finish()

function finish() {
  const failed = results.filter((item) => item.status === 'FAIL')
  const todo = results.filter((item) => item.status === 'TODO')
  const summary = failed.length ? 'RED' : todo.length ? 'PENDING' : 'GREEN'
  console.log(`\n${summary}  lsp mother check  (pass=${results.length - failed.length - todo.length} todo=${todo.length} fail=${failed.length})`)
  if (todo.length) console.log('next: ' + todo.map((item) => `${item.id}: ${item.detail}`).join(' | '))
  process.exit(failed.length ? 1 : 0)
}
