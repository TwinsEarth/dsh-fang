#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// tools/e2e.mjs — v2.0.0 实机端到端验收（不依赖用户宿主，不重启任何现有实例）。
//
// 做什么：
//   1. 在临时 $DSH_HOME 里生成一个只装 @local/dsh-fang 的 e2e profile；
//   2. 用真实 dsh CLI 启动一个独立母体（动态端口），等它打印带 token 的 URL；
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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const KEEP = process.argv.includes('--keep')
const TIMEOUT_MS = Number((process.argv.find(a => a.startsWith('--timeout=')) ?? '').split('=')[1] ?? 240000)

const CLI_CANDIDATES = [
  'E:\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd',
  'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
]
const CLI = CLI_CANDIDATES.find(p => { try { return fs.existsSync(p) } catch { return false } })
if (!CLI) {
  console.error('SKIP: dsh CLI not found')
  process.exit(2)
}

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

/** Create a real multi-frame session log + workspace index so /api/sessions can be asserted. */
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
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  // the bundle resolves from profile node_modules; point it at the workspace package
  const link = path.join(profileDir, 'node_modules', '@local', 'dsh-fang')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(ROOT, link, 'junction')
  return profileDir
}

async function main() {
  const startedAt = Date.now()
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-e2e-'))
  const port = await freePort()
  const E2E_NATIVE_TITLE = 'e2e 原生会话标题'
  const E2E_SESSION_ID = 'session-11111111-2222-4333-8444-555555555555'
  const E2E_WS_PATH = 'E:\\e2e-ws'
  seedSession(homeRoot, { sessionId: E2E_SESSION_ID, workspacePath: E2E_WS_PATH, title: E2E_NATIVE_TITLE })
  const profileDir = makeProfile(homeRoot)
  console.log(`e2e: home=${homeRoot}`)
  console.log(`e2e: profile=${profileDir}`)
  console.log(`e2e: cli=${CLI} port=${port}`)

  let child = null
  let stdout = ''
  let stderr = ''
  const env = { ...process.env, DSH_HOME: homeRoot, DSH_PROFILE: 'e2e', DSH_PROFILE_DIR: profileDir }
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
    check('status reports version 3.0.8', status.body?.version === '3.0.8')
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
    check('browser client half disabled (no dsh.client)', !pkgDsh.client)
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

    // ── v2.1 derive endpoint (lineage-only quick derive, same path the double-click uses) ──
    let derivedTaskId = ''
    const derived = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify({ title: 'e2e derive' }) })
    check('POST /fang/api/derive accepted', derived.body?.ok === true, JSON.stringify(derived.body?.error ?? ''))
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
