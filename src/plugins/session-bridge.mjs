// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-session-bridge — mother-side façade over a running PC host's loopback bridge.
// Transport only: it never copies session files and never writes to the PC host.
import { z, roleGate, resolveFangLayout, SERVICE, FANG_VERSION } from '../kernel/index.mjs'
import { createHttpGuard } from '../lib/http-auth.mjs'
import { createBridgeClient, readBridgeDescriptor } from '../lib/bridge-client.mjs'

export const name = 'fang-session-bridge'
export const inject = []

export const Config = z.object({
  dshHome: z.string().default('')
    .description('PC 宿主的 DSH_HOME（读取 desktop-bridge.json）；留空 = 本机 $DSH_HOME'),
  prefix: z.string().default('/fang')
    .description('HTTP 路由前缀'),
  timeoutMs: z.number().min(1000).max(120000).default(15000)
    .description('每次桥接请求的超时（毫秒）'),
  routes: z.object({ enabled: z.boolean().default(true) }).default({}),
  authToken: z.string().default('')
    .description('安装级鉴权 token；留空 = env DSH_FANG_AUTH_TOKEN 或 <dataDir>/fang-auth.json（0600，自动生成）'),
  authEnabled: z.boolean().default(true)
    .description('是否要求 /fang/api/bridge/* 携带安装级鉴权 token（默认开启；仅测试/本地调试可关）'),
})

export function apply(ctx, config) {
  const gate = roleGate('sessionBridge', { logger: ctx.logger })
  if (!gate.active) return

  const cfg = { ...Config({}), ...(config ?? {}) }
  const client = createBridgeClient({ dshHome: cfg.dshHome, timeoutMs: cfg.timeoutMs })
  const prefix = String(cfg.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'
  const authGuard = createHttpGuard({
    dataDir: resolveFangLayout().dataDir,
    token: cfg.authToken,
    enabled: cfg.authEnabled !== false,
  })

  const audit = (kind, data) => {
    try {
      const auditor = ctx.get(SERVICE.auditor)
      if (auditor && typeof auditor.append === 'function') auditor.append(kind, data)
    } catch { /* 审计失败不阻塞桥接 */ }
  }

  const service = {
    role: gate.role,
    version: FANG_VERSION,
    descriptor: () => {
      const desc = readBridgeDescriptor({ dshHome: cfg.dshHome })
      return desc.ok
        ? { ok: true, file: desc.file, pid: desc.info.pid, startedAt: desc.info.startedAt }
        : { ok: false, code: desc.code, error: desc.error, file: desc.file }
    },
    async status() { return client.status() },
    async listSessions() {
      const out = await client.listSessions()
      audit('bridge-list', { ok: out.ok, count: out.ok ? out.items.length : 0, code: out.code ?? null })
      return out
    },
    async events(sessionId, options = {}) {
      const out = await client.events(sessionId, options)
      audit('bridge-events', { ok: out.ok, sessionId, count: out.ok ? out.events.length : 0, code: out.code ?? null })
      return out
    },
    async send(sessionId, text) {
      const out = await client.send(sessionId, text)
      audit('bridge-send', { ok: out.ok, sessionId, accepted: out.ok ? out.accepted : false, requestId: out.ok ? out.requestId : null, code: out.code ?? null })
      return out
    },
    async create(input = {}) {
      const out = await client.create(input)
      audit('bridge-create', { ok: out.ok, code: out.code ?? null, sessionId: out.ok ? out.session?.id ?? out.session?.sessionId ?? null : null })
      return out
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.sessionBridge, service))

  if (cfg.routes?.enabled === false) return
  ctx.inject(['webServer'], (child) => {
    let webServer = null
    try { webServer = child?.get?.('webServer') ?? child?.webServer ?? null } catch { webServer = null }
    if (!webServer || typeof webServer.register !== 'function') return
    const json = (res, status, value) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(value))
    }
    const queryOf = (req) => new URL(String(req?.url ?? '/'), 'http://fang.local').searchParams
    const readBody = async (req) => {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return {}
      try { return JSON.parse(text) } catch { return { __parseError: true } }
    }
    const route = (method, routePath, handler) => {
      webServer.register({
        kind: 'exact',
        path: routePath,
        method,
        handler: async (req, res) => {
          try {
            const decision = authGuard.check(req)
            if (!decision.ok) return json(res, decision.status, { ok: false, error: decision.code, code: decision.code })
            if (String(req?.method ?? 'GET').toUpperCase() !== method) {
              try { res.setHeader?.('allow', method) } catch { /* fake res */ }
              return json(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
            }
            return await handler(req, res)
          } catch (e) {
            return json(res, 500, { ok: false, error: String(e?.message ?? e), code: 'handler-threw' })
          }
        },
      })
    }

    // DSH exact routes are keyed by path only: GET+POST share one registration.
    const routeMethods = (routePath, handlers) => {
      webServer.register({
        kind: 'exact',
        path: routePath,
        method: Object.keys(handlers).join(','),
        handler: async (req, res) => {
          try {
            const decision = authGuard.check(req)
            if (!decision.ok) return json(res, decision.status, { ok: false, error: decision.code, code: decision.code })
            const allow = Object.keys(handlers)
            const fn = handlers[String(req?.method ?? 'GET').toUpperCase()]
            if (typeof fn !== 'function') {
              try { res.setHeader?.('allow', allow.join(', ')) } catch { /* fake res */ }
              return json(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
            }
            return await fn(req, res)
          } catch (e) {
            return json(res, 500, { ok: false, error: String(e?.message ?? e), code: 'handler-threw' })
          }
        },
      })
    }

    route('GET', `${prefix}/api/bridge/status`, (req, res) => json(res, 200, service.descriptor()))
    routeMethods(`${prefix}/api/bridge/sessions`, {
      GET: async (req, res) => json(res, 200, await service.listSessions()),
      POST: async (req, res) => {
        const body = await readBody(req)
        if (body.__parseError) return json(res, 400, { ok: false, error: 'bad-json' })
        const out = await service.create({ cwd: body.cwd, title: body.title })
        json(res, out.ok ? 201 : 400, out)
      },
    })
    route('GET', `${prefix}/api/bridge/sessions/events`, async (req, res) => {
      const q = queryOf(req)
      const out = await service.events(q.get('sessionId') ?? '', { limit: q.get('limit') })
      json(res, out.ok ? 200 : 404, out)
    })
    route('POST', `${prefix}/api/bridge/sessions/prompt`, async (req, res) => {
      const body = await readBody(req)
      if (body.__parseError) return json(res, 400, { ok: false, error: 'bad-json' })
      const out = await service.send(body.sessionId, body.text)
      json(res, out.ok ? 200 : 400, out)
    })

  })
}
