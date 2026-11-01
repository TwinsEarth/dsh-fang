// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.0.0 — container executor (AppContainer fallback) + declared write proxy.
//
// Two independent pieces live here so the router / buffer-keeper can use them without
// loading a container:
//
//   1. Write proxy (pure): validateWriteRequest() / applyWriteRequest() decide whether a
//      write request that arrived from an isolated process may land in the buffer root,
//      and only ever write inside it. encodeFrame()/parseFrames() are the NDJSON wire
//      helper for `{op:'write'|'ping'|'stat', reqId, path, data, encoding}` frames.
//
//   2. Container host: createContainerHost() probes the vendored `probes/` assets and
//      runs code through `container-exec-pipe.ps1` (AppContainer worker). Probing never
//      throws: every failure degrades to `state:'unavailable'` (or 'disabled' off
//      Windows) with a machine-readable `reason`. Real container execution is only
//      established with the manual FANG_CONTAINER_LIVE=1 probe; unit tests never launch
//      a container.
//
// Design rules (docs/CONTRACTS-V2.md §5.6):
//   * path safety is checked on the RELATIVE path first (no drive letters, no UNC, no
//     `\\?\`, no `..`), then on the resolved target (must stay under bufferRoot), then
//     on the parent chain (lstat for junctions/symlinks + realpath containment).
//   * declared writes are a prefix allowlist: a request is accepted only when it is
//     exactly a declared path or a child of one.
//   * a single request is capped at maxBytes (default 1 MiB).
//   * zero third-party dependencies, no network, no writes outside the given root.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile as nodeExecFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Frame ops accepted by the write-proxy channel. */
export const WRITE_PROXY_OPS = Object.freeze(['write', 'ping', 'stat'])

/** Container host states — mirrors the kernel `CONTAINER` vocabulary. */
export const CONTAINER_STATE = Object.freeze({
  DISABLED: 'disabled',
  UNAVAILABLE: 'unavailable',
  READY: 'ready',
})

/** Default cap for a single write request: 1 MiB (contract §5.6). */
export const DEFAULT_MAX_BYTES = 1048576

/** Files the vendored probe directory must contain for a static "ready" preflight. */
const PROBE_FILES = Object.freeze([
  'AppContainerHost.cs',
  'container-exec-pipe.ps1',
  'worker-pipe-exec.mjs',
])

const isWin = () => process.platform === 'win32'

const msgOf = (e) => String(e && e.message ? e.message : e)

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function existsIn(fsImpl, p) {
  try {
    return fsImpl.existsSync(p)
  } catch {
    return false
  }
}

function safeLstat(fsImpl, p) {
  try {
    return fsImpl.lstatSync(p)
  } catch {
    return null
  }
}

function safeRealpath(fsImpl, p) {
  try {
    return typeof fsImpl.realpathSync === 'function' ? fsImpl.realpathSync(p) : null
  } catch {
    return null
  }
}

/** Case-insensitive path comparison on Windows; exact elsewhere. */
function compareKey(p) {
  return isWin() ? String(p).toLowerCase() : String(p)
}

/** True when `p` is `base` or lives under it (both already absolute). */
function isInside(base, p) {
  const rel = path.relative(base, p)
  if (!rel) return true
  if (path.isAbsolute(rel)) return false
  const key = compareKey(rel)
  return key !== '..' && !key.startsWith('..' + path.sep) && !key.startsWith('../')
}

// ---------------------------------------------------------------------------
// Relative-path normalisation + declaration allowlist
// ---------------------------------------------------------------------------

/**
 * Normalise a request/declaration path to a safe POSIX-style relative path.
 * Rejects drive letters, UNC/namespace paths, absolute paths, `..` segments, NUL,
 * ADS (`file.txt:stream`) and other non-relative shapes BEFORE path.resolve().
 * @returns {{ok:true,path:string}|{ok:false,reason:string}}
 */
function normalizeRelPath(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'bad-path' }
  if (raw.length === 0) return { ok: false, reason: 'bad-path' }
  if (raw.includes('\0')) return { ok: false, reason: 'bad-path' }
  const slashed = raw.replace(/\\/g, '/')
  if (slashed.startsWith('//')) return { ok: false, reason: 'unc-path' }
  if (/^[A-Za-z]:/.test(slashed)) return { ok: false, reason: 'absolute-path' }
  if (slashed.startsWith('/')) return { ok: false, reason: 'absolute-path' }
  const segments = slashed.split('/')
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'dotdot-segment' }
  const normalized = path.posix.normalize(slashed)
  if (!normalized || normalized === '.') return { ok: false, reason: 'bad-path' }
  if (normalized === '..' || normalized.startsWith('../')) return { ok: false, reason: 'escapes-buffer-root' }
  // On Windows a colon in a relative path is an alternate data stream ("file.txt:evil").
  if (normalized.includes(':')) return { ok: false, reason: 'ads-path' }
  return { ok: true, path: normalized }
}

/**
 * Normalise a declared-writes manifest into `[{path, reason}]`.
 * Paths that are malformed or would escape are dropped (they could never match a
 * safe request anyway). Accepts strings or `{path, reason}` entries.
 */
export function normalizeDeclared(declared) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(declared)) return out
  for (const entry of declared) {
    const raw = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.path : null
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    const normalized = normalizeRelPath(trimmed)
    if (!normalized.ok) continue
    if (seen.has(normalized.path)) continue
    seen.add(normalized.path)
    out.push({
      path: normalized.path,
      reason: isPlainObject(entry) && typeof entry.reason === 'string' ? entry.reason : '',
    })
  }
  return out
}

/** Prefix allowlist match; a declaration covers itself and its descendants. */
function declaredAllows(declaredNorm, rel) {
  for (const entry of declaredNorm) {
    if (rel === entry.path) return entry
    if (rel.startsWith(entry.path + '/')) return entry
  }
  return null
}

// ---------------------------------------------------------------------------
// Payload decoding + size cap
// ---------------------------------------------------------------------------

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

function normalizedMaxBytes(maxBytes) {
  const n = Number(maxBytes)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_BYTES
  return Math.floor(n)
}

/**
 * Decode `req.data` with `req.encoding` ('utf8' default, 'base64' supported).
 * @returns {{ok:true,bytes:Buffer,encoding:string,size:number}|{ok:false,reason:string}}
 */
function decodePayload(req, maxBytes) {
  const data = req?.data
  let encoding = typeof req?.encoding === 'string' ? req.encoding.toLowerCase() : 'utf8'
  if (encoding === 'utf-8') encoding = 'utf8'
  if (encoding === 'b64') encoding = 'base64'
  if (encoding !== 'utf8' && encoding !== 'base64') return { ok: false, reason: 'bad-encoding' }

  let bytes
  if (Buffer.isBuffer(data)) {
    bytes = Buffer.from(data)
  } else if (typeof data === 'string') {
    if (encoding === 'base64') {
      // Reject oversized strings before allocating the decoded copy.
      if (data.length > maxBytes * 2 + 4) return { ok: false, reason: 'too-large' }
      const compact = data.replace(/\s+/g, '')
      if (compact && !BASE64_RE.test(compact)) return { ok: false, reason: 'bad-base64' }
      bytes = Buffer.from(compact, 'base64')
    } else {
      bytes = Buffer.from(data.replace(/^\uFEFF/, ''), 'utf8')
    }
  } else {
    return { ok: false, reason: 'bad-data' }
  }
  if (bytes.length > maxBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, bytes, encoding, size: bytes.length }
}

// ---------------------------------------------------------------------------
// Path safety: resolved containment + parent-chain (junction) checks
// ---------------------------------------------------------------------------

/**
 * Validate that `rel` may be written under `bufferRoot`.
 * @returns {{ok:true,target:string,bytes:Buffer,path:string,declaredPath:string,size:number}
 *          |{ok:false,reason:string, ...details}}
 */
function checkWritePath({
  bufferRoot,
  declared,
  rel,
  req,
  maxBytes,
  fsImpl,
  requireDeclared = true,
  skipPayload = false,
}) {
  if (typeof bufferRoot !== 'string' || !bufferRoot.trim()) return { ok: false, reason: 'no-buffer-root' }
  const rootAbs = path.resolve(bufferRoot)
  const targetAbs = path.resolve(rootAbs, rel)
  if (compareKey(targetAbs) === compareKey(rootAbs)) return { ok: false, reason: 'bad-path' }
  if (!isInside(rootAbs, targetAbs)) return { ok: false, reason: 'escapes-buffer-root' }

  const declaredMatch = requireDeclared ? declaredAllows(declared, rel) : null
  if (requireDeclared && !declaredMatch) return { ok: false, reason: 'not-declared', path: rel }

  let payload = { ok: true, bytes: Buffer.alloc(0), size: 0 }
  if (!skipPayload) {
    payload = decodePayload(req, maxBytes)
    if (!payload.ok) return { ok: false, reason: payload.reason, path: rel }
  }

  const rootReal = safeRealpath(fsImpl, rootAbs)
  const parts = rel.split('/')
  // Ancestors strictly below the root: a junction/symlink there can redirect the write.
  for (let i = 1; i < parts.length; i++) {
    const dirAbs = path.join(rootAbs, ...parts.slice(0, i))
    const st = safeLstat(fsImpl, dirAbs)
    if (!st) break
    if (st.isSymbolicLink()) {
      return { ok: false, reason: 'symlink-ancestor', path: rel, at: parts.slice(0, i).join('/') }
    }
    if (rootReal) {
      const real = safeRealpath(fsImpl, dirAbs)
      if (!real || !isInside(rootReal, real)) {
        return { ok: false, reason: 'realpath-escape', path: rel, at: parts.slice(0, i).join('/') }
      }
    }
  }
  const targetSt = safeLstat(fsImpl, targetAbs)
  if (targetSt) {
    if (targetSt.isSymbolicLink()) return { ok: false, reason: 'symlink-target', path: rel }
    if (targetSt.isDirectory()) return { ok: false, reason: 'target-is-directory', path: rel }
    if (rootReal) {
      const real = safeRealpath(fsImpl, targetAbs)
      if (!real || !isInside(rootReal, real)) return { ok: false, reason: 'realpath-escape', path: rel }
    }
  }
  return {
    ok: true,
    target: targetAbs,
    bytes: payload.bytes,
    path: rel,
    declaredPath: declaredMatch ? declaredMatch.path : '',
    size: payload.size,
  }
}

/** Shared validation used by both the public validator and the applier. */
function validateInternal(input) {
  const { bufferRoot, declared, req, fsImpl = fs } = input ?? {}
  const maxBytes = normalizedMaxBytes(input?.maxBytes)
  if (!isPlainObject(req)) return { ok: false, reason: 'bad-request' }
  if (req.op !== 'write') {
    return { ok: false, reason: typeof req.op === 'string' ? `unsupported-op:${req.op}` : 'bad-request' }
  }
  const normalized = normalizeRelPath(req.path)
  if (!normalized.ok) return { ok: false, reason: normalized.reason, path: typeof req.path === 'string' ? req.path : '' }
  return checkWritePath({
    bufferRoot,
    declared: normalizeDeclared(declared),
    rel: normalized.path,
    req,
    maxBytes,
    fsImpl,
  })
}

/**
 * Validate a write request against the declared manifest and the buffer root.
 *
 * @param {{bufferRoot:string, declared?:Array, req:object, maxBytes?:number,
 *          fsImpl?:object}} input
 * @returns {{ok:true,target:string,path:string,declaredPath:string,size:number}
 *          |{ok:false,reason:string,path?:string}}
 */
export function validateWriteRequest(input = {}) {
  const check = validateInternal(input)
  if (!check.ok) return { ok: false, reason: check.reason, ...(check.path ? { path: check.path } : {}) }
  return {
    ok: true,
    target: check.target,
    path: check.path,
    declaredPath: check.declaredPath,
    size: check.size,
  }
}

/** Write bytes at `target`; prefers the injected kernel fsx atomic writer. */
function writeBytes({ target, bytes, fsx, fsImpl }) {
  const dir = path.dirname(target)
  if (fsx && typeof fsx.writeFileAtomic === 'function') {
    fsx.writeFileAtomic(target, bytes)
    return
  }
  if (fsx && typeof fsx.ensureDir === 'function') fsx.ensureDir(dir)
  else if (typeof fsImpl.mkdirSync === 'function') fsImpl.mkdirSync(dir, { recursive: true })
  if (fsx && typeof fsx.writeFileSync === 'function') {
    fsx.writeFileSync(target, bytes)
    return
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  fsImpl.writeFileSync(tmp, bytes)
  try {
    fsImpl.renameSync(tmp, target)
  } catch {
    try {
      fsImpl.copyFileSync(tmp, target)
    } finally {
      try {
        fsImpl.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Validate then write one request. Validation runs again here (callers cannot skip it).
 *
 * @param {{bufferRoot:string, declared?:Array, req:object, maxBytes?:number,
 *          fsx?:object}} input
 * @returns {{ok:true,target:string,bytes:number}|{ok:false,reason:string}}
 */
export function applyWriteRequest(input = {}) {
  const { fsx = null } = input ?? {}
  const check = validateInternal(input)
  if (!check.ok) return { ok: false, reason: check.reason, ...(check.path ? { path: check.path } : {}) }
  try {
    writeBytes({ target: check.target, bytes: check.bytes, fsx, fsImpl: fs })
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: msgOf(e) }
  }
  return { ok: true, target: check.target, bytes: check.size }
}

// ---------------------------------------------------------------------------
// NDJSON framing
// ---------------------------------------------------------------------------

/**
 * Encode one frame as a single NDJSON line (JSON + '\n').
 * @param {object} obj
 * @returns {string}
 */
export function encodeFrame(obj) {
  if (!isPlainObject(obj)) throw new TypeError('encodeFrame expects an object')
  return JSON.stringify(obj) + '\n'
}

/**
 * Split a stream buffer into complete NDJSON frames + the trailing partial line.
 * Blank lines are skipped; non-JSON lines are skipped and reported in `errors`
 * (never thrown: a hostile peer must not be able to break the parser).
 * @param {string|Buffer} input
 * @returns {{frames:object[], rest:string, errors:object[]}}
 */
export function parseFrames(input) {
  const frames = []
  const errors = []
  let text
  if (Buffer.isBuffer(input)) text = input.toString('utf8')
  else if (typeof input === 'string') text = input
  else if (input === null || input === undefined) return { frames, rest: '', errors }
  else throw new TypeError('parseFrames expects a string or Buffer')

  const parts = text.split('\n')
  const rest = parts.pop() ?? ''
  for (const rawLine of parts) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (e) {
      errors.push({ line, error: msgOf(e) })
      continue
    }
    if (!isPlainObject(parsed)) {
      errors.push({ line, error: 'not-an-object' })
      continue
    }
    frames.push(parsed)
  }
  return { frames, rest, errors }
}

// ---------------------------------------------------------------------------
// Container host
// ---------------------------------------------------------------------------

const defaultProbeDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../probes')

/**
 * Resolve a PowerShell executable without spawning it.
 * @returns {{ok:true,path:string}|{ok:false,reason:string}}
 */
function resolvePowerShell(name, { env = process.env, platform = process.platform } = {}) {
  const raw = typeof name === 'string' ? name.trim() : ''
  if (!raw) return { ok: false, reason: 'powershell-not-found' }
  const looksLikePath = path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')
  if (looksLikePath) {
    const candidate = path.resolve(raw)
    if (fs.existsSync(candidate)) return { ok: true, path: candidate }
    return { ok: false, reason: `powershell-not-found:${candidate}` }
  }
  const pathValue = env?.PATH ?? env?.Path ?? env?.path ?? ''
  const separators = platform === 'win32' ? [';', ':'] : [':']
  const dirs = []
  for (const sep of separators) {
    for (const dir of String(pathValue).split(sep)) if (dir) dirs.push(dir)
  }
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, raw + ext)
      if (fs.existsSync(candidate)) return { ok: true, path: candidate }
    }
  }
  return { ok: false, reason: `powershell-not-found:${raw}` }
}

function stringEnv(env) {
  const out = {}
  if (!isPlainObject(env)) return out
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) continue
    out[String(k)] = String(v)
  }
  return out
}

function clampTimeout(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

/**
 * Run one child process with a hard timeout. Resolves (never rejects) with a
 * structured result: { ok, stdout, stderr, exitCode, error, timedOut }.
 * Injected `execFileImpl` is node-style: (file, args, options, callback) -> ChildProcess.
 */
function runProcess({ file, args, env, timeoutMs, execFileImpl, input }) {
  return new Promise((resolve) => {
    let settled = false
    let child = null
    let backstop = null
    let backstopFired = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (backstop) clearTimeout(backstop)
      resolve(result)
    }
    const runner = typeof execFileImpl === 'function' ? execFileImpl : nodeExecFile
    const options = {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      env,
    }
    try {
      child = runner(file, args, options, (err, stdout, stderr) => {
        const out = {
          ok: !err,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          exitCode: 0,
          error: null,
          timedOut: false,
        }
        if (err) {
          const timedOut =
            backstopFired ||
            err.killed === true ||
            err.signal === 'SIGKILL' ||
            err.signal === 'SIGTERM' ||
            err.code === 'ETIMEDOUT'
          out.timedOut = timedOut
          out.error = timedOut ? 'timeout' : msgOf(err)
          out.exitCode = typeof err.code === 'number' ? err.code : null
        }
        finish(out)
      })
      if (input !== undefined && input !== null && child && child.stdin && typeof child.stdin.end === 'function' && !child.stdin.destroyed) {
        try {
          child.stdin.end(input)
        } catch {
          /* the runner may not expose a writable stdin */
        }
      }
    } catch (e) {
      finish({ ok: false, stdout: '', stderr: '', exitCode: null, error: msgOf(e), timedOut: false })
      return
    }
    // Backstop: a runner that never calls back (or hangs past the native timeout) still settles.
    backstop = setTimeout(() => {
      backstopFired = true
      try {
        child?.kill?.('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error: 'timeout',
        timedOut: true,
      })
    }, timeoutMs + 250)
  })
}

/** Read the probe result: the ResultFile first, then the last JSON line of stdout. */
function readProbeResult(resultFile, stdout) {
  try {
    const raw = fs.readFileSync(resultFile, 'utf8')
    return JSON.parse(raw)
  } catch {
    /* fall through to stdout */
  }
  const lines = String(stdout).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      return JSON.parse(line)
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** Validate/apply the frames emitted by container code, in order. */
async function handleProxyFrames(frames, { bufferRoot, declared, maxBytes, writeApplier, fsx }) {
  const writes = []
  for (const frame of frames) {
    if (!isPlainObject(frame) || !WRITE_PROXY_OPS.includes(frame.op)) continue
    const reqId = frame.reqId ?? null
    if (frame.op === 'ping') {
      writes.push({ op: 'ping', reqId, ok: true })
      continue
    }
    if (frame.op === 'stat') {
      const normalized = normalizeRelPath(frame.path)
      if (!normalized.ok) {
        writes.push({ op: 'stat', reqId, path: frame.path ?? '', ok: false, reason: normalized.reason })
        continue
      }
      const check = checkWritePath({
        bufferRoot,
        declared: [],
        rel: normalized.path,
        req: { op: 'write', data: '' },
        maxBytes,
        fsImpl: fs,
        requireDeclared: false,
        skipPayload: true,
      })
      // Reuse the path checks but not the declaration requirement for stat.
      writes.push(
        check.ok
          ? { op: 'stat', reqId, path: normalized.path, ok: true, target: check.target }
          : { op: 'stat', reqId, path: normalized.path, ok: false, reason: check.reason },
      )
      continue
    }
    // op === 'write'
    const check = validateInternal({ bufferRoot, declared, req: frame, maxBytes })
    if (!check.ok) {
      writes.push({ op: 'write', reqId, path: frame.path ?? '', ok: false, reason: check.reason })
      continue
    }
    const entry = {
      op: 'write',
      reqId,
      path: check.path,
      ok: true,
      target: check.target,
      bytes: check.size,
      applied: false,
    }
    if (typeof writeApplier === 'function') {
      try {
        // The applier receives the internal check (with the decoded Buffer in `bytes`).
        await writeApplier({ ...check }, frame)
        entry.applied = true
      } catch (e) {
        entry.ok = false
        entry.reason = 'applier-failed'
        entry.error = msgOf(e)
      }
    }
    writes.push(entry)
  }
  return writes
}

/** Frames worth proxying: NDJSON lines on stdout plus `writes` carried by the probe result. */
function collectFrames(stdout, parsedResult) {
  const frames = []
  const fromStdout = parseFrames(String(stdout ?? '')).frames
  for (const frame of fromStdout) if (WRITE_PROXY_OPS.includes(frame.op)) frames.push(frame)
  const carried = []
  if (parsedResult && Array.isArray(parsedResult.writes)) carried.push(...parsedResult.writes)
  if (parsedResult && parsedResult.result && Array.isArray(parsedResult.result.writes)) {
    carried.push(...parsedResult.result.writes)
  }
  for (const frame of carried) if (isPlainObject(frame)) frames.push(frame)
  return frames
}

/**
 * Create the container host. Probing is static and synchronous (files + PowerShell on
 * disk): a failure NEVER throws, it degrades to `state:'unavailable'` (+reason).
 *
 * @param {{powershellPath?:string, probeDir?:string, timeoutMs?:number,
 *          execFileImpl?:Function, bufferRoot?:string, maxBytes?:number,
 *          writeApplier?:Function|null, platform?:string,
 *          fsImpl?:object}} [options]
 * @returns {{state:string, available:Function, exec:Function, dispose:Function}}
 */
export function createContainerHost(options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const probeDir = typeof opts.probeDir === 'string' && opts.probeDir.trim()
    ? path.resolve(opts.probeDir)
    : defaultProbeDir()
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform
  const powershellPath = typeof opts.powershellPath === 'string' ? opts.powershellPath : 'powershell.exe'
  const timeoutMs = clampTimeout(opts.timeoutMs, 30000)
  const execFileImpl = typeof opts.execFileImpl === 'function' ? opts.execFileImpl : null
  const bufferRoot = typeof opts.bufferRoot === 'string' ? opts.bufferRoot : ''
  const maxBytes = normalizedMaxBytes(opts.maxBytes)
  const writeApplier = typeof opts.writeApplier === 'function' ? opts.writeApplier : null
  const fsImpl = opts.fsImpl && typeof opts.fsImpl === 'object' ? opts.fsImpl : fs

  const detect = () => {
    if (platform !== 'win32') return { state: CONTAINER_STATE.DISABLED, reason: `non-windows:${platform}` }
    const missing = PROBE_FILES.filter((name) => !existsIn(fsImpl, path.join(probeDir, name)))
    if (missing.length) return { state: CONTAINER_STATE.UNAVAILABLE, reason: `probe-missing:${missing.join(',')}` }
    const ps = resolvePowerShell(powershellPath, { env: process.env, platform })
    if (!ps.ok) return { state: CONTAINER_STATE.UNAVAILABLE, reason: ps.reason }
    return { state: CONTAINER_STATE.READY, reason: 'preflight-ok', powershellPath: ps.path }
  }

  const detected = detect()
  let state = detected.state
  const stateReason = detected.reason
  let disposed = false

  const available = () => {
    if (disposed) return { ok: false, state: CONTAINER_STATE.UNAVAILABLE, reason: 'disposed' }
    return { ok: state === CONTAINER_STATE.READY, state, reason: stateReason }
  }

  /**
   * Run code through the AppContainer pipe probe.
   * @param {{code:string, env?:object, declaredWrites?:Array, timeoutMs?:number}} request
   * @returns {Promise<{ok:boolean, stdout:string, stderr:string, exitCode:number|null,
   *                    writes:object[], result?:any, error?:string, reason?:string}>}
   */
  async function exec(request = {}) {
    const req = isPlainObject(request) ? request : {}
    const budget = clampTimeout(req.timeoutMs, timeoutMs)
    const base = { ok: false, stdout: '', stderr: '', exitCode: null, writes: [] }
    if (disposed) return { ...base, error: 'disposed', reason: 'disposed' }
    if (state !== CONTAINER_STATE.READY) {
      return {
        ...base,
        error: state === CONTAINER_STATE.DISABLED ? 'disabled' : 'unavailable',
        reason: stateReason,
      }
    }
    const code = typeof req.code === 'string' ? req.code : ''
    if (!code.trim()) return { ...base, error: 'empty-code' }

    const declared = normalizeDeclared(req.declaredWrites)
    let workDir = ''
    try {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-container-'))
    } catch (e) {
      return { ...base, error: 'tmp-failed', reason: msgOf(e) }
    }
    const codeFile = path.join(workDir, 'code.js')
    const resultFile = path.join(workDir, 'result.json')
    try {
      fs.writeFileSync(codeFile, code, 'utf8')
      const childEnv = { ...process.env, ...stringEnv(req.env) }
      if (declared.length) childEnv.FANG_DECLARED_WRITES = JSON.stringify(declared.map((d) => d.path))
      if (bufferRoot) childEnv.FANG_BUFFER_ROOT = path.resolve(bufferRoot)
      const script = path.join(probeDir, 'container-exec-pipe.ps1')
      const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-CodeFile',
        codeFile,
        '-ResultFile',
        resultFile,
        '-TimeoutSec',
        String(Math.max(1, Math.ceil(budget / 1000))),
      ]
      const run = await runProcess({
        file: detected.powershellPath,
        args,
        env: childEnv,
        timeoutMs: budget,
        execFileImpl,
      })
      if (run.timedOut) {
        return { ...base, stdout: run.stdout, stderr: run.stderr, error: 'timeout' }
      }
      const parsed = readProbeResult(resultFile, run.stdout)
      const frames = collectFrames(run.stdout, parsed)
      const writes = await handleProxyFrames(frames, {
        bufferRoot,
        declared,
        maxBytes,
        writeApplier,
        fsx: null,
      })
      const probeOk = run.ok && (!parsed || parsed.ok !== false)
      const result = parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed
      if (!probeOk) {
        return {
          ...base,
          stdout: run.stdout,
          stderr: run.stderr,
          exitCode: run.exitCode,
          writes,
          result,
          error: (parsed && parsed.error) || run.error || 'probe-failed',
        }
      }
      return {
        ok: true,
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode,
        writes,
        result,
      }
    } catch (e) {
      return { ...base, error: 'exec-failed', reason: msgOf(e) }
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true })
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }

  const dispose = () => {
    disposed = true
    state = CONTAINER_STATE.UNAVAILABLE
    return { ok: true }
  }

  return {
    get state() {
      return state
    },
    available,
    exec,
    dispose,
    get probeDir() {
      return probeDir
    },
  }
}
