// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared retry helper for release-time network calls. GitHub Actions runners
// see intermittent ENOTFOUND / ECONNRESET / TLS resets; a failed asset upload
// must not force a manual workflow re-run.
import crypto from 'node:crypto'

export const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

export class HttpError extends Error {
  constructor(message, { status = 0, body = null, retryAfterMs = 0 } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.retryAfterMs = retryAfterMs
  }
}

export function isTransientStatus(status) {
  return TRANSIENT_STATUS.has(Number(status))
}

export function isTransientError(error) {
  if (!error) return false
  if (isTransientStatus(error.status)) return true
  if (error.retryable === true) return true
  const code = String(error.code ?? error.cause?.code ?? '')
  if (TRANSIENT_CODES.has(code)) return true
  const message = String(error.message ?? error.cause?.message ?? error)
  return /fetch failed|network|socket hang up|other side closed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|TLS|secure connection/i.test(message)
}

export function retryAfterMsFrom(headers) {
  if (!headers || typeof headers.get !== 'function') return 0
  const raw = headers.get('retry-after')
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
}

/**
 * Retry a whole request operation. The operation may throw HttpError or a
 * native fetch error; only transient failures are retried.
 */
export async function retryOperation(operation, {
  attempts = 6,
  baseMs = 1000,
  capMs = 15000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  random = Math.random,
} = {}) {
  const max = Math.max(1, Number(attempts) || 6)
  let lastError = null
  for (let i = 0; i < max; i += 1) {
    try {
      return await operation(i + 1)
    } catch (error) {
      lastError = error
      if (!isTransientError(error) || i === max - 1) throw error
      const retryAfter = Number(error?.retryAfterMs) || 0
      const exp = Math.min(capMs, baseMs * 2 ** i)
      const jitter = Math.round(exp * 0.1 * random())
      const delay = Math.max(retryAfter, exp + jitter)
      log(`第 ${i + 1}/${max} 次网络失败（${error?.message ?? error}），${Math.round(delay / 1000)}s 后重试`)
      await sleep(delay)
    }
  }
  throw lastError
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
