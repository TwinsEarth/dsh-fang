// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.0.0 — 母体侧 Remote 客户端（契约：docs/CONTRACTS-V2.md §5.2、PROTOCOL-V2.md §4）。
//
// 母体与分身是两个独立 DSH 进程，控制面只能走分身自己的 HTTP 服务。本模块把
// 「URL + token + fetch」封成一次函数调用，统一返回 `{ok,status,data|error,kind}`：
//
//   const remote = createRemote({ url, token, timeoutMs: 8000 })
//   const hello = await remote.hello()               // {ok:true, status:200, data:{...}}
//   const read  = await remote.command('read-plugin', { pluginId: 'plug' })
//
// 硬约束：
//   * 纯模块：零 `node:*` 依赖，只用 Web 标准（URL/AbortController/encodeURIComponent）；
//   * 可注入 `fetchImpl`，测试不需要真实 socket；
//   * **永不抛出**：网络错误/超时/非 JSON/非 2xx 全部降级成返回对象；
//   * 超时用 AbortController；`token` 以查询参数形式幂等拼进每个请求。
import { ADAPTER_OP, ADAPTER_ROUTE } from '../kernel/types.mjs'

/** 失败分类词汇（与 CONTRACTS-V2 §5.2 的 kind 一一对应）。 */
export const REMOTE_FAILURE_KIND = Object.freeze({
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  HTTP: 'http',
  JSON: 'json',
  UNKNOWN: 'unknown',
})

const FAILURE_KINDS = new Set(Object.values(REMOTE_FAILURE_KIND))

const msgOf = (e) => String(e && e.message !== undefined ? e.message : e)

/** 把 "a b/c" 之类的 token 编码进查询串；任何非字符串都按空串处理。 */
function encodeToken(token) {
  try {
    return encodeURIComponent(String(token))
  } catch {
    return ''
  }
}

/**
 * 幂等地拼接/替换 `url` 的 `token` 查询参数（契约 §5.2）。
 * - 已有 token 参数 → 原地替换（不会出现两个 token）；
 * - 没有 → 追加到查询串末尾；`#hash` 永远保留在最后；
 * - token 为空/省略 → 原样返回（调用方没给 token 时不改动 URL）。
 * @param {string} url
 * @param {string} [token]
 * @returns {string}
 */
export function withToken(url, token) {
  const base = String(url ?? '')
  if (token === undefined || token === null || token === '') return base

  const encoded = encodeToken(token)
  if (!encoded) return base

  const hashAt = base.indexOf('#')
  const beforeHash = hashAt < 0 ? base : base.slice(0, hashAt)
  const hash = hashAt < 0 ? '' : base.slice(hashAt)

  const queryAt = beforeHash.indexOf('?')
  const pathPart = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt)
  const query = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1)

  const out = []
  let replaced = false
  for (const pair of query === '' ? [] : query.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    if (key === 'token') {
      if (!replaced) {
        out.push(`token=${encoded}`)
        replaced = true
      }
      continue
    }
    out.push(pair)
  }
  if (!replaced) out.push(`token=${encoded}`)
  return `${pathPart}?${out.join('&')}${hash}`
}

/**
 * 取出 URL 里的 token 查询参数（已 decode）。没有/非法时返回 ''。
 * @param {string} url
 * @returns {string}
 */
export function extractToken(url) {
  const s = String(url ?? '')
  const queryAt = s.indexOf('?')
  if (queryAt < 0) return ''
  const hashAt = s.indexOf('#', queryAt)
  const query = s.slice(queryAt + 1, hashAt < 0 ? undefined : hashAt)
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    if (key !== 'token') continue
    const raw = eq < 0 ? '' : pair.slice(eq + 1)
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return ''
}

/** '/fang/'、'fang' → '/fang'；空值兜底 '/fang'。 */
export function normalizePrefix(prefix) {
  const raw = String(prefix ?? '/fang').trim().replace(/\\/g, '/')
  if (!raw) return '/fang'
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return trimmed || '/fang'
}

/** 把端点路径拼到 base URL 上（丢弃 base 原本的 query/hash，token 由请求阶段重新拼）。 */
export function joinUrl(base, pathname, prefix = '/fang') {
  const s = String(base ?? '').trim()
  const hashAt = s.indexOf('#')
  let clean = hashAt < 0 ? s : s.slice(0, hashAt)
  const queryAt = clean.indexOf('?')
  if (queryAt >= 0) clean = clean.slice(0, queryAt)
  const root = clean.replace(/\/+$/, '')
  const p = normalizePrefix(prefix)
  const tail = String(pathname ?? '')
  return `${root}${p}${tail.startsWith('/') ? tail : `/${tail}`}`
}

/** 给 URL 追加查询参数（token 之外），idempotent 不重要——每次请求只拼一次。 */
function withQuery(url, query) {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!entries.length) return url
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`
}

function failure(status, error, kind, extra = null) {
  const out = { ok: false, status: Number(status) || 0, error: String(error ?? 'remote-failed'), kind }
  if (extra && typeof extra === 'object') out.data = extra
  return out
}

/** 错误 → {kind, message}；只做分类，不抛。 */
export function classifyRemoteFailure(err) {
  const message = msgOf(err)
  const explicit = err && typeof err.kind === 'string' ? err.kind : ''
  if (FAILURE_KINDS.has(explicit)) return { kind: explicit, message }

  const name = String(err?.name ?? '')
  const code = String(err?.code ?? '')
  const status = err?.status ?? err?.statusCode

  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT') {
    return { kind: REMOTE_FAILURE_KIND.TIMEOUT, message: message || 'timeout' }
  }
  if (/abort|timed?\s*out|timeout/i.test(message)) {
    return { kind: REMOTE_FAILURE_KIND.TIMEOUT, message: message || 'timeout' }
  }
  if (name === 'SyntaxError' || code === 'JSON_PARSE' || /\bJSON\b|unexpected token/i.test(message)) {
    return { kind: REMOTE_FAILURE_KIND.JSON, message: message || 'invalid json' }
  }
  if (typeof status === 'number' && Number.isFinite(status)) {
    return { kind: REMOTE_FAILURE_KIND.HTTP, message: message || `http-${status}` }
  }
  if (name === 'TypeError' || /fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|UND_ERR/i.test(message)) {
    return { kind: REMOTE_FAILURE_KIND.NETWORK, message: message || 'network-failure' }
  }
  return { kind: REMOTE_FAILURE_KIND.UNKNOWN, message: message || 'unknown-failure' }
}

/** 读响应体：优先 text()（真实 Response 只能读一次），退化到 json()；都不行返回 null。 */
async function readResponseBody(res) {
  if (!res || typeof res !== 'object') return { text: null }
  if (typeof res.text === 'function') {
    try {
      return { text: String(await res.text()) }
    } catch {
      /* 继续尝试 json() */
    }
  }
  if (typeof res.json === 'function') {
    try {
      return { value: await res.json() }
    } catch (e) {
      return { parseError: e }
    }
  }
  return { text: null }
}

function responseIsOk(res, status) {
  if (typeof res?.ok === 'boolean') return res.ok
  return status >= 200 && status < 300
}

function errorFromBody(data, status) {
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error) return data.error
    if (typeof data.code === 'string' && data.code) return data.code
  }
  return `http-${status}`
}

/**
 * 创建一个指向某个分身 Adapter 的远端客户端（契约 §5.2）。
 *
 * @param {object} [options]
 * @param {string} [options.url]      分身 web URL（通常来自 `parseWebUrl()`，可自带 `?token=`）
 * @param {string} [options.token]    token；省略时从 `url` 中提取
 * @param {string} [options.adapterToken] v3 Bearer token（Forker spawn 时注入；不落 URL）
 * @param {Function} [options.fetchImpl=globalThis.fetch] 可注入的 fetch（测试用）
 * @param {number} [options.timeoutMs=5000] 单次请求超时
 * @param {string} [options.prefix='/fang'] 路由前缀（与 Adapter Config.prefix 一致）
 */
export function createRemote({
  url,
  token,
  adapterToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  prefix = '/fang',
} = {}) {
  const targetUrl = String(url ?? '')
  const effectiveToken = token === undefined || token === null ? extractToken(targetUrl) : String(token)
  const effectiveAdapterToken = adapterToken === undefined || adapterToken === null ? '' : String(adapterToken)
  const requestTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : 5000
  const routePrefix = normalizePrefix(prefix)
  const impl = typeof fetchImpl === 'function' ? fetchImpl : null

  /** v3 Bearer 头；没有 token 时不发头（v2 兼容模式）。 */
  const authHeaders = () => (effectiveAdapterToken ? { authorization: `Bearer ${effectiveAdapterToken}` } : {})

  /**
   * 发出一次请求并归一化返回；任何情况下都 resolve，不 reject。
   * @returns {Promise<{ok:boolean,status:number,data?:any,error?:string,kind?:string}>}
   */
  async function request(method, pathname, { query = null, body = undefined } = {}) {
    if (!impl) return failure(0, 'no-fetch', REMOTE_FAILURE_KIND.NETWORK)

    // v3.0.5/B4：token 只走 Authorization header，绝不再拼进 URL（防日志/历史/Referer 泄漏）。
    const target = withQuery(joinUrl(targetUrl, pathname, routePrefix), query)

    const controller = new AbortController()
    let timer = null
    try {
      if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            controller.abort()
          } catch {
            /* 老运行时没有 AbortController.abort 也不影响分类 */
          }
        }, requestTimeoutMs)
      }

      const init = { method, signal: controller.signal }
      const headers = authHeaders()
      if (body !== undefined) {
        init.headers = { ...headers, 'content-type': 'application/json; charset=utf-8' }
        try {
          init.body = JSON.stringify(body)
        } catch (e) {
          return failure(0, `serialize-failed: ${msgOf(e)}`, REMOTE_FAILURE_KIND.UNKNOWN)
        }
      } else if (Object.keys(headers).length > 0) {
        init.headers = headers
      }

      let res
      try {
        res = await impl(target, init)
      } catch (e) {
        const classified = classifyRemoteFailure(e)
        return failure(0, classified.message, classified.kind)
      }

      const status = Number(res?.status)
      const okFlag = responseIsOk(res, status)
      const { text, value, parseError } = await readResponseBody(res)
      let data = null
      let parseOk = true
      if (value !== undefined) {
        data = value
      } else if (parseError !== undefined) {
        parseOk = false
      } else if (text !== null) {
        if (String(text).trim() === '') data = null
        else {
          try {
            data = JSON.parse(text)
          } catch {
            parseOk = false
          }
        }
      }

      if (!okFlag) {
        // HTTP 失败优先按 http 归类（body 是否 JSON 不影响语义），但把可读 body 带上便于诊断。
        return failure(status, errorFromBody(data, status), REMOTE_FAILURE_KIND.HTTP, data)
      }
      if (!parseOk) return failure(status, 'invalid-json', REMOTE_FAILURE_KIND.JSON)
      return { ok: true, status, data }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  const remote = {
    url: targetUrl,
    token: effectiveToken,
    prefix: routePrefix,
    /** v3 Bearer token（母体内存持有；为空 = v2 兼容模式）。 */
    adapterToken: effectiveAdapterToken,

    /** 握手：GET /fang/adapter/hello → {ok, status, data:{ok,role,taskId,version,capabilities}} */
    hello() {
      return request('GET', ADAPTER_ROUTE.HELLO)
    },

    /** 分身内服务表/缓冲区/待审批/审计头：GET /fang/adapter/status */
    status() {
      return request('GET', ADAPTER_ROUTE.STATUS)
    },

    /** 分身本地待审批项：GET /fang/adapter/approvals */
    approvals() {
      return request('GET', ADAPTER_ROUTE.APPROVALS)
    },

    /** 分身审计尾部：GET /fang/adapter/audit?limit=n（默认 100） */
    audit({ limit } = {}) {
      const raw = Number(limit)
      const n = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 100
      return request('GET', ADAPTER_ROUTE.AUDIT, { query: { limit: n } })
    },

    /** 控制命令：POST /fang/adapter/command {op, payload} */
    command(op, payload = {}) {
      const body = op !== null && typeof op === 'object'
        ? { op: String(op.op ?? ''), payload: op.payload ?? {} }
        : { op: String(op ?? ''), payload: payload ?? {} }
      return request('POST', ADAPTER_ROUTE.COMMAND, { body })
    },

    /** 控制面心跳：等价于 command('ping')，返回 {ok,status,data:{ok,op,result:{pong:true}}} */
    ping() {
      return request('POST', ADAPTER_ROUTE.COMMAND, { body: { op: ADAPTER_OP.PING, payload: {} } })
    },

    // ── v3（PROTOCOL-V3 §4）：协议协商 / 健康 / 快照 / 幂等命令 ──────────────

    /** 协议版本协商：GET /fang/adapter/version */
    version() {
      return request('GET', ADAPTER_ROUTE.VERSION)
    },

    /** 轻量健康检查：GET /fang/adapter/health */
    health() {
      return request('GET', ADAPTER_ROUTE.HEALTH)
    },

    /** 完整状态快照：GET /fang/adapter/state */
    state() {
      return request('GET', ADAPTER_ROUTE.STATE)
    },

    /**
     * 幂等命令：POST /fang/adapter/commands
     * @param {{commandId?:string, op?:string, payload?:object, async?:boolean}} envelope
     */
    commands(envelope = {}) {
      const body = envelope && typeof envelope === 'object' ? { ...envelope } : {}
      return request('POST', ADAPTER_ROUTE.COMMANDS, { body })
    },

    /**
     * 拼出 SSE 订阅 URL（含 DSH ?token= 与 since/session 查询参数）。
     * 实际流读取在 `adapter-client.mjs`；这里只保证 URL 规则与其它请求一致。
     */
    eventsUrl({ since = '0', session = '' } = {}) {
      const base = withToken(joinUrl(targetUrl, ADAPTER_ROUTE.EVENTS, routePrefix), effectiveToken)
      const query = []
      if (since !== undefined && since !== null && since !== '') query.push(`since=${encodeURIComponent(String(since))}`)
      if (session) query.push(`session=${encodeURIComponent(String(session))}`)
      return query.length > 0 ? `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}` : base
    },

    /** v3 Bearer 头（adapter-client 建 SSE 连接时复用）。 */
    authHeaders,
  }

  return remote
}

export const _internals = {
  joinUrl,
  withQuery,
  normalizePrefix,
  readResponseBody,
  responseIsOk,
  errorFromBody,
  requestTimeoutMs: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 5000),
}
