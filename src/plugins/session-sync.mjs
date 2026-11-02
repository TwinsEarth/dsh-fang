// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-session-sync — selected-session export/import (file-level sync mode).
// Export is read-only on the source; import never overwrites (keep-both + fork).
import path from 'node:path'
import {
  z, roleGate, resolveDshHome, resolveFangLayout, SERVICE, FANG_VERSION, ensureDir, readJson, exists,
} from '../kernel/index.mjs'
import { exportSessions, importSessions } from '../lib/session-bundle.mjs'
import { encodeWorkspaceKey } from '../lib/session-format.mjs'

export const name = 'fang-session-sync'
export const inject = []

export const Config = z.object({
  sessionsRoot: z.string().default('')
    .description('源会话目录（PC）；留空 = <DSH_HOME>/sessions'),
  storagesRoot: z.string().default('')
    .description('workspace.json 所在目录（源）；留空 = <DSH_HOME>/storages'),
  bundleRoot: z.string().default('')
    .description('交接 bundle 根；留空 = <fang dataDir>/sync-bundles'),
  prefix: z.string().default('/fang'),
  maxBundleBytes: z.number().min(0).max(4 * 1024 * 1024 * 1024).default(512 * 1024 * 1024)
    .description('单个 bundle 的大小上限（字节）；超过则拒绝导出'),
  routes: z.object({ enabled: z.boolean().default(true) }).default({}),
})

export function apply(ctx, config) {
  const gate = roleGate('sessionSync', { logger: ctx.logger })
  if (!gate.active) return
  const cfg = { ...Config({}), ...(config ?? {}) }
  const layout = resolveFangLayout()
  const sessionsRoot = cfg.sessionsRoot ? path.resolve(cfg.sessionsRoot) : path.join(resolveDshHome(), 'sessions')
  const storagesRoot = cfg.storagesRoot ? path.resolve(cfg.storagesRoot) : path.join(resolveDshHome(), 'storages')
  const bundleRoot = cfg.bundleRoot ? path.resolve(cfg.bundleRoot) : path.join(layout.dataDir, 'sync-bundles')
  const prefix = String(cfg.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'

  const workspacesOf = (homeDir) => {
    const file = path.join(homeDir, 'storages', 'workspace.json')
    if (!exists(file)) return []
    try {
      const doc = readJson(file)
      const table = doc?.tables?.workspaces
      if (!table || typeof table !== 'object') return []
      return Object.entries(table).map(([id, ws]) => ({ id, path: ws?.path, title: ws?.title })).filter((w) => typeof w.path === 'string')
    } catch { return [] }
  }

  const service = {
    role: gate.role,
    version: FANG_VERSION,
    sessionsRoot,
    storagesRoot,
    bundleRoot,
    status() {
      return { ok: true, role: gate.role, sessionsRoot, bundleRoot, exists: exists(sessionsRoot) }
    },
    /** PC 侧：把勾选会话只读地导出到 staging bundle。 */
    exportSelected(input = {}) {
      const workspaces = workspacesOf(storagesRoot)
      const requestedBundleId = input.bundleId === undefined ? `sync-${Date.now()}` : String(input.bundleId)
      // v3.0.5/B3：bundleId 只允许安全段（防 `../` 写出 bundleRoot）
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestedBundleId) || requestedBundleId === '.' || requestedBundleId === '..') {
        return { ok: false, code: 'invalid-bundle-id' }
      }
      const out = exportSessions({
        sessionsRoot,
        bundleDir: path.join(bundleRoot, requestedBundleId),
        sessionIds: input.sessionIds,
        workspaces,
      })
      if (out.ok && cfg.maxBundleBytes > 0 && out.bytes > cfg.maxBundleBytes) {
        return { ok: false, code: 'bundle-too-large', bytes: out.bytes, limit: cfg.maxBundleBytes }
      }
      return out
    },
    /** Web 侧：把 bundle 导入目标 sessionsRoot；workospace 由目标 workspace.json 决定。 */
    importInto(input = {}) {
      const bundleDir = path.resolve(String(input.bundleDir ?? ''))
      const targetHome = path.resolve(String(input.targetHome ?? ''))
      // v3.0.5/B3：bundle 必须位于 bundleRoot 内；目标 home 只允许当前 DSH_HOME 或 fork homes 根
      const inside = (base, target) => {
        const rel = path.relative(base, target)
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
      }
      if (!inside(bundleRoot, bundleDir)) return { ok: false, code: 'bundle-outside-root' }
      const allowedHomes = [resolveDshHome(), layout.forkHomesDir].filter((p) => typeof p === 'string' && p.length > 0)
      if (!allowedHomes.some((base) => inside(base, targetHome))) return { ok: false, code: 'target-outside-allowed' }
      const targetSessions = path.join(targetHome, 'sessions')
      ensureDir(targetSessions)
      const workspaces = workspacesOf(path.join(targetHome, 'storages'))
      const out = importSessions({
        bundleDir,
        targetSessionsRoot: targetSessions,
        workspaces,
        encodeWorkspaceKey,
      })
      return { ...out, targetHome, targetSessionsRoot: targetSessions }
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.sessionSync, service))

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
    const readBody = async (req) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        const buf = Buffer.from(chunk)
        size += buf.length
        if (size > 1_000_000) return { __tooLarge: true }
        chunks.push(buf)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return {}
      try { return JSON.parse(text) } catch { return { __parseError: true } }
    }
    const route = (method, routePath, handler) => {
      webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          try {
            if (String(req?.method ?? 'GET').toUpperCase() !== method) return json(res, 405, { ok: false, error: 'method-not-allowed' })
            return await handler(req, res)
          } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        },
      })
    }
    route('GET', `${prefix}/api/sync/status`, (req, res) => json(res, 200, service.status()))
    route('POST', `${prefix}/api/sync/export`, async (req, res) => {
      const body = await readBody(req)
      if (body.__tooLarge) return json(res, 413, { ok: false, error: 'body-too-large' })
      if (body.__parseError) return json(res, 400, { ok: false, error: 'bad-json' })
      const out = service.exportSelected(body)
      json(res, out.ok ? 200 : 400, out)
    })
    route('POST', `${prefix}/api/sync/import`, async (req, res) => {
      const body = await readBody(req)
      if (body.__tooLarge) return json(res, 413, { ok: false, error: 'body-too-large' })
      if (body.__parseError) return json(res, 400, { ok: false, error: 'bad-json' })
      const out = service.importInto(body)
      json(res, out.ok ? 200 : 400, out)
    })
  })
}
