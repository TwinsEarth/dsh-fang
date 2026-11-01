// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang 2.0 — fang-forker: the process layer for disposable fork dsh-Web instances.
//
// Hard boundary (CONTRACTS-V2.md §5.5 / §1):
//   * mother-only: apply() starts with roleGate('forker'); in a fork nothing is registered.
//   * The mother is immutable. `provision` only READS profileTemplate. With cleanTemplate
//     (v2 default) the fork profile is cloned from a *forker-owned clean template* (written
//     under the fork home), so a dirty mother profile can never leak into a fork; from the
//     mother it takes one thing only — the node_modules source for the junction.
//     Removal always goes through fsx.removeTree() (junction-safe: never enters the mother).
//   * A fork shares nothing: its own DSH_HOME (env.DSH_HOME=homeDir), its own buffer dir,
//     and in v2 a *deterministic* port from the pool (18000–18100) instead of --port 0.
//     `allocatePorts=false` keeps the v1 `--port 0` behaviour.
//   * This plugin owns process lifecycle only. Risk scoring / approval / routing / adapter
//     handshakes do not live here (scorer / approver / router / adapter own those).
//
// Port pool (v2):
//   * ports are probed with net.createServer().listen({port,host:'127.0.0.1'}) — a port is
//     usable only if the bind test succeeds; a busy port is skipped (next candidate).
//   * the occupancy table is persisted to <dataRoot>/ports.json as {port:{forkId,pid,at}}.
//     On first port use, entries whose recorded child pid is dead (or that never got a pid)
//     are reclaimed, so a crashed mother can never leak the deterministic pool forever.
//   * spawn validates the child's printed URL port against the port it was told to bind:
//     a mismatch is a hard failure (child stopped, {ok:false,error:'port-mismatch'}).
//   * stop/reap/dispose release the port; pool exhaustion is {ok:false,error:'port-exhausted'}.
//
// Windows launch note (measured): the default launcher is a `.cmd`
// (<DSH_INSTALL>\resources\runtime\cli\bin\dsh.cmd). child_process.spawn('.cmd') throws
// EINVAL/ENOENT without a shell, so `.cmd`/`.bat` must be launched with
// `shell: true`; `.mjs`/`.js` entries are launched through node; `.exe` directly.
import { spawn as spawnProcess, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import {
  AUDIT,
  EXIT,
  FORK_STATUS,
  SERVICE,
  bus,
  copyTree,
  ensureDir,
  exists,
  iso,
  listFiles,
  makeJunction,
  newId,
  nowMs,
  parseWebUrl,
  readJson,
  removeTree,
  resolveFangLayout,
  roleGate,
  writeFileAtomic,
  writeJsonAtomic,
  z,
} from '../kernel/index.mjs'
import { computeBackoff, planRestart, reconcileOrphans, writeForkMeta, probeHttpAlive, SUPERVISION_DEFAULTS } from '../lib/fork-supervisor.mjs'

export const name = 'fang-forker'
export const inject = []

/** In-process event topics (CONTRACTS.md §6). */
const EVENTS = {
  started: 'fang/fork-started',
  crashed: 'fang/fork-crashed',
  reaped: 'fang/fork-reaped',
}

/** v2 deterministic port pool (CONTRACTS-V2.md §5.5). */
const DEFAULT_PORT_POOL = { start: 18000, end: 18100 }
/** Loopback interface a fork's `dsh web` binds; the pool is probed on the same host. */
const PORT_HOST = '127.0.0.1'
/** A bind probe that does not answer by then counts as "not usable" (fail-closed, try next). */
const PORT_PROBE_TIMEOUT_MS = 5000
/** Bundle list of the clean fork profile: base + web app + this bundle (Cordis patch). */
const CLEAN_TEMPLATE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const DEFAULTS = {
  cliPath: '',
  profileTemplate: '',
  startTimeoutMs: 60000,
  maxForks: 8,
  maxLogLines: 400,
  dataRoot: '',
  portPool: { ...DEFAULT_PORT_POOL },
  allocatePorts: true,
  cleanTemplate: true,
  bundleName: '@local/dsh-fang',
  forkProfileTag: 'web-base',
}

/** Files cloned from a (clean or mother) template profile: package.json + cordis*.yml only. */
const CLONED_RE = /^(package\.json|cordis.*\.ya?ml)$/i
const PROFILE_UNSAFE_RE = /[^a-zA-Z0-9_.-]/g
/** stdout/stderr scan window kept for `parseWebUrl` (the banner may be split over chunks). */
const SCAN_TEXT_LIMIT = 64 * 1024

export { parseWebUrl }

export const Config = z
  .object({
    cliPath: z.string().default('').description('dsh CLI 入口：.exe / .cmd / .mjs（空 = 由 spawn 入参给）'),
    profileTemplate: z
      .string()
      .default('')
      .description('母版 profile 目录：clone 源 / node_modules junction 源（cleanTemplate 时只用后者）'),
    startTimeoutMs: z.natural().default(60000).description('等待 web URL 的启动超时（毫秒）'),
    maxForks: z.natural().default(8).description('允许同时存活的分身上限'),
    maxLogLines: z.natural().default(400).description('每个分身 stdout 滚动缓冲行数'),
    dataRoot: z.string().default('').description('注册表/端口表落盘根目录（空 = 仅进程内存）'),
    portPool: z
      .object({
        start: z.number().default(DEFAULT_PORT_POOL.start).description('端口池起始（含）'),
        end: z.number().default(DEFAULT_PORT_POOL.end).description('端口池结束（含）'),
      })
      .default({})
      .description('确定性端口池 18000–18100'),
    allocatePorts: z
      .boolean()
      .default(true)
      .description('true：预分配确定性端口（--port <port>）；false：退回 v1 的 --port 0'),
    cleanTemplate: z
      .boolean()
      .default(true)
      .description('true：用内置干净模板（不继承母体脏 profile）；false：沿用 profileTemplate'),
    bundleName: z.string().default('@local/dsh-fang').description('干净模板 profile.bundles 的第三个 bundle'),
    forkProfileTag: z.string().default('web-base').description('干净模板 profile 标签（模板目录/缺省 profile 名）'),
    supervise: z.boolean().default(false)
      .description('restart a crashed (already-ready) fork with exponential backoff; the patch layer enables it'),
    maxRestarts: z.natural().default(SUPERVISION_DEFAULTS.maxRestarts)
      .description('max automatic restarts per fork'),
    backoffBaseMs: z.natural().default(SUPERVISION_DEFAULTS.baseMs)
      .description('backoff base in milliseconds'),
    backoffMaxMs: z.natural().default(SUPERVISION_DEFAULTS.maxMs)
      .description('backoff cap in milliseconds'),
    backoffJitter: z.number().min(0).max(0.9).default(SUPERVISION_DEFAULTS.jitter)
      .description('backoff jitter ratio'),
    healthPath: z.string().default(SUPERVISION_DEFAULTS.healthPath)
      .description('HTTP liveness path (any response counts)')
  })
  .description('fang-forker 配置')

const msgOf = (e) => String(e && e.message ? e.message : e)

function safeProfile(value) {
  const p = String(value ?? '').trim().replace(PROFILE_UNSAFE_RE, '_')
  return p && p !== '.' && p !== '..' ? p : 'default'
}

/**
 * Pure: is this cliPath a Windows shell launcher (.cmd/.bat)?
 * Measured on Windows: spawn('...dsh.cmd', args) throws EINVAL/ENOENT unless shell:true.
 */
export function isShellLauncher(cliPath) {
  return /\.(cmd|bat)$/i.test(String(cliPath ?? '').trim())
}

/**
 * Pure: argv appended to the CLI (CONTRACTS.md §5.1).
 * v2: with allocatePorts the forker passes the pre-allocated `--port <n>`; the v1 fallback
 * is still `--port 0` (OS picks a free port).
 * @returns {string[]}
 */
export function buildSpawnArgs({ profile = 'default', port = 0, noOpen = true } = {}) {
  const n = Math.floor(Number(port))
  const p = Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0
  const args = ['--profile', safeProfile(profile), '--port', String(p)]
  if (noOpen) args.push('--no-open')
  return args
}

/**
 * Pure: turn a cliPath into the exact `{command, args, shell}` triple to spawn.
 *   .cmd / .bat  → shell launcher (shell:true)
 *   .mjs/.cjs/.js→ node + script prefix
 *   anything else (normally .exe) → direct spawn
 * Never touches the filesystem, so it is safe to unit-test without launching anything.
 * @returns {{command:string, args:string[], shell:boolean, windowsHide:boolean, nodeScript:boolean}}
 */
export function buildLaunchSpec({ cliPath = '', profile = 'default', port = 0 } = {}) {
  const entry = String(cliPath ?? '').trim()
  const args = buildSpawnArgs({ profile, port })
  if (isShellLauncher(entry)) {
    return { command: entry, args, shell: true, windowsHide: true, nodeScript: false }
  }
  if (/\.(mjs|cjs|js)$/i.test(entry)) {
    return { command: process.execPath, args: [entry, ...args], shell: false, windowsHide: true, nodeScript: true }
  }
  return { command: entry, args, shell: false, windowsHide: true, nodeScript: false }
}

/**
 * Pure: why did a fork exit? (CONTRACTS.md §5.1)
 *   0  = normal, 75 = the guard allowed a restart (supervisor contract), else crash.
 * @returns {{kind:'normal'|'restart-request'|'crash', code:number|null, signal:string|null, restartRequested:boolean}}
 */
export function classifyExit(code, signal = null) {
  const n = code === null || code === undefined || Number.isNaN(Number(code)) ? null : Number(code)
  if (n === EXIT.OK) return { kind: 'normal', code: n, signal, restartRequested: false }
  if (n === EXIT.RESTART) return { kind: 'restart-request', code: n, signal, restartRequested: true }
  return { kind: 'crash', code: n, signal, restartRequested: false }
}

/**
 * Pure: normalise a configured port pool. Returns null for an unusable range, so the
 * caller can fall back to the contract default instead of silently allocating nothing.
 * @returns {{start:number, end:number}|null}
 */
export function resolvePortPool(pool) {
  const start = Math.floor(Number(pool?.start))
  const end = Math.floor(Number(pool?.end))
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 1 || end > 65535 || start > end) return null
  return { start, end }
}

/**
 * Pure: the clean fork profile's package.json (CONTRACTS-V2.md §5.5).
 * `dsh.profile.bundles` is the loader contract: base plugins, the web app, then this
 * bundle — nothing inherited from the mother profile.
 * @returns {{name:string, version:string, private:boolean, dsh:{profile:{bundles:string[]}}}}
 */
export function buildTemplatePackageJson({ bundleName = DEFAULTS.bundleName, forkProfileTag = DEFAULTS.forkProfileTag } = {}) {
  const tag = safeProfile(forkProfileTag)
  const bundles = [...CLEAN_TEMPLATE_BUNDLES, String(bundleName ?? '').trim() || DEFAULTS.bundleName]
  return {
    name: `dsh-fang-fork-${tag}`,
    version: '1.0.0',
    private: true,
    dsh: { profile: { bundles } },
  }
}

/** Rolling stdout tail: line buffer capped at maxLines + a bounded text window for parseWebUrl. */
function createTextTail(maxLines) {
  const limit = Math.max(0, Math.floor(Number(maxLines) || 0)) || DEFAULTS.maxLogLines
  const lines = []
  let partial = ''
  let text = ''
  const trim = () => {
    if (lines.length > limit) lines.splice(0, lines.length - limit)
  }
  return {
    lines,
    get text() {
      return text
    },
    push(chunk) {
      const s = String(chunk ?? '')
      text = (text + s).slice(-SCAN_TEXT_LIMIT)
      partial += s
      let idx
      while ((idx = partial.indexOf('\n')) >= 0) {
        lines.push(partial.slice(0, idx).replace(/\r$/, ''))
        partial = partial.slice(idx + 1)
      }
      trim()
      return s
    },
    feed(chunk) {
      return this.push(chunk)
    },
    tail(n = 40) {
      const count = Math.max(0, Math.floor(Number(n) || 0))
      if (count === 0) return ''
      const all = partial ? [...lines, partial.replace(/\r$/, '')] : lines
      return all.slice(-count).join('\n')
    },
  }
}

/** Is this pid still alive? EPERM means "exists but not ours" — still alive. */
function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

/**
 * Bind-test one port on loopback: resolve true only when net can actually listen on it.
 * Asynchronous by contract: never blocks the host event loop while probing a busy pool.
 * @returns {Promise<boolean>}
 */
function probePortFree(port, { host = PORT_HOST, timeoutMs = PORT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    let timer = null
    const done = (free) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        server.close(() => {})
      } catch {
        /* already closed */
      }
      resolve(free)
    }
    timer = setTimeout(() => done(false), Math.max(1, Math.floor(timeoutMs) || PORT_PROBE_TIMEOUT_MS))
    timer.unref?.()
    server.once('error', () => done(false))
    try {
      server.listen({ port, host, exclusive: true }, () => done(true))
    } catch {
      done(false)
    }
  })
}

export function apply(ctx, config) {
  // v2 deployment matrix: forker is a mother-only organ. Must be the FIRST statement —
  // in a fork role nothing (service / timer / dir) may be created.
  const gate = roleGate('forker', { cfgRole: config?.role, logger: ctx?.logger })
  // v2 deployment matrix: this plugin is not deployed in this role — register nothing.
  if (!gate.active) return

  const rawConfig = { ...DEFAULTS, ...(config ?? {}) }
  const portPool = resolvePortPool(rawConfig.portPool) ?? { ...DEFAULT_PORT_POOL }
  const allocatePorts = rawConfig.allocatePorts !== false
  const cleanTemplate = rawConfig.cleanTemplate !== false
  const bundleName = String(rawConfig.bundleName ?? DEFAULTS.bundleName).trim() || DEFAULTS.bundleName
  const forkProfileTag = safeProfile(rawConfig.forkProfileTag)
  const cfg = { ...rawConfig, portPool, allocatePorts, cleanTemplate, bundleName, forkProfileTag }

  const logger = ctx?.logger ?? { debug() {}, info() {}, warn() {}, error() {} }
  const logWarn = (line) => {
    try {
      logger.warn?.(line)
    } catch {
      /* logger must never break the process layer */
    }
  }

  /** Cross-plugin reads are always tolerant (auditor/approver may be disabled rows). */
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
      /* auditing must never break fork lifecycle */
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

  /** 广播 Adapter token 刷新/生成；handler 异常隔离，绝不影响 spawn 流程。 */
  const emitTokenRefresh = (forkId, token) => {
    for (const handler of [...tokenRefreshHandlers]) {
      try {
        handler(forkId, token)
      } catch {
        /* 订阅者异常不得打断 spawn */
      }
    }
  }

  /** forkId -> fork record. Only the live child handle and log tail are in-memory-only. */
  const records = new Map()
  /** forkId -> disposer for an in-flight spawn promise (so plugin dispose cannot hang one). */
  const pendingSpawns = new Set()
  /** (forkId, token) 订阅者：每次 spawn 重新生成 Adapter token 时广播（首次派生与重启都会触发）。 */
  const tokenRefreshHandlers = new Set()
  /** port -> forkId reserved/assigned by THIS plugin instance (never release another instance's). */
  const ownedPorts = new Map()
  /** port -> {forkId,pid,at} persisted view of the pool (loaded lazily). */
  const portTable = new Map()

  let forksFile = ''
  let portsFile = ''
  let layout = null
  if (cfg.dataRoot) {
    try {
      layout = resolveFangLayout({ dataRoot: cfg.dataRoot })
      forksFile = layout.forksFile
      portsFile = path.join(layout.dataDir, 'ports.json')
    } catch (e) {
      logWarn(`[fang-forker] layout resolve failed: ${msgOf(e)}`)
      forksFile = ''
      portsFile = ''
    }
  }
  let registryLoaded = false
  let portsLoaded = false
  let disposed = false
  const starting = () => [...records.values()].filter((r) => r.running || r.child || r.starting).length

  const publicFork = (rec) => ({
    forkId: rec.forkId,
    taskTitle: rec.taskTitle ?? '',
    status: rec.status ?? FORK_STATUS.STOPPED,
    pid: rec.pid ?? null,
    port: rec.port ?? null,
    url: rec.url ?? null,
    homeDir: rec.homeDir ?? '',
    profile: rec.profile ?? '',
    profileDir: rec.profileDir ?? '',
    template: rec.template ?? '',
    bufferDir: rec.bufferDir ?? '',
    token: rec.token ?? null,
    running: !!rec.running,
    createdAt: rec.createdAt ?? null,
    startedAt: rec.startedAt ?? null,
    exitedAt: rec.exitedAt ?? null,
    exit: rec.exit ?? null,
    lastError: rec.lastError ?? null,
  })

  /** Load the persisted registry lazily, so `apply()` performs no I/O. */
  const ensureRegistry = () => {
    if (registryLoaded) return
    registryLoaded = true
    if (!forksFile) return
    const saved = readJson(forksFile, null)
    const rows = Array.isArray(saved) ? saved : Array.isArray(saved?.forks) ? saved.forks : []
    for (const row of rows) {
      const forkId = row && String(row.forkId ?? '').trim()
      if (!forkId || records.has(forkId)) continue
      records.set(forkId, { ...row, forkId, running: false, child: null, starting: false, restored: true, log: null })
    }
  }

  const persist = () => {
    if (!forksFile) return false
    try {
      writeJsonAtomic(forksFile, { at: iso(), forks: [...records.values()].map(publicFork) })
      return true
    } catch (e) {
      logWarn(`[fang-forker] registry write failed: ${msgOf(e)}`)
      return false
    }
  }

  // ───────────────────────────── port pool ─────────────────────────────
  const portsSnapshot = () => {
    const out = {}
    for (const port of [...portTable.keys()].sort((a, b) => a - b)) out[String(port)] = { ...portTable.get(port) }
    return out
  }

  const persistPorts = () => {
    if (!portsFile) return false
    try {
      writeJsonAtomic(portsFile, portsSnapshot())
      return true
    } catch (e) {
      logWarn(`[fang-forker] ports write failed: ${msgOf(e)}`)
      return false
    }
  }

  /**
   * Lazy load + startup reclaim. An entry is kept only when its recorded child pid is alive:
   * a pid-less reservation belongs to a mother that died mid-spawn and must be reclaimed too.
   */
  const ensurePorts = () => {
    if (portsLoaded) return
    portsLoaded = true
    if (!portsFile) return
    const saved = readJson(portsFile, null)
    const rows =
      saved && typeof saved === 'object'
        ? saved.ports && typeof saved.ports === 'object'
          ? saved.ports
          : saved
        : {}
    let changed = false
    for (const [key, meta] of Object.entries(rows)) {
      const port = Number(key)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        changed = true
        continue
      }
      const pid = meta ? Number(meta.pid) : null
      if (!meta || !isPidAlive(pid)) {
        changed = true
        continue
      }
      portTable.set(port, { forkId: String(meta.forkId ?? ''), pid: Math.floor(pid), at: String(meta.at ?? '') })
    }
    if (changed) persistPorts()
  }

  /** Reserve a port for this instance (persisted with pid=null until the child exists). */
  const reservePort = (port, forkId) => {
    ensurePorts()
    const n = Math.floor(Number(port))
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, port: null, error: 'invalid-port' }
    const existing = portTable.get(n)
    if (existing && !ownedPorts.has(n) && existing.forkId !== String(forkId ?? '')) {
      return { ok: false, port: n, error: 'port-in-use' }
    }
    portTable.set(n, { forkId: String(forkId ?? ''), pid: null, at: iso() })
    ownedPorts.set(n, String(forkId ?? ''))
    persistPorts()
    return { ok: true, port: n }
  }

  /** Attach the real child pid to a reservation so a later startup can prove liveness. */
  const bindPortToPid = (port, forkId, pid) => {
    const n = Math.floor(Number(port))
    if (ownedPorts.get(n) !== forkId) return false
    portTable.set(n, { forkId, pid: Number(pid) || null, at: iso() })
    persistPorts()
    return true
  }

  /** Release a port owned by this instance (never another instance's / another fork's). */
  const releaseOwnedPort = (port, forkId) => {
    ensurePorts()
    const n = Math.floor(Number(port))
    if (!Number.isInteger(n) || n < 1) return { ok: true, port: null, released: false }
    const owner = ownedPorts.get(n)
    if (owner === undefined || (forkId && owner !== forkId)) {
      return { ok: true, port: n, released: false, reason: 'not-owned' }
    }
    ownedPorts.delete(n)
    const entry = portTable.get(n)
    if (!entry) return { ok: true, port: n, released: false }
    if (forkId && entry.forkId && entry.forkId !== forkId) {
      return { ok: true, port: n, released: false, reason: 'not-owner' }
    }
    portTable.delete(n)
    persistPorts()
    return { ok: true, port: n, released: true }
  }

  /** Public release: removes any persisted entry for the port (operator/test escape hatch). */
  const releasePort = (port) => {
    ensurePorts()
    const n = Math.floor(Number(port))
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, port: null, released: false, error: 'invalid-port' }
    }
    ownedPorts.delete(n)
    const held = portTable.delete(n)
    if (held) persistPorts()
    return { ok: true, port: n, released: held }
  }

  /**
   * Allocate one deterministic port from the pool. A candidate is usable only when the
   * loopback bind test succeeds; occupied candidates are skipped. Pool exhausted → error.
   * @returns {Promise<{ok:boolean, port:number|null, reason:string, error?:string, pool?:object}>}
   */
  const allocatePort = async (opts = {}) => {
    ensurePorts()
    const forkId = String(opts.forkId ?? '').trim()
    const { start, end } = portPool
    for (let port = start; port <= end; port++) {
      if (portTable.has(port)) continue
      let free = false
      try {
        free = await probePortFree(port)
      } catch {
        free = false
      }
      if (!free) continue
      portTable.set(port, { forkId, pid: null, at: iso() })
      ownedPorts.set(port, forkId)
      persistPorts()
      return { ok: true, port, forkId, reason: '' }
    }
    return {
      ok: false,
      port: null,
      forkId,
      reason: 'port-exhausted',
      error: 'port-exhausted',
      pool: { ...portPool },
    }
  }

  /** Windows: taskkill /PID <pid> /T /F kills the whole tree (electron children too). */
  const killTree = (rec) => {
    const pid = rec?.pid ?? rec?.child?.pid ?? null
    if (process.platform === 'win32' && pid) {
      try {
        const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
        if (res && res.status === 0) return true
      } catch {
        /* fall through to child.kill */
      }
    }
    try {
      if (rec?.child && typeof rec.child.kill === 'function') {
        rec.child.kill('SIGTERM')
        return true
      }
    } catch {
      /* already gone */
    }
    return false
  }

  const isSafeToRemove = (homeDir) => {
    const resolved = path.resolve(homeDir)
    const root = path.parse(resolved).root
    return resolved !== root && resolved.length > root.length + 1
  }

  // ───────────────────────────── clean template ─────────────────────────────
  /**
   * Write a clean fork profile template (CONTRACTS-V2.md §5.5):
   *   package.json  { name, private, dsh.profile.bundles:[dsh-base,dsh-web-app,bundleName] }
   *   cordis.yml    '[]'
   *   cordis.patch.yml '[]'
   *   node_modules  junction → nodeModulesSource (absent source → warning, still ok)
   * Idempotent: same content is rewritten, an existing junction is left untouched.
   * @returns {{ok:boolean, dir:string, files:string[], warnings:string[], error?:string}}
   */
  const ensureTemplate = (opts = {}) => {
    const rawDir = String(opts.templateDir ?? '').trim()
    if (!rawDir) return { ok: false, dir: '', files: [], warnings: [], error: 'no-template-dir' }
    const templateDir = path.resolve(rawDir)
    const files = []
    const warnings = []
    try {
      ensureDir(templateDir)
      writeJsonAtomic(
        path.join(templateDir, 'package.json'),
        buildTemplatePackageJson({ bundleName: cfg.bundleName, forkProfileTag: cfg.forkProfileTag }),
      )
      files.push('package.json')
      for (const name of ['cordis.yml', 'cordis.patch.yml']) {
        writeFileAtomic(path.join(templateDir, name), '[]\n')
        files.push(name)
      }
      const srcRaw = String(opts.nodeModulesSource ?? '').trim()
      const source = srcRaw ? path.resolve(srcRaw) : ''
      const link = path.join(templateDir, 'node_modules')
      if (source && exists(source)) {
        try {
          makeJunction(source, link)
          files.push('node_modules')
        } catch (e) {
          warnings.push(`node-modules-junction-failed: ${msgOf(e)}`)
        }
      } else {
        warnings.push('node-modules-source-missing')
      }
      return { ok: true, dir: templateDir, files, warnings }
    } catch (e) {
      return { ok: false, dir: templateDir, files, warnings, error: 'template-write-failed', message: msgOf(e) }
    }
  }

  /** Clone exactly package.json + cordis*.yml from a template into the fork profile dir. */
  const cloneProfileConfig = (fromDir, toDir) => {
    const wanted = listFiles(fromDir).filter((rel) => !rel.includes('/') && CLONED_RE.test(rel))
    copyTree(fromDir, toDir, { filter: (entryName) => CLONED_RE.test(entryName) })
    return wanted.filter((rel) => exists(path.join(toDir, rel)))
  }

  // ───────────────────────────── provision ─────────────────────────────
  /**
   * Build homeDir/profiles/<profile>.
   * cleanTemplate=true: the clone source is a forker-owned clean template
   *   (<homeDir>/templates/<forkProfileTag>); only package.json + cordis*.yml are cloned and
   *   the mother contributes the node_modules junction source only — a dirty mother profile
   *   can never leak in. cleanTemplate=false: v1 behaviour (clone from profileTemplate).
   * @returns {{ok:boolean, forkId?:string, homeDir?:string, profileDir?:string, bufferDir?:string,
   *   profile?:string, template?:string, cloned?:string[], node_modules?:string|null,
   *   warnings?:string[], error?:string}}
   */
  const provision = (opts = {}) => {
    ensureRegistry()
    const homeRaw = String(opts.homeDir ?? '').trim()
    if (!homeRaw) return { ok: false, error: 'no-home-dir' }
    const templateRaw = String(opts.profileTemplate ?? cfg.profileTemplate ?? '').trim()
    if (!templateRaw) return { ok: false, error: 'no-profile-template' }
    const sourceTemplateDir = path.resolve(templateRaw)
    if (!exists(sourceTemplateDir)) return { ok: false, error: 'profile-template-missing', profileTemplate: sourceTemplateDir }

    const forkId = String(opts.forkId ?? '').trim() || newId('fork')
    const existing = records.get(forkId)
    if (existing && (existing.running || existing.starting)) return { ok: false, error: 'already-running', forkId }

    const homeDir = path.resolve(homeRaw)
    const profile = safeProfile(opts.profile ?? (cleanTemplate ? forkProfileTag : path.basename(sourceTemplateDir)))
    const profileDir = path.join(homeDir, 'profiles', profile)
    ensureDir(homeDir)
    ensureDir(profileDir)

    const warnings = []
    const nodeModulesSource = path.join(sourceTemplateDir, 'node_modules')
    let template = sourceTemplateDir
    let cloned = []

    if (cleanTemplate) {
      // Forker-owned clean template: never written into the mother profile directory.
      const cleanDir = path.join(homeDir, 'templates', forkProfileTag)
      const ensured = ensureTemplate({
        templateDir: cleanDir,
        nodeModulesSource: exists(nodeModulesSource) ? nodeModulesSource : '',
      })
      if (!ensured.ok) {
        return {
          ok: false,
          error: ensured.error ?? 'clean-template-failed',
          template: ensured.dir,
          warnings: ensured.warnings,
        }
      }
      template = ensured.dir
      warnings.push(...ensured.warnings)
      cloned = cloneProfileConfig(template, profileDir)
    } else {
      cloned = cloneProfileConfig(sourceTemplateDir, profileDir)
    }

    // node_modules junction in the fork profile (always to the mother's module tree).
    let nodeModules = null
    if (exists(nodeModulesSource)) {
      try {
        nodeModules = makeJunction(nodeModulesSource, path.join(profileDir, 'node_modules'))
      } catch (e) {
        warnings.push(`node-modules-junction-failed: ${msgOf(e)}`)
      }
    } else if (!cleanTemplate) {
      // Degraded but still usable: the fork simply has no node_modules link to the mother.
      warnings.push('node-modules-missing')
    }

    const bufferDir = path.join(homeDir, 'fang', profile, 'buffer')
    ensureDir(bufferDir)

    const rec = existing ?? { forkId, createdAt: nowMs() }
    Object.assign(rec, {
      forkId,
      taskTitle: String(opts.taskTitle ?? rec.taskTitle ?? ''),
      homeDir,
      profile,
      profileDir,
      bufferDir,
      template,
      nodeModules,
      pid: rec.pid ?? null,
      port: rec.port ?? null,
      url: rec.url ?? null,
      child: rec.child ?? null,
      running: false,
      starting: false,
      status: FORK_STATUS.PROVISIONING,
      exit: null,
      lastError: null,
    })
    records.set(forkId, rec)
    persist()
    audit(AUDIT.FORK_CREATED, { forkId, homeDir, profile, taskTitle: rec.taskTitle, cloned, warnings, template })
    return { ok: true, forkId, homeDir, profileDir, bufferDir, profile, template, cloned, node_modules: nodeModules, warnings }
  }

  // ───────────────────────────── spawn ─────────────────────────────
  /**
   * Launch the fork and resolve once stdout printed the tokenized web URL.
   * v2: with allocatePorts the child is told `--port <pool port>` and the printed URL port
   * must match it; a mismatch stops the child ({ok:false,error:'port-mismatch'}).
   * @returns {Promise<{ok:boolean, forkId?:string, pid?:number|null, port?:number, url?:string,
   *   token?:string, error?:string, expectedPort?:number}>}
   */
  const writeForkMetaOf = (rec) => {
    if (!rec?.homeDir) return false
    return writeForkMeta(rec.homeDir, {
      forkId: rec.forkId, status: rec.status, pid: rec.pid ?? null, port: rec.port ?? null,
      url: rec.url ?? null, profile: rec.profile ?? null,
      crashCount: rec.crashCount ?? 0, restartCount: rec.restartCount ?? 0,
      lastError: rec.lastError ?? null, startedAt: rec.startedAt ?? null,
      exitedAt: rec.exitedAt ?? null, restartScheduledAt: rec.restartScheduledAt ?? null,
    })
  }

  const spawn = async (opts = {}) => {
    ensureRegistry()
    ensurePorts()
    const forkId = String(opts.forkId ?? '').trim() || newId('fork')
    const homeDir = String(opts.homeDir ?? '').trim()
    const profile = safeProfile(opts.profile ?? 'default')
    const cliPath = String(opts.cliPath ?? cfg.cliPath ?? '').trim()
    const timeoutMs = Math.max(1, Math.floor(Number(opts.timeoutMs ?? cfg.startTimeoutMs) || DEFAULTS.startTimeoutMs))
    const maxLogLines = Math.max(1, Math.floor(Number(cfg.maxLogLines) || DEFAULTS.maxLogLines))

    if (!homeDir) return { forkId, ok: false, error: 'no-home-dir' }
    if (!cliPath) return { forkId, ok: false, error: 'no-cli-path' }
    const previous = records.get(forkId)
    if (previous && (previous.running || previous.child || previous.starting)) {
      return { forkId, ok: false, error: 'already-running', pid: previous.pid ?? null }
    }
    const maxForks = Math.max(1, Math.floor(Number(cfg.maxForks) || DEFAULTS.maxForks))
    if (starting() >= maxForks) return { forkId, ok: false, error: 'max-forks', limit: maxForks }

    const collector = createTextTail(maxLogLines)
    const rec = previous ?? { forkId, createdAt: nowMs(), taskTitle: '' }
    Object.assign(rec, {
      forkId,
      homeDir,
      profile,
      profileDir: rec.profileDir ?? path.join(path.resolve(homeDir), 'profiles', profile),
      pid: null,
      port: null,
      url: null,
      child: null,
      running: false,
      starting: true,
      status: FORK_STATUS.PROVISIONING,
      exit: null,
      lastError: null,
      intentionalStop: false,
      startedAt: nowMs(),
      ready: false,
      cliPath,
      crashCount: rec.crashCount ?? 0,
      restartCount: rec.restartCount ?? 0,
      restartScheduledAt: null,
      /**
       * v3 Adapter Bearer token：**每次 spawn 重新生成**，只存在于母体内存 + 分身环境变量。
       * 不写 fang-meta.json、不进 forks.json（publicFork 不含）、不写 URL —— 母体重启后
       * 旧 token 自然失效，孤儿分身不会被接管（PROTOCOL-V3 §3）。
       */
      adapterToken: randomBytes(24).toString('hex'),
      log: collector,
    })
    records.set(forkId, rec)
    writeForkMetaOf(rec)
    // 广播新 token：首次派生 = 生成，重启 = 刷新；订阅者拿到的是「当前 token」，
    // 不是「进程就绪」信号（进程就绪以 fang/fork-started 为准）。
    emitTokenRefresh(forkId, rec.adapterToken)

    // Port: explicit spawn option > deterministic pool allocation > v1 --port 0.
    const requested = Math.floor(Number(opts.port))
    let expectedPort = 0
    if (Number.isInteger(requested) && requested > 0 && requested <= 65535) {
      const reserved = reservePort(requested, forkId)
      if (!reserved.ok) {
        rec.starting = false
        rec.status = FORK_STATUS.STOPPED
        rec.lastError = reserved.error ?? 'port-in-use'
        persist()
        return { forkId, ok: false, error: rec.lastError }
      }
      expectedPort = reserved.port
    } else if (allocatePorts) {
      const alloc = await allocatePort({ forkId })
      if (!alloc.ok) {
        rec.starting = false
        rec.status = FORK_STATUS.STOPPED
        rec.lastError = alloc.error ?? 'port-exhausted'
        persist()
        return { forkId, ok: false, error: rec.lastError, reason: alloc.reason, pool: { ...portPool } }
      }
      expectedPort = alloc.port
    }
    if (expectedPort > 0) rec.port = expectedPort
    if (disposed) {
      rec.starting = false
      if (expectedPort > 0) releaseOwnedPort(expectedPort, forkId)
      return { forkId, ok: false, error: 'disposed' }
    }

    return new Promise((resolve) => {
      let done = false
      let timer = null
      let cleanup = null

      const releaseReserved = () => {
        if (expectedPort > 0) releaseOwnedPort(expectedPort, forkId)
      }

      const finish = (result) => {
        if (done) return false
        done = true
        rec.starting = false
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (cleanup) pendingSpawns.delete(cleanup)
        resolve({ forkId, ...result })
        return true
      }

      cleanup = () => {
        if (done) return
        rec.intentionalStop = true
        killTree(rec)
        rec.running = false
        rec.child = null
        rec.starting = false
        releaseReserved()
        finish({ ok: false, error: 'disposed' })
      }
      pendingSpawns.add(cleanup)

      const spec = buildLaunchSpec({ cliPath, profile, port: expectedPort })
      const env = {
        ...process.env,
        DSH_HOME: homeDir,
        // Fork identity is injected by the forker (a fork must never be able to call itself mother).
        DSH_FANG_ROLE: 'fork',
        DSH_FANG_TASK_ID: forkId,
        ...(opts.env ?? {}),
        // v3：Adapter Bearer token（PROTOCOL-V3 §3）。放在 opts.env 之后，母体生成的 token 优先。
        DSH_ADAPTER_TOKEN: rec.adapterToken,
      }
      let child = null
      try {
        child = spawnProcess(spec.command, spec.args, {
          env,
          ...(exists(homeDir) ? { cwd: homeDir } : {}),
          windowsHide: spec.windowsHide,
          shell: spec.shell,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        rec.status = FORK_STATUS.CRASHED
        rec.lastError = 'spawn-error'
        rec.exit = { kind: 'crash', code: null, message: msgOf(e) }
        releaseReserved()
        persist()
        return finish({ ok: false, error: 'spawn-error', message: msgOf(e), spec })
      }

      rec.child = child
      rec.pid = child.pid ?? null
      if (expectedPort > 0 && rec.pid) bindPortToPid(expectedPort, forkId, rec.pid)
      // Note: on a failed launch (ENOENT/EINVAL) `child.pid` is undefined and the
      // `error` event arrives on the next tick — never resolve early here, or that
      // event would have no listener and surface as an uncaughtException.

      const onData = (chunk) => {
        collector.push(chunk)
        if (rec.url) return
        const found = parseWebUrl(collector.text)
        if (!found) return
        // v2: the deterministic port is only trusted when the child really bound it.
        if (expectedPort > 0 && found.port !== expectedPort) {
          const pid = rec.pid
          rec.lastError = 'port-mismatch'
          const stopped = stopRecord(rec)
          persist()
          finish({
            ok: false,
            error: 'port-mismatch',
            expectedPort,
            pid,
            port: found.port,
            url: found.url,
            killed: stopped.killed,
          })
          return
        }
        rec.url = found.url
        rec.port = found.port
        rec.token = found.token ?? null
        rec.status = FORK_STATUS.RUNNING
        rec.running = true
        rec.starting = false
        rec.ready = true
        rec.startedAt = nowMs()
        writeForkMetaOf(rec)
        if (expectedPort > 0 && rec.pid) bindPortToPid(expectedPort, forkId, rec.pid)
        persist()
        emit(EVENTS.started, { forkId, pid: rec.pid, port: rec.port })
        audit(AUDIT.FORK_STARTED, { forkId, pid: rec.pid, port: rec.port, url: rec.url, profile })
        finish({
          ok: true,
          pid: rec.pid,
          port: rec.port,
          url: rec.url,
          token: rec.token,
          ...(expectedPort > 0 ? { allocatedPort: expectedPort } : {}),
        })
      }
      // The tokenized banner is normally on stdout; scanning stderr too costs nothing.
      try {
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
      } catch {
        /* pipes unavailable: the timeout path below still settles the promise */
      }

      child.once('error', (e) => {
        rec.running = false
        rec.child = null
        rec.starting = false
        rec.status = FORK_STATUS.CRASHED
        rec.lastError = msgOf(e)
        rec.exit = { kind: 'crash', code: null, message: msgOf(e) }
        releaseReserved()
        persist()
        finish({ ok: false, error: 'spawn-error', message: msgOf(e), log: collector.tail(20) })
      })

      child.once('exit', (code, signal) => {
        const exitInfo = classifyExit(code, signal)
        rec.exit = exitInfo
        rec.exitedAt = nowMs()
        rec.running = false
        rec.child = null
        rec.starting = false
        if (rec.intentionalStop) rec.status = FORK_STATUS.STOPPED
        else {
          rec.status = FORK_STATUS.CRASHED
          emit(EVENTS.crashed, { forkId, code: exitInfo.code, kind: exitInfo.kind })
          audit(AUDIT.FORK_CRASHED, { forkId, code: exitInfo.code, kind: exitInfo.kind, signal })
        }
        // A dead child never keeps a deterministic port: release it on every exit path.
        releaseReserved()
        if (!rec.intentionalStop) rec.crashCount = (rec.crashCount ?? 0) + 1
        // A reap may already have deleted the record + home; never resurrect it from the exit handler.
        if (records.get(forkId) === rec) {
          writeForkMetaOf(rec)
          persist()
        }
        if (!rec.intentionalStop && cfg.supervise && !disposed) {
          const plan = planRestart(exitInfo, rec, {
            maxRestarts: cfg.maxRestarts, baseMs: cfg.backoffBaseMs,
            maxMs: cfg.backoffMaxMs, jitter: cfg.backoffJitter,
          })
          if (plan.action === 'restart' && rec.cliPath && records.get(forkId) === rec) {
            rec.restartCount = (rec.restartCount ?? 0) + 1
            rec.restartScheduledAt = nowMs() + plan.delayMs
            rec.status = FORK_STATUS.PROVISIONING
            rec.lastError = `crash-restart-in-${plan.delayMs}ms`
            writeForkMetaOf(rec)
            rec.restartTimer = setTimeout(() => { rec.restartTimer = null; void restartFork(rec) }, plan.delayMs)
            audit(AUDIT.FORK_CRASHED, { forkId, restartInMs: plan.delayMs, attempt: plan.attempt, cause: plan.reason })
          } else if (plan.action === 'give-up') {
            rec.lastError = `restart-given-up:${plan.reason}`
            writeForkMetaOf(rec)
            audit(AUDIT.FORK_CRASHED, { forkId, restartGivenUp: plan.reason })
          }
        }
        finish({ ok: false, error: 'exited', code: exitInfo.code, signal, kind: exitInfo.kind, log: collector.tail(20) })
      })

      timer = setTimeout(() => {
        rec.lastError = 'timeout'
        const stopped = stopRecord(rec)
        persist()
        finish({
          ok: false,
          error: 'timeout',
          pid: rec.pid,
          timeoutMs,
          killed: stopped.killed,
          log: collector.tail(40),
        })
      }, timeoutMs)
    })
  }

  // ───────────────────────────── stop / reap ─────────────────────────────
  /** Shared stop primitive: kill the tree, mark stopped, release the port. Idempotent. */
  const stopRecord = (rec) => {
    rec.intentionalStop = true
    if (rec.restartTimer) { clearTimeout(rec.restartTimer); rec.restartTimer = null }
    rec.restartScheduledAt = null
    rec.ready = false
    // token 随进程死亡作废：绝不留给下一次 spawn 复用（restartFork 会重新生成）。
    rec.adapterToken = null
    const wasRunning = !!rec.running || !!rec.child || !!rec.starting
    const pid = rec.pid ?? rec.child?.pid ?? null
    if (wasRunning) {
      killTree(rec)
      rec.running = false
      rec.child = null
      rec.starting = false
      rec.status = FORK_STATUS.STOPPED
      rec.exitedAt = nowMs()
    } else if (rec.status !== FORK_STATUS.REAPED) {
      rec.status = FORK_STATUS.STOPPED
    }
    if (rec.port) releaseOwnedPort(rec.port, rec.forkId)
    return { ok: true, forkId: rec.forkId, pid, killed: wasRunning }
  }

  /** Kill the process tree. Idempotent: an already-dead fork returns ok with killed:false. */
  const stop = (forkId) => {
    ensureRegistry()
    ensurePorts()
    const id = String(forkId ?? '').trim()
    const rec = records.get(id)
    if (!rec) return { ok: false, error: 'not-found', forkId: id }
    const res = stopRecord(rec)
    persist()
    return res
  }

  /** stop + removeTree(homeDir) + registry delete. removeTree is junction-safe. */
  const reap = (forkId) => {
    ensureRegistry()
    ensurePorts()
    const id = String(forkId ?? '').trim()
    const rec = records.get(id)
    if (!rec) return { ok: false, error: 'not-found', forkId: id }
    stop(id)
    rec.status = FORK_STATUS.REAPED
    writeForkMetaOf(rec)
    const homeDir = rec.homeDir ? path.resolve(rec.homeDir) : ''
    let removed = false
    if (homeDir && isSafeToRemove(homeDir)) removed = exists(homeDir) ? removeTree(homeDir) : false
    records.delete(id)
    persist()
    emit(EVENTS.reaped, { forkId: id })
    audit(AUDIT.FORK_REAPED, { forkId: id, homeDir, removed })
    return { ok: true, forkId: id, removed, homeDir }
  }

  // ───────────────────────────── introspection ─────────────────────────────
  const status = (forkId) => {
    ensureRegistry()
    const id = String(forkId ?? '').trim()
    const rec = records.get(id)
    if (!rec) return { forkId: id, running: false, pid: null, error: 'not-found' }
    return publicFork(rec)
  }

  const list = () => {
    ensureRegistry()
    return [...records.values()]
      .map(publicFork)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.forkId).localeCompare(String(b.forkId)))
  }

  const logs = (forkId, tailLines = 40) => {
    ensureRegistry()
    const rec = records.get(String(forkId ?? '').trim())
    if (!rec || !rec.log) return ''
    return rec.log.tail(tailLines)
  }

  /**
   * v3 Adapter Bearer token（内存 only）。母体用它给 Remote/AdapterClient 加
   * `Authorization: Bearer`；**不要**把它塞进 status()/publicFork()（那会随
   * `/fang/api/status` 暴露给浏览器，也会落 forks.json）。
   * @returns {string} fork 不存在或已停止时为空串
   */
  const adapterToken = (forkId) => {
    ensureRegistry()
    const rec = records.get(String(forkId ?? '').trim())
    return typeof rec?.adapterToken === 'string' ? rec.adapterToken : ''
  }

  /** Re-spawn a crashed-but-ready fork after the backoff timer fires. */
  const restartFork = async (rec) => {
    if (disposed || rec.intentionalStop || records.get(rec.forkId) !== rec) return
    if (!rec.cliPath) { rec.lastError = 'restart-no-cli'; writeForkMetaOf(rec); return }
    rec.ready = false
    const out = await spawn({
      forkId: rec.forkId, homeDir: rec.homeDir, profile: rec.profile,
      cliPath: rec.cliPath, taskTitle: rec.taskTitle ?? '',
    })
    if (!out.ok && !disposed && records.get(rec.forkId) === rec) {
      rec.lastError = `restart-failed:${out.error}`
      writeForkMetaOf(rec)
    }
  }

  /** HTTP liveness for a fork (any response counts); process state is reported separately. */
  const health = async (forkId) => {
    ensureRegistry()
    ensurePorts()
    const id = String(forkId ?? '').trim()
    const rec = records.get(id)
    if (!rec) return { ok: false, error: 'not-found', forkId: id }
    const alive = !!rec.running && !!rec.child && rec.child.exitCode === null
    const http = alive && rec.port ? await probeHttpAlive(rec.port, { path: cfg.healthPath }) : false
    return { ok: true, forkId: id, status: rec.status, running: alive, pid: rec.pid ?? null, port: rec.port ?? null, http, url: rec.url ?? null }
  }

  /** Reconcile persisted records after a mother restart; never kills a live foreign pid. */
  const recover = async () => {
    ensureRegistry()
    ensurePorts()
    const actions = reconcileOrphans(
      [...records.values()].map((rec) => ({ forkId: rec.forkId, status: rec.status, pid: rec.pid })),
      isPidAlive,
    )
    for (const action of actions) {
      if (action.action !== 'mark-crashed') continue
      const rec = records.get(action.forkId)
      if (!rec) continue
      rec.pid = null
      rec.running = false
      rec.child = null
      rec.ready = false
      rec.status = FORK_STATUS.CRASHED
      rec.lastError = `orphaned:${action.reason}`
      if (rec.port) releaseOwnedPort(rec.port, rec.forkId)
      writeForkMetaOf(rec)
    }
    persist()
    return { ok: true, actions, forks: actions.filter((a) => a.action === 'mark-crashed').length }
  }

  /** 真实进程存活判断（用于归档确认 stop 真的生效，而不是只看 rec.running 状态）。 */
  const alive = (forkId) => {
    ensureRegistry()
    const rec = records.get(String(forkId ?? '').trim())
    if (!rec) return false
    const pid = rec.pid ?? rec.child?.pid ?? null
    return isPidAlive(pid)
  }

  const service = {
    role: gate.role,
    provision,
    spawn,
    stop,
    reap,
    alive,
    health,
    recover,
    status,
    list,
    logs,
    adapterToken,
    getToken: adapterToken,
    onTokenRefresh(handler) {
      if (typeof handler !== 'function') return () => {}
      tokenRefreshHandlers.add(handler)
      return () => tokenRefreshHandlers.delete(handler)
    },
    allocatePort,
    releasePort,
    ensureTemplate,
    portPool: () => ({ ...portPool }),
    ports: () => {
      ensurePorts()
      return portsSnapshot()
    },
    get config() {
      return { ...cfg }
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.forker, service))
  // Plugin unload must never leave orphan children (or leaked pool ports) behind.
  ctx.effect(() => () => {
    disposed = true
    for (const pending of [...pendingSpawns]) {
      try {
        pending()
      } catch {
        /* ignore */
      }
    }
    for (const rec of records.values()) {
      if (rec.restartTimer) { clearTimeout(rec.restartTimer); rec.restartTimer = null }
      if (rec.running || rec.child || rec.starting) {
        rec.intentionalStop = true
        killTree(rec)
        rec.running = false
        rec.child = null
        rec.starting = false
      }
    }
    for (const [port, forkId] of [...ownedPorts]) {
      try {
        releaseOwnedPort(port, forkId)
      } catch {
        /* best effort on unload */
      }
    }
    persist()
  })
  return service
}

export const _internals = {
  createTextTail,
  safeProfile,
  isPidAlive,
  probePortFree,
  DEFAULTS,
  EVENTS,
  DEFAULT_PORT_POOL,
  CLEAN_TEMPLATE_BUNDLES,
}
