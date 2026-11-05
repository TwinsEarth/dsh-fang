// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-session-catalog — 母体只读会话目录（v2.1.0，供门户「选中已有会话 → 继续开发」）。
//
// 产品语义（本轮用户需求）：左导航「瓮城」→ 插件控制面板 → 在浏览器页里选中已有会话 &
// 任务继续开发。本插件只做**母体侧只读目录**：
//   * 读 `$DSH_HOME/storages/workspace.json`（工作区索引：path/title/sessionIds/归档/置顶）；
//   * 只 stat `$DSH_HOME/sessions/<workspaceKey>/<sessionId>/session.v4.jsonl.zstd`；
//   * 有界头读：只读前 256KiB、只解**第一帧** zstd（多帧日志绝不解整文件）；
//   * 返回的文本一律脱敏（token/Bearer/密码/邮箱/手机号/绝对路径）；
//   * **不写任何文件、不 spawn、不 import forker/approver**；前端只拿 sessionId，永不接受路径。
//
// 角色：仅 mother（roleGate('sessionCatalog')），fork 进程里 apply 首行直接 return。
// 服务：SERVICE.sessionCatalog = 'fangSessionCatalog'。
// 路由（exact，prefix 默认 /fang）：
//   GET /fang/api/sessions          列表（?limit=&includeArchived=&workspaceId=）
//   GET /fang/api/sessions/item     单个会话元数据（?sessionId=）
//   GET /fang/api/sessions/head     有界头读（?sessionId=&lines=&maxChars=）
//
// 空态语义（Lead e2e 验收回归）：`$DSH_HOME/sessions` 不存在 = 全新环境「还没有会话」，
// 是**正常空态**而不是错误 —— GET /fang/api/sessions → 200 + `{ok:true, sessions:[],
// degraded:['sessions-root-missing']}`，面板照常渲染空态；只有显式非法 sessionId → 400、
// 单个会话不存在 → 404、digest 超限/数据损坏 → 409/ok:false。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  z,
  roleGate,
  resolveDshHome,
  resolveFangLayout,
  SERVICE,
  FANG_VERSION,
} from '../kernel/index.mjs'
import { createHttpGuard } from '../lib/http-auth.mjs'
import {
  SESSION_ID_RE,
  SESSION_LOG_FILE,
  WORKSPACE_INDEX_FILE,
  HEAD_DEFAULTS,
  DIGEST_MAX_BYTES,
  isValidSessionId,
  emptyWorkspaceIndex,
  parseWorkspaceIndex,
  encodeWorkspaceKey,
  scanSessionDirs,
  readBoundedHead,
  readBoundedEvents,
  extractSessionTitle,
  extractConversation,
  TITLE_DEFAULTS,
  SEED_DEFAULTS,
  redact,
} from '../lib/session-format.mjs'

export const name = 'fang-session-catalog'
export const inject = []

const DEFAULTS = Object.freeze({
  prefix: '/fang',
  limit: 50,
  maxFileBytes: 262144,
  previewMaxChars: 2048,
  titleMaxFrames: 64,
  titleMaxCompressedBytes: 2 * 1024 * 1024,
  allowArchived: true,
})

export const Config = z.object({
  dataRoot: z.string().default('')
    .description('Fang 数据根（保留键，本插件只读 $DSH_HOME，不写 dataRoot）'),
  sessionsRoot: z.string().default('')
    .description('会话目录；留空 = <DSH_HOME>/sessions'),
  storagesRoot: z.string().default('')
    .description('storages 目录；留空 = <DSH_HOME>/storages（读 workspace.json）'),
  prefix: z.string().default('/fang')
    .description('HTTP 路由前缀（与门户 / client 半保持一致）'),
  limit: z.number().min(1).max(500).default(50)
    .description('列表默认返回条数（请求 ?limit= 会被夹在 1..500）'),
  maxFileBytes: z.number().min(1024).max(67108864).default(262144)
    .description('单次头读的压缩字节预算；多帧日志只解第一帧'),
  titleMaxFrames: z.number().min(1).max(4096).default(64)
    .description('标题提取最多解码的 zstd 帧数（会话标题通常在前几十帧）'),
  titleMaxCompressedBytes: z.number().min(4096).max(67108864).default(2097152)
    .description('标题提取的压缩字节预算（有界读，绝不整文件解压）'),
  previewMaxChars: z.number().min(0).max(65536).default(2048)
    .description('digest 预览的最大字符数（超过 digest 32KiB 上限会 halt 而不是截断）'),
  allowArchived: z.boolean().default(true)
    .description('是否允许在请求 includeArchived 时列出已归档会话'),
  authToken: z.string().default('')
    .description('安装级鉴权 token；留空 = env DSH_FANG_AUTH_TOKEN 或 <dataDir>/fang-auth.json（0600，自动生成）'),
  authEnabled: z.boolean().default(true)
    .description('是否要求 /fang/api/sessions* 携带安装级鉴权 token（默认开启；仅测试/本地调试可关）'),
})

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizePrefix(prefix) {
  const raw = String(prefix ?? '/fang').trim().replace(/\\/g, '/')
  if (!raw) return '/fang'
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return trimmed || '/fang'
}

function isIsoFromMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** 目标路径必须严格落在 root 内（防御纵深：sessionId 已经过正则校验）。 */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function apply(ctx, config) {
  const gate = roleGate('sessionCatalog', { logger: ctx.logger })
  if (!gate.active) return

  let configDefaults = {}
  try {
    configDefaults = Config({}) ?? {}
  } catch {
    configDefaults = {}
  }
  const cfg = { ...DEFAULTS, ...configDefaults, ...(config ?? {}) }

  const dshHome = resolveDshHome()
  // v3.0.8/B1: these three routes read real session content; they must use the
  // same install-level Host/Origin/token gate as /fang/api/status.
  const authGuard = createHttpGuard({
    dataDir: resolveFangLayout({ dataRoot: cfg.dataRoot }).dataDir,
    token: cfg.authToken,
    enabled: cfg.authEnabled !== false,
  })
  const sessionsRoot = cfg.sessionsRoot ? path.resolve(String(cfg.sessionsRoot)) : path.join(dshHome, 'sessions')
  const storagesRoot = cfg.storagesRoot ? path.resolve(String(cfg.storagesRoot)) : path.join(dshHome, 'storages')
  const workspaceIndexFile = path.join(storagesRoot, WORKSPACE_INDEX_FILE)
  const prefix = normalizePrefix(cfg.prefix)
  const defaultLimit = clampInt(cfg.limit, 1, 500, DEFAULTS.limit)
  const maxFileBytes = clampInt(cfg.maxFileBytes, 1024, 64 * 1024 * 1024, DEFAULTS.maxFileBytes)
  const previewMaxChars = clampInt(cfg.previewMaxChars, 0, 65536, DEFAULTS.previewMaxChars)
  const allowArchived = cfg.allowArchived !== false
  const titleMaxFrames = clampInt(cfg.titleMaxFrames, 1, 4096, DEFAULTS.titleMaxFrames)
  const titleMaxCompressedBytes = clampInt(cfg.titleMaxCompressedBytes, 4096, 64 * 1024 * 1024, DEFAULTS.titleMaxCompressedBytes)

  /** 注入给纯函数库的 fs 视图（只读方法；库本身零 node 依赖）。 */
  const fsApi = {
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
    openSync: fs.openSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
  }
  const zstdDecompressSync = zlib.zstdDecompressSync

  const audit = (kind, data) => {
    try {
      const auditor = ctx.get(SERVICE.auditor)
      if (auditor && typeof auditor.append === 'function') auditor.append(kind, data)
    } catch {
      /* 审计失败不得阻塞只读目录 */
    }
  }

  // ── 只读索引 ─────────────────────────────────────────────────────────────
  const readIndex = () => {
    let raw
    try {
      raw = fs.readFileSync(workspaceIndexFile, 'utf8')
    } catch (e) {
      const code = e?.code === 'ENOENT' ? 'index-not-found' : 'index-read-failed'
      return { ok: false, code, ...emptyWorkspaceIndex([code]), file: workspaceIndexFile }
    }
    const parsed = parseWorkspaceIndex(raw)
    return { ok: true, ...parsed, file: workspaceIndexFile }
  }

  const keyMapOf = (index) => {
    const map = new Map()
    for (const workspace of index.workspaces) map.set(encodeWorkspaceKey(workspace.path), workspace)
    return map
  }

  /** 一次完整只读扫描：index + 目录（只 stat，不解压）。 */
  const scan = () => {
    const index = readIndex()
    const keyMap = keyMapOf(index)
    let workspaceDirs = []
    try {
      workspaceDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry && typeof entry.isDirectory === 'function' && entry.isDirectory())
        .map((entry) => entry.name)
    } catch (e) {
      const code = e?.code === 'ENOENT' ? 'sessions-root-missing' : 'sessions-root-read-failed'
      return { ok: false, code, index, sessions: [], degraded: [...index.degraded, code] }
    }
    const rows = scanSessionDirs({
      sessionsDir: sessionsRoot,
      workspaceIds: workspaceDirs,
      archivedSessionIds: index.global.archivedSessionIds,
      pinnedSessionIds: index.global.pinnedSessionIds,
      fsApi,
    })
    const sessions = rows.map((row) => {
      const workspace = keyMap.get(row.workspaceId) ?? null
      return {
        sessionId: row.sessionId,
        workspaceId: workspace ? workspace.id : null,
        workspaceKey: row.workspaceId,
        workspacePath: workspace ? workspace.path : null,
        workspaceTitle: workspace ? workspace.title : row.workspaceId,
        workspaceKnown: Boolean(workspace),
        updatedAt: row.updatedAt,
        bytes: row.bytes,
        archived: row.archived,
        pinned: row.pinned,
        relPath: row.relPath,
      }
    })
    return { ok: true, index, sessions, degraded: [...index.degraded] }
  }

  /** 对外视图：只给前端展示/选择所需字段（不暴露绝对日志路径）。 */
  const sessionView = (session) => ({
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    workspaceKey: session.workspaceKey,
    workspacePath: session.workspacePath,
    workspaceTitle: session.workspaceTitle,
    workspaceKnown: session.workspaceKnown,
    updatedAt: session.updatedAt,
    updatedAtIso: isIsoFromMs(session.updatedAt),
    bytes: session.bytes,
    archived: session.archived,
    pinned: session.pinned,
  })

  const logFileFor = (session) => {
    const file = path.resolve(sessionsRoot, session.workspaceKey, session.sessionId, SESSION_LOG_FILE)
    return isInside(sessionsRoot, file) ? file : null
  }

  // ── 会话标题（有界多帧读 + mtime 缓存）──────────────────────────────
  /** sessionId → { mtimeMs, size, value }；日志没变就不重复解帧。 */
  const titleCache = new Map()

  const titleOf = (session) => {
    const file = logFileFor(session)
    if (!file) return { title: null, titleSource: null, preview: null, degraded: ['no-log-file'] }
    let stat = null
    try { stat = fs.statSync(file) } catch { /* 读不到就走解帧降级 */ }
    const cached = titleCache.get(session.sessionId)
    if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
    const decoded = readBoundedEvents({
      file,
      maxFrames: titleMaxFrames,
      maxCompressedBytes: titleMaxCompressedBytes,
      fsApi,
      zstdDecompressSync,
    })
    const extracted = extractSessionTitle(decoded.events)
    const header = decoded.events.find((event) => event?.type === 'session')
    const userMessages = decoded.events.filter((event) => event?.type === 'user/message').length
    const value = {
      title: extracted.title,
      titleSource: extracted.titleSource,
      preview: extracted.preview,
      messageSeq: extracted.messageSeq,
      createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
      userMessages,
      empty: userMessages === 0,
      framesDecoded: decoded.framesDecoded,
      degraded: decoded.degraded,
    }
    if (stat) titleCache.set(session.sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  }

  const titleFields = (info, fallbackTitle = null) => ({
    title: info.title ?? fallbackTitle ?? null,
    titleSource: info.title ? (info.titleSource ?? 'unknown') : 'workspace',
    preview: info.preview ?? null,
    titleDegraded: info.degraded ?? [],
    createdAt: info.createdAt ?? null,
    createdAtIso: isIsoFromMs(info.createdAt),
    userMessages: info.userMessages ?? 0,
    empty: info.empty === true,
  })

  /** 按 sessionId 定位（前端只传 id；路径永远由扫描结果推出）。 */
  const findSession = (sessionId) => {
    const raw = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
    if (!isValidSessionId(raw)) {
      return { ok: false, code: 'invalid-session-id', sessionId: raw, allowedPattern: String(SESSION_ID_RE) }
    }
    const scanned = scan()
    // 「还没有会话目录」是全新环境的正常空态，不是服务错误：ok:true + readable:false + degraded。
    if (!scanned.ok) {
      return { ok: false, code: 'not-found', sessionId: raw, degraded: scanned.degraded }
    }
    const found = scanned.sessions.find((session) => session.sessionId === raw)
    if (!found) return { ok: false, code: 'not-found', sessionId: raw, sessionsRoot }
    const file = logFileFor(found)
    if (!file) return { ok: false, code: 'path-escape', sessionId: raw }
    return { ok: true, session: found, file, index: scanned.index, degraded: scanned.degraded }
  }

  // ── service 方法（只读）──────────────────────────────────────────────────

  const status = () => {
    const scanned = scan()
    const sessions = scanned.sessions ?? []
    const counts = {
      sessions: sessions.length,
      archived: sessions.filter((s) => s.archived).length,
      pinned: sessions.filter((s) => s.pinned).length,
      workspaces: scanned.index.workspaces.length,
      workspaceDirs: new Set(sessions.map((s) => s.workspaceKey)).size,
    }
    return {
      ok: true,
      role: gate.role,
      version: FANG_VERSION,
      readOnly: true,
      readable: scanned.ok,
      sessionsRoot,
      storagesRoot,
      workspaceIndex: workspaceIndexFile,
      workspaceIndexOk: scanned.index.ok !== false,
      limit: defaultLimit,
      maxFileBytes,
      previewMaxChars,
      titleBudget: { maxFrames: titleMaxFrames, maxCompressedBytes: titleMaxCompressedBytes },
      allowArchived,
      counts,
      degraded: scanned.degraded,
    }
  }

  const listSessions = (options = {}) => {
    const opts = options && typeof options === 'object' ? options : {}
    const scanned = scan()
    const requestedLimit = clampInt(opts.limit ?? defaultLimit, 1, 500, defaultLimit)
    const includeArchivedEffective = allowArchived && opts.includeArchived === true
    // 「sessions 根不存在」= 全新环境 / 还没有任何会话：200 + 空列表 + degraded，不是错误。
    if (!scanned.ok) {
      audit('session-listed', { ok: true, readable: false, code: scanned.code, count: 0 })
      return {
        ok: true,
        readable: false,
        sessions: [],
        total: 0,
        returned: 0,
        limit: requestedLimit,
        includeArchived: includeArchivedEffective,
        degraded: scanned.degraded,
        sessionsRoot,
        storagesRoot,
      }
    }
    const workspaceFilter = typeof opts.workspaceId === 'string' && opts.workspaceId.trim() ? opts.workspaceId.trim() : null

    let items = scanned.sessions
    if (!includeArchivedEffective) items = items.filter((session) => !session.archived)
    if (workspaceFilter) {
      items = items.filter((session) => session.workspaceId === workspaceFilter
        || session.workspaceKey === workspaceFilter
        || session.workspacePath === workspaceFilter)
    }
    const total = items.length
    const page = items.slice(0, requestedLimit)
    audit('session-listed', {
      ok: true,
      count: page.length,
      total,
      includeArchived: includeArchivedEffective,
      workspaceId: workspaceFilter,
      limit: requestedLimit,
    })
    return {
      ok: true,
      sessions: page.map((session) => ({ ...sessionView(session), ...titleFields(titleOf(session), session.workspaceTitle) })),
      total,
      returned: page.length,
      limit: requestedLimit,
      includeArchived: includeArchivedEffective,
      degraded: scanned.degraded,
      sessionsRoot,
    }
  }

  const getSession = (sessionId) => {
    const found = findSession(sessionId)
    if (!found.ok) return found
    const session = found.session
    const head = readBoundedHead({
      file: found.file,
      maxCompressedBytes: maxFileBytes,
      maxLines: 1,
      maxChars: 4096,
      fsApi,
      zstdDecompressSync,
    })
    const degraded = [...new Set([...(found.degraded ?? []), ...head.degraded])]
    let header = null
    if (head.lines.length > 0) {
      try {
        const parsed = JSON.parse(head.lines[0])
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) header = parsed
        else degraded.push('header-unparsable')
      } catch {
        degraded.push('header-unparsable')
      }
    } else if (!degraded.includes('decompress-failed')) {
      degraded.push('header-missing')
    }
    const createdAt = Number.isFinite(header?.createdAt) ? header.createdAt : null
    const view = {
      ...sessionView(session),
      createdAt,
      createdAtIso: isIsoFromMs(createdAt),
      cwd: typeof header?.cwd === 'string' ? header.cwd : null,
      agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : null,
      isSeeded: header?.isSeeded === true,
      delegationDepth: Number.isFinite(header?.delegationDepth) ? header.delegationDepth : null,
      sessionVersion: Number.isFinite(header?.version) ? header.version : null,
      header,
      logFile: SESSION_LOG_FILE,
      head: { lines: head.lines.length, bytesRead: head.bytesRead, degraded: head.degraded },
      ...titleFields(titleOf(session), session.workspaceTitle),
    }
    audit('session-read', { ok: true, sessionId: session.sessionId, op: 'get', bytesRead: head.bytesRead })
    return { ok: true, session: view, degraded }
  }

  const readHead = (sessionId, options = {}) => {
    const found = findSession(sessionId)
    if (!found.ok) return found
    const opts = options && typeof options === 'object' ? options : {}
    const maxLines = clampInt(opts.maxLines ?? HEAD_DEFAULTS.maxLines, 1, 1000, HEAD_DEFAULTS.maxLines)
    const maxChars = clampInt(opts.maxChars ?? HEAD_DEFAULTS.maxChars, 0, 16 * 1024 * 1024, HEAD_DEFAULTS.maxChars)
    const maxCompressedBytes = clampInt(opts.maxCompressedBytes ?? maxFileBytes, 4, 64 * 1024 * 1024, maxFileBytes)
    const head = readBoundedHead({
      file: found.file,
      maxCompressedBytes,
      maxLines,
      maxChars,
      fsApi,
      zstdDecompressSync,
    })
    let redactions = 0
    const lines = head.lines.map((line) => {
      const redacted = redact(line)
      redactions += redacted.redactions
      return redacted.text
    })
    audit('session-read', {
      ok: true,
      sessionId: found.session.sessionId,
      op: 'head',
      lines: lines.length,
      bytesRead: head.bytesRead,
      redactions,
    })
    return {
      ok: true,
      sessionId: found.session.sessionId,
      workspaceId: found.session.workspaceId,
      lines,
      redactions,
      bytesRead: head.bytesRead,
      degraded: [...new Set([...(found.degraded ?? []), ...head.degraded])],
    }
  }

  const buildDigest = (session, lines, degraded) => {
    const parts = []
    parts.push(`# 会话 ${session.sessionId}`)
    parts.push('')
    parts.push(`- 工作区: ${session.workspaceTitle}${session.workspaceKnown ? ` (${session.workspacePath})` : '（未在 workspace.json 登记）'}`)
    parts.push(`- sessionId: \`${session.sessionId}\``)
    parts.push(`- 创建: ${session.createdAtIso ?? 'unknown'} / 最近更新: ${session.updatedAtIso ?? 'unknown'}`)
    parts.push(`- 日志: ${session.bytes} bytes（头读 ${lines.bytesRead ?? 0} bytes，只解第一帧）`)
    parts.push(`- 归档: ${session.archived ? 'yes' : 'no'} / 置顶: ${session.pinned ? 'yes' : 'no'}`)
    if (session.agentPreset) parts.push(`- agentPreset: ${session.agentPreset}`)
    if (Number.isFinite(session.sessionVersion)) parts.push(`- session format: v${session.sessionVersion}`)
    if (session.cwd) parts.push(`- cwd: ${session.cwd}`)
    parts.push('')
    parts.push('## 头部事件（已脱敏）')
    parts.push('')
    if (lines.lines.length === 0) {
      parts.push('_（头读没有解出任何行）_')
    } else {
      parts.push('```jsonl')
      for (const line of lines.lines) parts.push(line)
      parts.push('```')
    }
    if (degraded.length > 0) {
      parts.push('')
      parts.push(`> degraded: ${degraded.join(', ')}`)
    }
    return parts.join('\n')
  }

  const digest = (sessionId) => {
    const got = getSession(sessionId)
    if (!got.ok) return got
    const session = got.session
    const head = readHead(sessionId, { maxLines: 20, maxChars: previewMaxChars })
    const lines = head.ok ? head : { lines: [], bytesRead: 0, degraded: [] }
    const degraded = [...new Set([
      ...(got.degraded ?? []),
      ...(head.ok ? head.degraded : [head.code ?? 'head-failed']),
    ])]
    const markdown = buildDigest(session, lines, degraded)
    const bytes = Buffer.byteLength(markdown, 'utf8')
    if (bytes > DIGEST_MAX_BYTES) {
      // 契约：超限 halt，不静默截断（调用方要么收紧 previewMaxChars，要么只读 head）。
      return {
        ok: false,
        code: 'digest-too-large',
        bytes,
        limit: DIGEST_MAX_BYTES,
        sessionId: session.sessionId,
        degraded: [...degraded, 'digest-too-large'],
      }
    }
    audit('session-read', { ok: true, sessionId: session.sessionId, op: 'digest', bytes })
    return {
      ok: true,
      sessionId: session.sessionId,
      // `markdown` 是 orchestrator.derive() 读取的字段（lineage seed）；`digest` 为等价别名。
      markdown,
      digest: markdown,
      bytes,
      limit: DIGEST_MAX_BYTES,
      redactions: lines.redactions ?? 0,
      degraded,
    }
  }

  /**
   * 会话交接种子：有界多帧读取 + 对话摘录，供派生分身时写入 fang-seeds 并导入历史会话。
   * 空会话（没有任何 user/message）显式返回 session-empty，不伪造交接内容。
   */
  const seed = (sessionId, options = {}) => {
    const found = findSession(sessionId)
    if (!found.ok) return found
    const opts = options && typeof options === 'object' ? options : {}
    const maxFrames = clampInt(opts.maxFrames ?? SEED_DEFAULTS.maxFrames, 8, 4096, SEED_DEFAULTS.maxFrames)
    const maxCompressedBytes = clampInt(opts.maxCompressedBytes ?? SEED_DEFAULTS.maxCompressedBytes, 4096, 256 * 1024 * 1024, SEED_DEFAULTS.maxCompressedBytes)
    const maxChars = clampInt(opts.maxChars ?? SEED_DEFAULTS.maxChars, 1024, 256 * 1024, SEED_DEFAULTS.maxChars)
    const decoded = readBoundedEvents({ file: found.file, maxFrames, maxCompressedBytes, fsApi, zstdDecompressSync })
    const meta = extractSessionTitle(decoded.events)
    const conv = extractConversation(decoded.events, { maxChars })
    if (conv.messages === 0) {
      return {
        ok: false,
        code: 'session-empty',
        sessionId: found.session.sessionId,
        degraded: decoded.degraded,
        framesDecoded: decoded.framesDecoded,
      }
    }
    const header = decoded.events.find((event) => event.type === 'session')
    const session = found.session
    const title = meta.title ?? '未命名会话'
    const lines = []
    lines.push(`# 会话交接：${title}`)
    lines.push('')
    lines.push(`- sessionId: \`${session.sessionId}\``)
    lines.push(`- 工作区: ${session.workspaceTitle}${session.workspacePath ? ` (${session.workspacePath})` : '（未在 workspace.json 登记）'}`)
    if (Number.isFinite(header?.createdAt)) lines.push(`- 创建: ${new Date(header.createdAt).toISOString()}`)
    if (Number.isFinite(session.updatedAt)) lines.push(`- 最近更新: ${new Date(session.updatedAt).toISOString()}`)
    if (typeof header?.cwd === 'string') lines.push(`- cwd: ${header.cwd}`)
    if (typeof header?.agentPreset === 'string') lines.push(`- agentPreset: ${header.agentPreset}`)
    lines.push(`- 摘录: ${conv.messages} 条消息 / 最多 ${maxChars} 字符${conv.truncated ? '（已截断）' : ''}`)
    lines.push('')
    lines.push('## 对话摘录')
    lines.push('')
    lines.push(conv.markdown || '_（无对话内容）_')
    if (decoded.degraded.length > 0) {
      lines.push('')
      lines.push(`> degraded: ${decoded.degraded.join(', ')}`)
    }
    const markdown = lines.join('\n')
    return {
      ok: true,
      sessionId: session.sessionId,
      title,
      markdown,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      messages: conv.messages,
      truncated: conv.truncated,
      framesDecoded: decoded.framesDecoded,
      degraded: decoded.degraded,
      sourceFile: found.file,
      sourceBytes: session.bytes,
      workspaceId: session.workspaceId,
      workspacePath: session.workspacePath,
      workspaceTitle: session.workspaceTitle,
      createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
      updatedAt: session.updatedAt,
      cwd: typeof header?.cwd === 'string' ? header.cwd : null,
      agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : null,
    }
  }

  const service = {
    role: gate.role,
    version: FANG_VERSION,
    /** 只读能力自述：任何调用方都不得通过本服务写盘。 */
    readOnly: true,
    sessionsRoot,
    storagesRoot,
    routes: [],

    status,
    listSessions,
    getSession,
    readHead,
    digest,
    seed,
  }

  ctx.effect(() => ctx.provide(SERVICE.sessionCatalog, service))

  // ── HTTP 路由（处理器与 service 共用同一实现）────────────────────────────
  const json = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    } catch {
      /* 假 res 不能把处理器打挂 */
    }
    try {
      res.end(JSON.stringify(obj))
    } catch {
      /* 同上 */
    }
  }

  const statusForCode = (code) => {
    switch (String(code ?? '')) {
      case 'invalid-session-id':
      case 'bad-request':
        return 400
      case 'not-found':
        return 404
      case 'path-escape':
      case 'sessions-root-missing':
      case 'sessions-root-read-failed':
      case 'index-read-failed':
      case 'digest-too-large':
        return 409
      default:
        return 500
    }
  }

  const sendResult = (res, out) => json(res, out && out.ok !== false ? 200 : statusForCode(out?.code), out)

  const parseQuery = (rawUrl) => {
    try {
      const url = new URL(String(rawUrl ?? '/'), 'http://127.0.0.1')
      return url.searchParams
    } catch {
      return new URLSearchParams()
    }
  }
  const paramNumber = (params, name) => {
    if (!params.has(name)) return undefined
    const value = Number(params.get(name))
    return Number.isFinite(value) ? value : undefined
  }

  const registerRoutes = (webServer) => {
    const route = (method, routePath, handler) => {
      webServer.register({
        kind: 'exact',
        path: routePath,
        method,
        handler: async (req, res) => {
          // Auth before method: a token-less POST must be 401, not 405 (fail-closed).
          const decision = authGuard.check(req)
          if (!decision.ok) {
            return json(res, decision.status, { ok: false, error: decision.code, code: decision.code })
          }
          const actual = String(req?.method ?? 'GET').toUpperCase()
          if (actual !== method) {
            try { res.setHeader?.('allow', method) } catch { /* fake res */ }
            return json(res, 405, { ok: false, code: 'method-not-allowed', error: 'method-not-allowed', path: routePath })
          }
          try {
            return await handler(req, res)
          } catch (e) {
            return json(res, 500, { ok: false, code: 'handler-threw', error: String(e?.message ?? e) })
          }
        },
      })
      service.routes.push(routePath)
    }

    route('GET', `${prefix}/api/sessions`, (req, res) => {
      const params = parseQuery(req?.url)
      const includeRaw = params.get('includeArchived')
      const includeArchived = includeRaw === '1' || includeRaw === 'true' || includeRaw === 'yes'
      return sendResult(res, listSessions({
        limit: paramNumber(params, 'limit'),
        includeArchived,
        workspaceId: params.get('workspaceId') ?? undefined,
      }))
    })

    route('GET', `${prefix}/api/sessions/item`, (req, res) => {
      const params = parseQuery(req?.url)
      return sendResult(res, getSession(params.get('sessionId') ?? ''))
    })

    route('GET', `${prefix}/api/sessions/head`, (req, res) => {
      const params = parseQuery(req?.url)
      return sendResult(res, readHead(params.get('sessionId') ?? '', {
        maxLines: paramNumber(params, 'lines'),
        maxChars: paramNumber(params, 'maxChars'),
        maxCompressedBytes: paramNumber(params, 'maxCompressedBytes'),
      }))
    })
  }

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (child) => {
        let webServer = null
        try {
          webServer = child?.get?.('webServer') ?? child?.webServer ?? null
        } catch {
          webServer = null
        }
        if (!webServer || typeof webServer.register !== 'function') return
        registerRoutes(webServer)
      })
    }
  } catch {
    /* 没有 webServer 时 service 仍可被宿主内其它插件（orchestrator seed）直接调用 */
  }

  return service
}

export const _internals = {
  DEFAULTS,
  normalizePrefix,
  isInside,
  clampInt,
}
