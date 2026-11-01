// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.6.1 — 母体侧 Adapter v3 客户端（契约：docs/PROTOCOL-V3.md §5）。
//
// 把「协议协商 + 状态快照 + SSE 事件流 + 断线重连 + cursor 续传 + 幂等命令」封成一个
// ForkClient。母体（Orchestrator / 未来 Forker 监督器）只接触方法，不碰 HTTP/SSE 细节。
//
// 失败语义（刻意与 remote.mjs 一致）：**永不抛出**，全部降级为 `{ok:false, ...}`；
// 网络/超时类失败按指数退避无限重连，401（token 错误）是致命失败、不重试。
import { RECONNECT_DEFAULTS, createSseParser, negotiateProtocol, newCommandId } from './adapter-protocol.mjs'
import { classifyRemoteFailure, createRemote } from './remote.mjs'

const msgOf = (e) => String(e && e.message !== undefined ? e.message : e)

const positiveMs = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * @param {object} [options]
 * @param {string} [options.url]          分身 web URL（可自带 `?token=`）
 * @param {string} [options.token]        DSH web token（也用于 SSE 的 ?token=）
 * @param {string} [options.adapterToken] v3 Bearer token（不落 URL）
 * @param {Function} [options.fetchImpl]  可注入 fetch（测试用）
 * @param {number} [options.timeoutMs]
 * @param {string} [options.prefix]
 * @param {number} [options.minProtocol]
 * @param {number} [options.maxProtocol]
 * @param {{baseMs?:number,maxMs?:number}} [options.reconnect]
 * @param {boolean} [options.autoReconnect=true] 事件流断开后是否自动重连
 */
export function createAdapterClient(options = {}) {
  const {
    url,
    token,
    adapterToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    prefix = '/fang',
    minProtocol,
    maxProtocol,
    reconnect = {},
    autoReconnect = true,
  } = options

  const remote = createRemote({ url, token, adapterToken, fetchImpl, timeoutMs, prefix })
  const impl = typeof fetchImpl === 'function' ? fetchImpl : null
  const limits = {
    ...(Number.isInteger(minProtocol) ? { min: minProtocol } : {}),
    ...(Number.isInteger(maxProtocol) ? { max: maxProtocol } : {}),
  }
  const backoff = {
    baseMs: positiveMs(reconnect?.baseMs, RECONNECT_DEFAULTS.baseMs),
    maxMs: positiveMs(reconnect?.maxMs, RECONNECT_DEFAULTS.maxMs),
  }

  const listeners = {
    event: new Set(),
    state: new Set(),
    reconnect: new Set(),
    disconnect: new Set(),
  }

  let mode = 'idle'
  let protocol = 0
  let sessionId = ''
  let lastCursor = '0'
  let lastState = null
  let lastVersionInfo = null
  let sessionMismatch = null
  let protocolRange = { min: undefined, max: undefined }
  let lastError = ''
  let stopped = true
  let controller = null
  let pumpPromise = null

  const emit = (kind, payload) => {
    for (const fn of listeners[kind]) {
      try {
        fn(payload)
      } catch {
        /* 订阅者异常不得打断连接 */
      }
    }
  }

  const on = (kind) => (fn) => {
    if (typeof fn !== 'function') return () => {}
    listeners[kind].add(fn)
    return () => listeners[kind].delete(fn)
  }

  const pendingWaits = new Map()

  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingWaits.delete(timer)
      resolve()
    }, ms)
    pendingWaits.set(timer, resolve)
  })

  const backoffFor = (attempt) => Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(attempt, 5))

  const headers = () => remote.authHeaders()

  /** 用快照把 cursor/session 对齐（410 cursor-expired / 409 session-changed 后调用）。 */
  async function resyncFromState(reason) {
    lastCursor = '0'
    const snapshot = await remote.state()
    if (snapshot.ok && snapshot.data) {
      lastState = snapshot.data
      if (snapshot.data.sessionId) sessionId = String(snapshot.data.sessionId)
      lastCursor = String(snapshot.data.lastCursor ?? '0')
      emit('state', lastState)
    }
    emit('reconnect', { resetCursor: true, reason, sessionId, lastCursor })
    return snapshot
  }

  /** 打开一次 SSE 连接：返回可判定结果，不抛。 */
  async function openOnce() {
    if (!impl) return { ok: false, code: 'no-fetch', fatal: true }
    controller = new AbortController()
    const target = remote.eventsUrl({ since: lastCursor, session: sessionId })
    let res = null
    try {
      res = await impl(target, { method: 'GET', headers: headers(), signal: controller.signal })
    } catch (e) {
      return { ok: false, code: classifyRemoteFailure(e).kind, error: msgOf(e), retryable: true }
    }
    const status = Number(res?.status)
    if (status === 401) return { ok: false, code: 'unauthorized', status, fatal: true }
    if (status === 409) {
      await resyncFromState('session-changed')
      return { ok: false, code: 'session-changed', status, resync: true, retryable: true }
    }
    if (status === 410) {
      await resyncFromState('cursor-expired')
      return { ok: false, code: 'cursor-expired', status, resync: true, retryable: true }
    }
    if (!(status >= 200 && status < 300)) return { ok: false, code: `http-${status}`, status, retryable: true }
    return { ok: true, res }
  }

  /** 读 SSE 流直到结束；解析出的每条事件更新 cursor 并回调 onEvent。 */
  async function pump(res) {
    const parser = createSseParser()
    const body = res?.body
    const onFrame = (frame) => {
      if (!frame || !frame.data) return
      let envelope = null
      try {
        envelope = JSON.parse(frame.data)
      } catch {
        return
      }
      const cursor = frame.id || (envelope && envelope.cursor) || ''
      if (cursor) lastCursor = String(cursor)
      if (envelope && envelope.event) emit('event', envelope)
    }
    try {
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return { ok: true }
          if (chunk.value !== undefined) {
            for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) onFrame(frame)
          }
        }
      }
      if (body && typeof body[Symbol.asyncIterator] === 'function') {
        const decoder = new TextDecoder()
        for await (const value of body) {
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) onFrame(frame)
        }
        return { ok: true }
      }
      return { ok: false, code: 'no-stream-body' }
    } catch (e) {
      return { ok: false, code: classifyRemoteFailure(e).kind, error: msgOf(e) }
    }
  }

  /** 断线后的重连循环：指数退避；401 致命；409/410 先快照对齐再立即重试。 */
  async function reconnectLoop() {
    let attempt = 0
    while (!stopped) {
      const opened = await openOnce()
      if (stopped) return
      if (opened.fatal) {
        mode = 'failed'
        lastError = opened.code
        emit('disconnect', { reason: opened.code, fatal: true })
        return
      }
      if (opened.ok) {
        attempt = 0
        mode = 'streaming'
        emit('reconnect', { resetCursor: false, reason: 'resumed', sessionId, lastCursor })
        const result = await pump(opened.res)
        if (stopped) return
        mode = 'reconnecting'
        emit('disconnect', { reason: result.code ?? 'stream-closed' })
        if (!autoReconnect) {
          mode = 'idle'
          return
        }
        await wait(backoffFor(attempt++))
        continue
      }
      mode = 'reconnecting'
      lastError = opened.code
      emit('disconnect', { reason: opened.code, retryable: true })
      if (opened.resync) {
        attempt = 0
        await wait(backoffFor(0))
        continue
      }
      await wait(backoffFor(attempt++))
    }
  }

  /**
   * 建立会话：版本协商 → 首帧快照 → 打开事件流。
   * 结果可判定：`{ok:true, protocol, sessionId, lastCursor}` 或 `{ok:false, code, fatal|retryable}`。
   * 首连失败但可重试时仍会启动后台重连（设计上母体不放弃分身，只等在 onDisconnect 里上报）。
   */
  async function connect() {
    stopped = false
    mode = 'negotiating'
    const versionRes = await remote.version()
    if (!versionRes.ok) {
      const fatal = Number(versionRes.status) === 401
      mode = fatal ? 'failed' : 'reconnecting'
      lastError = versionRes.error ?? versionRes.kind ?? 'version-failed'
      emit('disconnect', { reason: lastError, fatal })
      return { ok: false, code: lastError, status: versionRes.status ?? 0, fatal }
    }

    const negotiated = negotiateProtocol(versionRes.data?.protocol, limits)
    if (!negotiated.ok) {
      mode = 'failed'
      lastError = negotiated.reason
      emit('disconnect', { reason: negotiated.reason, fatal: true })
      return { ok: false, code: negotiated.reason, protocol: versionRes.data?.protocol }
    }
    protocol = negotiated.protocol
    protocolRange = { min: negotiated.min, max: negotiated.max }
    lastVersionInfo = versionRes.data && typeof versionRes.data === 'object' ? versionRes.data : { protocol: versionRes.data ?? null }
    sessionId = String(versionRes.data?.sessionId ?? '')

    const snapshot = await remote.state()
    if (!snapshot.ok) {
      const fatal = Number(snapshot.status) === 401
      mode = fatal ? 'failed' : 'reconnecting'
      lastError = snapshot.error ?? snapshot.kind ?? 'state-failed'
      emit('disconnect', { reason: lastError, fatal })
      return { ok: false, code: lastError, status: snapshot.status ?? 0, fatal }
    }
    lastState = snapshot.data ?? null
    if (lastState?.sessionId) sessionId = String(lastState.sessionId)
    if (lastState?.lastCursor !== undefined) lastCursor = String(lastState.lastCursor)
    // 一致性诊断：version 与 state 之间 Adapter 若重启，sessionId 会变化。
    // 此时 state 是最新真相，继续用 state.sessionId 连接；只记录差异供排障（不重试三步）。
    const versionSession = String(lastVersionInfo?.sessionId ?? '')
    const stateSession = String(lastState?.sessionId ?? '')
    sessionMismatch = versionSession && stateSession && versionSession !== stateSession
      ? { versionSession, stateSession, at: Date.now() }
      : null
    emit('state', lastState)

    const opened = await openOnce()
    if (stopped) return { ok: false, code: 'stopped' }
    if (!opened.ok) {
      if (opened.fatal) {
        mode = 'failed'
        lastError = opened.code
        emit('disconnect', { reason: opened.code, fatal: true })
        return { ok: false, code: opened.code, fatal: true }
      }
      mode = 'reconnecting'
      if (autoReconnect) void reconnectLoop()
      return { ok: false, code: opened.code, retryable: true, sessionId, lastCursor }
    }

    mode = 'streaming'
    pumpPromise = pump(opened.res).then((result) => {
      if (stopped) return result
      mode = autoReconnect ? 'reconnecting' : 'idle'
      emit('disconnect', { reason: result.code ?? 'stream-closed' })
      if (autoReconnect) void reconnectLoop()
      return result
    })
    return { ok: true, protocol, sessionId, state: lastState, lastCursor, version: lastVersionInfo, sessionMismatch }
  }

  /** 停止事件流（幂等）。未到期的退避计时器会被立即唤醒，让重连循环看到 stopped 退出。 */
  function stop() {
    stopped = true
    try {
      controller?.abort()
    } catch {
      /* 老运行时没有 abort 也不影响逻辑 */
    }
    controller = null
    for (const [timer, resolve] of pendingWaits) {
      clearTimeout(timer)
      resolve()
    }
    pendingWaits.clear()
    mode = 'idle'
  }

  /**
   * 幂等命令：生成 commandId，网络/超时失败时用**同一个** commandId 重试一次。
   * 服务端命中 CommandCache 会返回 `deduplicated:true`，不会重复执行副作用。
   */
  async function command(op, payload = {}, { commandId = newCommandId(), async: isAsync = false, retries = 1 } = {}) {
    const envelope = { commandId, op: String(op ?? ''), payload: payload ?? {} }
    if (isAsync) envelope.async = true
    let result = await remote.commands(envelope)
    let attempt = 0
    while (!result.ok && attempt < retries && (result.kind === 'network' || result.kind === 'timeout')) {
      await wait(backoffFor(attempt++))
      result = await remote.commands(envelope)
    }
    return result
  }

  return {
    ...remote,
    connect,
    stop,
    command,
    onEvent: on('event'),
    onState: on('state'),
    onReconnect: on('reconnect'),
    onDisconnect: on('disconnect'),
    get mode() {
      return mode
    },
    get protocol() {
      return protocol
    },
    get sessionId() {
      return sessionId
    },
    get lastCursor() {
      return lastCursor
    },
    get lastState() {
      return lastState
    },
    /** 最近一次 /adapter/version 的原始响应（protocol / version / sessionId…），供诊断。 */
    get lastVersionInfo() {
      return lastVersionInfo
    },
    /** version 与 state 的 sessionId 不一致时记录（Adapter 在两次请求之间重启过）。 */
    get sessionMismatch() {
      return sessionMismatch
    },
    /** 本客户端实际用于协商的协议区间（min/max），供诊断与上层审计。 */
    get protocolRange() {
      return { ...protocolRange }
    },
    get lastError() {
      return lastError
    },
    get streaming() {
      return mode === 'streaming'
    },
    /** 等待首帧事件流结束（测试/编排器优雅停止时用）。 */
    get pumpDone() {
      return pumpPromise ?? Promise.resolve(null)
    },
  }
}

export const _internals = { positiveMs }
