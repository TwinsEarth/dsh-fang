// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.1.0 — 会话格式库（T10，母体只读会话目录的纯函数核心）。
//
// 本模块**零 import**：不依赖 node:fs / node:path / node:zlib / node:buffer。
// 所有 IO 与 zstd 解码通过参数注入（fsApi / zstdDecompressSync），因此可以在
// 单测里用假 fs、在浏览器兼容层里复用；只有文本解码用了 Web 标准 TextDecoder。
//
// 格式（本机实测 $DSH_HOME，2026-11-01）：
//   $DSH_HOME/storages/workspace.json
//     { unit, global:{ archivedSessionIds[], pinnedSessionIds[], workspaceIds[], defaultWorkspaceId },
//       tables:{ workspaces:{ <workspaceId>:{ path, title, sessionIds[], createdAt, updatedAt } } } }
//   $DSH_HOME/sessions/<workspaceKey>/<sessionId>/session.v4.jsonl.zstd
//     workspaceKey 由工作区绝对路径编码（`E:\GPT` → `--E-GPT--`，只用于显示/定位，不可反解）；
//     日志是**多帧 zstd 拼接**：第一帧通常只有一行 session 头，后续帧是事件。
//
// 安全规则：任何来自前端的值只当 sessionId 用（正则校验，拒绝路径元字符），绝不拼路径。

/** 允许作为会话目录名的 id：`session-<uuid>` 或裸 `<uuid>`（本机 v4 两种都存在）。 */
export const SESSION_ID_RE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 会话日志文件名（v4 格式）。 */
export const SESSION_LOG_FILE = 'session.v4.jsonl.zstd'

/** 工作区索引文件名。 */
export const WORKSPACE_INDEX_FILE = 'workspace.json'

/** zstd 帧 magic 28 B5 2F FD。 */
export const ZSTD_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd])

/** 头读默认预算（契约 §T10）。 */
export const HEAD_DEFAULTS = Object.freeze({
  maxCompressedBytes: 262144,
  maxLines: 50,
  maxChars: 65536,
})

/** digest 上限：32 KiB（超限 halt，不静默截断）。 */
export const DIGEST_MAX_BYTES = 32 * 1024

let sharedDecoder = null
function decodeUtf8(bytes) {
  if (typeof TextDecoder !== 'function') {
    // 极端宿主没有 TextDecoder：逐字节 Latin-1 兜底（不抛，可能非 UTF-8 文本降级）
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return s
  }
  if (!sharedDecoder) sharedDecoder = new TextDecoder('utf-8', { fatal: false })
  return sharedDecoder.decode(bytes)
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** workspace 目录名只接受单段名字（readdir 已保证，但外部传入也挡一层）。 */
function isSingleSegmentName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

/** 宽松的 sessionId 校验：只允许 `session-` + 36 个 hex/'-' 或裸 uuid。 */
export function isValidSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && SESSION_ID_RE.test(value)
}

/** 返回空工作区索引（错误路径也保持同一形状）。 */
export function emptyWorkspaceIndex(degraded = []) {
  return {
    workspaces: [],
    global: {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      workspaceIds: [],
      defaultWorkspaceId: null,
      initialized: false,
    },
    degraded: [...degraded],
  }
}

/** 字符串数组归一化：trim、去空、去重（可选正则过滤）。 */
function cleanList(value, filter = null) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (!s || seen.has(s)) continue
    if (filter && !filter(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 容错解析 workspace.json。
 * @param {string|object} raw JSON 文本或已解析对象
 * @returns {{workspaces:{id,path,title,sessionIds}[], global:{archivedSessionIds,pinnedSessionIds,workspaceIds,defaultWorkspaceId,initialized}, degraded:string[]}}
 */
export function parseWorkspaceIndex(raw) {
  if (raw === undefined || raw === null) return emptyWorkspaceIndex(['empty'])
  let doc = raw
  if (typeof raw === 'string') {
    const text = raw.replace(/^\uFEFF/, '').trim()
    if (!text) return emptyWorkspaceIndex(['empty'])
    try {
      doc = JSON.parse(text)
    } catch {
      return emptyWorkspaceIndex(['invalid-json'])
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return emptyWorkspaceIndex(['invalid-shape'])

  const degraded = []
  const tables = doc.tables && typeof doc.tables === 'object' && doc.tables.workspaces
    ? doc.tables.workspaces
    : null
  const rawWorkspaces = tables && typeof tables === 'object' && !Array.isArray(tables)
    ? tables
    : (doc.workspaces && typeof doc.workspaces === 'object' && !Array.isArray(doc.workspaces) ? doc.workspaces : null)
  if (!rawWorkspaces) degraded.push('no-workspaces-table')

  const workspaces = []
  const seenPaths = new Set()
  for (const [id, rec] of Object.entries(rawWorkspaces ?? {})) {
    if (!rec || typeof rec !== 'object') continue
    const workspacePath = typeof rec.path === 'string' ? rec.path.trim() : ''
    if (!workspacePath) continue
    if (seenPaths.has(workspacePath)) continue
    seenPaths.add(workspacePath)
    workspaces.push({
      id: String(id),
      path: workspacePath,
      title: typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : workspacePath,
      sessionIds: cleanList(rec.sessionIds),
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : null,
      updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null,
    })
  }
  workspaces.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const g = doc.global && typeof doc.global === 'object' ? doc.global : {}
  return {
    workspaces,
    global: {
      archivedSessionIds: cleanList(g.archivedSessionIds, isValidSessionId),
      pinnedSessionIds: cleanList(g.pinnedSessionIds, isValidSessionId),
      workspaceIds: cleanList(g.workspaceIds),
      defaultWorkspaceId: typeof g.defaultWorkspaceId === 'string' ? g.defaultWorkspaceId : null,
      initialized: g.initialized === true,
    },
    degraded,
  }
}

/**
 * 工作区绝对路径 → 会话目录名（仅显示/定位，**不可反解**）。
 * 实测 `E:\GPT` → `--E-GPT--`，`C:\Users\a\b\c` → `--C-Users-a-b-c--`：
 * 非 [A-Za-z0-9_-] 的连续字符折叠为单个 '-'，首尾各包 '--'。
 */
export function encodeWorkspaceKey(workspacePath) {
  const raw = String(workspacePath ?? '').trim().replace(/[\\/]+$/, '')
  if (!raw) return ''
  const body = raw.replace(/[^A-Za-z0-9_-]+/g, '-')
  return `--${body}--`
}

/** 'a/b' 拼接（不引入 node:path；Windows 也接受正斜杠）。 */
function joinRel(base, ...rest) {
  const parts = [String(base ?? '').replace(/[\\/]+$/, ''), ...rest.map((p) => String(p ?? '').replace(/^[\\/]+/g, '').replace(/[\\/]+$/, ''))]
  return parts.filter((p) => p !== '').join('/')
}

/** 帧边界：从 buf 里找 zstd magic 出现的位置。 */
function findMagicOffsets(bytes) {
  const offsets = []
  const b0 = ZSTD_MAGIC[0]
  const b1 = ZSTD_MAGIC[1]
  const b2 = ZSTD_MAGIC[2]
  const b3 = ZSTD_MAGIC[3]
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === b0 && bytes[i + 1] === b1 && bytes[i + 2] === b2 && bytes[i + 3] === b3) offsets.push(i)
    if (offsets.length >= 64) break // 头读预算内 64 帧足够；再多也只解第一帧
  }
  return offsets
}

/**
 * 取第一帧的字节切片（多帧 zstd 只解第一帧；不得整文件解压）。
 * 候选边界 = 第 2 个及之后的 magic 位置；按升序尝试单帧解压，第一个成功者即第一帧边界。
 * 没有候选 / 候选都失败 → 返回整段（由调用方单帧解压，通常是真第一帧或会抛错降级）。
 * @returns {{slice:Uint8Array, hasMoreFrames:boolean, boundary:number|null}}
 */
function firstFrameSlice(bytes, zstdDecompressSync) {
  const offsets = findMagicOffsets(bytes)
  const candidates = offsets.filter((off) => off > 0)
  for (const off of candidates) {
    try {
      zstdDecompressSync(bytes.subarray(0, off))
      return { slice: bytes.subarray(0, off), hasMoreFrames: true, boundary: off }
    } catch {
      /* 这个 magic 是压缩数据里的巧合，试下一个候选 */
    }
  }
  return { slice: bytes, hasMoreFrames: false, boundary: null }
}

/**
 * 有界头读：只读文件前 maxCompressedBytes 字节，只解第一帧 zstd，返回文本行。
 * @param {object} options
 * @param {string} options.file 会话日志绝对路径
 * @param {number} [options.maxCompressedBytes=262144] 读取/解压预算（压缩字节）
 * @param {number} [options.maxLines=50] 最多返回的行数
 * @param {number} [options.maxChars=65536] 最多返回的字符数
 * @param {object} options.fsApi 注入的 fs：{statSync?, openSync, readSync, closeSync}
 * @param {Function} options.zstdDecompressSync 注入的 zlib.zstdDecompressSync
 * @returns {{lines:string[], degraded:string[], bytesRead:number}}
 */
export function readBoundedHead(options = {}) {
  const {
    file,
    maxCompressedBytes = HEAD_DEFAULTS.maxCompressedBytes,
    maxLines = HEAD_DEFAULTS.maxLines,
    maxChars = HEAD_DEFAULTS.maxChars,
    fsApi,
    zstdDecompressSync,
  } = options ?? {}
  const degraded = []
  const out = { lines: [], degraded, bytesRead: 0 }
  const note = (tag) => {
    if (!degraded.includes(tag)) degraded.push(tag)
  }

  if (typeof file !== 'string' || !file) {
    note('no-file')
    return out
  }
  if (!fsApi || typeof fsApi.openSync !== 'function' || typeof fsApi.readSync !== 'function' || typeof fsApi.closeSync !== 'function') {
    note('no-fs-api')
    return out
  }
  const budget = clampInt(maxCompressedBytes, 4, 64 * 1024 * 1024, HEAD_DEFAULTS.maxCompressedBytes)
  const lineBudget = clampInt(maxLines, 1, 100000, HEAD_DEFAULTS.maxLines)
  const charBudget = clampInt(maxChars, 0, 16 * 1024 * 1024, HEAD_DEFAULTS.maxChars)

  let fd = null
  try {
    let fileSize = null
    if (typeof fsApi.statSync === 'function') {
      try {
        const st = fsApi.statSync(file)
        if (st && Number.isFinite(st.size)) fileSize = st.size
      } catch {
        /* stat 失败会在 open 阶段再次暴露 */
      }
    }
    if (fileSize === 0) {
      note('empty')
      return out
    }
    fd = fsApi.openSync(file, 'r')
    const toRead = fileSize === null ? budget : Math.min(fileSize, budget)
    if (!(toRead > 0)) {
      note('empty')
      return out
    }
    const buffer = new Uint8Array(toRead)
    const read = fsApi.readSync(fd, buffer, 0, toRead, 0)
    out.bytesRead = Number.isFinite(read) ? read : 0
    if (out.bytesRead <= 0) {
      note('empty')
      return out
    }
    if (fileSize !== null && out.bytesRead < fileSize) note('compressed-limit')
    if (out.bytesRead < toRead) note('short-read')
    const view = buffer.subarray(0, out.bytesRead)

    const looksZstd = view.length >= 4
      && view[0] === ZSTD_MAGIC[0] && view[1] === ZSTD_MAGIC[1]
      && view[2] === ZSTD_MAGIC[2] && view[3] === ZSTD_MAGIC[3]
    let text = ''
    let moreBytesOnDisk = fileSize !== null && fileSize > out.bytesRead
    if (looksZstd) {
      if (typeof zstdDecompressSync !== 'function') {
        note('no-zstd')
        return out
      }
      const frame = firstFrameSlice(view, zstdDecompressSync)
      if (frame.hasMoreFrames) moreBytesOnDisk = true
      if (moreBytesOnDisk) note('first-frame-only')
      try {
        const decoded = zstdDecompressSync(frame.slice)
        // 注意：Node 的 zstdDecompressSync 对「被截断的帧」不抛错，而是返回 0 字节。
        // 会话日志帧不会是空内容，因此 0 字节 + 非空输入一律按解压失败降级，绝不假装成功。
        const bytes = decoded instanceof Uint8Array ? decoded : new Uint8Array(decoded)
        if (bytes.length === 0 && frame.slice.length > 0) {
          note('decompress-failed')
          return out
        }
        text = decodeUtf8(bytes)
      } catch {
        note('decompress-failed')
        return out
      }
    } else {
      // 非 zstd（例如测试人造纯文本）：按 UTF-8 文本读，如实标记降级而不是假装成功。
      note('not-zstd')
      text = decodeUtf8(view)
    }

    let lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length > lineBudget) {
      lines = lines.slice(0, lineBudget)
      note('line-limit')
    }
    const kept = []
    let chars = 0
    for (const line of lines) {
      if (charBudget <= 0) {
        note('char-limit')
        break
      }
      if (chars + line.length + 1 <= charBudget) {
        kept.push(line)
        chars += line.length + 1
        continue
      }
      const remain = charBudget - chars
      kept.push(remain > 1 ? line.slice(0, remain - 1) : '')
      note('char-limit')
      break
    }
    out.lines = kept
    return out
  } catch {
    note('read-failed')
    return out
  } finally {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd)
      } catch {
        /* close 失败不影响已读结果 */
      }
    }
  }
}

// ── 脱敏 ────────────────────────────────────────────────────────────────────
// 顺序有意义：先凭证类，再联系方式，最后绝对路径；每类替换后计数。
const REDACTION_RULES = [
  // Bearer <token>
  { re: /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, to: (_m, p1) => `${p1}<redacted>` },
  // token / password / secret / api_key = value（含 JSON 的 "key":"value" 形式）
  {
    re: /(\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password|passwd)\b["']?\s*[:=]\s*["']?)([^"'\s,&}]{3,})/gi,
    to: (_m, p1) => `${p1}<redacted>`,
  },
  // OpenAI 风格 sk- 键
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, to: () => '<redacted>' },
  // 邮箱（本地/域名段都限长：避免在超长无 @ 字符串上退化成 O(n²) 回溯）
  { re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9][A-Za-z0-9.-]{0,253}\.[A-Za-z]{2,24}/g, to: () => '<email>' },
  // 手机号（中国大陆 11 位 / +86 前缀）
  { re: /(?<![\w.])(?:\+?86[-\s]?)?1[3-9]\d{9}(?![\w.])/g, to: () => '<phone>' },
  // 国际号码
  { re: /(?<![\w.])\+\d{1,3}[-\s]?\d{6,14}(?![\w.])/g, to: () => '<phone>' },
  // Windows 绝对路径（必须先于 UNC：JSON 里的 `E:\\GPT\\x` 双反斜杠前缀也像 UNC）
  { re: /[A-Za-z]:[\\/](?:[^\s"'<>|,;:]+[\\/])*[^\s"'<>|,;:]+/g, to: () => '<path>' },
  // UNC 绝对路径
  { re: /\\\\[A-Za-z0-9._$-]+\\[^\s"'<>|,;]+/g, to: () => '<path>' },
  // POSIX 绝对路径（至少两段，避免误伤单段路由）
  { re: /(?<=[\s"'(=:])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, to: () => '<path>' },
]

/**
 * 文本脱敏：token/Bearer/sk-/password/secret/api_key 值、邮箱、手机号、绝对路径。
 * @param {string} text
 * @returns {{text:string, redactions:number}}
 */
export function redact(text) {
  const input = String(text ?? '')
  if (!input) return { text: input, redactions: 0 }
  let current = input
  let redactions = 0
  for (const rule of REDACTION_RULES) {
    current = current.replace(rule.re, (...args) => {
      redactions += 1
      return rule.to(...args)
    })
  }
  return { text: current, redactions }
}

/**
 * 只 stat 扫描会话目录（不解压、不写）：返回会话元数据列表。
 * @param {object} options
 * @param {string} options.sessionsDir
 * @param {string[]} [options.workspaceIds] 限定扫描的工作区目录名；空/缺省 = 扫描全部
 * @param {string[]} [options.archivedSessionIds]
 * @param {string[]} [options.pinnedSessionIds]
 * @param {object} options.fsApi 注入的 fs：{readdirSync, statSync}
 * @returns {{sessionId:string, workspaceId:string, updatedAt:number, bytes:number, archived:boolean, pinned:boolean, relPath:string}[]}
 */
export function scanSessionDirs(options = {}) {
  const {
    sessionsDir,
    workspaceIds = [],
    archivedSessionIds = [],
    pinnedSessionIds = [],
    fsApi,
  } = options ?? {}
  if (typeof sessionsDir !== 'string' || !sessionsDir) return []
  if (!fsApi || typeof fsApi.readdirSync !== 'function' || typeof fsApi.statSync !== 'function') return []

  const archived = new Set(Array.isArray(archivedSessionIds) ? archivedSessionIds : [])
  const pinned = new Set(Array.isArray(pinnedSessionIds) ? pinnedSessionIds : [])
  const wanted = Array.isArray(workspaceIds)
    ? workspaceIds.filter(isSingleSegmentName)
    : []
  const result = []

  const readDir = (dir) => {
    try {
      return fsApi.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }

  const workspaceKeys = wanted.length > 0
    ? wanted
    : readDir(sessionsDir)
      .filter((entry) => entry && entry.isDirectory && entry.isDirectory())
      .map((entry) => entry.name)
      .filter(isSingleSegmentName)

  for (const workspaceKey of workspaceKeys) {
    const wsDir = joinRel(sessionsDir, workspaceKey)
    for (const entry of readDir(wsDir)) {
      const sessionId = entry && entry.name
      if (!entry || !entry.isDirectory || !entry.isDirectory()) continue
      if (!isValidSessionId(sessionId)) continue
      const relPath = joinRel(workspaceKey, sessionId, SESSION_LOG_FILE)
      const logFile = joinRel(sessionsDir, workspaceKey, sessionId, SESSION_LOG_FILE)
      let stat
      try {
        stat = fsApi.statSync(logFile)
      } catch {
        continue // 没有 v4 日志的目录不可恢复，不列进目录
      }
      if (!stat || !Number.isFinite(stat.size)) continue
      result.push({
        sessionId,
        workspaceId: workspaceKey,
        updatedAt: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : 0,
        bytes: stat.size,
        archived: archived.has(sessionId),
        pinned: pinned.has(sessionId),
        relPath,
      })
    }
  }
  result.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
  return result
}

export const _internals = {
  findMagicOffsets,
  firstFrameSlice,
  joinRel,
  cleanList,
  decodeUtf8,
  REDACTION_RULES,
}
