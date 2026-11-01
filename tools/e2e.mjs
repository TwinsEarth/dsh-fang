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

    const api = async (p, opts = {}) => {
      const url = `${booted.url.replace(/\/\?.*$/, '')}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      const res = await fetch(url, {
        ...opts,
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      })
      const text = await res.text()
      let body = null
      try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
      return { status: res.status, body }
    }

    const status = await api('/fang/api/status')
    console.log('mother config:', JSON.stringify(status.body?.mother))
    check('GET /fang/api/status 200', status.status === 200, `version=${status.body?.version}`)
    check('status reports version 2.6.5', status.body?.version === '2.6.5')
    check('status reports role=mother', status.body?.role === 'mother')
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

    const panel = await fetch(`${booted.url.replace(/\?.*$/, '')}?token=${encodeURIComponent(token)}`).catch(() => null)
    const panelRes = await api('/fang/panel')
    check('GET /fang/panel 200', panelRes.status === 200)
    check('panel is v2', String(panelRes.body?.raw ?? '').includes('dsh-Fang v2') || String(panelRes.body?.raw ?? '').includes('派生新任务'))

    // ── create a real task/fork ─────────────────────────────────────────
    const created = await api('/fang/api/tasks/create', {
      method: 'POST',
      body: JSON.stringify({ title: 'e2e 验收任务' }),
    })
    check('POST /fang/api/tasks/create accepted', created.body?.ok === true, JSON.stringify(created.body?.error ?? ''))
    const taskId = created.body?.taskId
    check('task id returned', typeof taskId === 'string' && taskId.startsWith('task_'), taskId ?? '')

    if (!taskId) {
      console.error('create failed:', JSON.stringify(created.body))
      console.error('log tail:\n' + (stdout + stderr).split('\n').slice(-40).join('\n'))
      return 1
    }

    check('fork returned a tokenized url', String(created.body?.url ?? '').includes('token='))
    check('adapter handshake succeeded', created.body?.adapter?.ok === true, JSON.stringify(created.body?.adapter))

    const taskStatus = await api(`/fang/api/tasks/status?taskId=${encodeURIComponent(taskId)}`)
    check('GET /fang/api/tasks/status 200', taskStatus.status === 200)
    check('task reaches READY', taskStatus.body?.status === 'ready', String(taskStatus.body?.status))
    const forkServices = taskStatus.body?.adapterStatus?.services ?? {}
    check('fork adapter is up', forkServices.adapter === true, JSON.stringify(forkServices))
    check('fork has hot-reloader organ', forkServices.hotReloader === true)
    check('fork has scorer organ', forkServices.scorer === true)
    check('fork does NOT expose orchestrator', forkServices.orchestrator !== true)
    check('fork does NOT expose forker', forkServices.forker !== true)

    const tasksList = await api('/fang/api/tasks')
    check('GET /fang/api/tasks lists the task', Array.isArray(tasksList.body?.tasks) && tasksList.body.tasks.length === 1)

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
    // ── archive the task (flush + reap) ────────────────────────────────
    const archived = await api('/fang/api/tasks/archive', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    })
    check('POST /fang/api/tasks/archive accepted', archived.body?.ok === true, JSON.stringify(archived.body?.error ?? ''))
    const after = await api('/fang/api/status')
    check('registry empty after archive', (after.body?.tasks?.total ?? -1) === 0)


    // ── v2.1 derive endpoint (lineage-only quick derive, same path the double-click uses) ──
    const derived = await api('/fang/api/derive', { method: 'POST', body: JSON.stringify({ title: 'e2e derive' }) })
    check('POST /fang/api/derive accepted', derived.body?.ok === true, JSON.stringify(derived.body?.error ?? ''))
    if (derived.body?.ok) {
      const dStatus = await api('/fang/api/tasks/status?taskId=' + encodeURIComponent(derived.body.taskId))
      check('derive → task ready with adapter', dStatus.body?.status === 'ready' && dStatus.body?.adapter?.ok === true)
      const dArchived = await api('/fang/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId: derived.body.taskId }) })
      check('derive task archived', dArchived.body?.ok === true)
    }

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

    // ── fork home was reaped ───────────────────────────────────────────
    const forksRoot = path.join(motherData, 'forks')
    const leftover = fs.existsSync(forksRoot) ? fs.readdirSync(forksRoot) : []
    check('fork home reaped after archive', leftover.length === 0, leftover.join(','))

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
