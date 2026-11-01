// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// bridge-client — talk to a running PC host's `@ignotuss/dsh-desktop-bridge`.
//
// The bridge is transport only: 127.0.0.1 + bearer token from
// `<DSH_HOME>/desktop-bridge.json`. The descriptor is re-read on every call because
// the port and token are regenerated each time the PC host mounts the plugin.
// This client never writes to the PC host and never logs the token.

import fs from 'node:fs'
import path from 'node:path'

export const BRIDGE_DESCRIPTOR_FILE = 'desktop-bridge.json'
export const BRIDGE_DEFAULT_TIMEOUT_MS = 15000

export const BRIDGE_CODE = Object.freeze({
  UNAVAILABLE: 'bridge-unavailable',
  INVALID: 'bridge-descriptor-invalid',
  HTTP: 'bridge-http',
  NETWORK: 'bridge-network',
  TIMEOUT: 'bridge-timeout',
  INVALID_INPUT: 'bridge-invalid-input',
})

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function defaultDshHome() {
  return String(process.env.DSH_HOME ?? '').trim() || path.join(String(process.env.USERPROFILE ?? '').trim() || '.', '.dsh')
}

export function descriptorPath(dshHome) {
  return path.join(String(dshHome ?? '').trim() || defaultDshHome(), BRIDGE_DESCRIPTOR_FILE)
}

/**
 * Read + validate the descriptor. Fail-closed: a malformed or non-loopback
 * descriptor is an error, never a partial client.
 * @returns {{ok:true, info:{version:number,address:string,port:number,token:string,pid?:number}, file:string} | {ok:false, code:string, error:string, file:string}}
 */
export function readBridgeDescriptor(options = {}) {
  const file = options.file ?? descriptorPath(options.dshHome)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { ok: false, code: BRIDGE_CODE.UNAVAILABLE, error: `desktop-bridge.json not readable (${e?.code ?? 'ENOENT'})`, file }
  }
  let info
  try { info = JSON.parse(raw) } catch { return { ok: false, code: BRIDGE_CODE.INVALID, error: 'desktop-bridge.json is not JSON', file } }
  if (!info || typeof info !== 'object') return { ok: false, code: BRIDGE_CODE.INVALID, error: 'descriptor is not an object', file }
  if (info.version !== 1) return { ok: false, code: BRIDGE_CODE.INVALID, error: `unsupported descriptor version ${String(info.version)}`, file }
  if (!LOOPBACK.has(String(info.address ?? ''))) return { ok: false, code: BRIDGE_CODE.INVALID, error: 'bridge address is not loopback', file }
  const port = Number(info.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: BRIDGE_CODE.INVALID, error: 'invalid bridge port', file }
  const token = typeof info.token === 'string' ? info.token.trim() : ''
  if (!/^[0-9a-f]{32,}$/i.test(token)) return { ok: false, code: BRIDGE_CODE.INVALID, error: 'invalid bridge token', file }
  return { ok: true, file, info: { version: 1, address: String(info.address), port, token, pid: info.pid, startedAt: info.startedAt } }
}

function cleanError(e) {
  const code = e?.name === 'AbortError' ? BRIDGE_CODE.TIMEOUT : BRIDGE_CODE.NETWORK
  return { ok: false, code, error: code === BRIDGE_CODE.TIMEOUT ? 'bridge request timed out' : 'bridge request failed' }
}

/**
 * Create a client bound to a DSH home. Every method reloads the descriptor.
 * @returns {{status:Function, listSessions:Function, events:Function, send:Function, create:Function}}
 */
export function createBridgeClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || BRIDGE_DEFAULT_TIMEOUT_MS)

  async function call(method, pathname, body) {
    const desc = readBridgeDescriptor({ file: options.file, dshHome: options.dshHome })
    if (!desc.ok) return desc
    const url = `http://${desc.info.address}:${desc.info.port}${pathname}`
    let res
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${desc.info.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      return cleanError(e)
    }
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) {
      return { ok: false, code: BRIDGE_CODE.HTTP, status: res.status, error: String(data?.error ?? `HTTP ${res.status}`).slice(0, 300) }
    }
    return { ok: true, status: res.status, data, pid: desc.info.pid, startedAt: desc.info.startedAt }
  }

  return {
    async status() {
      const desc = readBridgeDescriptor({ file: options.file, dshHome: options.dshHome })
      if (!desc.ok) return desc
      return { ok: true, available: true, pid: desc.info.pid, startedAt: desc.info.startedAt, file: desc.file }
    },
    async listSessions() {
      const out = await call('GET', '/v1/sessions')
      if (!out.ok) return out
      return { ok: true, items: Array.isArray(out.data?.items) ? out.data.items : [] }
    },
    async events(sessionId, opts = {}) {
      const id = String(sessionId ?? '').trim()
      if (!id) return { ok: false, code: BRIDGE_CODE.INVALID_INPUT, error: 'sessionId required' }
      const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30))
      const out = await call('GET', `/v1/sessions/${encodeURIComponent(id)}/events?limit=${limit}`)
      if (!out.ok) return out
      return { ok: true, sessionId: id, events: Array.isArray(out.data?.events) ? out.data.events : [] }
    },
    async send(sessionId, text) {
      const id = String(sessionId ?? '').trim()
      const body = String(text ?? '')
      if (!id) return { ok: false, code: BRIDGE_CODE.INVALID_INPUT, error: 'sessionId required' }
      if (!body.trim() || Buffer.byteLength(body, 'utf8') > 4096) return { ok: false, code: BRIDGE_CODE.INVALID_INPUT, error: 'text must be 1-4096 bytes' }
      const out = await call('POST', `/v1/sessions/${encodeURIComponent(id)}/messages`, { text: body })
      if (!out.ok) return out
      return { ok: true, accepted: out.data?.accepted === true, requestId: out.data?.requestId ?? null }
    },
    async create(input = {}) {
      const cwd = String(input.cwd ?? '').trim()
      if (!cwd) return { ok: false, code: BRIDGE_CODE.INVALID_INPUT, error: 'cwd required' }
      const out = await call('POST', '/v1/sessions', { cwd, ...(input.title ? { title: String(input.title) } : {}) })
      if (!out.ok) return out
      return { ok: true, session: out.data }
    },
  }
}
