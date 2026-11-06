// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-orchestrator — dsh-Fang 母体的「大脑」（v2.0.0）。
//
// 三层拓扑里的第一层：只做任务语义（create / status / promote / archive），
// 进程机制全部交给 Forker，跨进程控制全部交给分身的 Adapter + src/lib/remote.mjs。
// 边界：母体不可变；分身零共享；分身崩溃/回收不经过 restart-guard。
//
// 所有子插件服务通过 ctx.get(SERVICE.x) 可选获取，缺失时显式降级，
// 绝不假装成功。orchestrator 自身只在 mother 角色激活（roleGate）。
import fs from 'node:fs'
import path from 'node:path'

import {
  z, roleGate, resolveFangLayout, resolveProfileDir, resolveSessionsLayout,
  SERVICE, AUDIT, TASK_STATUS, FORK_STATUS, FANG_VERSION, ADAPTER_OP,
  exists, ensureDir, readJson, writeJsonAtomic, writeFileAtomic, sha256, removeTree, copyTree,
  newId, iso, nowMs, bus, sleep, parseWebUrl, probeWebUrl,
  invokeCommercial, commercialConfigSchemaDefaults,
} from '../kernel/index.mjs'
import { parseWorkspaceIndex, scanSessionDirs, readBoundedEvents, extractSessionTitle, encodeWorkspaceKey } from '../lib/session-format.mjs'
import { negotiateProtocol } from '../lib/adapter-protocol.mjs'
import { describeMotherLink, probeLink, readSharedProfileSummary } from '../lib/mother-link.mjs'
import { MirrorManager } from '../lib/mirror.mjs'
import { buildMirrorStatusResponse } from '../lib/mirror-etag.mjs'
import { PreferencesStore } from '../lib/preferences.mjs'
import { EssenceManager, OFFICIAL_ESSENCE_ID, VIP_QUOTAS } from '../lib/essence.mjs'
import { applyForkConfigLock, setProfileConfigReadonly } from '../lib/fork-config-lock.mjs'
import { DEFAULT_ESSENCE_NAME, planDefaultEssence } from '../lib/default-essence.mjs'
import { MirrorUpgradeCoordinator } from '../lib/upgrade-coordinator.mjs'
import { DEFAULT_EXPECTED_ROUTE_COUNT, readCompatStatus, runCompatGate, writeCompatStatus } from '../lib/compat.mjs'
import { buildUpgradeStatus } from '../lib/upgrade-status.mjs'
import { authErrorBody, checkRequestAuth, loadAuthToken } from '../lib/http-auth.mjs'
import { buildEssenceActions, buildTaskActions } from '../lib/ui-actions.mjs'
import { BranchStore } from '../lib/branch-store.mjs'
import { ComposerJournal } from '../lib/composer-journal.mjs'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

export const name = 'fang-orchestrator'
export const inject = []

export const Config = z.object({
  role: z.union([z.const('mother'), z.const('fork')]).default('mother')
    .description('配置层角色；环境 DSH_FANG_ROLE 优先（forker 派生的分身自动为 fork）'),
  maxForks: z.number().min(1).max(64).default(8)
    .description('同时存活的任务/分身上限'),
  motherProfile: z.string().default('')
    .description('母体 profile 名；留空 = 当前 profile（分身模板来源）'),
  profileTemplate: z.string().default('')
    .description('分身 profile 模板目录；留空 = 当前 profile 目录（Forker 的 cleanTemplate 会覆盖）'),
  fangHome: z.string().default('')
    .description('三区数据根（相当于 FANG_HOME）；留空 = 自动（新装默认 D:\\ToFuture，已有旧数据沿用旧布局）'),
  defaultEssenceAuto: z.boolean().default(true)
    .description('新用户自动生成“默认元宝”（仅当没有任何用户元主、且默认插件已有安装时；失败不影响启动）'),
  cliPath: z.string().default('')
    .description('dsh 启动器路径；留空自动探测（PATH 上的 dsh / 安装目录 dsh.cmd）'),
  dataRoot: z.string().default('')
    .description('数据根目录；留空 = $DSH_HOME/fang/<profileTag>'),
  forksRoot: z.string().default('')
    .description('分身 home 根目录；留空 = <dataRoot>/forks'),
  mirrorRoot: z.string().default('')
    .description('母体镜像根目录；留空 = <dataRoot>/mirror（备份/恢复/升级都在这一个文件夹里）'),
  adapterTimeoutMs: z.number().min(100).max(120000).default(10000)
    .description('派生后等待分身 Adapter 就绪的上限（毫秒）；超时任务记为 running（adapter 未就绪）'),
  adapterPollMs: z.number().min(50).max(5000).default(400)
    .description('Adapter 握手轮询间隔（毫秒）'),
  importMaxBytes: z.number().min(0).max(268435456).default(33554432)
    .description('派生时导入母体历史会话日志的大小上限（字节）；超过则只保留交接摘要，不复制历史'),
  allowProcessRestart: z.boolean().default(false)
    .description('是否允许编排器主动重启母体（默认禁止；重启一律交给 restart-guard）'),
  autoReapIdleMinutes: z.number().min(0).max(1440).default(0)
    .description('空闲多少分钟后自动回收任务（0 = 不自终）'),
  archiveStopTimeoutMs: z.number().min(100).max(30000).default(3000)
    .description('归档时等待分身进程真正退出的上限（毫秒）'),
  commercial: z.object({
    collaboration: z.boolean().default(false).description('联合开发（需 fangCommercial provider）'),
    git: z.boolean().default(false).description('本地 Git 快照（需 provider）'),
    backup: z.boolean().default(false).description('云备份（需 provider）'),
    tokenApi: z.boolean().default(false).description('Token API（不在本插件内实现）'),
    teams: z.boolean().default(false).description('团队权限（需 provider）'),
  }).default({}),
  routes: z.object({
    enabled: z.boolean().default(true).description('是否注册 /fang 路由'),
    prefix: z.string().default('/fang').description('路由前缀'),
  }).default({}),
  authToken: z.string().default('')
    .description('v3.0.5/B1：安装级鉴权 token；留空 = 读 DSH_FANG_AUTH_TOKEN 或 <dataDir>/fang-auth.json（0600，自动生成）'),
  authEnabled: z.boolean().default(true)
    .description('v3.0.5/B1：是否要求 /fang/api 携带鉴权 token（默认开启；仅测试/本地调试可关）'),
})

const HTML_ESCAPE = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/** v3.0.5/B4：对外的任务 URL 一律去掉 ?token=（token 只在内存/打开时临时下发）。 */
export function stripUrlToken(url) {
  const raw = String(url ?? '')
  if (!raw) return raw || null
  try {
    const parsed = new URL(raw)
    if (!parsed.searchParams.has('token')) return raw
    parsed.searchParams.delete('token')
    return parsed.toString()
  } catch {
    return raw.replace(/([?&])token=[^&#]*&?/i, (_, sep) => (sep === '?' ? '?' : '')).replace(/[?&]$/, '')
  }
}

/** Find a runnable dsh launcher. `.cmd` wrappers are spawned through a shell by the forker. */
export function resolveCliPath(explicit = '', env = process.env) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (env.DSH_CLI) candidates.push(env.DSH_CLI)
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue
    candidates.push(path.join(dir, 'dsh.cmd'), path.join(dir, 'dsh.exe'), path.join(dir, 'dsh'))
  }
  candidates.push(
    'E:\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd',
    'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
  )
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch { /* next */ }
  }
  return explicit || 'dsh'
}

export function isShellLauncher(cliPath) {
  return /\.(cmd|bat)$/i.test(String(cliPath))
}

/** Durable task registry (v1 files stay readable: they carry the same forkId field). */
function loadRegistry(file) {
  const raw = readJson(file, [])
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.forks)) return raw.forks
  return []
}

function saveRegistry(file, entries) {
  writeJsonAtomic(file, { version: 2, at: iso(), forks: entries })
}

/** Normalize a lineage seed payload; returns null when absent. Bounded by 64 KiB. */
export function normalizeSeed(seed) {
  if (!seed || typeof seed !== 'object') return null
  const sessionId = String(seed.sessionId ?? '').trim()
  const markdown = String(seed.markdown ?? '')
  if (!sessionId && !markdown) return null
  if (markdown.length > 64 * 1024) throw new Error('seed-too-large')
  return { sessionId, markdown: markdown || `# lineage seed\n\n- session: ${sessionId}\n- mode: lineage-only\n` }
}

export function apply(ctx, config) {
  const cfg = { ...Config({}), ...(config ?? {}) }
  const gate = roleGate('orchestrator', { cfgRole: cfg.role, logger: ctx.logger })
  if (!gate.active) return
  const role = gate.role

  const layout = resolveFangLayout({ dataRoot: cfg.dataRoot, forksRoot: cfg.forksRoot, fangHome: cfg.fangHome })
  const branchStore = new BranchStore(layout.dataDir)
  const composerJournal = new ComposerJournal(layout.dataDir)
  // v3.0.5/B1：安装级 token（0600 文件 / env / 显式配置）；关闭仅限测试
  const authToken = cfg.authEnabled === false
    ? ''
    : loadAuthToken(layout.dataDir, cfg.authToken || process.env.DSH_FANG_AUTH_TOKEN)
  const motherProfile = cfg.motherProfile || layout.profileTag
  ensureDir(layout.dataDir)
  ensureDir(layout.forkHomesDir)

  /** @type {Map<string, any>} */
  const tasks = new Map()
  // v2 owns tasks.json. A v1 install only has forks.json; read it once so a live upgrade
  // does not lose the task list, but never write it back (the forker owns that file).
  const registrySource = exists(layout.tasksFile) ? layout.tasksFile : layout.forksFile
  for (const f of loadRegistry(registrySource)) {
    if (f && typeof f.forkId === 'string') {
      const task = normalizeTask(f)
      tasks.set(task.taskId, task)
    }
  }

  const safeGet = (key) => { try { return ctx.get(key) } catch { return undefined } }
  const audit = (kind, data) => {
    try { safeGet(SERVICE.auditor)?.append(kind, data) } catch { /* auditor optional */ }
    try { bus.emit('fang/audit', { kind, data }) } catch { /* ignore */ }
  }
  const persist = () => {
    try {
      // v3.0.5/B4：tasks.json 不落 token，URL 也不带 ?token=（打开时走 open-url 临时下发）
      saveRegistry(layout.tasksFile, [...tasks.values()].map(task => ({
        ...task, token: '', url: stripUrlToken(task.url),
      })))
    } catch { /* best effort */ }
  }
  const forker = () => safeGet(SERVICE.forker)
  const cliPath = () => (cfg.cliPath ? cfg.cliPath : resolveCliPath('', process.env))
  // The booted profile's own directory is authoritative (launcher sets DSH_PROFILE_DIR);
  // resolving "$DSH_HOME/profiles/<tag>" from argv can point at a template that never existed.
  // 分身模板必须来自一个**真的装了本 bundle** 的 profile；否则分身的 node_modules junction
  // 指到一个没有 @local/dsh-fang 的 profile，fork 里所有 /fang 路由都会 404（实测事故）。
  const templateDir = () => {
    const candidates = [cfg.profileTemplate, process.env.DSH_PROFILE_DIR, resolveProfileDir(motherProfile), resolveProfileDir(layout.profileTag)]
    const usable = candidates.filter((dir) => typeof dir === "string" && dir.trim()
      && exists(path.join(dir, "node_modules", "@local", "dsh-fang")))
    if (usable.length > 0) return usable[0]
    return candidates.find((dir) => typeof dir === "string" && dir.trim()) ?? resolveProfileDir(layout.profileTag)
  }
  const commercialHooks = commercialConfigSchemaDefaults()
  for (const key of Object.keys(commercialHooks)) {
    if (cfg.commercial && cfg.commercial[key] === true) commercialHooks[key] = true
  }

  function normalizeTask(f) {
    const taskId = f.taskId ?? f.forkId
    const status = f.status === FORK_STATUS.RUNNING ? TASK_STATUS.RUNNING
      : f.status === FORK_STATUS.CRASHED ? TASK_STATUS.FAILED
        : f.status === FORK_STATUS.STOPPED ? TASK_STATUS.ARCHIVED
          : f.status ?? TASK_STATUS.PROVISIONING
    return {
      taskId,
      forkId: taskId,
      title: f.title ?? f.taskTitle ?? taskId,
      taskTitle: f.title ?? f.taskTitle ?? taskId,
      profile: f.profile,
      homeDir: f.homeDir,
      status,
      createdAt: f.createdAt ?? nowMs(),
      restarts: f.restarts ?? 0,
      pid: f.pid ?? null,
      port: f.port ?? null,
      url: f.url ?? null,
      token: f.token ?? (f.url ? extractTokenSafe(f.url) : ''),
      adapter: f.adapter ?? { ok: false, error: 'not-handshaked' },
      collaborators: Array.isArray(f.collaborators) ? f.collaborators : [],
      template: f.template ?? '',
      essenceId: f.essenceId ?? null,
      sourceEssence: f.sourceEssence ?? null,
      sessions: (() => { const list = scanForkSessions(f); return { count: list.length, violation: list.length > 1 } })(),
    }
  }

  function extractTokenSafe(url) {
    try {
      const u = new URL(String(url))
      return u.searchParams.get('token') ?? ''
    } catch { return '' }
  }

  /** Layout of one fork's private $DSH_HOME (its buffer lives inside it). */
  function forkLayout(info) {
    return resolveFangLayout({
      env: { ...process.env, DSH_HOME: info.homeDir },
      argv: ['--profile', info.profile],
    })
  }

  // ── 跨进程 remote 客户端（懒加载，模块缺失时显式降级）────────────────────────
  let remoteModulePromise = null
  const remoteModule = async () => {
    if (!remoteModulePromise) {
      remoteModulePromise = import('../lib/remote.mjs').catch(() => null)
    }
    return remoteModulePromise
  }
  const remoteCache = new Map()
  async function remoteFor(task) {
    if (!task?.url) return null
    // v3 Bearer token 只从 Forker 内存取（不落盘、不进 task 持久化字段）。
    const adapterToken = (() => {
      try {
        const f = forker()
        return f && typeof f.adapterToken === 'function' ? String(f.adapterToken(task.taskId) ?? '') : ''
      } catch {
        return ''
      }
    })()
    const cached = remoteCache.get(task.taskId)
    if (cached && cached.url === task.url && cached.adapterToken === adapterToken) return cached.client
    const mod = await remoteModule()
    if (!mod || typeof mod.createRemote !== 'function') return null
    const client = mod.createRemote({
      url: task.url,
      token: task.token || (mod.extractToken ? mod.extractToken(task.url) : ''),
      adapterToken,
      timeoutMs: 8000,
    })
    remoteCache.set(task.taskId, { url: task.url, adapterToken, client })
    return client
  }

  /** Poll the fork-side Adapter until it answers hello (bounded by adapterTimeoutMs). */
  async function handshake(task) {
    const client = await remoteFor(task)
    if (!client) {
      task.adapter = { ok: false, error: 'remote-module-missing', at: nowMs() }
      return task.adapter
    }
    const deadline = nowMs() + cfg.adapterTimeoutMs
    let last = null
    while (nowMs() < deadline) {
      const res = await client.hello()
      if (res?.ok && res.data?.ok) {
        // v3 版本协商（PROTOCOL-V3 §2）：旧分身没有 /adapter/version（404）→ 按 legacy 接受；
        // 新分身回 protocol 且超出母体支持区间 → fail-closed，绝不假装 READY。
        let protocol = Number(res.data.protocol) || 0
        let sessionId = String(res.data.sessionId ?? '')
        try {
          const ver = typeof client.version === 'function' ? await client.version() : null
          if (ver?.ok && ver.data) {
            const negotiated = negotiateProtocol(ver.data.protocol)
            if (!negotiated.ok) {
              task.adapter = { ok: false, error: negotiated.reason, protocol: ver.data.protocol, at: nowMs() }
              audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: false, error: negotiated.reason, protocol: ver.data.protocol })
              return task.adapter
            }
            protocol = negotiated.protocol
            sessionId = String(ver.data.sessionId ?? sessionId)
          }
        } catch {
          /* 版本探测失败不改变 hello 的结论；按 hello 自报的 protocol 记录 */
        }
        task.adapter = {
          ok: true,
          version: res.data.version ?? '',
          protocol,
          sessionId,
          role: res.data.role ?? 'fork',
          taskId: res.data.taskId ?? task.taskId,
          at: nowMs(),
        }
        audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: true, version: task.adapter.version, protocol })
        return task.adapter
      }
      last = res
      await sleep(cfg.adapterPollMs)
    }
    task.adapter = { ok: false, error: last?.error ?? last?.kind ?? 'timeout', at: nowMs() }
    audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: false, error: task.adapter.error })
    return task.adapter
  }

  function taskView(t) {
    const live = forker()?.status?.(t.taskId)
    const running = live ? !!live.running : t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.READY
    const status = !running ? (t.status === TASK_STATUS.ARCHIVED ? TASK_STATUS.ARCHIVED : TASK_STATUS.FAILED)
      : (t.adapter?.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING)
    const phase = !running
      ? (t.status === TASK_STATUS.ARCHIVED ? 'archived' : (t.status === TASK_STATUS.FAILED ? 'failed' : 'stopped'))
      : (t.adapter?.ok ? 'running' : 'starting')
    return {
      taskId: t.taskId,
      forkId: t.taskId,
      title: t.title,
      taskTitle: t.title,
      status,
      phase,
      health: { adapter: t.adapter?.ok ? 'ok' : 'pending', error: t.adapter?.error ?? '' },
      // v3.0.7/S1：动作可用性由服务端给出，UI 不再自行推断
      ...(() => {
        const ui = buildTaskActions({ running, archived: t.status === TASK_STATUS.ARCHIVED })
        return { actions: ui.actions, blocks: ui.blocks }
      })(),
      sessionTitle: t.importedSession?.title ?? t.seed?.title ?? '',
      startedAt: t.startedAt ?? live?.startedAt ?? null,
      updatedAt: t.updatedAt ?? live?.exitedAt ?? t.createdAt,
      projectBytes: t.projectBytes ?? 0,
      essenceId: t.essenceId ?? null,
      // 来源原身已被删除：分身仍可运行/归档/还原/删除，但不能重新派生。
      essenceDeleted: Boolean(t.essenceId) && (t.essenceDeleted === true || isTombstoned(t.essenceId)),
      // 方案 B：同一分身可挂多个分支会话，但同时只有一个 active。
      branch: (() => {
        try {
          const store = branchStore.list(t.taskId)
          return { activeBranchId: store.activeBranchId ?? t.activeBranchId ?? null, sessionId: store.sessionId ?? null, count: Array.isArray(store.branches) ? store.branches.length : 0 }
        } catch {
          return { activeBranchId: t.activeBranchId ?? null, sessionId: null, count: 0 }
        }
      })(),
      pid: live?.pid ?? t.pid ?? null,
      port: t.port ?? null,
      url: stripUrlToken(t.url),
      homeDir: t.homeDir,
      profile: t.profile,
      createdAt: t.createdAt,
      restarts: t.restarts ?? 0,
      adapter: { ok: !!t.adapter?.ok, version: t.adapter?.version ?? '', protocol: t.adapter?.protocol ?? 0, error: t.adapter?.error ?? '' },
      collaborators: t.collaborators ?? [],
      seed: t.seed ?? null,
      importedSession: t.importedSession ?? null,
      archivedAt: t.archivedAt ?? null,
      archiveRemote: t.archiveRemote ?? null,
    }
  }

  /**
   * 把一个母体会话日志有界地导入分身自己的 $DSH_HOME（会话目录 + workspace 索引），
   * 让分身原生 UI 能看到这段历史；超过 importMaxBytes 则不复制，只保留交接种子。
   */
  const importSessionIntoFork = (homeDir, meta) => {
    const sessionId = String(meta?.sessionId ?? '').trim()
    const sourceFile = String(meta?.sourceFile ?? '').trim()
    if (!sessionId || !sourceFile) return { ok: false, reason: 'bad-import-meta' }
    let bytes = 0
    try { bytes = fs.statSync(sourceFile).size } catch { return { ok: false, reason: 'source-missing' } }
    if (bytes > cfg.importMaxBytes) return { ok: false, reason: 'too-large', bytes, limit: cfg.importMaxBytes }
    const workspacePath = String(meta?.workspacePath ?? '').trim() || 'imported-session'
    const workspaceKey = encodeWorkspaceKey(workspacePath)
    const workspaceTitle = String(meta?.workspaceTitle ?? '').trim() || '导入的会话'
    const destDir = path.join(homeDir, 'sessions', workspaceKey, sessionId)
    ensureDir(destDir)
    fs.copyFileSync(sourceFile, path.join(destDir, 'session.v4.jsonl.zstd'))

    const storagesDir = path.join(homeDir, 'storages')
    ensureDir(storagesDir)
    const indexFile = path.join(storagesDir, 'workspace.json')
    let doc = null
    try { doc = readJson(indexFile) } catch { doc = null }
    if (!doc || typeof doc !== 'object') {
      doc = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } }
    }
    doc.tables = doc.tables && typeof doc.tables === 'object' ? doc.tables : {}
    doc.tables.workspaces = doc.tables.workspaces && typeof doc.tables.workspaces === 'object' ? doc.tables.workspaces : {}
    doc.global = doc.global && typeof doc.global === 'object' ? doc.global : { initialized: true, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
    doc.global.workspaceIds = Array.isArray(doc.global.workspaceIds) ? doc.global.workspaceIds : []
    const workspaceId = `ws-${sha256(workspacePath).slice(0, 12)}`
    const existing = doc.tables.workspaces[workspaceId]
    const sessionIds = Array.isArray(existing?.sessionIds) ? existing.sessionIds.filter((id) => typeof id === 'string') : []
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    doc.tables.workspaces[workspaceId] = {
      path: workspacePath,
      title: workspaceTitle,
      sessionIds,
      createdAt: existing?.createdAt ?? (Number.isFinite(meta?.createdAt) ? iso(meta.createdAt) : iso(nowMs())),
      updatedAt: iso(nowMs()),
    }
    if (!doc.global.workspaceIds.includes(workspaceId)) doc.global.workspaceIds.push(workspaceId)
    if (!doc.global.defaultWorkspaceId) doc.global.defaultWorkspaceId = workspaceId
    doc.global.initialized = true
    writeJsonAtomic(indexFile, doc)
    return { ok: true, bytes, sessionId, workspacePath, workspaceKey, workspaceTitle, indexFile }
  }

  // v3.0.9 单会话强制：扫分身自己的 sessions，保留最新一个，其余移到 quarantine-sessions/。
  const scanForkSessions = (task) => {
    const root = path.join(String(task?.homeDir ?? ''), 'sessions')
    const out = []
    try {
      for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue
        const wsDir = path.join(root, workspace.name)
        for (const session of fs.readdirSync(wsDir, { withFileTypes: true })) {
          if (!session.isDirectory()) continue
          const full = path.join(wsDir, session.name)
          let mtime = 0
          try { mtime = fs.statSync(full).mtimeMs } catch { mtime = 0 }
          out.push({ workspaceKey: workspace.name, sessionId: session.name, path: full, mtime })
        }
      }
    } catch { /* 没有 sessions 目录 */ }
    return out.sort((a, b) => b.mtime - a.mtime)
  }
  const applySingleSessionGuard = (task) => {
    // 受管的分支子会话不参与“单会话”隔离（它们由分支库登记，属于同一分身的合法分支）。
    const branchSessionIds = new Set()
    try {
      for (const branch of branchStore.list(task.taskId).branches ?? []) {
        if (branch?.sessionId) branchSessionIds.add(String(branch.sessionId))
      }
      const storeSession = branchStore.load?.(task.taskId)?.sessionId
      if (storeSession) branchSessionIds.add(String(storeSession))
    } catch { /* 无分支库 */ }
    const sessions = scanForkSessions(task).filter((session) => !branchSessionIds.has(session.sessionId))
    const bindBranches = (keptId) => { try { branchStore?.bindSession?.(task.taskId, keptId) } catch { /* ignore */ } }
    if (sessions.length <= 1) {
      const kept = sessions[0]?.sessionId ?? null
      bindBranches(kept)
      return { ok: true, kept, quarantined: [] }
    }
    const [keep, ...rest] = sessions
    const stamp = String(nowMs())
    const quarantined = []
    for (const session of rest) {
      const target = path.join(task.homeDir, 'quarantine-sessions', stamp, session.workspaceKey, session.sessionId)
      try {
        ensureDir(path.dirname(target))
        try { fs.renameSync(session.path, target) } catch { copyTree(session.path, target); removeTree(session.path) }
        quarantined.push({ workspaceKey: session.workspaceKey, sessionId: session.sessionId, movedTo: target, at: nowMs() })
      } catch { /* 移动失败保留原样，不破坏数据 */ }
    }
    if (quarantined.length > 0) {
      task.quarantinedSessions = (Array.isArray(task.quarantinedSessions) ? task.quarantinedSessions : []).concat(quarantined)
      persist()
      audit('fork-session-quarantined', { taskId: task.taskId, kept: keep.sessionId, moved: quarantined.length })
    }
    bindBranches(keep.sessionId)
    return { ok: true, kept: keep.sessionId, quarantined }
  }

  const tombstonesFile = path.join(layout.dataDir, 'deleted-essences.json')
  const loadTombstones = () => {
    try {
      const doc = readJson(tombstonesFile, {})
      return Array.isArray(doc?.ids) ? doc.ids.map(String) : []
    } catch { return [] }
  }
  const isTombstoned = (essenceId) => loadTombstones().includes(String(essenceId ?? ''))
  const addTombstone = (essenceId, name) => {
    const ids = new Set(loadTombstones())
    ids.add(String(essenceId))
    writeJsonAtomic(tombstonesFile, { ids: [...ids], updatedAt: nowMs(), last: { id: String(essenceId), name: String(name ?? ''), at: nowMs() } })
  }

  // v3.0.9 默认元宝：新用户免创建，自动生成一个带默认插件清单的元主。
  const defaultEssenceFile = path.join(layout.dataDir, 'default-essence.json')
  const readDefaultEssenceId = () => {
    try { return String(readJson(defaultEssenceFile, {})?.essenceId ?? '') } catch { return '' }
  }
  const writeDefaultEssenceId = (essenceId) => writeJsonAtomic(defaultEssenceFile, { essenceId: String(essenceId), at: nowMs() })
  const listInstalledPlugins = async () => {
    try {
      const pm = safeGet('pluginManager')
      if (!pm || typeof pm.listPlugins !== 'function') return null
      const out = await pm.listPlugins()
      if (Array.isArray(out)) return out
      if (Array.isArray(out?.plugins)) return out.plugins
      return null
    } catch { return null }
  }

  const service = {
    role,
    version: FANG_VERSION,
    dataDir: layout.dataDir,

    /** v2 主入口：派生一个任务（= 一个分身）。 */
    async createTask(input = {}) {
      const title = String(input.title ?? input.taskTitle ?? '').trim() || `任务 ${tasks.size + 1}`
      const running = [...tasks.values()].filter(t => {
        const s = taskView(t).status
        return s === TASK_STATUS.RUNNING || s === TASK_STATUS.READY
      }).length
      if (running >= cfg.maxForks) {
        return { ok: false, error: 'quota-exceeded', detail: `已达上限 ${cfg.maxForks}，请先归档旧任务` }
      }
      const f = forker()
      if (!f || typeof f.spawn !== 'function') {
        return { ok: false, error: 'forker-unavailable', detail: 'fang-forker 未加载' }
      }

      const taskId = newId('task')
      const profile = `fang-${taskId.replace(/^task_/, '').slice(0, 12)}`
      const homeDir = path.join(layout.forkHomesDir, taskId)
      const template = String(input.template ?? '').trim()
      // v3.0.9：从原身派生时，模板来源是该原身的 merged/profile（分身只生产，不回写原身）。
      // v3.0.9：未指定来源时，若存在“默认元宝”，快速派生直接以它为模板（新用户小白路径）。
      let essenceIdInput = String(input.essenceId ?? '').trim()
      if (!essenceIdInput && !template) {
        const presetId = readDefaultEssenceId()
        if (presetId && essenceManager.getMeta(presetId)?.id) essenceIdInput = presetId
      }
      let sourceEssence = null
      if (essenceIdInput) {
        const essenceId = essenceIdInput
        const meta = essenceManager.getMeta(essenceId)
        if (!meta || typeof meta.id !== 'string') {
          return { ok: false, error: isTombstoned(essenceId) ? 'essence-deleted' : 'unknown-essence' }
        }
        if (meta.archived === true) return { ok: false, error: 'essence-archived' }
        await essenceManager.ensureFresh(essenceId)
        const fresh = essenceManager.getMeta(essenceId)
        sourceEssence = { id: essenceId, name: meta.name, fingerprint: fresh?.lastMergedFingerprint ?? null }
      }
      const profileTemplate = sourceEssence
        ? essenceManager.mergedProfileDir(sourceEssence.id)
        : (template || templateDir())
      const task = normalizeTask({
        taskId,
        title,
        profile,
        homeDir,
        status: TASK_STATUS.PROVISIONING,
        createdAt: nowMs(),
        collaborators: Array.isArray(input.collaborators) ? input.collaborators : [],
        template,
        essenceId: sourceEssence?.id ?? null,
        sourceEssence,
        adapter: { ok: false, error: 'handshaking' },
      })
      tasks.set(taskId, task)
      persist()

      try {
        const provisioned = await f.provision({
          forkId: taskId,
          taskTitle: title,
          homeDir,
          profile,
          profileTemplate,
          // 从原身派生：配置必须真的来自原身 merged（不能被 clean template 覆盖），
          // node_modules 仍 junction 到母体模块树。
          ...(sourceEssence ? { cleanTemplate: false, nodeModulesSource: path.join(templateDir(), 'node_modules') } : {}),
        })
        if (provisioned && provisioned.ok === false) {
          task.status = TASK_STATUS.FAILED
          persist()
          return { ok: false, error: 'provision-failed', detail: provisioned.error }
        }
        audit(AUDIT.FORK_CREATED, { taskId, forkId: taskId, title, homeDir, profile })

        // 防御：分身的 profile 必须能解析本 bundle；否则派生出来的是一个"没有 /fang 路由"的
        // 僵尸分身（adapter 握手会得到 http-404）。发现即回收并如实报错。
        const forkProfileDir = path.join(homeDir, 'profiles', profile)
        const forkBundle = path.join(forkProfileDir, 'node_modules', '@local', 'dsh-fang')
        if (!exists(forkBundle)) {
          task.status = TASK_STATUS.FAILED
          tasks.delete(taskId)
          persist()
          try { await f.reap(taskId) } catch { /* 回收失败不改变结论 */ }
          audit(AUDIT.FORK_CRASHED, { taskId, error: 'fork-bundle-unavailable', forkProfileDir })
          return { ok: false, error: 'fork-bundle-unavailable', detail: forkProfileDir }
        }


        // v2.1 lineage seed: a bounded handoff digest copied into the fork's own home.
        // The fork reads it; the mother stays immutable (no session mount/copy).
        const seed = normalizeSeed(input.seed ?? (input.seedSessionId ? { sessionId: input.seedSessionId } : null))
        if (seed) {
          try {
            const seedsDir = path.join(homeDir, 'fang-seeds')
            ensureDir(seedsDir)
            const seedId = newId('seed')
            const seedPath = path.join(seedsDir, seedId + '.md')
            writeFileAtomic(seedPath, seed.markdown)
            task.seed = {
              seedId,
              path: seedPath,
              sessionId: seed.sessionId ?? '',
              sha256: sha256(seed.markdown),
              bytes: Buffer.byteLength(seed.markdown, 'utf8'),
            }
            audit(AUDIT.FORK_CREATED + '-seed', { taskId, seedId, sessionId: task.seed.sessionId, bytes: task.seed.bytes })
          } catch (e) {
            task.seed = null
            audit(AUDIT.FORK_CRASHED + '-seed', { taskId, error: String(e?.message ?? e) })
          }
        }

        if (input.importSession && typeof input.importSession === 'object') {
          try {
            task.importedSession = importSessionIntoFork(homeDir, input.importSession)
            audit(AUDIT.FORK_CREATED + '-import', { taskId, ...task.importedSession })
          } catch (e) {
            task.importedSession = { ok: false, reason: 'import-failed', error: String(e?.message ?? e) }
            audit(AUDIT.FORK_CRASHED + '-import', { taskId, error: task.importedSession.error })
          }
          persist()
        }

        const started = await f.spawn({
          forkId: taskId,
          homeDir,
          profile,
          cliPath: cliPath(),
          env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: taskId, DSH_FANG_MOTHER: layout.dataDir },
        })
        if (!started || started.ok === false) {
          task.status = TASK_STATUS.FAILED
          persist()
          audit(AUDIT.FORK_CRASHED, { taskId, error: started?.error ?? 'spawn-failed' })
          bus.emit('fang/task-failed', { taskId, error: started?.error ?? 'spawn-failed' })
          return { ok: false, error: 'spawn-failed', detail: started?.error ?? 'unknown' }
        }
        task.status = TASK_STATUS.RUNNING
        task.pid = started.pid ?? null
        task.port = started.port ?? null
        task.url = started.url ?? null
        task.token = started.token ?? extractTokenSafe(task.url)
        persist()
        audit(AUDIT.FORK_STARTED, { taskId, pid: task.pid, port: task.port, profile })
        bus.emit('fang/task-created', { taskId, forkId: taskId, title, url: task.url, port: task.port })

        const reachable = await probeWebUrl(task.url).catch(() => ({ ok: false }))
        const adapter = await handshake(task)
        task.status = adapter.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING
        persist()
        audit(AUDIT.TASK_READY, { taskId, adapter, reachable: !!reachable.ok })

        // 商用钩子：联合开发（无 provider 时返回 not-configured，不阻塞）。
        if (task.collaborators.length && commercialHooks.collaboration) {
          await invokeCommercial({
            commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'collaboration',
            method: 'publishChange', args: [{ taskId, pluginId: '', files: [] }],
          })
        }

        return {
          ok: true,
          taskId,
          forkId: taskId,
          title,
          url: stripUrlToken(task.url),
          port: task.port,
          homeDir,
          profile,
          adapter: { ok: adapter.ok, version: adapter.version ?? '', error: adapter.error ?? '' },
          reachable: !!reachable.ok,
          seed: task.seed,
        }
      } catch (e) {
        task.status = TASK_STATUS.FAILED
        persist()
        audit(AUDIT.FORK_CRASHED, { taskId, error: String(e?.message ?? e) })
        bus.emit('fang/task-failed', { taskId, error: String(e?.message ?? e) })
        return { ok: false, error: 'create-task-threw', detail: String(e?.message ?? e) }
      }
    },

    /** v1 兼容别名：fork 就是一个任务。 */
    async fork(request = {}) {
      return service.createTask({ title: request.taskTitle ?? request.title, template: request.basePlugin })
    },

    listTasks() {
      return [...tasks.values()].map(taskView).sort((a, b) => a.createdAt - b.createdAt)
    },

    /** v3.0.6：任务重命名（archived 拒绝；1–80 字符）。 */
    renameTask(taskId, title) {
      const id = String(taskId ?? '').trim()
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status === TASK_STATUS.ARCHIVED) return { ok: false, error: 'task-archived' }
      const clean = String(title ?? '').trim()
      if (clean.length === 0 || clean.length > 80) return { ok: false, error: 'invalid-title' }
      task.title = clean
      task.updatedAt = nowMs()
      persist()
      audit(AUDIT.FORK_CREATED + '-rename', { taskId: id, title: clean })
      return { ok: true, task: taskView(task) }
    },

    /** v3.0.6：复制分身访问信息（不克隆实例；token 不返回，打开走 open-url）。 */
    copyTaskInfo(taskId) {
      const task = tasks.get(String(taskId ?? '').trim())
      if (!task) return { ok: false, error: 'unknown-task' }
      return { ok: true, taskId: task.taskId, title: task.title, url: stripUrlToken(task.url), port: task.port ?? null }
    },

    /** v3.0.6：导出分身元数据清单（完整项目/会话打包留给后续版本）。 */
    downloadTaskManifest(taskId) {
      const task = tasks.get(String(taskId ?? '').trim())
      if (!task) return { ok: false, error: 'unknown-task' }
      return {
        ok: true,
        manifest: {
          version: 1,
          taskId: task.taskId,
          title: task.title,
          createdAt: task.createdAt,
          status: taskView(task).phase,
          port: task.port ?? null,
          importedSession: task.importedSession ?? null,
          seed: task.seed ?? null,
          files: [],
          note: 'v3.0.6 metadata-only; full project/session archive is planned for v3.0.7',
        },
      }
    },

    listForks() {
      return service.listTasks()
    },

    async getTaskStatus(taskId) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      const view = taskView(task)
      const client = task.adapter?.ok ? await remoteFor(task) : null
      let adapterStatus = null
      if (client) {
        const res = await client.status()
        adapterStatus = res.ok ? res.data : { ok: false, error: res.error ?? res.kind }
      }
      return {
        ok: true,
        taskId: task.taskId,
        status: view.status,
        title: view.title,
        fork: {
          pid: view.pid, port: view.port, url: view.url, homeDir: view.homeDir,
          profile: view.profile, createdAt: view.createdAt,
        },
        adapter: view.adapter,
        adapterStatus,
      }
    },

    async getForkHealth(forkId) {
      const status = await service.getTaskStatus(forkId)
      if (status.ok === false) return status
      const probe = status.fork.url
        ? await probeWebUrl(status.fork.url).catch(() => ({ ok: false }))
        : { ok: false, reason: 'no-url' }
      return {
        ok: probe.ok,
        forkId,
        taskId: forkId,
        status: status.status,
        pid: status.fork.pid,
        port: status.fork.port,
        url: status.fork.url,
        probe,
        adapter: status.adapter,
      }
    },

    /**
     * v2 提升：从分身取回插件源码 → 母体阈值复核 → Router 初判 → 审批 → A/B → staging。
     * 与 v1 的 promote() 区别：走 Adapter 跨进程取源码与分身评分，不再假设母体能读分身磁盘。
     */
    async promoteTask(taskId, pluginId) {
      const id = String(taskId ?? '')
      const plugin = String(pluginId ?? '').trim()
      if (!id) return { ok: false, error: 'task-id-required' }
      if (!plugin) return { ok: false, error: 'plugin-id-required' }
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (!task.adapter?.ok) return { ok: false, error: 'adapter-unavailable', detail: task.adapter?.error ?? '' }

      const client = await remoteFor(task)
      if (!client) return { ok: false, error: 'remote-unavailable' }

      const read = await client.command(ADAPTER_OP.READ_PLUGIN, { pluginId: plugin })
      if (!read.ok || read.data?.ok === false) {
        return { ok: false, error: 'read-plugin-failed', detail: read.data?.error ?? read.error ?? '' }
      }
      const files = read.data?.result?.files ?? {}
      if (!Object.keys(files).length) return { ok: false, error: 'plugin-not-found', detail: plugin }

      const forkScore = await client.command(ADAPTER_OP.SCORE_PLUGIN, { pluginId: plugin })
      const forkAssessment = forkScore.ok && forkScore.data?.ok ? forkScore.data.result : null

      // Materialize the fetched source into a mother-side work dir, then re-score with
      // the MOTHER threshold policy (母体更严格，且这是真正写进生产的判定).
      const workDir = path.join(layout.dataDir, 'work', `${id}-${plugin}`)
      try {
        removeTree(workDir)
        ensureDir(workDir)
        for (const [rel, content] of Object.entries(files)) {
          const target = resolveInside(workDir, rel)
          if (!target) return { ok: false, error: 'unsafe-plugin-path', detail: rel }
          writeFileAtomic(target, String(content))
        }
      } catch (e) {
        return { ok: false, error: 'materialize-failed', detail: String(e?.message ?? e) }
      }

      const scorer = safeGet(SERVICE.scorer)
      const motherAssessment = scorer?.scoreDir ? scorer.scoreDir(workDir, null, { environment: 'mother' }) : null
      if (!motherAssessment) return { ok: false, error: 'scorer-unavailable' }
      if (motherAssessment.grade === 'D' || motherAssessment.grade === 'E') {
        return { ok: false, error: 'grade-too-low', grade: motherAssessment.grade, score: motherAssessment.S }
      }

      const router = safeGet(SERVICE.router)
      const route = router?.decide
        ? router.decide({
          plugin: { name: plugin, source: 'local-author' },
          assessment: motherAssessment,
          source: 'mother',
        })
        : null
      if (route && route.route !== 'sandbox') {
        return { ok: false, error: 'route-refused', route: route.route, reason: route.reason }
      }

      const approver = safeGet(SERVICE.approver)
      if (!approver) return { ok: false, error: 'approver-unavailable' }

      // 团队权限钩子（无 provider 时放行并记录 basis）。
      let teamBasis = { commercial: false }
      if (commercialHooks.teams) {
        const check = await invokeCommercial({
          commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'teams',
          method: 'check', args: [{ action: 'promote', group: plugin }],
        })
        teamBasis = { commercial: true, ...(check.ok ? check.value : { allowed: true, error: check.error }) }
        if (teamBasis.allowed === false) return { ok: false, error: 'team-denied', basis: teamBasis }
      }

      const decision = typeof approver.requestPromotion === 'function'
        ? await approver.requestPromotion({
          pluginId: plugin,
          taskId: id,
          detail: `来源任务 ${task.title}`,
          impact: { taskId: id, pluginId: plugin, forkGrade: forkAssessment?.grade ?? null, motherGrade: motherAssessment.grade },
        })
        : await approver.request({
          kind: 'promotion',
          risk: 'red',
          title: `提升插件 ${plugin} → 母体`,
          detail: `来源任务 ${id}（${task.title}）`,
          impact: { taskId: id, pluginId: plugin, grade: motherAssessment.grade },
        })
      const outcome = decision?.outcome ?? 'timeout'
      audit(AUDIT.APPROVAL_DECIDED, { kind: 'promotion', taskId: id, pluginId: plugin, outcome })
      if (outcome !== 'approved') return { ok: false, error: 'denied', outcome }

      const target = path.join(layout.dataDir, 'promoted', plugin)
      try {
        if (exists(target)) {
          approver.snapshot?.({ tag: plugin, dir: target })
          removeTree(target)
        }
        copyTree(workDir, target)
      } catch (e) {
        audit(AUDIT.PROMOTE_FAILED, { taskId: id, pluginId: plugin, error: String(e?.message ?? e) })
        return { ok: false, error: 'promote-failed', detail: String(e?.message ?? e) }
      }
      audit(AUDIT.PROMOTE_COMMITTED, {
        taskId: id, pluginId: plugin, target,
        forkGrade: forkAssessment?.grade ?? null, motherGrade: motherAssessment.grade,
      })

      // 商用钩子：云备份（不阻塞、失败只记录）。
      let backup = { ok: false, error: 'not-configured' }
      if (commercialHooks.backup) {
        backup = await invokeCommercial({
          commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'backup',
          method: 'upload', args: [{ kind: 'plugin', id: plugin, key: plugin, body: files }],
        })
      }

      return {
        ok: true,
        outcome: 'approved',
        taskId: id,
        pluginId: plugin,
        target,
        forkAssessment,
        motherAssessment,
        route: route?.route ?? null,
        teamBasis,
        backup,
        note: '已写入母体 staging；重启母体后生效（重启需 restart-guard 审批）',
      }
    },

    /** v1 兼容提升：本地路径直接读分身 buffer（同机、旧流程）。 */
    async promote(forkId, pluginId) {
      const info = tasks.get(String(forkId ?? ''))
      if (!info) return { ok: false, error: 'unknown-fork' }
      if (!pluginId) return { ok: false, error: 'plugin-id-required' }
      const src = path.join(forkLayout(info).bufferDir, String(pluginId))
      if (!exists(src)) return { ok: false, error: 'not-in-fork-buffer', detail: src }

      const scorer = safeGet(SERVICE.scorer)
      const assessment = scorer?.scoreDir ? scorer.scoreDir(src, null, { environment: 'mother' }) : null
      if (assessment && (assessment.grade === 'D' || assessment.grade === 'E')) {
        return { ok: false, error: 'grade-too-low', grade: assessment.grade, score: assessment.S }
      }
      const approver = safeGet(SERVICE.approver)
      if (!approver) return { ok: false, error: 'approver-unavailable' }
      const decision = await approver.request({
        kind: 'promotion',
        risk: 'red',
        title: `提升插件 ${pluginId} → 母体`,
        detail: `来源分身 ${forkId}（${info.title}）`,
        impact: { forkId, pluginId, grade: assessment?.grade ?? 'unknown' },
      })
      if ((decision?.outcome ?? 'timeout') !== 'approved') {
        return { ok: false, error: 'denied', outcome: decision?.outcome ?? 'timeout' }
      }
      const target = path.join(layout.dataDir, 'promoted', String(pluginId))
      try {
        if (exists(target)) {
          approver.snapshot?.({ tag: String(pluginId), dir: target })
          removeTree(target)
        }
        copyTree(src, target)
      } catch (e) {
        return { ok: false, error: 'promote-failed', detail: String(e?.message ?? e) }
      }
      audit(AUDIT.PROMOTE_COMMITTED, { forkId, pluginId, target })
      return { ok: true, outcome: 'approved', target, pluginId, assessment }
    },

    /**
     * v2.1 门户入口：派生一个任务，可选地用母体只读会话做 lineage 种子。
     * 只读会话目录（session catalog）缺失时退化为 lineage-only，不阻塞派生。
     */
    async derive(input = {}) {
      const sessionId = String(input.sessionId ?? '').trim()
      let seed = null
      let importSession = null
      if (sessionId) {
        const catalog = safeGet(SERVICE.sessionCatalog)
        if (!catalog || typeof catalog.seed !== 'function') {
          return { ok: false, error: 'session-catalog-unavailable' }
        }
        const seeded = await catalog.seed(sessionId)
        if (!seeded || seeded.ok === false) {
          const code = seeded?.code ?? seeded?.error ?? 'unknown'
          return { ok: false, error: code === 'session-empty' ? 'session-empty' : 'session-seed-failed', detail: code }
        }
        seed = { sessionId, markdown: seeded.markdown }
        importSession = {
          sessionId,
          sourceFile: seeded.sourceFile,
          workspacePath: seeded.workspacePath,
          workspaceTitle: seeded.workspaceTitle,
          workspaceId: seeded.workspaceId,
          createdAt: seeded.createdAt,
          cwd: seeded.cwd,
          agentPreset: seeded.agentPreset,
          sourceBytes: seeded.sourceBytes,
        }
      }
      const title = String(input.title ?? '').trim()
        || (seed ? `从会话继续 · ${seed.sessionId.slice(-8)}` : `派生任务 ${tasks.size + 1}`)
      const out = await service.createTask({ title, seed, importSession, collaborators: input.collaborators })
      return { ...out, derivedFrom: seed ? { sessionId: seed.sessionId } : null, importedSession: out.importedSession ?? null }
    },

    /**
     * 分身（任务）内部的会话目录：只读该分身自己的 $DSH_HOME/sessions。
     * 用于控制面板右栏「分身项目 & 会话」；有界解帧取会话标题，未知/超限如实降级。
     */
    async listForkSessions(taskId, options = {}) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      const limit = Math.min(50, Math.max(1, Number(options.limit) || 20))
      const sessionsRoot = path.join(task.homeDir, "sessions")
      const storagesRoot = path.join(task.homeDir, "storages")
      if (!exists(sessionsRoot)) return { ok: true, taskId: task.taskId, sessions: [], degraded: ['sessions-root-missing'] }
      let index = { workspaces: [], global: { archivedSessionIds: [], pinnedSessionIds: [] }, degraded: [] }
      try {
        index = parseWorkspaceIndex(fs.readFileSync(path.join(storagesRoot, "workspace.json"), "utf8"))
      } catch (e) {
        index = { workspaces: [], global: { archivedSessionIds: [], pinnedSessionIds: [] }, degraded: [e?.code === 'ENOENT' ? 'index-not-found' : 'index-read-failed'] }
      }
      const fsApi = { statSync: fs.statSync, readdirSync: fs.readdirSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync }
      let dirs = []
      try {
        dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
          .filter((entry) => entry && typeof entry.isDirectory === "function" && entry.isDirectory())
          .map((entry) => entry.name)
      } catch { /* 空目录/权限 */ }
      const rows = scanSessionDirs({
        sessionsDir: sessionsRoot,
        workspaceIds: dirs,
        archivedSessionIds: index.global.archivedSessionIds,
        pinnedSessionIds: index.global.pinnedSessionIds,
        fsApi,
      }).slice(0, limit)
      const keyMap = new Map()
      for (const ws of index.workspaces) keyMap.set(encodeWorkspaceKey(ws.path), ws)
      const sessions = rows.map((row) => {
        const workspace = keyMap.get(row.workspaceId) ?? null
        let title = null; let titleSource = null; let preview = null
        const file = path.join(sessionsRoot, row.workspaceId, row.sessionId, "session.v4.jsonl.zstd")
        try {
          if (exists(file)) {
            const decoded = readBoundedEvents({ file, maxFrames: 32, maxCompressedBytes: 1024 * 1024, fsApi, zstdDecompressSync: zlib.zstdDecompressSync })
            const meta = extractSessionTitle(decoded.events)
            title = meta.title; titleSource = meta.titleSource; preview = meta.preview
          }
        } catch { /* 标题失败不阻塞列出会话 */ }
        return {
          sessionId: row.sessionId,
          title: title ?? (workspace ? workspace.title : "未命名会话"),
          titleSource: titleSource ?? 'workspace',
          preview,
          updatedAt: row.updatedAt,
          workspaceTitle: workspace ? workspace.title : row.workspaceId,
          archived: row.archived,
          pinned: row.pinned,
        }
      })
      return { ok: true, taskId: task.taskId, sessions, degraded: index.degraded ?? [] }
    },
    /** v2 归档：先让分身 flush + 落审计，再**停止进程但保留 home**（读档/还原/删除见 restoreTask/deleteArchived）。 */
    async archiveTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status === TASK_STATUS.ARCHIVED) {
        return { ok: true, archived: true, already: true, taskId: id, title: task.title, homeKept: true }
      }
      const summary = taskView(task)
      let remote = { ok: false, error: 'adapter-unavailable' }
      if (task.adapter?.ok) {
        const client = await remoteFor(task)
        if (client) {
          const res = await client.command(ADAPTER_OP.ARCHIVE, {})
          remote = { ok: !!(res.ok && res.data?.ok !== false), error: res.data?.error ?? res.error }
        }
      }

      // 归档 = 停止进程 + 保留 home；必须确认进程真的退了，否则把失败如实返回，
      // 不能把「列表里没了、进程还在」当成归档成功。
      const f = forker()
      if (!f || typeof f.stop !== 'function') return { ok: false, error: 'forker-unavailable', taskId: id, remote }
      try {
        const stopped = await f.stop(id)
        if (stopped && stopped.ok === false && stopped.error !== 'not-found') {
          return { ok: false, error: 'stop-failed', detail: stopped.error ?? 'stop-failed', taskId: id, remote }
        }
      } catch (e) {
        return { ok: false, error: 'stop-failed', detail: String(e?.message ?? e), taskId: id, remote }
      }
      const deadline = nowMs() + cfg.archiveStopTimeoutMs
      let alive = true
      while (nowMs() < deadline) {
        alive = typeof f.alive === 'function' ? !!f.alive(id) : !!(f.status?.(id)?.running)
        if (!alive) break
        await sleep(100)
      }
      if (alive) {
        audit(AUDIT.TASK_ARCHIVED, { taskId: id, title: task.title, ok: false, error: 'stop-failed', remote })
        return { ok: false, error: 'stop-failed', detail: 'fork process is still alive after stop', taskId: id, remote, alive: true }
      }

      task.status = TASK_STATUS.ARCHIVED
      task.archivedAt = nowMs()
      task.archiveRemote = remote
      task.pid = null
      task.port = null
      task.url = null
      task.token = ''
      task.adapter = { ok: false, error: 'archived', at: nowMs() }
      persist()
      remoteCache.delete(id)
      audit(AUDIT.TASK_ARCHIVED, { taskId: id, title: task.title, remote, stopped: true, homeKept: true })
      bus.emit('fang/task-archived', { taskId: id, title: task.title })
      return {
        ok: true,
        archived: true,
        taskId: id,
        title: task.title,
        summary,
        remote,
        stopped: true,
        homeKept: true,
      }
    },

    /** 还原存档：用原 home/profile 重新 spawn（新端口 + 新 token），再握手。 */
    /** 分身配置重置：把来源原身的 merged/profile 重新覆盖到分身 profile（保留 node_modules 与会话）。 */
    async resetForkConfig(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (!task.essenceId) return { ok: false, error: 'no-source-essence' }
      const meta = essenceManager.getMeta(task.essenceId)
      if (!meta || typeof meta.id !== 'string') return { ok: false, error: 'source-essence-missing' }
      if (meta.archived === true) return { ok: false, error: 'source-essence-archived' }
      await essenceManager.ensureFresh(task.essenceId)
      const source = essenceManager.mergedProfileDir(task.essenceId)
      const target = path.join(task.homeDir, 'profiles', task.profile)
      if (!exists(target)) return { ok: false, error: 'fork-profile-missing' }
      setProfileConfigReadonly(target, false)
      const picked = []
      for (const rel of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
        const from = path.join(source, rel)
        if (!exists(from)) continue
        fs.copyFileSync(from, path.join(target, rel))
        picked.push(rel)
      }
      const settings = path.join(source, 'settings')
      if (exists(settings)) {
        const to = path.join(target, 'settings')
        if (exists(to)) removeTree(to)
        copyTree(settings, to)
        picked.push('settings/')
      }
      // 重置后重新加回“生产盘”锁（插件安装/设置入口仍禁用），并把配置设回只读。
      const configLock = applyForkConfigLock(target)
      const profileReadonly = setProfileConfigReadonly(target, true)
      task.configSyncedAt = nowMs()
      task.configSyncedFrom = task.essenceId
      persist()
      audit('fork-config-reset', { taskId: id, essenceId: task.essenceId, files: picked, configLock, profileReadonly })
      return { ok: true, taskId: id, essenceId: task.essenceId, files: picked, configLock, profileReadonly }
    },

    /** 强制单会话：运行中拒绝；停止/归档态把多余会话移到 quarantine-sessions/。 */
    enforceSingleSession(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      const live = forker()?.status?.(id)
      if (live?.running) return { ok: false, error: 'task-running', taskId: id }
      return { ...applySingleSessionGuard(task), taskId: id }
    },

    async restoreTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status !== TASK_STATUS.ARCHIVED) return { ok: false, error: 'not-archived', taskId: id }
      if (!task.homeDir || !exists(task.homeDir)) {
        return { ok: false, error: 'archive-home-missing', taskId: id, homeDir: task.homeDir ?? '' }
      }
      try { assertInside(layout.forkHomesDir, task.homeDir, 'fork-home') } catch (error) {
        return { ok: false, error: 'path-escape', taskId: id, detail: String(error?.message ?? error) }
      }
      const forkProfileDir = path.join(task.homeDir, 'profiles', task.profile)
      const forkBundle = path.join(forkProfileDir, 'node_modules', '@local', 'dsh-fang')
      if (!exists(forkBundle)) {
        return { ok: false, error: 'fork-bundle-unavailable', taskId: id, detail: forkProfileDir }
      }
      const f = forker()
      if (!f || typeof f.spawn !== 'function') return { ok: false, error: 'forker-unavailable', taskId: id }
      // 从原身派生的分身：还原前先把配置重置回来源原身（分身只生产，不保留配置改动）。
      let configReset = null
      if (task.essenceId) {
        try { configReset = await service.resetForkConfig(id) } catch (error) {
          configReset = { ok: false, error: String(error?.message ?? error) }
        }
      }
      // 还原前强制单会话（多余会话移到 quarantine，不删除），再做配置重置后的启动。
      let sessionGuard = null
      try { sessionGuard = applySingleSessionGuard(task) } catch { sessionGuard = { ok: false } }
      const started = await f.spawn({
        forkId: id,
        homeDir: task.homeDir,
        profile: task.profile,
        cliPath: cliPath(),
        env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: id, DSH_FANG_MOTHER: layout.dataDir },
      })
      if (!started || started.ok === false) {
        audit(AUDIT.TASK_RESTORED, { taskId: id, ok: false, error: started?.error ?? 'spawn-failed' })
        return { ok: false, error: 'spawn-failed', detail: started?.error ?? 'unknown', taskId: id }
      }
      task.status = TASK_STATUS.RUNNING
      task.archivedAt = null
      task.archiveRemote = null
      task.pid = started.pid ?? null
      task.port = started.port ?? null
      task.url = started.url ?? null
      task.token = started.token ?? extractTokenSafe(task.url)
      task.adapter = { ok: false, error: 'handshaking' }
      persist()
      audit(AUDIT.FORK_STARTED, { taskId: id, pid: task.pid, port: task.port, profile: task.profile, restored: true })
      const adapter = await handshake(task)
      task.status = adapter.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING
      persist()
      audit(AUDIT.TASK_RESTORED, { taskId: id, ok: true, adapter })
      bus.emit('fang/task-restored', { taskId: id, url: task.url, port: task.port })
      return { ok: true, restored: true, taskId: id, title: task.title, url: task.url, port: task.port, adapter, configReset, sessionGuard }
    },

    /** 永久删除存档：reap（杀进程 + 删 home + 删记录）；forker 记录已丢时按 home 兜底清理。 */
    async deleteArchivedTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status !== TASK_STATUS.ARCHIVED) return { ok: false, error: 'not-archived', taskId: id }
      const f = forker()
      let reaped = { ok: true }
      try {
        if (f && typeof f.reap === 'function') reaped = await f.reap(id)
      } catch (e) {
        reaped = { ok: false, error: String(e?.message ?? e) }
      }
      if (reaped && reaped.ok === false && reaped.error !== 'not-found') {
        return { ok: false, error: 'reap-failed', detail: reaped.error, taskId: id }
      }
      // forker 记录不存在（宿主重启/旧归档）时，仍清理 task.homeDir（限定在 forks 根内）。
      if (reaped?.error === 'not-found' && task.homeDir) {
        const root = path.resolve(layout.forkHomesDir) + path.sep
        const target = path.resolve(task.homeDir)
        if (target.startsWith(root) && exists(target)) {
          try { removeTree(target) } catch (e) { return { ok: false, error: 'remove-failed', detail: String(e?.message ?? e), taskId: id } }
        }
      }
      tasks.delete(id)
      remoteCache.delete(id)
      persist()
      audit(AUDIT.FORK_REAPED, { taskId: id, title: task.title, archivedDelete: true })
      bus.emit('fang/fork-reaped', { forkId: id })
      return { ok: true, deleted: true, taskId: id, title: task.title }
    },

    async reap(taskId) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-fork' }
      const f = forker()
      let reaped = { ok: true }
      try {
        reaped = f && typeof f.reap === 'function' ? await f.reap(task.taskId) : { ok: true }
      } catch (e) {
        reaped = { ok: false, error: String(e?.message ?? e) }
      }
      if (reaped && reaped.ok === false) {
        task.status = TASK_STATUS.FAILED
        persist()
        return { ok: false, error: 'reap-failed', detail: reaped.error }
      }
      tasks.delete(task.taskId)
      remoteCache.delete(task.taskId)
      persist()
      audit(AUDIT.FORK_REAPED, { taskId: task.taskId })
      bus.emit('fang/fork-reaped', { forkId: task.taskId })
      return { ok: true, forkId: task.taskId, removed: reaped?.removed ?? true }
    },

    status() {
      const list = [...tasks.values()].map(taskView)
      const ready = list.filter(t => t.status === TASK_STATUS.READY).length
      const running = list.filter(t => t.status === TASK_STATUS.RUNNING).length
      return {
        version: FANG_VERSION,
        role,
        profileTag: layout.profileTag,
        dataDir: layout.dataDir,
        // 三区路径（无需 D: 访问即可在面板/接口核对目录是否已迁移）
        layout: {
          fangHome: layout.fangHome || '',
          dataDir: layout.dataDir,
          essenceRoot: layout.essenceRoot,
          forkHomesDir: layout.forkHomesDir,
          runtimeRoot: layout.runtimeRoot,
          sessionsRoot: layout.sessionsRoot || '',
        },
        mother: { profile: motherProfile, cliPath: cliPath(), template: templateDir() },
        tasks: { total: list.length, ready, running, max: cfg.maxForks, list },
        // v1 兼容视图：Client 徽标与旧调用方仍读 forks.*
        forks: { total: list.length, running: ready + running, max: cfg.maxForks, list },
        audit: { checkedAt: bootState.at, ok: bootState.ok, findings: bootState.findings },
        commercial: { ...commercialHooks },
        services: {
          forker: !!safeGet(SERVICE.forker),
          scorer: !!safeGet(SERVICE.scorer),
          healer: !!safeGet(SERVICE.healer),
          approver: !!safeGet(SERVICE.approver),
          hotReloader: !!safeGet(SERVICE.hotReloader),
          restart: !!safeGet(SERVICE.restart),
          buffer: !!safeGet(SERVICE.buffer),
          auditor: !!safeGet(SERVICE.auditor),
          router: !!safeGet(SERVICE.router),
          adapter: !!safeGet(SERVICE.adapter),
          commercial: !!safeGet(SERVICE.commercial),
          sessionCatalog: !!safeGet(SERVICE.sessionCatalog),
        },
      }
    },

    /** 母体重启的唯一入口：转交 restart-guard，自身永不直接退出进程。 */
    async requestMotherRestart(reason = 'manual') {
      const guard = safeGet(SERVICE.restart)
      if (!guard || typeof guard.request !== 'function') {
        return { ok: false, error: 'restart-guard-unavailable' }
      }
      const decision = await guard.request({
        reason: String(reason),
        risk: 'red',
        scope: 'mother',
        origin: 'fang:orchestrator',
      })
      return { ok: decision?.outcome === 'approved', ...decision }
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.orchestrator, service))

  // ── v2.9.0 母体连接：只描述 + 只读探测，不持有连接状态 ──────────────────
  const linkProfileDir = () => {
    try {
      const dir = resolveProfileDir?.()
      return typeof dir === 'string' ? dir : ''
    } catch {
      return ''
    }
  }
  const linkService = {
    /** 母体连接描述：前缀/门户/接入说明/共享配置摘要（不包含任何 token）。 */
    describe: () => describeMotherLink({
      role: 'mother',
      version: FANG_VERSION,
      prefix: cfg.routes?.prefix ?? '/fang',
      sharedConfig: readSharedProfileSummary({ profileDir: linkProfileDir() }),
    }),
    /** 只读探测一个 http(s) 母体地址的 /api/status；失败以结构化错误返回。 */
    probe: (input = {}) => probeLink({
      target: input?.target,
      prefix: cfg.routes?.prefix ?? '/fang',
      timeoutMs: input?.timeoutMs,
    }),
  }
  ctx.effect(() => ctx.provide(SERVICE.link, linkService))

  // ── v2.11.0 母体镜像：备份 / 恢复 / 升级 / 自动备份（只管理文件夹 1）──────
  const mirrorRoot = cfg.mirrorRoot ? String(cfg.mirrorRoot) : path.join(layout.dataDir, 'mirror')
  // v3.0.3：客户端升级后的兼容性门禁（模块导入 + 路由契约；失败保持子插件关闭）
  const compatRoot = fileURLToPath(new URL('../../', import.meta.url))
  let compatWebServer = null
  const runCompatCheck = async () => {
    const status = await runCompatGate({
      rootDir: compatRoot,
      expectedRouteCount: DEFAULT_EXPECTED_ROUTE_COUNT,
      routePaths: compatWebServer !== null && typeof compatWebServer.paths === 'function'
        ? compatWebServer.paths()
        : null,
    })
    writeCompatStatus(layout.dataDir, status)
    return status
  }
  let upgradeCoordinator = null
  const mirrorManager = new MirrorManager({
    mirrorRoot,
    logger: ctx.logger ?? {},
    usageProvider: () => ({
      activeEssenceCount: 0,
      activeSessionCount: Array.isArray(service.listForks?.())
        ? service.listForks().filter(fork => fork.status === 'running').length
        : 0,
    }),
    compatGate: () => runCompatCheck(),
    onCompatResult: (compat) => { writeCompatStatus(layout.dataDir, compat) },
    postUpgradeHook: () => { if (upgradeCoordinator !== null) void upgradeCoordinator.onUpgradeSuccess() },
  })
  mirrorManager.ensureLayout()
  const preferencesStore = new PreferencesStore({ mirrorRoot, logger: ctx.logger ?? {} })
  preferencesStore.load()
  const essenceManager = new EssenceManager({
    essencesRoot: layout.essenceRoot,
    mirrorRoot,
    logger: ctx.logger ?? {},
  })
  // v3.0.4：首次启动 seed 官方推荐原身（锁定、预装默认插件）；失败不阻塞主插件
  let officialEssence = null
  try {
    officialEssence = essenceManager.ensureOfficialEssence()
  } catch (error) {
    ctx.logger?.warn?.('[essence] official essence seed failed', { error: String(error?.message ?? error) })
  }
  upgradeCoordinator = new MirrorUpgradeCoordinator({ essence: essenceManager, logger: ctx.logger ?? {} })
  // 元主运行态的 forkId 命名（稳定、可用于 forker 记录与端口池）
  const runtimeForkId = (essenceId) => 'rt-' + String(essenceId).replace(/^essence-/, '').replace(/[^A-Za-z0-9-]/g, '-')
  // v3.0.9 三区口径：运行态 home 统一在 runtimeRoot（FANG_HOME 下是 sessions/<essenceId>/home）。
  const runtimeHomeFor = (essenceId) => path.join(layout.runtimeRoot, String(essenceId), 'home')
  // 路径守卫：任何拼接出来的目标必须落在给定根内（拒绝 .. / 绝对路径逃逸）。
  const assertInside = (root, target, label) => {
    const resolvedRoot = path.resolve(String(root))
    const resolved = path.resolve(String(target))
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`path-escape: ${label} (${resolved} not under ${resolvedRoot})`)
    }
    return resolved
  }
  // v3.0.9 会话配额：数该元主运行态隔离 home 里的会话目录（归档数不再计入——归档目录由实例自管）。
  const countEssenceSessions = (essenceId, meta) => {
    const home = path.join(runtimeHomeFor(essenceId), 'sessions')
    let used = 0
    try {
      for (const workspace of fs.readdirSync(home, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue
        const wsDir = path.join(home, workspace.name)
        for (const session of fs.readdirSync(wsDir, { withFileTypes: true })) {
          if (session.isDirectory()) used += 1
        }
      }
    } catch { used = 0 }
    const tier = String(meta?.tier ?? 'free')
    const limit = Number(VIP_QUOTAS[tier]?.maxActiveSessions) || VIP_QUOTAS.free.maxActiveSessions
    return { used, limit, over: used >= limit }
  }

  // 把母体的工作区索引按“被导入的会话”过滤后合并进隔离 home，界面上按工作区名分组而不是 key。
  const mergeWorkspaceIndexFor = (homeDir, importedSessions) => {
    try {
      const motherLayout = resolveSessionsLayout()
      const motherRaw = exists(motherLayout.workspaceFile) ? fs.readFileSync(motherLayout.workspaceFile, 'utf8') : ''
      const mother = parseWorkspaceIndex(motherRaw)
      const keys = new Set(importedSessions.map((session) => String(session.workspaceKey)))
      const ids = new Set(importedSessions.map((session) => String(session.sessionId)))
      const targetFile = path.join(homeDir, 'storages', 'workspace.json')
      const existing = exists(targetFile) ? parseWorkspaceIndex(fs.readFileSync(targetFile, 'utf8')) : { workspaces: [], global: { archivedSessionIds: [], pinnedSessionIds: [] } }
      const byPath = new Map(existing.workspaces.map((workspace) => [workspace.path, workspace]))
      for (const workspace of mother.workspaces) {
        if (!keys.has(encodeWorkspaceKey(workspace.path))) continue
        const previous = byPath.get(workspace.path)
        const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...workspace.sessionIds.filter((id) => ids.has(id))])]
        byPath.set(workspace.path, { ...workspace, sessionIds })
      }
      const workspaces = [...byPath.values()]
      const archivedSessionIds = [...new Set([
        ...(existing.global?.archivedSessionIds ?? []),
        ...mother.global.archivedSessionIds.filter((id) => ids.has(id)),
      ])]
      const pinnedSessionIds = [...new Set([
        ...(existing.global?.pinnedSessionIds ?? []),
        ...mother.global.pinnedSessionIds.filter((id) => ids.has(id)),
      ])]
      const tables = {}
      for (const workspace of workspaces) {
        tables[workspace.id] = {
          path: workspace.path, title: workspace.title, sessionIds: workspace.sessionIds,
          createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
        }
      }
      ensureDir(path.dirname(targetFile))
      writeJsonAtomic(targetFile, {
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          defaultWorkspaceId: workspaces[0]?.id ?? null,
          workspaceIds: workspaces.map((workspace) => workspace.id),
          archivedSessionIds,
          pinnedSessionIds,
        },
        tables: { workspaces: tables },
      })
      return { ok: true, workspaces: workspaces.length }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const importSessionsInto = (homeDir, sessionIds) => {
    const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id ?? '').trim()).filter(Boolean))]
    if (ids.length === 0) return []
    if (ids.length > 5) throw new Error('too-many-sessions (max 5)')
    const catalog = safeGet(SERVICE.sessionCatalog)
    if (!catalog || typeof catalog.listSessions !== 'function') throw new Error('session-catalog-unavailable')
    const listed = catalog.listSessions({ limit: 500, includeArchived: false })
    const rows = Array.isArray(listed?.sessions) ? listed.sessions : []
    const sessionsRoot = String(listed?.sessionsRoot ?? '')
    if (!sessionsRoot) throw new Error('sessions-root-missing')
    const byId = new Map(rows.map((row) => [String(row.sessionId), row]))
    const imported = []
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) throw new Error('unknown-session: ' + id)
      if (row.archived === true) throw new Error('archived-session-not-importable: ' + id)
      const workspaceKey = String(row.workspaceKey ?? '')
      if (!workspaceKey || workspaceKey.includes('..') || workspaceKey.includes('/') || workspaceKey.includes('\\')) {
        throw new Error('invalid-workspace-key: ' + workspaceKey)
      }
      const source = path.join(sessionsRoot, workspaceKey, id)
      if (!exists(source)) throw new Error('session-dir-missing: ' + id)
      const target = assertInside(homeDir, path.join(homeDir, 'sessions', workspaceKey, id), 'session-import')
      ensureDir(path.dirname(target))
      if (exists(target)) removeTree(target)
      copyTree(source, target)
      imported.push({ sessionId: id, title: row.title ?? null, workspaceKey })
    }
    // 工作区索引合并：让实例按工作区名分组，而不是显示 --E-GPT-- 这样的 key。
    const index = mergeWorkspaceIndexFor(homeDir, imported)
    if (index.ok === false) {
      try { audit('workspace-index-merge-failed', { homeDir, error: index.error }) } catch { /* ignore */ }
    }
    return imported
  }

  const mirrorService = {
    status: () => {
      const status = mirrorManager.getStatus()
      let preferences = null
      let sync = null
      try { preferences = preferencesStore.get() } catch { preferences = null }
      try { sync = readJson(path.join(mirrorRoot, 'sync-state.json'), null) } catch { sync = null }
      return { ...status, preferences, sync }
    },
    getPreferences: () => preferencesStore.get(),
    setPreferences: (patch = {}) => preferencesStore.update(patch),
    listEssences: () => {
      const defaultEssence = essenceManager.getDefault()
      // 元主是否落后于母体镜像：lastMergedFingerprint !== 当前镜像指纹。
      let mirrorFingerprint = ''
      try { mirrorFingerprint = String(essenceManager.loadMirror().fingerprint ?? '') } catch { /* mirror 不可读时全部标 stale=false */ }
      const essences = essenceManager.list().map((meta) => {
        const ui = buildEssenceActions({ locked: meta.locked === true, archived: meta.archived === true })
        const stale = mirrorFingerprint.length > 0 && meta.archived !== true
          && String(meta.lastMergedFingerprint ?? '') !== mirrorFingerprint
        const sessionQuota = countEssenceSessions(meta.id, meta)
        return {
          ...meta,
          locked: meta.locked === true,
          official: meta.official === true,
          archived: meta.archived === true,
          stale,
          sessions: sessionQuota,
          // 设计稿字段：quota.sessions = { used, limit, over }
          quota: { sessions: sessionQuota },
          // 运行态：面板据此把「打开」切换成「停止」。
          runtime: (() => {
            try {
              const live = forker()?.status?.(runtimeForkId(meta.id))
              return live ? { running: live.running === true, pid: live.pid ?? null, port: live.port ?? null } : { running: false, pid: null, port: null }
            } catch { return { running: false, pid: null, port: null } }
          })(),
          pluginCount: (() => { try { return essenceManager.pluginCount(meta.id) } catch { return 0 } })(),
          actions: ui.actions,
          blocks: ui.blocks,
        }
      })
      return {
        officialId: OFFICIAL_ESSENCE_ID,
        official: officialEssence,
        defaultId: defaultEssence.essenceId,
        defaultEssence,
        essences,
        mirrorFingerprint,
        staleCount: essences.filter(item => item.stale === true).length,
        capacity: { slots: 7, defaultLimit: 5, used: essences.filter(item => item.archived !== true).length },
      }
    },
    createEssence: (input = {}) => essenceManager.create({
      name: input?.name, tier: input?.tier, parentId: input?.parentId ?? null,
      defaultPatchEntries: Array.isArray(input?.defaultPatchEntries) ? input.defaultPatchEntries : undefined,
    }),
    defaultPreset: async () => {
      const entries = await listInstalledPlugins()
      const plan = planDefaultEssence(entries ?? [])
      const existingId = readDefaultEssenceId()
      const meta = existingId ? essenceManager.getMeta(existingId) : null
      return { ok: true, pluginManager: Array.isArray(entries), plan, defaultEssenceId: meta?.id ? existingId : '', exists: Boolean(meta?.id) }
    },
    ensureDefaultEssence: async ({ apply = false, force = false, mode = 'copy-local' } = {}) => {
      const existingId = readDefaultEssenceId()
      const existing = existingId ? essenceManager.getMeta(existingId) : null
      if (existing?.id) return { ok: true, existed: true, created: false, essenceId: existingId, mode }
      const entries = await listInstalledPlugins()
      const plan = planDefaultEssence(entries ?? [])
      const userEssences = essenceManager.list().filter((meta) => meta.official !== true)
      if (!force && userEssences.length > 0) return { ok: false, error: 'user-essence-exists', plan, mode }
      if (apply !== true) return { ok: true, dryRun: true, plan, mode }
      if (mode === 'preset') {
        const patchEntries = []
        const pending = []
        for (const group of plan.groups) {
          for (const plugin of group.plugins) {
            if (!plugin.installed) { pending.push({ spec: plugin.spec, group: group.key }); continue }
            patchEntries.push({ id: plugin.pluginId || plugin.spec, name: plugin.spec, disabled: group.enabled !== true })
          }
        }
        if (patchEntries.length === 0) return { ok: false, error: 'no-installed-default-plugins', plan, pending, mode }
        const created = essenceManager.create({ name: DEFAULT_ESSENCE_NAME, tier: 'free', defaultPatchEntries: patchEntries })
        writeDefaultEssenceId(created.id)
        try {
          writeJsonAtomic(path.join(essenceManager.essenceRoot(created.id), 'default-preset.json'), {
            at: nowMs(), mode, version: plan.version, groups: plan.groups, patchEntries, pending,
          })
        } catch { /* marker 失败不影响创建 */ }
        audit('default-essence-created', { essenceId: created.id, mode, installed: patchEntries.length, pending: pending.length })
        return { ok: true, created: true, mode, essenceId: created.id, plan, pending }
      }
      // copy-local（默认）：只复制本机插件的启用/禁用 + 设置；不复制任何会话/数据/代码/凭据。
      let captured
      try {
        captured = essenceManager.captureFromProfile(templateDir(), { name: DEFAULT_ESSENCE_NAME, tier: 'free' })
      } catch (error) {
        return { ok: false, error: 'capture-failed', detail: String(error?.message ?? error), plan, mode }
      }
      const created = captured.meta ?? captured
      writeDefaultEssenceId(created.id)
      try {
        writeJsonAtomic(path.join(essenceManager.essenceRoot(created.id), 'default-preset.json'), {
          at: nowMs(), mode, source: templateDir(),
          captured: captured.captured ?? null,
          conflicts: captured.conflicts ?? [],
          note: '只复制插件启用状态与设置；未复制会话/项目/凭据/Token',
        })
      } catch { /* marker 失败不影响创建 */ }
      audit('default-essence-created', { essenceId: created.id, mode, source: templateDir() })
      return { ok: true, created: true, mode, essenceId: created.id, plan, captured: captured.captured ?? null, conflicts: captured.conflicts ?? [] }
    },
    renameEssence: (essenceId, name) => essenceManager.rename(essenceId, name),
    archiveEssence: (essenceId, archived = true) => essenceManager.archive(essenceId, archived === true),
    deleteEssence: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const meta = essenceManager.getMeta(id)
      // 删除配置/插件目录，但**保留运行态会话**：旧布局把运行时 home 放在原身目录里，先搬出去。
      const legacyHome = path.join(essenceManager.essenceRoot(id), 'runtime', 'home')
      const preserved = runtimeHomeFor(id)
      try {
        if (exists(legacyHome) && !exists(preserved)) {
          ensureDir(path.dirname(preserved))
          copyTree(legacyHome, preserved)
        }
      } catch { /* 保留失败不阻塞删除，如实返回 */ }
      const removed = essenceManager.remove(id)
      addTombstone(id, meta?.name)
      return { ...removed, essenceId: id, tombstone: true, sessionsPreserved: exists(preserved) }
    },
    copyEssence: (essenceId, name) => {
      const result = essenceManager.copy(essenceId, { name })
      // v3.0.9：沙盒会话（运行态隔离 home 里的 sessions）随副本一起复制，副本可继续开发。
      const candidates = [
        path.join(runtimeHomeFor(String(essenceId)), 'sessions'),
        path.join(essenceManager.essenceRoot(String(essenceId)), 'runtime', 'home', 'sessions'),
        path.join(layout.dataDir, 'runtime', runtimeForkId(String(essenceId)), 'home', 'sessions'),
      ]
      const source = candidates.find((dir) => exists(dir))
      let sessionsCopied = 0
      if (source) {
        const target = path.join(runtimeHomeFor(result.id), 'sessions')
        try {
          copyTree(source, target)
          const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const file = path.join(dir, entry.name)
              if (entry.isDirectory()) walk(file)
              else if (entry.isFile()) sessionsCopied += 1
            }
          }
          walk(target)
        } catch { /* 会话复制失败不阻塞配置副本，如实返回 0 */ }
        // 工作区索引也随副本走，否则副本里会话会按 workspace key 显示。
        const sourceIndex = path.join(path.dirname(path.dirname(source)), 'storages', 'workspace.json')
        if (exists(sourceIndex)) {
          const targetIndex = path.join(runtimeHomeFor(result.id), 'storages', 'workspace.json')
          try { ensureDir(path.dirname(targetIndex)); fs.copyFileSync(sourceIndex, targetIndex) } catch { /* ignore */ }
        }
      }
      return { ...result, copy: { ...(result.copy ?? {}), sessionsCopied } }
    },
    // v3.0.9 母体 → 元主：克隆母体 profile 的可写层（patch/依赖/设置），不带凭据与会话。
    captureEssence: (input = {}) => {
      const result = essenceManager.captureFromProfile(templateDir(), {
        name: input?.name,
        tier: input?.tier,
        parentId: input?.parentId ?? null,
        includeDependencies: input?.includeDependencies !== false,
        includeSettings: input?.includeSettings !== false,
      })
      const defaultEssence = input?.setDefault === true ? essenceManager.setDefault(result.meta.id) : null
      return { ...result, default: defaultEssence }
    },
    setDefaultEssence: (essenceId) => essenceManager.setDefault(essenceId),
    downloadEssence: (essenceId, options = {}) => {
      const bundle = essenceManager.downloadBundle(essenceId, { full: options?.full === true })
      if (bundle.full !== true) return bundle
      // 整包迁移还要带走运行态沙盒：会话 + 工作区索引（运行态 home 在原身文件夹之外）。
      const id = String(essenceId)
      const home = runtimeHomeFor(id)
      const addFile = (relative, file) => {
        try {
          const bytes = fs.readFileSync(file)
          bundle.files.push({ path: relative, base64: bytes.toString('base64') })
          bundle.bytes += bytes.length
        } catch { /* 读失败跳过，不阻塞导出 */ }
      }
      const indexFile = path.join(home, 'storages', 'workspace.json')
      if (exists(indexFile)) addFile('runtime/home/storages/workspace.json', indexFile)
      const sessionsDir = path.join(home, 'sessions')
      if (exists(sessionsDir)) {
        const walk = (dir, rel) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name)
            const nextRel = rel ? rel + '/' + entry.name : entry.name
            if (entry.isDirectory()) walk(fullPath, nextRel)
            else if (entry.isFile()) addFile('runtime/home/sessions/' + nextRel, fullPath)
          }
        }
        walk(sessionsDir, '')
      }
      return bundle
    },
    backupEssence: (essenceId) => essenceManager.backup(essenceId),
    restoreEssence: (essenceId) => essenceManager.restoreBackup(essenceId),
    importEssence: (input = {}) => essenceManager.importBundle(input?.bundle ?? input, {
      name: input?.name, tier: input?.tier, parentId: input?.parentId ?? null,
    }),
    // v3.0.9 原身运行态：用元主 merged/profile 起一个**隔离 home** 的配置态实例。
    // 隔离边界：DSH_HOME = essences/<id>/runtime/home（自己的 sessions/storages），
    // 不写母体 sessions；node_modules 通过 junction 指向母体模块树（不复制）。
    startEssenceRuntime: async (essenceId, input = {}) => {
      const id = String(essenceId ?? '').trim()
      const meta = essenceManager.getMeta(id)
      if (!meta || typeof meta.id !== 'string') throw new Error('unknown-essence')
      if (meta.archived === true) throw new Error('essence-archived')
      // 进行中会话配额（默认 10；归档不限；达到上限拒绝再开实例）。
      const sessionQuota = countEssenceSessions(id, meta)
      if (sessionQuota.over) throw new Error(`session-quota-exceeded: ${sessionQuota.used}/${sessionQuota.limit}`)
      const f = forker()
      if (!f || typeof f.provision !== 'function' || typeof f.spawn !== 'function') throw new Error('forker-unavailable')
      await essenceManager.ensureFresh(id)
      const merged = essenceManager.mergedProfileDir(id)
      if (!exists(merged)) throw new Error('merged-profile-missing')
      assertInside(layout.essenceRoot, merged, 'essence-merged')
      const motherModules = path.join(templateDir(), 'node_modules')
      const link = path.join(merged, 'node_modules')
      if (exists(motherModules) && !exists(link)) {
        try { fs.symlinkSync(motherModules, link, 'junction') } catch { /* 已存在或权限不足时继续，forker 会再尝试 */ }
      }
      const forkId = runtimeForkId(id)
      // v3.0.9 三区：运行态 home 在 runtimeRoot 下（FANG_HOME 时是 sessions/<essenceId>/home），
      // 原身文件夹只保留配置，项目/会话/任务文件不落原身目录。
      const homeDir = runtimeHomeFor(id)
      assertInside(layout.runtimeRoot, homeDir, 'runtime-home')
      const legacyHomes = [
        path.join(layout.dataDir, 'runtime', forkId, 'home'),
        path.join(essenceManager.essenceRoot(id), 'runtime', 'home'),
      ]
      if (!exists(homeDir)) {
        const legacyHome = legacyHomes.find((dir) => exists(dir))
        if (legacyHome) {
          try { ensureDir(path.dirname(homeDir)); copyTree(legacyHome, homeDir) } catch { /* 迁移失败不阻塞 */ }
        }
      }
      const provisioned = await f.provision({
        forkId, taskTitle: `元主运行时 · ${String(meta.name ?? id)}`,
        homeDir, profile: 'essence-runtime', profileTemplate: merged,
      })
      if (!provisioned.ok) throw new Error(String(provisioned.error ?? 'runtime-provision-failed'))
      // 先导入选中的进行中会话，再拉起实例（实例启动时就能看到它们）。
      const importedSessions = importSessionsInto(homeDir, input?.sessionIds)
      // 注意：forker.spawn 需要显式 homeDir/profile（它不从 provision 记录里猜）。
      const started = await f.spawn({
        forkId,
        homeDir,
        profile: 'essence-runtime',
        cliPath: cliPath(),
        env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: forkId },
      })
      if (!started.ok) throw new Error(`runtime-spawn-failed: ${started.error ?? 'unknown'} (forkId=${forkId}, homeDir=${homeDir}, profile=essence-runtime)`)
      return {
        ok: true, essenceId: id, forkId,
        url: started.url, port: started.port, pid: started.pid,
        sandboxHome: homeDir,
        importedSessions,
      }
    },
    stopEssenceRuntime: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const f = forker()
      if (!f || typeof f.stop !== 'function') return { ok: false, error: 'forker-unavailable' }
      const forkId = runtimeForkId(id)
      const out = f.stop(forkId)
      return { ok: true, essenceId: id, forkId, stopped: out?.ok !== false }
    },
    essenceRuntimeStatus: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const f = forker()
      if (!f || typeof f.status !== 'function') return { ok: false, error: 'forker-unavailable' }
      const forkId = runtimeForkId(id)
      let runtime = null
      try { runtime = f.status(forkId) ?? null } catch { runtime = null }
      return { ok: true, essenceId: id, forkId, runtime }
    },
    /** 打开前可选导入的「进行中」会话（最多 50 条给选择器，提交时服务端再限 5 条）。 */
    essenceOpenCandidates: () => {
      const catalog = safeGet(SERVICE.sessionCatalog)
      if (!catalog || typeof catalog.listSessions !== 'function') return { ok: false, error: 'session-catalog-unavailable' }
      const listed = catalog.listSessions({ limit: 200, includeArchived: false })
      const sessions = (Array.isArray(listed?.sessions) ? listed.sessions : [])
        .filter((row) => row?.archived !== true)
        .slice(0, 50)
        .map((row) => ({
          sessionId: row.sessionId,
          title: row.title ?? null,
          workspaceTitle: row.workspaceTitle ?? null,
          updatedAt: row.updatedAt ?? 0,
        }))
      return { ok: true, sessions, total: sessions.length }
    },
    /** 元主详情页数据：元数据 + overlay 插件条目 + 设置项 + 备份/运行态/日志（不含凭据）。 */
    essenceDetail: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const meta = essenceManager.getMeta(id)
      if (!meta || typeof meta.id !== 'string') throw new Error('unknown-essence')
      const root = essenceManager.essenceRoot(id)
      const overlay = essenceManager.loadOverlay(root)
      const patchEntries = (overlay.patchEntries || []).map((entry) => ({
        id: String(entry?.id ?? ''),
        name: String(entry?.name ?? ''),
        disabled: entry?.disabled === true,
      }))
      const f = forker()
      let runtime = null
      let logs = ''
      try { runtime = f?.status?.(runtimeForkId(id)) ?? null } catch { runtime = null }
      try { logs = String(f?.logs?.(runtimeForkId(id), 120) || '') } catch { logs = '' }
      return {
        ok: true,
        essenceId: id,
        meta,
        overlay: { patchEntries, settings: Object.keys(overlay.settings || {}) },
        sessions: countEssenceSessions(id, meta),
        backup: exists(path.join(root, 'Backup')),
        runtime,
        logs,
      }
    },
    /** 打开运行态：返回带临时 token 的 URL（仅内存，不落盘）。 */    openEssenceRuntime: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const f = forker()
      if (!f || typeof f.openUrl !== 'function') return { ok: false, error: 'forker-unavailable' }
      const out = f.openUrl(runtimeForkId(id))
      if (!out || out.ok === false) return { ok: false, error: out?.error ?? 'not-running' }
      return { ok: true, essenceId: id, url: out.url, port: out.port ?? null }
    },
    // v3.0.9 升级链路 2.1：把本机母体 profile（PC 客户端那份）克隆成镜像基础层。
    cloneMotherProfile: (input = {}) => {
      const sourceDir = path.resolve(String(input?.sourceDir || templateDir()))
      const packageFile = path.join(sourceDir, 'package.json')
      if (!exists(packageFile)) throw new Error('mother profile has no package.json: ' + sourceDir)
      const activeProfile = path.join(mirrorRoot, 'active', 'profile')
      const relative = path.relative(path.resolve(mirrorRoot), sourceDir)
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error('clone: source is already inside the mirror')
      }
      let backup = null
      try { backup = mirrorManager.backup({ label: '克隆母体前自动备份' }) } catch { /* 首次克隆没有可备份内容 */ }
      if (exists(activeProfile)) removeTree(activeProfile)
      ensureDir(activeProfile)
      const picked = []
      for (const rel of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
        const from = path.join(sourceDir, rel)
        if (!exists(from)) continue
        fs.copyFileSync(from, path.join(activeProfile, rel))
        picked.push(rel)
      }
      const settingsDir = path.join(sourceDir, 'settings')
      if (exists(settingsDir)) { copyTree(settingsDir, path.join(activeProfile, 'settings')); picked.push('settings/') }
      let version = ''
      try { version = String(readJson(packageFile, {})?.version ?? '') } catch { version = '' }
      const meta = mirrorManager.readMeta()
      mirrorManager.writeMeta({
        ...meta,
        version: version || meta.version || 'unknown',
        installedAt: nowMs(),
        lastBackupAt: backup?.createdAt ?? meta.lastBackupAt,
      })
      writeJsonAtomic(path.join(mirrorRoot, 'sync-state.json'), { lastSyncAt: nowMs(), sourceDir })
      return {
        ok: true,
        sourceDir,
        target: activeProfile,
        files: picked,
        version: version || meta.version || 'unknown',
        backup: backup ? { id: backup.id, bucket: backup.bucket, createdAt: backup.createdAt } : null,
      }
    },
    /** 空白母体（初始盘）：备份当前 → 清空 active/profile → 版本标记 blank。 */
    blankMother: () => {
      const activeProfile = path.join(mirrorRoot, 'active', 'profile')
      let backup = null
      try { backup = mirrorManager.backup({ label: '空白母体前自动备份' }) } catch { /* 首次为空 */ }
      if (exists(activeProfile)) removeTree(activeProfile)
      ensureDir(activeProfile)
      const meta = mirrorManager.readMeta()
      mirrorManager.writeMeta({
        ...meta,
        version: 'blank',
        installedAt: nowMs(),
        lastBackupAt: backup?.createdAt ?? meta.lastBackupAt,
      })
      return {
        ok: true,
        version: 'blank',
        target: activeProfile,
        backup: backup ? { id: backup.id, bucket: backup.bucket, createdAt: backup.createdAt } : null,
      }
    },
    // v3.0.9 升级链路 3：母体变化后，元主按 overlay 重放到新镜像（配置不动）。
    syncEssences: async (input = {}) => {
      const essenceId = String(input?.essenceId ?? '').trim()
      if (!essenceId) {
        const out = await essenceManager.recomputeAll({ concurrency: Number(input?.concurrency) || 2 })
        return { ok: true, mode: 'all', ...out }
      }
      const meta = essenceManager.getMeta(essenceId)
      if (meta.locked === true) return { ok: false, error: 'locked', essenceId }
      if (meta.archived === true) return { ok: false, error: 'archived', essenceId }
      const fresh = await essenceManager.ensureFresh(essenceId)
      return {
        ok: true, mode: 'one', essenceId,
        recomputed: fresh.recomputed === true,
        status: fresh.meta?.status ?? 'unknown',
      }
    },
    backup: (input = {}) => mirrorManager.backup({
      label: input?.label, bucket: input?.bucket === 'restore' ? 'restore' : 'backup',
    }),
    restore: (backupId) => mirrorManager.restore(backupId),
    deleteBackup: (backupId) => mirrorManager.deleteBackup(backupId),
    setBackupInterval: (hours) => mirrorManager.setBackupInterval(hours),
    checkUpdate: () => mirrorManager.checkUpdate(),
    recomputeStatus: () => upgradeCoordinator.getRecomputeStatus(),
    compatStatus: () => readCompatStatus(layout.dataDir),
    runCompatCheck,
    upgrade: (input = {}) => mirrorManager.upgrade({
      autoBackup: input?.autoBackup !== false,
      autoRollback: input?.autoRollback !== false,
    }),
  }
  ctx.effect(() => ctx.provide(SERVICE.mirror, mirrorService))
  // 启动后自检一次；兼容状态默认 subPluginsEnabled=false，直到门禁通过
  const compatBootTimer = setTimeout(() => { void runCompatCheck() }, 1500)
  compatBootTimer.unref?.()
  ctx.effect(() => () => clearTimeout(compatBootTimer))
  const mirrorAutoTimer = setInterval(() => {
    try {
      const status = mirrorService.status()
      if (status.meta?.nextBackupAt !== null && Date.now() >= status.meta.nextBackupAt) {
        mirrorManager.maybeAutoBackup()
      }
      // 母体自动同步：按偏好 6/12/24h 从本机 profile 克隆到镜像（关闭时不跑）。
      const prefs = preferencesStore.get()
      const syncHours = Number(prefs?.syncIntervalHours)
      if (Number.isFinite(syncHours) && syncHours > 0) {
        let last = 0
        try { last = Number(readJson(path.join(mirrorRoot, 'sync-state.json'), {})?.lastSyncAt) || 0 } catch { last = 0 }
        if (Date.now() - last >= syncHours * 3_600_000) {
          try {
            mirrorService.cloneMotherProfile({})
            ctx.logger?.info?.('[mirror] auto-sync completed', { hours: syncHours })
          } catch (error) {
            ctx.logger?.warn?.('[mirror] auto-sync failed', { error: String(error?.message ?? error) })
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('[mirror] auto backup tick failed', { error: String(error?.message ?? error) })
    }
  }, 60_000)
  mirrorAutoTimer.unref?.()
  ctx.effect(() => () => clearInterval(mirrorAutoTimer))

  // ── 启动自检 ───────────────────────────────────────────────────────────
  const bootState = { at: nowMs(), ok: null, findings: [] }
  const bootAuditTimer = setTimeout(() => {
    try {
      const auditor = safeGet(SERVICE.auditor)
      const check = auditor?.bootCheck?.() ?? auditor?.bootAudit?.()
      bootState.ok = check?.ok !== false
      bootState.findings = Array.isArray(check?.findings) ? check.findings : []
      audit(AUDIT.BOOT, { ok: bootState.ok, findings: bootState.findings })
    } catch (e) {
      bootState.ok = false
      bootState.findings = [{ id: 'boot-audit-threw', level: 'error', message: String(e?.message ?? e) }]
    }
  }, 1000)
  ctx.effect(() => () => clearTimeout(bootAuditTimer))

  // ── 启动时把注册表里已经死掉的任务标成 stopped（不假装还活着）───────────────
  const refreshStale = () => {
    let changed = false
    for (const t of tasks.values()) {
      const live = forker()?.status?.(t.taskId)
      if (live && !live.running && (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.READY)) {
        t.status = TASK_STATUS.FAILED
        changed = true
      }
    }
    if (changed) persist()
  }
  const bootTimer = setTimeout(() => { try { refreshStale() } catch { /* ignore */ } }, 2000)
  ctx.effect(() => () => clearTimeout(bootTimer))

  // ── 可选：空闲自动归档 ───────────────────────────────────────────────────
  if (cfg.autoReapIdleMinutes > 0) {
    const t = setInterval(() => {
      const idleMs = cfg.autoReapIdleMinutes * 60_000
      for (const task of [...tasks.values()]) {
        if (nowMs() - (task.lastActiveAt ?? task.createdAt) > idleMs) {
          service.reap(task.taskId).catch(() => { /* best effort */ })
        }
      }
    }, 60_000)
    ctx.effect(() => () => clearInterval(t))
  }

  // v3.0.9：连接信息要的宿主服务（只有 Web 运行时才有；分身/无 Web 环境允许缺失）。
  // 必须用 ctx.inject 取——直接 child.get 在插件上下文里拿不到这两个服务。
  let connectionService = null
  let webAppService = null
  ctx.inject(['connection'], (child) => {
    try { connectionService = child.get('connection') ?? child.connection ?? null } catch { connectionService = null }
  })
  ctx.inject(['webApp'], (child) => {
    try { webAppService = child.get('webApp') ?? child.webApp ?? null } catch { webAppService = null }
  })

  // ── HTTP 门户 ──────────────────────────────────────────────────────────
  if (cfg.routes?.enabled !== false) {
    ctx.inject(['webServer'], (child) => {
      const webServer = child.get('webServer') ?? child.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      compatWebServer = webServer
      // v3.0.8：把当前宿主 origin 写到 dataDir/endpoint.json，供 Electron 面板发现，
      // 避免桌面宿主端口每次变化后必须手工设置 FANG_UPSTREAM。
      try {
        const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
        if (origin) {
          fs.mkdirSync(layout.dataDir, { recursive: true })
          fs.writeFileSync(path.join(layout.dataDir, 'endpoint.json'), JSON.stringify({ url: origin, updatedAt: new Date().toISOString() }) + '\n')
        }
      } catch { /* endpoint discovery is best-effort */ }
      const prefix = String(cfg.routes?.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'

      const json = (res, code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      }
      const readBody = (req) => new Promise((resolve) => {
        let raw = ''
        req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy() })
        req.on('end', () => {
          try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
        })
        req.on('error', () => resolve({}))
      })
      const route = (method, pathname, handler, routeOptions) => webServer.register({
        kind: 'exact',
        path: pathname,
        method,
        handler: async (req, res) => {
          // v3.0.5/B1：loopback Host + Origin/CSRF + 安装 token（fail-closed）。
          // Auth must run before the method check: a token-less POST is 401, not 405.
          const decision = checkRequestAuth(req, {
            token: authToken,
            publicRoute: authToken.length === 0 || routeOptions?.public === true,
          })
          if (!decision.ok) return json(res, decision.status, authErrorBody(decision))
          if (req.method !== method) {
            try { res.setHeader?.('allow', method) } catch { /* fake res */ }
            return json(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
          }
          try { return await handler(req, res) } catch (e) {
            return json(res, 500, { ok: false, error: 'handler-threw', code: 'handler-threw', detail: String(e?.message ?? e) })
          }
        },
      })

      // The DSH webServer keys exact routes by path only, so GET+POST on the same
      // path cannot be two `register()` calls (the second throws and later routes
      // silently never register). One handler dispatches by method instead.
      const routeMethods = (pathname, handlers, routeOptions) => webServer.register({
        kind: 'exact',
        path: pathname,
        method: Object.keys(handlers).join(','),
        handler: async (req, res) => {
          const decision = checkRequestAuth(req, {
            token: authToken,
            publicRoute: authToken.length === 0 || routeOptions?.public === true,
          })
          if (!decision.ok) return json(res, decision.status, authErrorBody(decision))
          const allow = Object.keys(handlers)
          const fn = handlers[String(req.method ?? 'GET').toUpperCase()]
          if (typeof fn !== 'function') {
            try { res.setHeader?.('allow', allow.join(', ')) } catch { /* fake res */ }
            return json(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
          }
          try { return await fn(req, res) } catch (e) {
            return json(res, 500, { ok: false, error: 'handler-threw', code: 'handler-threw', detail: String(e?.message ?? e) })
          }
        },
      })

      // ── 分支路由共用：taskId 必须是注册表里的安全 id ─────────────────────
      // 既保证 404 语义一致（tasks/status 对未知任务返回 404），也阻断把
      // `../` 之类的 taskId 带进 BranchStore.file() 的路径逃逸。
      const safeTaskId = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value ?? ''))
      const requireTask = (value) => {
        const taskId = String(value ?? '').trim()
        if (!taskId) return { ok: false, status: 400, error: 'taskId-required' }
        if (!safeTaskId(taskId) || !tasks.has(taskId)) return { ok: false, status: 404, error: 'unknown-task' }
        return { ok: true, taskId }
      }
      const branchErrorStatus = (code) => {
        switch (String(code ?? '')) {
          case 'invalid-branch-id':
          case 'invalid-status':
          case 'invalid-task-id':
            return 400
          case 'branch-missing':
          case 'parent-missing':
            return 404
          case 'branch-exists':
          case 'branch-not-active':
          case 'cannot-seal-active':
            return 409
          default:
            return 500
        }
      }

      // 浏览器面板 bootstrap：同源读取 token（Host/Origin 已校验；不跨站）
      route('GET', `${prefix}/api/auth-token`, (req, res) => json(res, 200, {
        ok: true, token: authToken,
      }), { public: true })

      // 母体不可删除：即使有人直接打接口也返回 403，而不是“没有这个路由”。
      route('DELETE', `${prefix}/api/mother`, (req, res) => json(res, 403, { ok: false, error: 'mother-immutable' }))
      route('POST', `${prefix}/api/mother/delete`, (req, res) => json(res, 403, { ok: false, error: 'mother-immutable' }))

      // 完整连接地址（带进程 token）：Web 端「连接信息」用它，不再依赖桌面壳。
      // 桌面壳缺失时也能给出可复制的真实登录地址；拿不到 token 时如实标 tokenized:false。
      route('GET', `${prefix}/api/connection`, (req, res) => {
        const advertised = (() => { try { return String(webAppService?.getAdvertisedUrl?.() ?? '') } catch { return '' } })()
        const origin = (() => { try { return String(webServer.getOrigin?.() ?? '') } catch { return '' } })()
        const base = advertised || origin
        let url = base
        let tokenized = false
        try {
          if (base && typeof connectionService?.authenticatedUrl === 'function') {
            const next = connectionService.authenticatedUrl(base)
            if (next) { url = String(next); tokenized = url !== base }
          }
        } catch { /* 无 connection 服务时退回裸地址，不假装成功 */ }
        return json(res, 200, {
          ok: true, url, origin, advertisedUrl: advertised, tokenized, available: Boolean(url),
        })
      })

      route('GET', `${prefix}/api/status`, (req, res) => json(res, 200, service.status()))
      route('GET', `${prefix}/api/upgrade/status`, (req, res) => {
        let mirror = null
        let essences = []
        let compat = null
        try { mirror = mirrorService.status() } catch { /* empty */ }
        try { essences = mirrorService.listEssences()?.essences ?? [] } catch { /* empty */ }
        try { compat = readCompatStatus(layout.dataDir) } catch { /* empty */ }
        let failedTasks = 0
        try { failedTasks = [...tasks.values()].filter(task => task.status === TASK_STATUS.FAILED).length } catch { /* empty */ }
        return json(res, 200, buildUpgradeStatus({ version: FANG_VERSION, mirror, essences, compat, tasks: { failed: failedTasks } }))
      })
      route('GET', `${prefix}/api/tasks`, (req, res) => json(res, 200, { ok: true, tasks: service.listTasks() }))
      route('POST', `${prefix}/api/tasks/create`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = await service.createTask({ title: body?.title, template: body?.template, collaborators: body?.collaborators, essenceId: body?.essenceId })
          return json(res, out.ok ? 200 : 409, out)
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('GET', `${prefix}/api/tasks/status`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await service.getTaskStatus(query.get('taskId') ?? '')
        return json(res, out.ok === false ? 404 : 200, out)
      })
      // v3.0.5/B4：打开分身时才在内存中取带 token 的 URL（不落盘、不进列表）
      route('GET', `${prefix}/api/tasks/open-url`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const taskId = String(query.get('taskId') ?? '').trim()
        const out = taskId ? forker()?.openUrl?.(taskId) : null
        if (!out || out.ok !== true) return json(res, 404, { ok: false, error: out?.error ?? 'not-running' })
        return json(res, 200, out)
      })
      route('POST', `${prefix}/api/tasks/archive`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.archiveTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/restore`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.restoreTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      // v3.0.9：强制单会话（运行中拒绝；停止/归档态把多余会话隔离到 quarantine-sessions/）
      route('POST', `${prefix}/api/tasks/sessions/enforce`, async (req, res) => {
        const body = await readBody(req)
        const out = service.enforceSingleSession(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/reset`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = await service.resetForkConfig(String(body?.taskId ?? ''))
          return json(res, out.ok ? 200 : 409, out)
        } catch (error) {
          return json(res, 500, { ok: false, error: 'reset-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/tasks/archive/delete`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.deleteArchivedTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/promote`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.promoteTask(String(body?.taskId ?? ''), String(body?.pluginId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })

      route('POST', `${prefix}/api/derive`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.derive({ title: body?.title, sessionId: body?.sessionId, collaborators: body?.collaborators })
        return json(res, out.ok ? 200 : 409, out)
      })
      route('GET', `${prefix}/api/tasks/sessions`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await service.listForkSessions(query.get("taskId") ?? "", { limit: query.get("limit") })
        return json(res, out.ok === false ? 404 : 200, out)
      })
      // v1 兼容路由
      route('GET', `${prefix}/api/forks`, (req, res) => json(res, 200, { ok: true, forks: service.listForks() }))
      route('POST', `${prefix}/api/forks/create`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.fork({ taskTitle: body?.taskTitle ?? body?.title })
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/reap`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.reap(String(body?.forkId ?? body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/promote`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.promote(String(body?.forkId ?? ''), String(body?.pluginId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      // v2.9.0 母体连接
      route('GET', `${prefix}/api/mother-link`, (req, res) => json(res, 200, linkService.describe()))
      route('POST', `${prefix}/api/mother-link/probe`, async (req, res) => {
        const body = await readBody(req)
        const out = await linkService.probe(body && typeof body === 'object' ? body : {})
        try {
          ctx.get(SERVICE.auditor)?.append?.(AUDIT.LINK_PROBE, {
            target: out.target ?? null, ok: out.ok === true,
            latencyMs: out.latencyMs ?? null, error: out.error ?? null,
          })
        } catch { /* 审计缺失不影响探测结果 */ }
        return json(res, 200, out)
      })
      // v2.11.0 母体镜像管理
      route('GET', `${prefix}/api/mirror/status`, (req, res) => {
        const payload = mirrorService.status()
        const ifNoneMatch = req && req.headers ? req.headers['if-none-match'] : undefined
        const out = buildMirrorStatusResponse(payload, ifNoneMatch)
        res.writeHead(out.statusCode, out.headers)
        res.end(out.notModified ? '' : out.body)
      })
      route('POST', `${prefix}/api/mirror/backup`, async (req, res) => {
        const body = await readBody(req)
        try {
          const entry = mirrorService.backup({ label: body?.label, bucket: body?.bucket })
          return json(res, 200, { ok: true, entry })
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/mirror/restore`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = mirrorService.restore(body?.backupId)
          return json(res, out.ok ? 200 : 409, out)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/mirror/backup/delete`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = mirrorService.deleteBackup(body?.backupId)
          return json(res, out.ok ? 200 : 404, out)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/mirror/backup-interval`, async (req, res) => {
        const body = await readBody(req)
        const out = mirrorService.setBackupInterval(body?.hours)
        return json(res, out.ok ? 200 : 400, out)
      })
      // v3.0.9 升级链路 2.1：从本机母体 profile 克隆镜像基础层（先自动备份）。
      route('POST', `${prefix}/api/mirror/clone-profile`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.cloneMotherProfile(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'clone-failed', detail: String(error?.message ?? error) })
        }
      })
      // 空白母体（初始盘）：备份当前 → active/profile 清空 → 版本 blank
      route('POST', `${prefix}/api/mirror/blank`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.blankMother(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'blank-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.0.8 镜像偏好：对话框交互超时 15/30/60s（宿主侧持久化）
      route('GET', `${prefix}/api/mirror/preferences`, (req, res) => json(res, 200, mirrorService.getPreferences()))
      route('POST', `${prefix}/api/mirror/preferences/set`, async (req, res) => {
        const body = await readBody(req)
        try {
          const patch = {}
          if (body?.activeIdleTimeoutMs !== undefined) patch.activeIdleTimeoutMs = body.activeIdleTimeoutMs
          if (body?.syncIntervalHours !== undefined) patch.syncIntervalHours = body.syncIntervalHours
          const preferences = mirrorService.setPreferences(patch)
          return json(res, 200, preferences)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // v3.0.3 compat 门禁：客户端升级后子插件默认关闭，门禁通过才允许启用
      route('GET', `${prefix}/api/mirror/recompute-status`, (req, res) => json(res, 200, mirrorService.recomputeStatus()))
      route('GET', `${prefix}/api/essence/list`, (req, res) => json(res, 200, mirrorService.listEssences()))
      // v3.0.6 元主 CRUD / 默认元主 / 导出
      route('POST', `${prefix}/api/essence/create`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.createEssence(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // v3.0.9 母体 → 元主：从当前母体 profile 的可写层生成一个可配置元主。
      route('POST', `${prefix}/api/essence/capture`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.captureEssence(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'capture-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.0.9 升级链路 3：把元主 overlay 重放到当前镜像（单个或全部）。
      route('POST', `${prefix}/api/essence/sync`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...(await mirrorService.syncEssences(body)) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'sync-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.0.9 原身运行态：start / stop（隔离 home 的配置态实例）
      // 注意：DSH webServer 按 path 键路由，GET+POST 必须走 routeMethods 一次注册，
      // 否则第二次 register 抛出，后面的路由会静默丢失（实测踩过）。
      routeMethods(`${prefix}/api/essence/runtime`, {
        GET: (req, res) => {
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          return json(res, 200, mirrorService.essenceRuntimeStatus(query.get('essenceId')))
        },
        POST: async (req, res) => {
          const body = await readBody(req)
          const action = String(body?.action ?? 'start')
          try {
            if (action === 'stop') return json(res, 200, mirrorService.stopEssenceRuntime(body?.essenceId))
            return json(res, 200, await mirrorService.startEssenceRuntime(body?.essenceId, body))
          } catch (error) {
            return json(res, 400, { ok: false, error: 'runtime-failed', detail: String(error?.message ?? error) })
          }
        },
      })
      route('GET', `${prefix}/api/essence/detail`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        try { return json(res, 200, mirrorService.essenceDetail(query.get('essenceId'))) } catch (error) {
          return json(res, 400, { ok: false, error: 'detail-failed', detail: String(error?.message ?? error) })
        }
      })
      route('GET', `${prefix}/api/essence/open/candidates`, (req, res) => json(res, 200, mirrorService.essenceOpenCandidates()))
      route('GET', `${prefix}/api/essence/runtime/open`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        return json(res, 200, mirrorService.openEssenceRuntime(query.get('essenceId')))
      })
      route('POST', `${prefix}/api/essence/backup`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.backupEssence(String(body?.essenceId ?? '')) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'backup-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/restore`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.restoreEssence(String(body?.essenceId ?? '')) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'restore-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/import`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.importEssence(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'import-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/rename`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.renameEssence(String(body?.essenceId ?? ''), body?.name) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/archive`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.archiveEssence(String(body?.essenceId ?? ''), body?.archived !== false) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/delete`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.deleteEssence(String(body?.essenceId ?? '')) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/copy`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.copyEssence(String(body?.essenceId ?? ''), body?.name) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/default`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, default: mirrorService.setDefaultEssence(String(body?.essenceId ?? '')) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('GET', `${prefix}/api/essence/download`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        try {
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          const bundle = mirrorService.downloadEssence(String(query.get('essenceId') ?? ''), { full: query.get('full') === '1' })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="essence-${bundle.essenceId}.json"`,
            'cache-control': 'no-store',
          })
          return res.end(JSON.stringify(bundle))
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // v3.0.6 分身 rename/copy/download（copy=访问信息；download=元数据清单）
      route('POST', `${prefix}/api/tasks/rename`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.renameTask(String(body?.taskId ?? ''), body?.title)
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/copy`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.copyTaskInfo(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 404, out)
      })
      route('GET', `${prefix}/api/tasks/download`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await Promise.resolve(service.downloadTaskManifest(String(query.get('taskId') ?? '')))
        return json(res, out.ok ? 200 : 404, out)
      })
      route('GET', `${prefix}/api/compat`, (req, res) => json(res, 200, mirrorService.compatStatus()))
      route('POST', `${prefix}/api/compat/check`, async (req, res) => {
        const status = await mirrorService.runCompatCheck()
        return json(res, status.ok ? 200 : 409, status)
      })
      route('POST', `${prefix}/api/mirror/upgrade`, async (req, res) => {
        const body = await readBody(req)
        const out = await mirrorService.upgrade({
          autoBackup: body?.autoBackup !== false,
          autoRollback: body?.autoRollback !== false,
        })
        return json(res, out.ok ? 200 : 409, out)
      })
      // v3.0.8 分支 HTTP 面（注册在末尾，避免影响既有路由初始化顺序）
      routeMethods(`${prefix}/api/tasks/branches`, {
        GET: (req, res) => {
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          const checked = requireTask(query.get('taskId'))
          if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
          return json(res, 200, branchStore.list(checked.taskId))
        },
        POST: async (req, res) => {
          const body = await readBody(req)
          const checked = requireTask(body?.taskId)
          if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
          try {
            return json(res, 200, branchStore.create(checked.taskId, {
              branchId: String(body?.branchId ?? ''),
              parentBranchId: body?.parentBranchId ? String(body.parentBranchId) : undefined,
              baseTurn: Number(body?.baseTurn) || 0,
            }))
          } catch (error) {
            const code = String(error?.message ?? error)
            return json(res, branchErrorStatus(code), { ok: false, error: code, code })
          }
        },
      })
      route('POST', `${prefix}/api/tasks/branches/activate`, async (req, res) => {
        const body = await readBody(req)
        const checked = requireTask(body?.taskId)
        if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
        try {
          const out = branchStore.activate(checked.taskId, String(body?.branchId ?? ''))
          // 方案 B：激活即切换 active 分支会话（同一分身可有多个分支会话，但同时只有 1 个 active）。
          const task = tasks.get(checked.taskId)
          if (task) {
            task.activeBranchId = out.activeBranchId
            persist()
          }
          audit('fork-branch-activated', { taskId: checked.taskId, branchId: out.activeBranchId, childSessionId: out.branch?.sessionId ?? null })
          return json(res, 200, out)
        } catch (error) {
          const code = String(error?.message ?? error)
          return json(res, branchErrorStatus(code), { ok: false, error: code, code })
        }
      })
      route('POST', `${prefix}/api/tasks/branches/status`, async (req, res) => {
        const body = await readBody(req)
        const checked = requireTask(body?.taskId)
        if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
        try {
          return json(res, 200, branchStore.setStatus(checked.taskId, String(body?.branchId ?? ''), String(body?.status ?? '')))
        } catch (error) {
          const code = String(error?.message ?? error)
          return json(res, branchErrorStatus(code), { ok: false, error: code, code })
        }
      })
      // 方案 A：物理分支——在分身自己的宿主里 sessions.fork，子会话挂回同一分身。
      route('POST', `${prefix}/api/tasks/branches/fork`, async (req, res) => {
        const body = await readBody(req)
        const checked = requireTask(body?.taskId)
        if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
        const task = tasks.get(checked.taskId)
        if (!task) return json(res, 404, { ok: false, error: 'unknown-task' })
        if (task.status === TASK_STATUS.ARCHIVED) return json(res, 409, { ok: false, error: 'task-archived' })
        const client = await remoteFor(task)
        if (!client || typeof client.command !== 'function') return json(res, 502, { ok: false, error: 'adapter-unavailable' })
        const current = branchStore.list(checked.taskId)
        const sourceSessionId = String(body?.sessionId ?? current.sessionId ?? '').trim()
        if (!sourceSessionId) return json(res, 409, { ok: false, error: 'no-session' })
        const branchId = String(body?.branchId ?? '').trim() || `b${Date.now().toString(36)}`
        const baseTurn = Number.isFinite(Number(body?.baseTurn)) ? Number(body.baseTurn) : 0
        try {
          const out = await client.command('fork-session', { sessionId: sourceSessionId, boundary: baseTurn || undefined })
          const result = out?.data?.result ?? out?.data ?? null
          if (!out?.ok || result?.ok === false) {
            const code = String(result?.code ?? result?.error ?? out?.error ?? 'fork-failed')
            return json(res, 502, { ok: false, error: code, detail: result })
          }
          const childSessionId = result?.childSessionId ?? result?.id ?? null
          const branch = branchStore.create(checked.taskId, { branchId, baseTurn, sessionId: childSessionId })
          audit('fork-branch-created', { taskId: checked.taskId, branchId, childSessionId })
          return json(res, 200, { ok: true, branch: branch.branch, childSessionId, sourceSessionId })
        } catch (error) {
          const code = String(error?.message ?? error)
          return json(res, branchErrorStatus(code), { ok: false, error: code, code })
        }
      })
      route('GET', `${prefix}/api/reflow/policy`, (req, res) => json(res, 200, {
        ok: true,
        states: ['sealed', 'verified', 'quarantine', 'adopted'],
        transitions: {
          sealed: ['verified'],
          verified: ['quarantine', 'adopted'],
          quarantine: ['verified'],
          adopted: [],
        },
        forbiddenFields: ['token', 'password', 'secret', 'credential', 'auth', 'cookie', 'sessionkey', 'apikey'],
        merge: false,
      }))

      // v3.0.9 composer journal: persist unsent drafts and a read-only queue mirror
      // so a restart/crash can offer recovery. Nothing is auto-sent.
      routeMethods(`${prefix}/api/composer/journal`, {
        GET: (req, res) => {
          const key = new URL(String(req.url ?? '/'), 'http://x').searchParams.get('key') || ''
          if (!key) return json(res, 400, { ok: false, error: 'journal-key-required' })
          return json(res, 200, { ok: true, entry: composerJournal.get(key) })
        },
        POST: async (req, res) => {
          const body = await readBody(req)
          const key = String(body?.key ?? '')
          if (!key) return json(res, 400, { ok: false, error: 'journal-key-required' })
          try {
            return json(res, 200, { ok: true, entry: composerJournal.save(key, body) })
          } catch (error) {
            return json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      // v3.0.8 contract: an unknown /fang/api/* path must be a JSON 404 under the
      // same Host/Origin/token gate — not an unauthenticated empty 404 from the host.
      // Exact routes above win because the webServer matches exact before prefix.
      // 默认元宝（新用户免创建）：dry-run 计划 + 应用。
      route('GET', `${prefix}/api/essence/default-preset`, async (req, res) => {
        try { return json(res, 200, await mirrorService.defaultPreset()) } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/default`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = await mirrorService.ensureDefaultEssence({ apply: body?.apply === true, force: body?.force === true, mode: body?.mode === 'preset' ? 'preset' : 'copy-local' })
          return json(res, out.ok === false ? 409 : 200, out)
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // 新用户延迟自动创建（不阻塞启动；无已装默认插件时不创建）。
      if (cfg.defaultEssenceAuto !== false) {
        const timer = setTimeout(() => { mirrorService.ensureDefaultEssence({ apply: true, mode: 'copy-local' }).catch(() => {}) }, 8000)
        if (typeof timer.unref === 'function') timer.unref()
      }

      webServer.register({
        kind: 'prefix',
        path: `${prefix}/api`,        handler: async (req, res) => {
          const decision = checkRequestAuth(req, {
            token: authToken,
            publicRoute: authToken.length === 0,
          })
          if (!decision.ok) return json(res, decision.status, authErrorBody(decision))
          return json(res, 404, { ok: false, error: 'not-found', code: 'not-found' })
        },
      })
    })
  }
}

/** Reject any plugin-provided relative path that escapes its base directory. */
export function resolveInside(base, rel) {
  const p = String(rel ?? '')
  if (!p || p.includes('\0')) return null
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\') || p.includes('..')) return null
  const resolved = path.resolve(base, p)
  const baseResolved = path.resolve(base)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) return null
  return resolved
}

/** Server-rendered portal (v2): task table + adapter state + four actions. */
export function renderPanelHtml(prefix = '/fang', authToken = '') {
  const p = HTML_ESCAPE(prefix)
  const token = HTML_ESCAPE(authToken)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="fang-auth" content="${token}">
<title>dsh-Fang v2 · 瓮城</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; max-width: 1180px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8a8a; margin-bottom: 20px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  input, button { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; }
  input { min-width: 280px; }
  button { cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #8884; vertical-align: middle; }
  th { font-weight: 600; color: #8a8a8a; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; }
  .ready { color: #16a34a; } .running { color: #2563eb; } .failed { color: #dc2626; }
  .archived { color: #8a8a8a; } .provisioning { color: #d97706; }
  .empty { color: #8a8a8a; padding: 24px 0; }
  #msg { min-height: 22px; color: #d97706; }
  a { color: inherit; }
</style></head>
<body>
  <h1>dsh-Fang v2 · 瓮城</h1>
  <div class="sub">母体只读；每个任务一个分身（用完即弃）。Adapter 就绪 = 分身器官已上线；归档 = flush + 回收。</div>
  <div class="row">
    <input id="title" placeholder="任务标题，例如：开发 dsh-foo 插件" />
    <button class="primary" id="create">派生新任务</button>
    <button id="refresh">刷新</button>
    <span id="mother"></span>
  </div>
  <div id="msg"></div>
  <table>
    <thead><tr><th>任务</th><th>状态</th><th>Adapter</th><th>端口</th><th>PID</th><th>操作</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
  </table>
<script>
const P = ${JSON.stringify(p)};
const $ = (id) => document.getElementById(id);
// v3.0.5/B1：面板同源读取安装 token，所有 /api 请求必须携带 header（否则 401 unauthorized）
const AUTH = (document.querySelector('meta[name="fang-auth"]')?.content || '');
// UI 分析日志：所有按钮/链接点击都记录（可被自动冒烟读取）
window.__fangUiLog = [];
document.addEventListener('click', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest('button, a[href]') : null;
  if (!el) return;
  window.__fangUiLog.push({
    at: Date.now(),
    text: String(el.textContent || '').trim().slice(0, 80),
    act: el.getAttribute('data-act') || null,
    href: el.href || null,
  });
}, true);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function msg(t, bad) { $('msg').textContent = t || ''; $('msg').style.color = bad ? '#dc2626' : '#16a34a'; }
async function api(path, opts) {
  const res = await fetch(P + path, Object.assign({
    headers: Object.assign({ 'content-type': 'application/json' }, AUTH ? { 'x-fang-auth': AUTH } : {}),
  }, opts));
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
async function refresh() {
  const { body } = await api('/api/status');
  const s = body || {};
  $('mother').innerHTML = s.version
    ? '<span class="badge">母体 · ' + esc(s.profileTag) + ' · ' + esc(s.tasks?.ready) + ' ready / ' + esc(s.tasks?.total) + ' tasks</span>'
    : '';
  const list = s.tasks?.list ?? [];
  if (!list.length) { $('rows').innerHTML = '<tr><td colspan="6" class="empty">还没有任务。输入标题并点「派生新任务」。</td></tr>'; return; }
  $('rows').innerHTML = list.map(t => '<tr>' +
    '<td>' + esc(t.title) + '<br><code>' + esc(t.taskId) + '</code></td>' +
    '<td><span class="badge ' + esc(t.status) + '">' + esc(t.status) + '</span></td>' +
    '<td><span class="badge ' + (t.adapter?.ok ? 'ready' : 'failed') + '">' + (t.adapter?.ok ? 'ready' : esc(t.adapter?.error || 'down')) + '</span></td>' +
    '<td>' + (t.port ? esc(t.port) : '—') + '</td>' +
    '<td>' + (t.pid ? esc(t.pid) : '—') + '</td>' +
    '<td>' +
      (t.url ? '<a class="badge" href="' + esc(t.url) + '" target="_blank" rel="noopener">打开</a> ' : '') +
      '<button data-act="archive" data-id="' + esc(t.taskId) + '">归档</button> ' +
      '<button data-act="promote" data-id="' + esc(t.taskId) + '">提升插件…</button>' +
    '</td></tr>').join('');
}
$('create').onclick = async () => {
  const title = $('title').value.trim();
  msg('派生中…（含 Adapter 握手，约 5–20 秒）');
  const { body } = await api('/api/tasks/create', { method: 'POST', body: JSON.stringify({ title }) });
  if (body?.ok) { msg('已派生：' + body.taskId + '（adapter ' + (body.adapter?.ok ? 'ready' : '未就绪') + '）'); if (body.url) window.open(body.url, '_blank', 'noopener'); $('title').value = ''; }
  else msg('派生失败：' + (body?.error || 'unknown') + (body?.detail ? ' — ' + body.detail : ''), true);
  refresh();
};
$('refresh').onclick = refresh;
$('rows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (btn.dataset.act === 'archive') {
    if (!confirm('归档该任务？会先 flush 分身缓冲并落审计，再删除 $DSH_HOME。')) return;
    const { body } = await api('/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId: id }) });
    msg(body?.ok ? '已归档 ' + id : '归档失败：' + (body?.error || 'unknown'), !body?.ok);
  } else {
    const pluginId = prompt('要提升的插件目录名（位于该任务缓冲区内）：');
    if (!pluginId) return;
    const { body } = await api('/api/tasks/promote', { method: 'POST', body: JSON.stringify({ taskId: id, pluginId }) });
    msg(body?.ok ? '提升已批准：' + (body.note || body.target) : '提升被拒：' + (body?.error || 'unknown'), !body?.ok);
  }
  refresh();
});
refresh();
setInterval(refresh, 5000);
</script>
</body></html>`
}

export const _internals = { resolveCliPath, isShellLauncher, renderPanelHtml, loadRegistry, resolveInside, normalizeSeed }
