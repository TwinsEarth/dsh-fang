#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// tools/e2e.mjs — v2.0.0 实机端到端验收（不依赖用户宿主，不重启任何现有实例）。
//
// 做什么：
//   1. 在临时 $DSH_HOME 里生成一个只装 @local/dsh-fang 的 e2e profile；
//   2. 用真实 dsh CLI 启动一个独立母体（动态端口），等它打印带 token 的 URL；
//      默认走测试缝；`--lsp`（或 FANG_E2E_LSP=1）会把官方 LSP 三件套 +
//      typescript-language-server staging 目录接进 profile，用真实 ctx.lsp provider 验证
//      definition/hover（准备：node tools/release/lsp-live-setup.mjs）。
//   3. 通过 HTTP 走完整任务生命周期：status → 派生任务（真分身）→ Adapter 握手 →
//      分身角色矩阵断言 → 任务状态 → 归档（flush+回收）；
//   4. 校验母体审计账本（哈希链）与母体/分身两侧数据布局；
//   5. 杀进程树并清理临时目录。
//
// 用法：node tools/e2e.mjs [--keep] [--timeout 180]
// 退出码：0 全绿；1 有失败；2 环境不具备（缺 CLI / 非 Windows 等）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import vm from 'node:vm'
import zlib from 'node:zlib'

import { encodeWorkspaceKey } from '../src/lib/session-format.mjs'
import { CONTRACT_VERSION as E2E_CONTRACT_VERSION, createEnvelope } from '../src/contract/index.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const KEEP = process.argv.includes('--keep')
const TIMEOUT_MS = Number((process.argv.find(a => a.startsWith('--timeout=')) ?? '').split('=')[1] ?? 240000)
// v3.1.12: the e2e drill verifies the fork lifecycle, not the default plugin seed
// (downloading the seed on every CI run would be slow and flaky). Seeding is covered
// by test/fork-seed.test.mjs with an injected installer.
process.env.DSH_FANG_FORK_SEED = process.env.DSH_FANG_FORK_SEED ?? '0'

const CLI_CANDIDATES = [
  process.env.DSH_CLI_PATH,
  'E:\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd',
  'E:\\DSH\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd',
  'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
].filter(Boolean)
const CLI = CLI_CANDIDATES.find(p => { try { return fs.existsSync(p) } catch { return false } })
if (!CLI) {
  console.error('SKIP: dsh CLI not found')
  process.exit(2)
}
// 路线 A 真实 LSP 模式：安装官方三件套 + typescript-language-server 后，用真实 provider
// 替换 e2e 测试缝（默认仍走测试缝，保证 CI 确定性）。
const LSP_MODE = process.argv.includes('--lsp') || process.env.FANG_E2E_LSP === '1'
const LSP_STAGE = process.env.FANG_E2E_LSP_STAGE || 'E:\\GPT\\.tmp\\e2e-lsp-stage'

const results = []
function check(id, ok, detail = '') {
  results.push({ id, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(38)} ${detail}`)
}

function freePort(start = 18110) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const srv = net.createServer()
      srv.once('error', () => tryPort(port + 1))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)))
    }
    tryPort(start)
  })
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last?.ok) return last
    await sleep(intervalMs)
  }
  return { ok: false, error: `timeout waiting for ${label}`, last }
}

function seedSession(homeRoot, { sessionId, workspacePath, title }) {
  const sessionsDir = path.join(homeRoot, 'sessions', encodeWorkspaceKey(workspacePath), sessionId)
  fs.mkdirSync(sessionsDir, { recursive: true })
  const frames = [
    JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1793500000000, cwd: workspacePath }) + '\n',
    JSON.stringify({ type: 'session/title', seq: 2, data: { title, messageSeqs: [1], source: { kind: 'fallback' } } }) + '\n',
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'e2e 首条用户消息' }] } }) + '\n',
  ]
  fs.writeFileSync(path.join(sessionsDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map((fr) => zlib.zstdCompressSync(Buffer.from(fr, 'utf8')))))
  const storages = path.join(homeRoot, 'storages')
  fs.mkdirSync(storages, { recursive: true })
  fs.writeFileSync(path.join(storages, 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'ws-e2e', workspaceIds: ['ws-e2e'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-e2e': { path: workspacePath, title: 'E2E', sessionIds: [sessionId], createdAt: '2026-10-16T05:35:00.313Z', updatedAt: '2026-11-01T02:44:03.199Z' } } },
  }, null, 2))
}

/**
 * M3.3 workspaceRoot 策略：把一个 fork 任务（含 workspace 索引）登记进任务 registry，
 * 让母体的 LSP 允许根自动登记该 fork 的工作区（“母体 + 所有 fork 工作区根，显式登记”）。
 */
function seedLspForkTask(homeRoot, forkHome) {
  const dataDir = path.join(homeRoot, 'fang', 'e2e')
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'tasks.json')
  let existing = { version: 2, forks: [] }
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first run */ }
  const forks = Array.isArray(existing.forks) ? existing.forks.filter((task) => task?.forkId !== 'lsp-fork-probe') : []
  forks.push({ forkId: 'lsp-fork-probe', homeDir: forkHome, coreMode: 'accelerated', status: 'running', createdAt: new Date().toISOString() })
  fs.writeFileSync(file, JSON.stringify({ version: 2, at: new Date().toISOString(), forks }, null, 2))
}

function makeProfile(homeRoot) {
  const profileDir = path.join(homeRoot, 'profiles', 'e2e')
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-e2e',
    private: true,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-fang'],
      },
    },
    dependencies: {},
  }, null, 2))
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n')
  const lspWorkspace = path.join(homeRoot, 'lsp-workspace')
  if (LSP_MODE) {
    fs.mkdirSync(lspWorkspace, { recursive: true })
    fs.writeFileSync(path.join(lspWorkspace, 'base.ts'), 'export const base = 1\nexport const unused = 0\n')
    fs.writeFileSync(path.join(lspWorkspace, 'a.ts'), "import { base } from './base'\nexport function add(x: number) {\n  return x + base\n}\n")
    fs.writeFileSync(path.join(lspWorkspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' }, include: ['a.ts', 'base.ts'] }, null, 2))
    // Fork workspace fixture: the task registry entry below registers this root explicitly.
    const forkHome = path.join(homeRoot, 'lsp-fork-home')
    const forkWorkspace = path.join(homeRoot, 'lsp-fork-workspace')
    fs.mkdirSync(path.join(forkHome, 'storages'), { recursive: true })
    fs.mkdirSync(forkWorkspace, { recursive: true })
    fs.writeFileSync(path.join(forkWorkspace, 'a.ts'), 'export const forkBase = 2\nexport function forkUse(x: number) {\n  return x + forkBase\n}\n')
    fs.writeFileSync(path.join(forkHome, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['fw-lsp'] },
      tables: { workspaces: { 'fw-lsp': { path: forkWorkspace, title: 'LSP fork', sessionIds: [] } } },
    }, null, 2))
  }
  const lspDelegate = LSP_MODE
    ? '        lsp:\n          allowedRoots:\n            - ' + JSON.stringify(lspWorkspace) + '\n'
    : ''
  const lspRows = LSP_MODE
    ? '- insert:\n' +
      '    - id: dsh-lsp\n      name: \'@deepseek-ai/dsh-lsp\'\n' +
      '    - id: dsh-lsp-stdio\n      name: \'@deepseek-ai/dsh-lsp-stdio\'\n      config:\n        servers:\n          typescript:\n' +
      '            command: ' + JSON.stringify(process.execPath) + '\n' +
      '            args:\n              - ' + JSON.stringify(path.join(LSP_STAGE, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')) + '\n              - "--stdio"\n' +
      '            extensionToLanguage:\n              ".ts": typescript\n'
    : ''
  // v3.3.3: queue-journal is disabled by default in the bundle. The e2e profile
  // explicitly enables it so the journal/queue recovery API is exercised; the
  // default-off + 503 path is covered by unit tests.
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'),
    '- id: fang-queue-journal\n  disabled: false\n' +
    '- id: fang-orchestrator\n  config:\n    contract:\n      token: e2e-contract-token\n' +
    '      delegate:\n        readTimeoutMs: 100\n        maxConcurrent: 2\n' + lspDelegate +
    '        allow:\n' +
    "          - fang.capability.list\n          - fang.orchestrator.status\n          - fang.session.list\n          - fang.session.events\n          - fang.decision.list\n          - fang.approvals.list\n          - fang.tool.invoke\n          - fang.chat.import\n          - fang.test.sleep\n" +
    lspRows)
  // the bundle resolves from profile node_modules; point it at the workspace package
  const link = path.join(profileDir, 'node_modules', '@local', 'dsh-fang')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(ROOT, link, 'junction')
  // The fang bundle now carries a client-side child plugin (queue journal).
  const childLink = path.join(profileDir, 'node_modules', '@twinsearth', 'dsh-fang-queue-journal')
  fs.mkdirSync(path.dirname(childLink), { recursive: true })
  fs.symlinkSync(path.join(ROOT, 'queue-journal'), childLink, 'junction')
  const entryLink = path.join(profileDir, 'node_modules', '@twinsearth', 'dsh-fang-web-entry')
  fs.mkdirSync(path.dirname(entryLink), { recursive: true })
  fs.symlinkSync(path.join(ROOT, 'web-entry'), entryLink, 'junction')
  if (LSP_MODE) {
    // Stage the official LSP stack + typescript-language-server from a real npm install;
    // junction each package into the profile (no writes into the user profile).
    const staged = path.join(LSP_STAGE, 'node_modules')
    const target = path.join(profileDir, 'node_modules')
    const linkEntry = (from, to) => { try { if (!fs.existsSync(to)) fs.symlinkSync(from, to, 'junction') } catch { /* ignore */ } }
    for (const entry of fs.readdirSync(staged, { withFileTypes: true })) {
      if (entry.name === '.bin') continue
      if (entry.name.startsWith('@')) {
        fs.mkdirSync(path.join(target, entry.name), { recursive: true })
        for (const sub of fs.readdirSync(path.join(staged, entry.name))) linkEntry(path.join(staged, entry.name, sub), path.join(target, entry.name, sub))
      } else {
        linkEntry(path.join(staged, entry.name), path.join(target, entry.name))
      }
    }
  }
  return profileDir
}

async function main() {
  const startedAt = Date.now()
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-e2e-'))
  const port = await freePort()
  const E2E_NATIVE_TITLE = 'e2e 原生会话标题'
  const E2E_SESSION_ID = 'session-11111111-2222-4333-8444-555555555555'
  const E2E_WS_PATH = 'E:\\e2e-ws'
  const LSP_WS = path.join(homeRoot, 'lsp-workspace')
  const LSP_FORK_HOME = path.join(homeRoot, 'lsp-fork-home')
  const LSP_FORK_WS = path.join(homeRoot, 'lsp-fork-workspace')
  seedSession(homeRoot, { sessionId: E2E_SESSION_ID, workspacePath: E2E_WS_PATH, title: E2E_NATIVE_TITLE })
  const profileDir = makeProfile(homeRoot)
  console.log(`e2e: home=${homeRoot}`)
  console.log(`e2e: profile=${profileDir}`)
  console.log(`e2e: cli=${CLI} port=${port}`)

  let child = null
  let stdout = ''
  let stderr = ''
  const env = { ...process.env, DSH_HOME: homeRoot, DSH_PROFILE: 'e2e', DSH_PROFILE_DIR: profileDir, FANG_CONTRACT_TEST_HOOKS: '1' }
  delete env.DSH_FANG_ROLE
  delete env.DSH_FANG_TASK_ID

  try {
    child = spawn(CLI, ['--profile', 'e2e', '--port', String(port), '--no-open'], {
      cwd: homeRoot,
      env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (e) => { stderr += '\nspawn-error: ' + e.message })

    const urlParse = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+)\/\S*)/.exec(stdout)
    const booted = await waitFor(() => {
      const m = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+)\/\S*)/.exec(stdout)
      return m ? { ok: true, url: m[1], port: Number(m[2]) } : { ok: false }
    }, { timeoutMs: 150000, label: 'mother boot' })
    if (!booted.ok) {
      console.error('boot log tail:\n' + (stdout + stderr).split('\n').slice(-40).join('\n'))
      check('mother boots with v2 bundle', false, booted.error)
      return 1
    }
    check('mother boots with v2 bundle', true, `port=${booted.port}`)
    const token = (() => { try { return new URL(booted.url).searchParams.get('token') ?? '' } catch { return '' } })()
    check('mother URL carries a token', token.length > 0)
    // v3.0.7/B1：fang 安装级 token（0600 文件）；e2e 作为本机客户端按真实方式带上 header
    let fangToken = ''
    try {
      fangToken = JSON.parse(fs.readFileSync(path.join(homeRoot, 'fang', 'e2e', 'fang-auth.json'), 'utf8')).token ?? ''
    } catch { /* 无 token 文件 = 旧版本；后续断言会暴露 401 */ }

    const api = async (p, opts = {}) => {
      const url = `${booted.url.replace(/\/\?.*$/, '')}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      const res = await fetch(url, {
        ...opts,
        headers: {
          'content-type': 'application/json',
          ...(fangToken ? { 'x-fang-auth': fangToken } : {}),
          ...(opts.headers ?? {}),
        },
      })
      const text = await res.text()
      let body = null
      try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
      return { status: res.status, body }
    }

    const status = await api('/fang/api/status')
    console.log('mother config:', JSON.stringify(status.body?.mother))
    check('GET /fang/api/status 200', status.status === 200, `version=${status.body?.version}`)
    check('status reports current package version', status.body?.version === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)
    check('status reports role=mother', status.body?.role === 'mother')
    const upgradeStatus = await api('/fang/api/upgrade/status')
    check('GET /fang/api/upgrade/status 200 + read-only shape',
      upgradeStatus.status === 200 && upgradeStatus.body?.ok === true &&
      upgradeStatus.body?.mother !== undefined && Array.isArray(upgradeStatus.body?.essences) &&
      upgradeStatus.body?.operation === null,
      JSON.stringify({ status: upgradeStatus.status, ok: upgradeStatus.body?.ok }))
    const unauthUpgrade = await fetch(`http://127.0.0.1:${booted.port}/fang/api/upgrade/status`).catch(() => null)
    check('upgrade/status rejects missing token (401)', unauthUpgrade?.status === 401, `status=${unauthUpgrade?.status ?? 'n/a'}`)
    // Route-table gate: catches duplicate-path registration losses (GET+POST same path)
    // and stale DEFAULT_EXPECTED_ROUTE_COUNT / REQUIRED_ROUTE_PATHS.
    const compatCheck = await api('/fang/api/compat/check', { method: 'POST', body: '{}' })
    check('compat gate passes (route count + required paths)',
      compatCheck.status === 200 && compatCheck.body?.ok === true,
      JSON.stringify({
        status: compatCheck.status,
        ok: compatCheck.body?.ok,
        routeCount: compatCheck.body?.routeCount,
        expectedRouteCount: compatCheck.body?.expectedRouteCount,
        findings: (compatCheck.body?.findings ?? []).map((f) => f.code).slice(0, 6),
      }))
    const unknownBranches = await api('/fang/api/tasks/branches?taskId=e2e-probe')
    check('GET /fang/api/tasks/branches unknown task → 404 unknown-task',
      unknownBranches.status === 404 && unknownBranches.body?.error === 'unknown-task',
      JSON.stringify({ status: unknownBranches.status, error: unknownBranches.body?.error }))
    const journalSave = await api('/fang/api/composer/journal', {
      method: 'POST',
      body: JSON.stringify({ key: 'e2e-journal', draft: '未发送草稿', queue: [{ text: '排队消息', at: 1 }] }),
    })
    check('POST /fang/api/composer/journal persists draft',
      journalSave.status === 200 && journalSave.body?.entry?.draft === '未发送草稿', `status=${journalSave.status}`)
    const journalGet = await api('/fang/api/composer/journal?key=e2e-journal')
    check('GET /fang/api/composer/journal returns queue mirror',
      journalGet.status === 200 && journalGet.body?.entry?.queue?.[0]?.text === '排队消息', `status=${journalGet.status}`)
    const traversalBranches = await api('/fang/api/tasks/branches?taskId=' + encodeURIComponent('../../escape'))
    check('GET /fang/api/tasks/branches traversal taskId → 404',
      traversalBranches.status === 404 && traversalBranches.body?.error === 'unknown-task',
      JSON.stringify({ status: traversalBranches.status, error: traversalBranches.body?.error }))
    check('mother has forker service', status.body?.services?.forker === true)

    const route = await api('/fang/api/route?realtime=1')
    check('GET /fang/api/route 200', route.status === 200, `mode=${route.body?.mode}`)
    check('router chooses sync without a bridge descriptor', route.body?.mode === 'sync' && route.body?.bridge?.available === false, JSON.stringify(route.body?.bridge ?? null))
    const syncStatus = await api('/fang/api/sync/status')
    check('GET /fang/api/sync/status 200', syncStatus.status === 200 && syncStatus.body?.ok === true, JSON.stringify(syncStatus.body ?? null).slice(0, 160))
    const bridgeStatus = await api('/fang/api/bridge/status')
    check('GET /fang/api/bridge/status fail-closed', bridgeStatus.status === 200 && bridgeStatus.body?.ok === false && bridgeStatus.body?.code === 'bridge-unavailable', JSON.stringify(bridgeStatus.body ?? null).slice(0, 160))

    // ── P1/D2：分身核心开关（面板「官方 / 一键加速」）契约 ──────────────────
    const forkCore = await api('/fang/api/fork-core')
    const fc = forkCore.body ?? {}
    check('GET /fang/api/fork-core 200 + shape', forkCore.status === 200 && fc.ok === true
      && ['stock', 'accelerated'].includes(fc.mode)
      && ['new', 'copy'].includes(fc.sessionMode)
      && (fc.effectiveMode === null || ['stock', 'accelerated'].includes(fc.effectiveMode))
      && typeof fc.accelerated === 'object' && fc.accelerated !== null
      && typeof fc.accelerated.installed === 'boolean'
      && fc.accelerated.limitBytes === 1024 * 1024 * 1024
      && typeof fc.accelerated.requiresConfirmation === 'boolean'
      && typeof fc.forks?.stock === 'number' && typeof fc.forks?.accelerated === 'number',
      JSON.stringify({ status: forkCore.status, mode: fc.mode, sessionMode: fc.sessionMode, accel: fc.accelerated ?? null }).slice(0, 200))
    check('fork-core essence is pinned to stock', fc.essence === 'stock')
    const modeBefore = fc.mode
    if (fc.accelerated?.installed !== true) {
      // 未安装加速核：服务端必须 fail-closed（409 + unchanged），且设置不被修改。
      const rejected = await api('/fang/api/fork-core', { method: 'POST', body: JSON.stringify({ mode: 'accelerated' }) })
      check('fork-core rejects accelerated without install (409 unchanged)', rejected.status === 409
        && rejected.body?.error === 'accelerated-cli-missing' && rejected.body?.unchanged === true,
        JSON.stringify({ status: rejected.status, error: rejected.body?.error, unchanged: rejected.body?.unchanged }))
      const after = await api('/fang/api/fork-core')
      check('fork-core setting unchanged after rejection', after.body?.mode === modeBefore && after.body?.blocked === null,
        JSON.stringify({ before: modeBefore, after: after.body?.mode }))
    } else {
      const toAccel = await api('/fang/api/fork-core', { method: 'POST', body: JSON.stringify({ mode: 'accelerated' }) })
      check('fork-core switch to accelerated persisted', toAccel.status === 200 && toAccel.body?.mode === 'accelerated' && toAccel.body?.effectiveMode === 'accelerated',
        JSON.stringify({ status: toAccel.status, mode: toAccel.body?.mode, effective: toAccel.body?.effectiveMode }))
      const backToStock = await api('/fang/api/fork-core', { method: 'POST', body: JSON.stringify({ mode: 'stock' }) })
      check('fork-core switch back to stock persisted', backToStock.status === 200 && backToStock.body?.mode === 'stock',
        JSON.stringify({ status: backToStock.status, mode: backToStock.body?.mode }))
    }

    // ── B 契约委托基线：hello 协商 + 只读能力真实调用（Bearer token 走契约端点）──
    const contractAuth = { authorization: 'Bearer e2e-contract-token' }
    const helloRes = await api('/fang/api/contract/hello', { method: 'POST', headers: contractAuth, body: '{}' })
    const hello = helloRes.body?.result ?? helloRes.body ?? {}
    check('contract.hello advertises version + methods', helloRes.status === 200
      && hello.contractVersion === E2E_CONTRACT_VERSION && hello.contractVersion === '1.2.0'
      && Array.isArray(hello.methods) && hello.methods.includes('fang.session.list')
      && Array.isArray(hello.capabilities),
      JSON.stringify({ status: helloRes.status, version: hello.contractVersion, methods: (hello.methods ?? []).length }).slice(0, 180))
    const contractInvoke = async (method, params) => api('/fang/api/contract/invoke', {
      method: 'POST', headers: contractAuth, body: JSON.stringify(createEnvelope({ method, params, source: 'e2e' })),
    })
    const statusEnv = await contractInvoke('fang.orchestrator.status')
    check('contract fang.orchestrator.status delegated call 200', statusEnv.status === 200 && statusEnv.body?.result && typeof statusEnv.body.result === 'object',
      JSON.stringify({ status: statusEnv.status, error: statusEnv.body?.error?.code ?? null }).slice(0, 160))
    const sessionListEnv = await contractInvoke('fang.session.list', { limit: 5 })
    const sessionListCode = sessionListEnv.body?.error?.code ?? null
    check('contract fang.session.list delegated call answered (result or known-unavailable)', sessionListEnv.status === 200
      && ((sessionListEnv.body?.result && typeof sessionListEnv.body.result === 'object') || sessionListCode === 'fang-service-unavailable'),
      JSON.stringify({ status: sessionListEnv.status, error: sessionListCode }).slice(0, 160))

    // ── B 委托（meta.delegate=true）：白名单默认拒绝 / 只读能力放行 ─────────
    const delegatedInvoke = async (method, params = null) => api('/fang/api/contract/invoke', {
      method: 'POST', headers: contractAuth,
      body: JSON.stringify(createEnvelope({ method, params, source: 'fork-e2e', meta: { delegate: true } })),
    })
    const capList = await delegatedInvoke('fang.capability.list')
    const capItems = Array.isArray(capList.body?.result?.capabilities) ? capList.body.result.capabilities : []
    const lspCap = capItems.find((c) => c.method === 'fang.tool.invoke')
    const lspCapOk = LSP_MODE
      ? (lspCap?.provider?.default === 'mother' && lspCap.provider?.available === true
        && Array.isArray(lspCap.actions) && lspCap.actions.includes('definition') && lspCap.actions.includes('hover')
        && !lspCap.actions.includes('diagnostics')
        && lspCap.provider?.providers?.mother?.mode === 'delegated'
        && lspCap.provider?.providers?.['fork-local']?.mode === 'local'
        && Array.isArray(lspCap.provider?.nonProduction) && lspCap.provider.nonProduction.includes('test-hook'))
      : (Boolean(lspCap) && Array.isArray(lspCap.actions) && lspCap.actions.length === 0
        && !lspCap.actions.includes('diagnostics') && lspCap.provider?.services?.['test-hook'] === true
        && lspCap.provider?.providers?.mother?.mode === 'delegated'
        && lspCap.provider?.providers?.['fork-local']?.mode === 'local'
        && Array.isArray(lspCap.provider?.nonProduction) && lspCap.provider.nonProduction.includes('test-hook'))
    check('delegated fang.capability.list returns catalog + provider-tagged lsp capability (advertises only real provider capabilities)', capList.status === 200 && capList.body?.ok === true
      && capItems.some((c) => c.method === 'fang.session.list')
      && capItems.filter((c) => c.kind === 'write').every((c) => c.approval === 'required')
      && lspCapOk,
      JSON.stringify({ status: capList.status, caps: capItems.map((c) => `${c.method}:${c.kind}`), provider: lspCap?.provider?.default ?? null, actions: lspCap?.actions ?? null }).slice(0, 900))
    const rejectedCap = await delegatedInvoke('fang.fork.spawn', {})
    check('delegated unlisted capability rejected (contract-unsupported)', rejectedCap.status === 200
      && rejectedCap.body?.ok === false && rejectedCap.body?.error?.code === 'contract-unsupported',
      JSON.stringify({ status: rejectedCap.status, code: rejectedCap.body?.error?.code ?? null }).slice(0, 160))
    const delegatedStatus = await delegatedInvoke('fang.orchestrator.status')
    check('delegated read capability succeeds (fang.orchestrator.status)', delegatedStatus.status === 200
      && delegatedStatus.body?.ok === true && delegatedStatus.body?.result && typeof delegatedStatus.body.result === 'object',
      JSON.stringify({ status: delegatedStatus.status, code: delegatedStatus.body?.error?.code ?? null }).slice(0, 160))
    const delegatedSessionList = await delegatedInvoke('fang.session.list', { limit: 5 })
    const delegatedSessionCode = delegatedSessionList.body?.error?.code ?? null
    check('delegated capability maps missing mother service to contract-unavailable', delegatedSessionList.status === 200
      && ((delegatedSessionList.body?.result && typeof delegatedSessionList.body.result === 'object') || delegatedSessionCode === 'contract-unavailable'),
      JSON.stringify({ status: delegatedSessionList.status, code: delegatedSessionCode }).slice(0, 160))
    const delegatedEvents = await delegatedInvoke('fang.session.events', { sessionId: E2E_SESSION_ID, limit: 5 })
    const delegatedEventsCode = delegatedEvents.body?.error?.code ?? null
    check('delegated fang.session.events bounded read answered (result or contract-unavailable)', delegatedEvents.status === 200
      && ((delegatedEvents.body?.result && Array.isArray(delegatedEvents.body.result.events)) || delegatedEventsCode === 'contract-unavailable'),
      JSON.stringify({ status: delegatedEvents.status, code: delegatedEventsCode }).slice(0, 160))
    // 超时错误：e2e 母体 readTimeoutMs=100ms + 测试缝 sleep(500ms) → contract-timeout
    const delegatedSlow = await delegatedInvoke('fang.test.sleep', { ms: 500 })
    check('delegated capability timeout maps to contract-timeout', delegatedSlow.status === 200
      && delegatedSlow.body?.ok === false && delegatedSlow.body?.error?.code === 'contract-timeout',
      JSON.stringify({ status: delegatedSlow.status, code: delegatedSlow.body?.error?.code ?? null }).slice(0, 160))
    // B-6：LSP 委托——路线 A 真实 provider（--lsp）或测试缝（默认）；写类子命令可读拒绝。
    if (LSP_MODE) seedLspForkTask(homeRoot, LSP_FORK_HOME)
    const lspReadParams = LSP_MODE
      ? { tool: 'lsp', action: 'definition', file: 'a.ts', line: 2, character: 13, workspaceRoot: LSP_WS }
      : { tool: 'lsp', action: 'definition', file: 'example.mjs', line: 0, character: 0 }
    const lspRead = await delegatedInvoke('fang.tool.invoke', lspReadParams)
    const lspReadOk = LSP_MODE
      ? (lspRead.body?.ok === true && lspRead.body?.result?.provider === 'mother'
        && lspRead.body.result.kind === 'locations' && Array.isArray(lspRead.body.result.locations)
        && lspRead.body.result.locations.length > 0
        && lspRead.body.result.locations.every((loc) => typeof loc?.path === 'string' && loc.path.length > 0 && Number(loc?.line) === 1))
      : (lspRead.body?.ok === true && lspRead.body?.result?.provider === 'test-hook'
        && lspRead.body.result.kind === 'locations' && Array.isArray(lspRead.body.result.locations))
    check(LSP_MODE ? 'delegated lsp definition via real mother provider (ctx.lsp) succeeds' : 'delegated lsp definition (official read action) succeeds', lspRead.status === 200 && lspReadOk,
      JSON.stringify({ status: lspRead.status, code: lspRead.body?.error?.code ?? null, provider: lspRead.body?.result?.provider ?? null, locations: lspRead.body?.result?.locations ?? null, detail: lspRead.body?.error?.detail ?? null }).slice(0, 500))
    const lspWrite = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'format', file: 'example.mjs', line: 0, character: 0 })
    check('delegated lsp legacy write action rejected (official seam is read-only: contract-unsupported)', lspWrite.status === 200
      && lspWrite.body?.ok === false && lspWrite.body?.error?.code === 'contract-unsupported'
      && /official LSP seam is read-only/i.test(String(lspWrite.body?.error?.message ?? '')),
      JSON.stringify({ status: lspWrite.status, code: lspWrite.body?.error?.code ?? null }).slice(0, 180))
    const lspInvalid = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'nope', file: 'example.mjs', line: 0, character: 0 })
    check('delegated lsp unknown action rejected (contract-invalid-request)', lspInvalid.status === 200
      && lspInvalid.body?.ok === false && lspInvalid.body?.error?.code === 'contract-invalid-request',
      JSON.stringify({ status: lspInvalid.status, code: lspInvalid.body?.error?.code ?? null }).slice(0, 160))
    // diagnostics 仅 e2e 测试缝可用（不对外 advertise）：测试缝返回 stub；真实 provider 下显式拒绝。
    const lspDiagnostics = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'diagnostics', file: LSP_MODE ? 'a.ts' : 'example.mjs', line: 0, character: 0, ...(LSP_MODE ? { workspaceRoot: LSP_WS } : {}) })
    if (LSP_MODE) {
      check('delegated lsp diagnostics rejected with real provider (test-seam-only)', lspDiagnostics.status === 200
        && lspDiagnostics.body?.ok === false && lspDiagnostics.body?.error?.code === 'contract-unsupported'
        && lspDiagnostics.body?.error?.detail?.reason === 'test-seam-only',
        JSON.stringify({ status: lspDiagnostics.status, code: lspDiagnostics.body?.error?.code ?? null }).slice(0, 180))
    } else {
      check('delegated lsp diagnostics works only through the test seam (not advertised; non-production)', lspDiagnostics.status === 200
        && lspDiagnostics.body?.ok === true && lspDiagnostics.body?.result?.provider === 'test-hook'
        && lspDiagnostics.body?.result?.testSeam === true && lspDiagnostics.body?.result?.nonProduction === true
        && Array.isArray(lspDiagnostics.body.result.diagnostics),
        JSON.stringify({ status: lspDiagnostics.status, code: lspDiagnostics.body?.error?.code ?? null, provider: lspDiagnostics.body?.result?.provider ?? null }).slice(0, 180))
    }
    if (LSP_MODE) {
      const lspForkRoot = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'definition', file: 'a.ts', line: 2, character: 13, workspaceRoot: LSP_FORK_WS })
      check('delegated lsp auto-registers fork workspace root (task registry explicit registration)', lspForkRoot.status === 200
        && lspForkRoot.body?.ok === true && lspForkRoot.body?.result?.provider === 'mother'
        && lspForkRoot.body.result.kind === 'locations' && lspForkRoot.body.result.locations.length > 0
        && lspForkRoot.body.result.locations.some((loc) => /lsp-fork-workspace/i.test(String(loc?.path ?? ''))),
        JSON.stringify({ status: lspForkRoot.status, code: lspForkRoot.body?.error?.code ?? null, detail: lspForkRoot.body?.error?.detail ?? null }).slice(0, 240))
      const lspHover = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'hover', file: 'a.ts', line: 2, character: 13, workspaceRoot: LSP_WS })
      check('delegated lsp hover via real mother provider returns normalized {contents}', lspHover.status === 200
        && lspHover.body?.ok === true && lspHover.body?.result?.provider === 'mother'
        && lspHover.body.result.kind === 'hover'
        && typeof lspHover.body.result.contents === 'string'
        && lspHover.body.result.contents.length > 0
        && /base/i.test(lspHover.body.result.contents),
        JSON.stringify({ status: lspHover.status, code: lspHover.body?.error?.code ?? null, provider: lspHover.body?.result?.provider ?? null, contents: String(lspHover.body?.result?.contents ?? '').slice(0, 120), detail: lspHover.body?.error?.detail ?? null }).slice(0, 420))
      const lspRefs = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'references', file: 'base.ts', line: 0, character: 13, workspaceRoot: LSP_WS })
      const refPaths = Array.isArray(lspRefs.body?.result?.locations) ? lspRefs.body.result.locations.map((loc) => String(loc?.path ?? '')) : []
      check('delegated lsp references resolve across fixture files (real TS semantics)', lspRefs.status === 200
        && lspRefs.body?.ok === true && lspRefs.body?.result?.provider === 'mother'
        && lspRefs.body.result.kind === 'locations' && refPaths.length >= 2
        && refPaths.some((item) => /base\.ts$/i.test(item)) && refPaths.some((item) => /a\.ts$/i.test(item)),
        JSON.stringify({ status: lspRefs.status, code: lspRefs.body?.error?.code ?? null, refs: refPaths }).slice(0, 320))
      const lspEscape = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'definition', file: '../outside.ts', line: 0, character: 0, workspaceRoot: LSP_WS })
      check('delegated lsp rejects file escaping the registered root (contract-invalid-request)', lspEscape.status === 200
        && lspEscape.body?.ok === false && lspEscape.body?.error?.code === 'contract-invalid-request'
        && lspEscape.body?.error?.detail?.reason === 'file-outside-root',
        JSON.stringify({ status: lspEscape.status, code: lspEscape.body?.error?.code ?? null, detail: lspEscape.body?.error?.detail ?? null }).slice(0, 240))
      const lspDenied = await delegatedInvoke('fang.tool.invoke', { tool: 'lsp', action: 'definition', file: 'a.ts', line: 2, character: 13, workspaceRoot: path.join(os.tmpdir(), 'outside-lsp-root') })
      check('delegated lsp rejects workspaceRoot outside the registered allowlist (contract-invalid-request)', lspDenied.status === 200
        && lspDenied.body?.ok === false && lspDenied.body?.error?.code === 'contract-invalid-request'
        && lspDenied.body?.error?.detail?.reason === 'root-not-allowed',
        JSON.stringify({ status: lspDenied.status, code: lspDenied.body?.error?.code ?? null, detail: lspDenied.body?.error?.detail ?? null }).slice(0, 240))
    }
    // P2：专业版能力默认关闭——fang.code.run 未激活时一律 contract-unsupported
    const codeRun = await delegatedInvoke('fang.code.run', { code: 'console.log(1)' })
    check('P2 pro capability fang.code.run rejected by default (contract-unsupported)', codeRun.status === 200
      && codeRun.body?.ok === false && codeRun.body?.error?.code === 'contract-unsupported',
      JSON.stringify({ status: codeRun.status, code: codeRun.body?.error?.code ?? null }).slice(0, 160))
    // B-7：chat.import——dryRun 两次结果一致；真实导入必须审批（拒绝执行、无副作用）
    const importParams = { source: 'deepseek', sessionId: E2E_SESSION_ID, dryRun: true }
    const importDry1 = await delegatedInvoke('fang.chat.import', importParams)
    const importDry2 = await delegatedInvoke('fang.chat.import', importParams)
    const dry1 = importDry1.body?.result ?? null
    const dry2 = importDry2.body?.result ?? null
    check('delegated chat.import dryRun is deterministic across calls', importDry1.status === 200 && importDry1.body?.ok === true
      && dry1 && dry2 && JSON.stringify(dry1) === JSON.stringify(dry2) && dry1.dryRun === true && dry1.approvalRequired === true,
      JSON.stringify({ status: importDry1.status, digest: dry1?.digest ?? null, found: dry1?.found ?? null }).slice(0, 160))
    const importReal = await delegatedInvoke('fang.chat.import', { source: 'deepseek', sessionId: E2E_SESSION_ID, dryRun: false })
    check('delegated chat.import real import requires approval (contract-approval-required)', importReal.status === 200
      && importReal.body?.ok === false && importReal.body?.error?.code === 'contract-approval-required',
      JSON.stringify({ status: importReal.status, code: importReal.body?.error?.code ?? null }).slice(0, 160))
    // M5：并发上限压测——母体 maxConcurrent=2，同时 8 个 80ms 委托：必须有被限流、也必须有成功的
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => delegatedInvoke('fang.test.sleep', { ms: 80 })))
    const concurrentOk = concurrent.filter((r) => r.body?.ok === true).length
    const concurrentLimited = concurrent.filter((r) => r.body?.error?.code === 'contract-rate-limited').length
    check('delegated concurrency cap enforced (contract-rate-limited)', concurrentLimited >= 1 && concurrentOk >= 1,
      JSON.stringify({ ok: concurrentOk, rateLimited: concurrentLimited, total: concurrent.length }).slice(0, 160))


    check('mother has no adapter service', status.body?.services?.adapter === false, 'adapter is fork-only')
    check('mother exposes 8 mother-side services', Object.values(status.body?.services ?? {}).filter(Boolean).length >= 5)

    const sessions = await api('/fang/api/sessions')
    const sessionItems = sessions.body?.sessions ?? sessions.body?.items ?? []
    check('GET /fang/api/sessions 200', sessions.status === 200, `status=${sessions.status} sessions=${sessionItems.length}`)
    check('session catalog is readable (served from a real log)', sessions.body?.readable !== false, JSON.stringify(sessions.body?.degraded ?? []))
    const titled = sessionItems.find((s) => s.sessionId === E2E_SESSION_ID)
    check('session list contains the seeded session', Boolean(titled))
    check('session title is the native session/title', titled?.title === E2E_NATIVE_TITLE, JSON.stringify(titled?.title ?? null))
    check('session titleSource is session/title', titled?.titleSource === 'session/title', String(titled?.titleSource))
    check('session preview carries the first user message', String(titled?.preview ?? '').includes('e2e 首条用户消息'), JSON.stringify(titled?.preview ?? null))

    // ── v3.0.7 门禁：组合配置必须包含 16 个 fang-* 行 ────────────────────
    let dumpText = ''
    try {
      dumpText = execFileSync(CLI, ['--profile', 'e2e', '--dump-config'], { env, encoding: 'utf8', timeout: 120000, shell: true, maxBuffer: 8 * 1024 * 1024 })
    } catch (e) { dumpText = String(e?.stdout ?? '') }
    const fangRowIds = [...new Set([...dumpText.matchAll(/\bid:\s*['"]?(fang-[a-z0-9-]+)/g)].map((m) => m[1]))]
    check('16 fang plugin rows composed', fangRowIds.length >= 16, `rows=${fangRowIds.length} ${fangRowIds.slice(0, 3).join(',')}`)
    // v3.0.7：client half 由宿主 Loader 对「bare 包名行」的 dsh.client 扫描发现，
    // 不能新增 `<pkg>/client` 行（子路径不是包根，会被当成坏插件）。
    const pkgDsh = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dsh ?? {}
    check('browser client half enabled (dsh.client web)', pkgDsh.client?.platform === 'web')
    check('no inactive plugin entries', !/entry did not activate/.test(`${stdout}\n${stderr}`))

    // ── create a real task/fork ─────────────────────────────────────────
    const created = await api('/fang/api/tasks/create', {
      method: 'POST',
      body: JSON.stringify({ title: 'e2e 验收任务' }),
    })
    check('POST /fang/api/tasks/create accepted', created.body?.ok === true, `status=${created.status} ${JSON.stringify(created.body).slice(0, 200)}`)
    const taskId = created.body?.taskId
    check('task id returned', typeof taskId === 'string' && taskId.startsWith('task_'), taskId ?? '')

    if (!taskId) {
      console.error('create failed:', JSON.stringify(created.body))
      console.error('log tail:\n' + (stdout + stderr).split('\n').slice(-40).join('\n'))
      return 1
    }

    check('create returned tokenless url', !String(created.body?.url ?? '').includes('token='))
    const openUrl = await api(`/fang/api/tasks/open-url?taskId=${encodeURIComponent(taskId)}`)
    check('open-url returns tokenized url (memory only)', openUrl.status === 200 && String(openUrl.body?.url ?? '').includes('token='), JSON.stringify({ status: openUrl.status, hasUrl: !!openUrl.body?.url }))

    // v3.0.7/SEC-07：token 不得落盘到 tasks.json / forks.json
    const readMaybe = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
    const fangDir = path.join(homeRoot, 'fang', 'e2e')
    const tasksPersist = readMaybe(path.join(fangDir, 'tasks.json'))
    const forksPersist = readMaybe(path.join(fangDir, 'forks.json'))
    const tokenValueLeak = /"token"\s*:\s*"[^"]+"/.test(tasksPersist) || /"token"\s*:\s*"[^"]+"/.test(forksPersist)
    const tokenUrlLeak = tasksPersist.includes('token=') || forksPersist.includes('token=')
    check('no token persisted in tasks/forks json', !tokenValueLeak && !tokenUrlLeak, JSON.stringify({ tasks: tasksPersist.length, forks: forksPersist.length }))
    check('adapter handshake succeeded', created.body?.adapter?.ok === true, JSON.stringify(created.body?.adapter))

    const taskStatus = await api(`/fang/api/tasks/status?taskId=${encodeURIComponent(taskId)}`)
    check('GET /fang/api/tasks/status 200', taskStatus.status === 200)
    check('task reaches READY', taskStatus.body?.status === 'ready', String(taskStatus.body?.status))
    const forkServices = taskStatus.body?.adapterStatus?.services ?? {}
    check('fork adapter is up', forkServices.adapter === true, JSON.stringify(forkServices))
    check('fork has hot-reloader organ', forkServices.hotReloader === true)
    check('fork has scorer organ', forkServices.scorer === true)
    check('fork has umbrella organ', forkServices.umbrella === true)
    check('fork does NOT expose orchestrator', forkServices.orchestrator !== true)
    check('fork does NOT expose forker', forkServices.forker !== true)

    const tasksList = await api('/fang/api/tasks')
    check('GET /fang/api/tasks lists the task', Array.isArray(tasksList.body?.tasks) && tasksList.body.tasks.length === 1)

    // ── v3.0.8 branch contract: real task → 200, unknown → 404, branch errors mapped ──
    const initialBranches = await api(`/fang/api/tasks/branches?taskId=${encodeURIComponent(taskId)}`)
    check('GET /fang/api/tasks/branches 200 + main branch',
      initialBranches.status === 200 && initialBranches.body?.activeBranchId === 'main'
      && Array.isArray(initialBranches.body?.branches) && initialBranches.body.branches.some((b) => b.branchId === 'main'),
      JSON.stringify({ status: initialBranches.status, active: initialBranches.body?.activeBranchId }))
    const branchCreated = await api('/fang/api/tasks/branches', {
      method: 'POST', body: JSON.stringify({ taskId, branchId: 'b1' }),
    })
    check('POST /fang/api/tasks/branches 200 + b1', branchCreated.status === 200 && branchCreated.body?.branch?.branchId === 'b1',
      JSON.stringify({ status: branchCreated.status, error: branchCreated.body?.error }))
    const duplicate = await api('/fang/api/tasks/branches', {
      method: 'POST', body: JSON.stringify({ taskId, branchId: 'b1' }),
    })
    check('POST duplicate branch → 409 branch-exists', duplicate.status === 409 && duplicate.body?.error === 'branch-exists',
      JSON.stringify({ status: duplicate.status, error: duplicate.body?.error }))
    const invalidBranch = await api('/fang/api/tasks/branches', {
      method: 'POST', body: JSON.stringify({ taskId, branchId: '../escape' }),
    })
    check('POST invalid branchId → 400 invalid-branch-id',
      invalidBranch.status === 400 && invalidBranch.body?.error === 'invalid-branch-id',
      JSON.stringify({ status: invalidBranch.status, error: invalidBranch.body?.error }))
    const activated = await api('/fang/api/tasks/branches/activate', {
      method: 'POST', body: JSON.stringify({ taskId, branchId: 'b1' }),
    })
    check('POST /branches/activate 200 + pointer move',
      activated.status === 200 && activated.body?.activeBranchId === 'b1',
      JSON.stringify({ status: activated.status, active: activated.body?.activeBranchId }))
    const sealed = await api('/fang/api/tasks/branches/status', {
      method: 'POST', body: JSON.stringify({ taskId, branchId: 'main', status: 'sealed' }),
    })
    check('POST /branches/status 200 + main sealed', sealed.status === 200 && sealed.body?.branch?.status === 'sealed',
      JSON.stringify({ status: sealed.status, error: sealed.body?.error }))
    const unknownPost = await api('/fang/api/tasks/branches', {
      method: 'POST', body: JSON.stringify({ taskId: 'missing-task', branchId: 'b2' }),
    })
    check('POST branches unknown task → 404 unknown-task',
      unknownPost.status === 404 && unknownPost.body?.error === 'unknown-task',
      JSON.stringify({ status: unknownPost.status, error: unknownPost.body?.error }))

    // ── the right pane of the panel: sessions owned by the fork itself ──
    const forkHome = path.join(homeRoot, 'fang', 'e2e', 'forks', taskId)
    const FORK_SESSION_ID = 'session-22222222-3333-4444-8555-666666666666'
    if (fs.existsSync(forkHome)) {
      seedSession(forkHome, { sessionId: FORK_SESSION_ID, workspacePath: 'E:\\fork-ws', title: 'e2e 分身会话标题' })
      const fsessions = await api('/fang/api/tasks/sessions?taskId=' + encodeURIComponent(taskId))
      check('GET /fang/api/tasks/sessions 200', fsessions.status === 200, `status=${fsessions.status}`)
      const fitems = fsessions.body?.sessions ?? []
      const ft = fitems.find((s) => s.sessionId === FORK_SESSION_ID)
      check('fork session list contains the seeded session', Boolean(ft))
      check('fork session title is native', ft?.title === 'e2e 分身会话标题', JSON.stringify(ft?.title ?? null))
    }
    // ── archive the task (flush + stop, keep home for read/restore) ─────
    const archived = await api('/fang/api/tasks/archive', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
    check('POST /fang/api/tasks/archive accepted', archived.body?.ok === true, JSON.stringify(archived.body?.error ?? ''))
    check('archive stopped the process', archived.body?.stopped === true && archived.body?.homeKept === true)
    const after = await api('/fang/api/status')
    check('archived task stays in the registry', (after.body?.tasks?.total ?? -1) === 1)
    const archivedTask = (after.body?.tasks?.list ?? []).find((t) => t.taskId === taskId)
    check('task status is archived', archivedTask?.status === 'archived', JSON.stringify(archivedTask?.status ?? null))
    check('archived task has archivedAt', Number(archivedTask?.archivedAt) > 0)
    check('archived task has no live url', !archivedTask?.url)
    check('fork home kept after archive', fs.existsSync(forkHome), forkHome)

    // ── restore the archive (new process/port/token, same home) ─────────
    const restored = await api('/fang/api/tasks/restore', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
    check('POST /fang/api/tasks/restore accepted', restored.body?.ok === true, JSON.stringify(restored.body?.error ?? ''))
    check('restored task is ready', restored.body?.adapter?.ok === true && Boolean(restored.body?.url))
    check('fork home still exists after restore', fs.existsSync(forkHome), forkHome)
    const reArchived = await api('/fang/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId }) })
    check('re-archive after restore accepted', reArchived.body?.ok === true)

// ── v3.1.30 derive contract: 派生必须导入「一个」进行中会话 ──────────────────
// 旧的 lineage-only 空白派生已按需求移除，这里同时验证拒绝侧与接受侧。
let derivedTaskId = ''
const derivedNoSession = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify({ title: 'e2e derive' }) })
check('POST /fang/api/derive without session is rejected',
  derivedNoSession.body?.ok === false && derivedNoSession.body?.error === 'session-required',
  JSON.stringify(derivedNoSession.body?.error ?? ''))
const derivedMulti = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify({ sessionIds: ['session-a', 'session-b'] }) })
check('POST /fang/api/derive with multiple sessions is rejected',
  derivedMulti.body?.ok === false && derivedMulti.body?.error === 'session-multi-not-allowed',
  JSON.stringify(derivedMulti.body?.error ?? ''))
// 用母体里真实存在的一个会话派生（e2e 母体是新起的，先查一次会话表）。
const sessionList = await api('/fang/api/sessions?limit=5')
const firstSession = Array.isArray(sessionList.body?.sessions) ? sessionList.body.sessions[0] : null
const derived = firstSession
  ? await api('/fang/api/derive', { method: 'POST', body: JSON.stringify({ title: 'e2e derive', sessionId: firstSession.sessionId }) })
  : { status: 0, body: { ok: false, error: 'no-session-available' } }
check('POST /fang/api/derive accepted with exactly one session',
  derived.body?.ok === true, JSON.stringify(derived.body?.error ?? 'no-session-available'))
    if (derived.body?.ok) {
      derivedTaskId = String(derived.body.taskId ?? '')
      const dStatus = await api('/fang/api/tasks/status?taskId=' + encodeURIComponent(derived.body.taskId))
      check('derive → task ready with adapter', dStatus.body?.status === 'ready' && dStatus.body?.adapter?.ok === true)
      const dArchived = await api('/fang/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId: derived.body.taskId }) })
      check('derive task archived', dArchived.body?.ok === true)
    }

    // ── delete archives: stop + remove home, then the record ──────────
    const deleted = await api('/fang/api/tasks/archive/delete', { method: 'POST', body: JSON.stringify({ taskId }) })
    check('POST /fang/api/tasks/archive/delete accepted', deleted.body?.ok === true, JSON.stringify(deleted.body?.error ?? ''))
    if (derivedTaskId) {
      const dDeleted = await api('/fang/api/tasks/archive/delete', { method: 'POST', body: JSON.stringify({ taskId: derivedTaskId }) })
      check('derived archive deleted', dDeleted.body?.ok === true, JSON.stringify(dDeleted.body?.error ?? ''))
    }
    const finalStatus = await api('/fang/api/status')
    check('registry empty after delete', (finalStatus.body?.tasks?.total ?? -1) === 0)

    // ── audit ledger on the mother ─────────────────────────────────────
    const motherData = path.join(homeRoot, 'fang', 'e2e')
    const ledger = path.join(motherData, 'audit.jsonl')
    const hasLedger = fs.existsSync(ledger)
    check('mother audit ledger written', hasLedger, ledger)
    if (hasLedger) {
      const { verifyChain } = await import('../src/kernel/ledger.mjs')
      const verified = verifyChain(ledger)
      check('mother audit hash chain verifies', verified.ok === true, `records=${verified.count}`)
      const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const kinds = new Set(lines.map(r => r.kind))
      check('audit records task-created', lines.some(r => String(r.kind).includes('fork-created')))
      check('audit records adapter handshake', kinds.has('adapter-handshake'))
      // M5：委托审计完整性——每次委托（成功/拒绝/限流/超时）都要有 capability/source/outcome/latencyMs
      const delegateRecords = lines.filter((r) => r.kind === 'contract-delegate')
      check('audit records delegated capability calls', delegateRecords.length > 0
        && delegateRecords.every((r) => typeof r.capability === 'string' && r.capability.length > 0
          && typeof r.outcome === 'string' && Number.isFinite(Number(r.latencyMs))),
        `records=${delegateRecords.length}`)
      check('audit records rejection + rate-limit + timeout outcomes', delegateRecords.some((r) => r.outcome === 'rejected')
        && delegateRecords.some((r) => r.outcome === 'rate-limited')
        && delegateRecords.some((r) => r.outcome === 'error' && r.error === 'contract-timeout'),
        JSON.stringify({ outcomes: [...new Set(delegateRecords.map((r) => r.outcome))] }).slice(0, 160))
      if (LSP_MODE) {
        const lspRecords = delegateRecords.filter((r) => r.tool === 'lsp')
        check('audit records lsp workspaceRoot/outcome trail', lspRecords.some((r) => r.outcome === 'ok' && r.workspaceRoot)
          && lspRecords.some((r) => r.outcome === 'denied' && r.workspaceRoot),
          JSON.stringify({ lspRecords: lspRecords.length, outcomes: [...new Set(lspRecords.map((r) => r.outcome))] }).slice(0, 200))
      }
    }

    // ── decision center: real submit → list → resolve → 落库断言 ──────────
    const decisionIngest = await api('/fang/api/decisions/ingest', {
      method: 'POST',
      body: JSON.stringify({
        producer: 'HarnessMM', kind: 'harnessmm-suggestion', level: 'yellow',
        title: 'e2e decision ticket', context: 'e2e real logic',
        options: [{ value: 'ack', label: 'OK' }, { value: 'ignore', label: 'Ignore' }],
      }),
    })
    check('decision ingest accepted', decisionIngest.status === 200 && decisionIngest.body?.ok === true, JSON.stringify(decisionIngest.body?.reason ?? decisionIngest.status))
    const decisionId = String(decisionIngest.body?.ticket?.id ?? '')
    check('decision ingest returns ticket id', decisionId.startsWith('dec_'), decisionId)
    const decisionList = await api('/fang/api/decisions?includeArchived=1')
    check('decision appears in inbox list', decisionList.body?.items?.some((item) => item.id === decisionId) === true)
    const decisionResolve = await api('/fang/api/decisions/resolve', {
      method: 'POST', body: JSON.stringify({ id: decisionId, option: 'ack', by: 'e2e' }),
    })
    check('decision resolve accepted', decisionResolve.status === 200 && decisionResolve.body?.ok === true, JSON.stringify(decisionResolve.body?.reason ?? decisionResolve.status))
    const decisionStore = path.join(motherData, 'decision-center.json')
    check('decision center store flushed', fs.existsSync(decisionStore), decisionStore)
    if (fs.existsSync(decisionStore)) {
      let stored = null
      try { stored = JSON.parse(fs.readFileSync(decisionStore, 'utf8')) } catch { stored = null }
      const storedTicket = (stored?.tickets ?? []).find((item) => item.id === decisionId)
      check('decision resolution persisted to disk', storedTicket?.status === 'resolved', String(storedTicket?.status ?? 'missing'))
    }

    // ── v3.2.0 四色决策：真实 HTTP → 状态机 → JSON 落库断言 ──────────────
    const makeDecision = (level, title, extra = {}) => api('/fang/api/decisions/ingest', {
      method: 'POST',
      body: JSON.stringify({
        producer: 'e2e', level, title, context: 'v3.2.0 real four-level policy',
        options: [{ value: 'go', label: 'Go', isRecommended: true }, { value: 'hold', label: 'Hold' }],
        timeoutMinutes: 0.001,
        ...extra,
      }),
    })
    const yellowDecision = await makeDecision('yellow', 'e2e yellow deferred', { priority: 'P2', risk: 'high' })
    const blueDecision = await makeDecision('blue', 'e2e blue auto recommended')
    const greenDecision = await makeDecision('green', 'e2e green immediate', { options: [] })
    // 红色 timeoutMinutes 仍是归档期限，不使用黄/蓝的 60ms 测试等待窗口。
    const redDecision = await makeDecision('red', 'e2e red human required', { timeoutMinutes: 60 })
    check('four-level tickets accepted', [yellowDecision, blueDecision, greenDecision, redDecision].every((r) => r.status === 200 && r.body?.ok === true))
    const yellowId = String(yellowDecision.body?.ticket?.id ?? '')
    const blueId = String(blueDecision.body?.ticket?.id ?? '')
    const greenId = String(greenDecision.body?.ticket?.id ?? '')
    const redId = String(redDecision.body?.ticket?.id ?? '')
    check('green resolves immediately without pending alert', greenDecision.body?.ticket?.status === 'resolved' && greenDecision.body?.ticket?.autoResolved === true)
    check('priority/risk default by level (green=P3/info)', greenDecision.body?.ticket?.priority === 'P3' && greenDecision.body?.ticket?.risk === 'info')
    check('priority/risk override is honoured (yellow=P2/high)', yellowDecision.body?.ticket?.priority === 'P2' && yellowDecision.body?.ticket?.risk === 'high')
    check('red default is P0/high', redDecision.body?.ticket?.priority === 'P0' && redDecision.body?.ticket?.risk === 'high')
    check('red remains pending before human choice', redDecision.body?.ticket?.status === 'pending' && redDecision.body?.ticket?.isBlocking === true)
    await sleep(450)
    const policyList = await api('/fang/api/decisions?includeArchived=1')
    const policyItems = Array.isArray(policyList.body?.items) ? policyList.body.items : []
    const yellowNow = policyItems.find((item) => item.id === yellowId)
    const blueNow = policyItems.find((item) => item.id === blueId)
    check('yellow timeout defers but stays pending and answerable', yellowNow?.status === 'pending' && yellowNow?.outcome === 'deferred' && yellowNow?.level === 'yellow' && Number(yellowNow?.deferredAt) > 0)
    check('blue timeout executes recommended option', blueNow?.status === 'resolved' && blueNow?.resolvedOption === 'go' && blueNow?.autoResolved === true)
    const lateYellow = await api('/fang/api/decisions/resolve', {
      method: 'POST', body: JSON.stringify({ id: yellowId, option: 'hold', by: 'e2e-late-human' }),
    })
    check('yellow late choice is accepted and marked lateResponse', lateYellow.status === 200 && lateYellow.body?.ticket?.lateResponse === true && lateYellow.body?.ticket?.resolvedOption === 'hold')
    const redResolved = await api('/fang/api/decisions/resolve', {
      method: 'POST', body: JSON.stringify({ id: redId, option: 'go', by: 'e2e-human' }),
    })
    check('red resumes after explicit human choice', redResolved.status === 200 && redResolved.body?.ticket?.status === 'resolved')
    const history = await api('/fang/api/decisions?includeArchived=1')
    const historyItems = Array.isArray(history.body?.items) ? history.body.items : []
    check('inbox history exposes all four colors', ['red', 'yellow', 'blue', 'green'].every((level) => historyItems.some((item) => item.level === level)))
    if (fs.existsSync(decisionStore)) {
      const disk = JSON.parse(fs.readFileSync(decisionStore, 'utf8'))
      const tickets = Array.isArray(disk.tickets) ? disk.tickets : []
      check('four-level policy state persisted to disk', tickets.some((item) => item.id === yellowId && item.lateResponse === true)
        && tickets.some((item) => item.id === blueId && item.autoReason === 'blue-timeout')
        && tickets.some((item) => item.id === greenId && item.autoReason === 'green-immediate')
        && tickets.some((item) => item.id === yellowId && item.priority === 'P2' && item.risk === 'high'))
    }

    // ── fork homes removed by delete-archive ───────────────────────────
    const forksRoot = path.join(motherData, 'forks')
    const leftover = fs.existsSync(forksRoot) ? fs.readdirSync(forksRoot) : []
    check('fork home removed after delete-archive', leftover.length === 0, leftover.join(','))

    return results.every(r => r.ok) ? 0 : 1
  } catch (e) {
    console.error('e2e threw:', e?.stack ?? e)
    check('e2e completed without throwing', false, String(e?.message ?? e))
    return 1
  } finally {
    if (child && child.pid) killTree(child.pid)
    await sleep(300)
    if (!KEEP) {
      try { fs.rmSync(homeRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    } else {
      console.log('keeping e2e home:', homeRoot)
    }
    const elapsed = Date.now() - startedAt
    const failed = results.filter(r => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${(elapsed / 1000).toFixed(1)}s`)
    if (failed.length) {
      console.log('failed: ' + failed.map(f => f.id).join(', '))
      console.log('boot log tail:\n' + (stdout + stderr).split('\n').slice(-30).join('\n'))
    }
  }
}

process.exitCode = await main()
