// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang 2.7 — fang-buffer-keeper: watch a buffer directory and judge it in three
// states before anything is promoted out of it.
//
//   settled          — nothing changed since the last flush/baseline
//   writing          — a change arrived less than settleMs ago (a writer is still active)
//   pending-high-risk— the change went quiet but has not been flushed yet (or a flush
//                      gave up while the directory kept changing)
//
// Watch mode is `fs.watch(dir, {recursive:true})`; when recursive watching is not
// available on this platform/FS the keeper degrades to polling `fsx.digestTree(dir)`
// every pollMs — same states, only latency differs. All watchers/timers are owned by
// `ctx.effect` disposers, so unloading the plugin cannot leak a handle.
import fs from 'node:fs'
import path from 'node:path'
import {
  AUDIT,
  BUFFER_STATE,
  SERVICE,
  bus,
  diffDigests,
  digestTree,
  ensureDir,
  iso,
  nowMs,
  roleGate,
  writeFileAtomic,
  z,
} from '../kernel/index.mjs'
import {
  applyWriteRequest,
  normalizeDeclared,
  validateWriteRequest,
} from '../lib/container/index.mjs'

export const name = 'fang-buffer-keeper'
export const inject = []

const EVENTS = { settled: 'fang/buffer-settled' }

const DEFAULTS = {
  root: '',
  settleMs: 750,
  pollMs: 250,
  watch: true,
  flushTimeoutMs: 0,
}

/** v2 declared write proxy defaults (docs/CONTRACTS-V2.md §5.6). */
const PROXY_DEFAULTS = {
  enabled: false,
  maxBytes: 1048576,
}

/** Ring size of the in-memory proxy log (proxyLog returns the newest entries). */
const PROXY_LOG_LIMIT = 200

/** Files whose content directly changes what the host loads / how it boots. */
const HIGH_RISK_RE = /(^|\/)(package\.json|cordis[^/]*\.ya?ml|\.env[^/]*)$/i

export const Config = z
  .object({
    root: z.string().default('').description('监视根目录（空 = 由 start({dir}) 给）'),
    settleMs: z.natural().default(750).description('静默多久算 settled（毫秒）'),
    pollMs: z.natural().default(250).description('退化轮询间隔（毫秒）'),
    watch: z.boolean().default(true).description('false = 强制走轮询（用于验证退化路径）'),
    flushTimeoutMs: z.natural().default(0).description('flush 硬上限（毫秒，0 = 自动 4×strictMs）'),
    proxy: z
      .object({
        enabled: z.boolean().default(false).description('启用申报写代理（容器/不可信代码只能经此写 bufferRoot）'),
        maxBytes: z.natural().default(1048576).description('单个写请求上限（字节，默认 1MB）'),
      })
      .default({})
      .description('申报写代理配置（v2 追加，默认关闭）'),
  })
  .description('fang-buffer-keeper 配置')

const msgOf = (e) => String(e && e.message ? e.message : e)

export function apply(ctx, config) {
  const gate = roleGate('bufferKeeper', { cfgRole: config?.role, logger: ctx?.logger })
  if (!gate.active) return undefined
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const proxyCfg = { ...PROXY_DEFAULTS, ...(cfg.proxy && typeof cfg.proxy === 'object' ? cfg.proxy : {}) }
  cfg.proxy = proxyCfg
  const logger = ctx?.logger ?? { debug() {}, info() {}, warn() {}, error() {} }
  const safeGet = (key) => {
    try {
      return ctx?.get?.(key)
    } catch {
      return undefined
    }
  }
  const audit = (kind, data) => {
    try {
      const auditor = safeGet(SERVICE.auditor)
      if (auditor && typeof auditor.append === 'function') return auditor.append(kind, data)
    } catch {
      /* auditing must never block a flush */
    }
    return null
  }
  const emit = (topic, payload) => {
    try {
      return bus.emit(topic, payload)
    } catch {
      return 0
    }
  }

  let dir = ''
  let mode = 'idle' // 'watch' | 'poll' | 'idle'
  let watcher = null
  let pollTimer = null
  let pollSnapshot = {}
  let baselineDigests = {}
  let settledDigests = {}
  let lastEventAt = null
  let lastFlushAt = null
  let forcedHighRisk = false
  let dirty = new Set()
  let flushQueue = Promise.resolve()

  // ---- v2 declared write proxy state (append-only; v1 state above is untouched) ----
  let declaredWrites = []
  const proxyEntries = []

  const settleMs = () => Math.max(1, Math.floor(Number(cfg.settleMs) || DEFAULTS.settleMs))
  const pollMs = () => Math.max(10, Math.floor(Number(cfg.pollMs) || DEFAULTS.pollMs))

  const normalizeRel = (filename) => {
    if (filename === null || filename === undefined || filename === '') return '*'
    return String(filename).replace(/\\/g, '/').replace(/^\/+/, '')
  }
  const noteChange = (filename) => {
    lastEventAt = nowMs()
    dirty.add(normalizeRel(filename))
  }
  const closeWatcher = () => {
    const w = watcher
    watcher = null
    if (w) {
      try {
        w.close()
      } catch {
        /* already closed */
      }
    }
  }
  const clearPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
  const stopWatching = () => {
    closeWatcher()
    clearPoll()
    mode = 'idle'
  }

  /** Degraded mode: poll digestTree; identical state machine, coarser latency. */
  const startPoll = () => {
    stopWatching()
    mode = 'poll'
    pollSnapshot = digestTree(dir)
    pollTimer = setInterval(() => {
      if (!dir) return
      const cur = digestTree(dir)
      const diff = diffDigests(pollSnapshot, cur)
      const touched = [...diff.added, ...diff.changed, ...diff.removed]
      if (touched.length) {
        for (const rel of touched) dirty.add(normalizeRel(rel))
        lastEventAt = nowMs()
      }
      pollSnapshot = cur
    }, pollMs())
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  const startWatch = () => {
    if (cfg.watch !== false) {
      try {
        watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          try {
            noteChange(filename)
          } catch {
            /* a malformed watch event must not kill the keeper */
          }
        })
        watcher.on('error', () => {
          closeWatcher()
          try {
            startPoll()
          } catch {
            mode = 'idle'
          }
        })
        mode = 'watch'
        return
      } catch (e) {
        logger.warn?.(`[fang-buffer-keeper] fs.watch unavailable, falling back to polling: ${msgOf(e)}`)
        closeWatcher()
      }
    }
    startPoll()
  }

  /**
   * Begin watching a directory. Re-starting the same live dir is a no-op.
   * @returns {{ok:boolean, dir:string, mode?:string, already?:boolean, error?:string}}
   */
  const start = (opts = {}) => {
    const raw = String(opts?.dir ?? cfg.root ?? '').trim()
    if (!raw) return { ok: false, dir: '', error: 'no-dir' }
    const next = path.resolve(raw)
    if (dir === next && mode !== 'idle') return { ok: true, dir, mode, already: true }
    stop()
    ensureDir(next)
    dir = next
    lastEventAt = null
    lastFlushAt = null
    forcedHighRisk = false
    dirty = new Set()
    baselineDigests = digestTree(dir)
    settledDigests = { ...baselineDigests }
    startWatch()
    return { ok: true, dir, mode }
  }

  /** Stop watching; service stays callable and reports the settled empty state. */
  const stop = () => {
    const previous = dir
    stopWatching()
    dir = ''
    dirty = new Set()
    lastEventAt = null
    lastFlushAt = null
    forcedHighRisk = false
    baselineDigests = {}
    settledDigests = {}
    pollSnapshot = {}
    return { ok: true, dir: previous }
  }

  const currentDiff = () => {
    const digests = dir ? digestTree(dir) : {}
    const diff = diffDigests(settledDigests, digests)
    const pending = [...diff.added, ...diff.changed, ...diff.removed].sort()
    return { digests, diff, pending }
  }

  /**
   * @returns {{state:string, dir:string, lastEventAt:number|null, pending:string[], mode:string}}
   */
  const state = () => {
    if (!dir) {
      return { state: BUFFER_STATE.SETTLED, dir: '', lastEventAt: null, pending: [], highRisk: [], mode }
    }
    const { pending } = currentDiff()
    if (!pending.length) {
      return { state: BUFFER_STATE.SETTLED, dir, lastEventAt, pending: [], highRisk: [], mode, lastFlushAt }
    }
    // A pending change can be observed before any watcher/poller event timestamp exists
    // (the digest fallback in currentDiff() sees it first). Stamping the observation time
    // keeps the quiet window honest: without it, the quiet window has no start bound and
    // state() could report pending-high-risk with a null lastEventAt.
    if (lastEventAt === null) lastEventAt = nowMs()
    const quietMs = nowMs() - lastEventAt
    const judged =
      forcedHighRisk || quietMs >= settleMs()
        ? BUFFER_STATE.PENDING_HIGH_RISK
        : BUFFER_STATE.WRITING
    return {
      state: judged,
      dir,
      lastEventAt,
      pending,
      pendingCount: pending.length,
      quietMs,
      settleMs: settleMs(),
      highRisk: pending.filter((rel) => HIGH_RISK_RE.test(rel)),
      mode,
      lastFlushAt,
    }
  }

  const flushOnce = (opts = {}) =>
    new Promise((resolve) => {
      const strictMs = Math.max(1, Math.floor(Number(opts?.strictMs ?? settleMs()) || settleMs()))
      if (!dir) {
        return resolve({ state: BUFFER_STATE.SETTLED, flushed: [], timedOut: false, dir: '' })
      }
      const begin = nowMs()
      const configured = Math.max(0, Math.floor(Number(cfg.flushTimeoutMs) || 0))
      const hardMs = configured > 0 ? configured : Math.max(strictMs * 4, 250)
      const finish = (result) => resolve({ dir, strictMs, ...result })
      const tick = () => {
        if (!dir) return finish({ state: BUFFER_STATE.SETTLED, flushed: [], timedOut: false })
        const { digests, pending } = currentDiff()
        if (!pending.length) {
          forcedHighRisk = false
          return finish({ state: BUFFER_STATE.SETTLED, flushed: [], timedOut: false })
        }
        const quietMs = nowMs() - (lastEventAt ?? begin)
        if (quietMs >= strictMs) {
          settledDigests = digests
          dirty = new Set()
          forcedHighRisk = false
          lastFlushAt = nowMs()
          emit(EVENTS.settled, { dir, changed: pending })
          audit(AUDIT.BUFFER_FLUSH, { dir, changed: pending, count: pending.length, strictMs })
          return finish({ state: BUFFER_STATE.SETTLED, flushed: pending, timedOut: false })
        }
        if (nowMs() - begin >= hardMs) {
          forcedHighRisk = true
          return finish({
            state: BUFFER_STATE.PENDING_HIGH_RISK,
            flushed: [],
            timedOut: true,
            pending,
            hardMs,
          })
        }
        setTimeout(tick, Math.max(10, Math.min(50, Math.floor(strictMs / 4))))
      }
      tick()
    })

  /** Serialized so two concurrent flushes cannot interleave their digest bookkeeping. */
  const flush = (opts = {}) => {
    const run = () => flushOnce(opts)
    const p = flushQueue.then(run, run)
    flushQueue = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  /** Compare the live tree with the last baseline() (NOT with the last flush). */
  const scan = () => {
    const digests = dir ? digestTree(dir) : {}
    const diff = diffDigests(baselineDigests, digests)
    return {
      dir,
      digests,
      changed: diff.changed,
      added: diff.added,
      removed: diff.removed,
      same: diff.same,
      count: Object.keys(digests).length,
      baselineCount: Object.keys(baselineDigests).length,
    }
  }

  /** Re-snapshot the reference point that scan() compares against. */
  const baseline = () => {
    baselineDigests = dir ? digestTree(dir) : {}
    return { ok: true, dir, count: Object.keys(baselineDigests).length, at: iso() }
  }

  // -------------------------------------------------------------------------
  // v2 declared write proxy (append-only addition; docs/CONTRACTS-V2.md §5.6)
  // Only writes that (a) stay inside the watched buffer root, (b) are declared in
  // the manifest allowlist and (c) are <= maxBytes are applied — via kernel fsx
  // atomic write — and every attempt is logged + audited.
  // -------------------------------------------------------------------------

  const proxyEnabled = () => proxyCfg.enabled === true
  const proxyMaxBytes = () => {
    const n = Number(proxyCfg.maxBytes)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : PROXY_DEFAULTS.maxBytes
  }
  /** The buffer root the proxy is allowed to write into (live dir, else configured root). */
  const proxyBufferRoot = () => {
    const raw = String(dir || cfg.root || '').trim()
    return raw ? path.resolve(raw) : ''
  }
  const noteProxy = (entry) => {
    try {
      proxyEntries.push({ at: iso(), ...entry })
      while (proxyEntries.length > PROXY_LOG_LIMIT) proxyEntries.shift()
    } catch {
      /* the proxy log must never block a write decision */
    }
    return entry
  }

  /** @returns {{enabled:boolean, bufferRoot:string, declaredCount:number}} */
  const proxyState = () => ({
    enabled: proxyEnabled(),
    bufferRoot: proxyBufferRoot(),
    declaredCount: declaredWrites.length,
  })

  /**
   * Replace the declared-writes manifest. Entries are `{path, reason}` (or plain paths).
   * Malformed / escaping entries are dropped (they could never match a safe request).
   * @returns {{ok:boolean, count:number, reason?:string}}
   */
  const setDeclared = (declared) => {
    if (!Array.isArray(declared)) return { ok: false, count: declaredWrites.length, reason: 'bad-declared' }
    declaredWrites = normalizeDeclared(declared)
    return { ok: true, count: declaredWrites.length }
  }

  /**
   * Apply one write request inside the buffer root.
   * @param {{op:string, path:string, data:string|Buffer, encoding?:string, reqId?:string}} req
   * @returns {{ok:boolean, target?:string, bytes?:number, reason?:string}}
   */
  const proxyWrite = (req) => {
    const request = req && typeof req === 'object' ? req : {}
    const reqId = request.reqId ?? null
    const reqPath = typeof request.path === 'string' ? request.path : ''
    if (!proxyEnabled()) {
      noteProxy({ op: 'write', reqId, path: reqPath, ok: false, reason: 'proxy-disabled' })
      return { ok: false, reason: 'proxy-disabled' }
    }
    const root = proxyBufferRoot()
    if (!root) {
      noteProxy({ op: 'write', reqId, path: reqPath, ok: false, reason: 'no-buffer-root' })
      return { ok: false, reason: 'no-buffer-root' }
    }
    const check = validateWriteRequest({
      bufferRoot: root,
      declared: declaredWrites,
      req: request,
      maxBytes: proxyMaxBytes(),
    })
    if (!check.ok) {
      audit(AUDIT.ROUTE, {
        op: 'write-proxy',
        decision: 'deny',
        path: reqPath,
        reqId,
        reason: check.reason,
        bufferRoot: root,
      })
      noteProxy({ op: 'write', reqId, path: reqPath, ok: false, reason: check.reason })
      return { ok: false, reason: check.reason }
    }
    const applied = applyWriteRequest({
      bufferRoot: root,
      declared: declaredWrites,
      req: request,
      maxBytes: proxyMaxBytes(),
      fsx: { writeFileAtomic },
    })
    if (!applied.ok) {
      audit(AUDIT.ROUTE, {
        op: 'write-proxy',
        decision: 'deny',
        path: reqPath,
        reqId,
        reason: applied.reason,
        bufferRoot: root,
      })
      noteProxy({ op: 'write', reqId, path: reqPath, ok: false, reason: applied.reason })
      return { ok: false, reason: applied.reason }
    }
    audit(AUDIT.BUFFER_FLUSH, {
      op: 'write-proxy',
      path: check.path,
      target: applied.target,
      bytes: applied.bytes,
      reqId,
      bufferRoot: root,
    })
    noteProxy({ op: 'write', reqId, path: check.path, ok: true, target: applied.target, bytes: applied.bytes })
    return { ok: true, target: applied.target, bytes: applied.bytes }
  }

  /**
   * Newest-first proxy log.
   * @param {{limit?:number}} [opts]
   * @returns {object[]}
   */
  const proxyLog = (opts = {}) => {
    const raw = Number(opts?.limit)
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20
    return proxyEntries.slice(-limit).reverse().map((entry) => ({ ...entry }))
  }

  const service = {
    start,
    stop,
    state,
    flush,
    scan,
    baseline,
    // v2 append-only surface:
    proxyState,
    setDeclared,
    proxyWrite,
    proxyLog,
    get dir() {
      return dir
    },
    get mode() {
      return mode
    },
    get config() {
      return { ...cfg, proxy: { ...proxyCfg } }
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.buffer, service))
  ctx.effect(() => () => {
    stopWatching()
    dir = ''
    dirty = new Set()
    // v2 proxy state released with the fiber (no user-declared grants survive an unload)
    declaredWrites = []
    proxyEntries.length = 0
  })
  return service
}

export const _internals = { HIGH_RISK_RE, DEFAULTS, EVENTS, PROXY_DEFAULTS, PROXY_LOG_LIMIT }
