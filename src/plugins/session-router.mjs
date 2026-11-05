// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-session-router — hybrid routing between sync (files) and bridge (live sessions).
//
// The decision is a pure truth table, exposed for tests and for the panel:
//   cross-machine + realtime        -> deny (bridge is loopback-only, sync not realtime)
//   same machine + host + bridge    -> bridge
//   otherwise                       -> sync
import { z, roleGate, resolveFangLayout, SERVICE, FANG_VERSION } from '../kernel/index.mjs'
import { createHttpGuard } from '../lib/http-auth.mjs'
import { readBridgeDescriptor } from '../lib/bridge-client.mjs'

export const name = 'fang-session-router'
export const inject = []

export const Config = z.object({
  sameMachine: z.boolean().default(true)
    .description('PC 宿主与 Web 母体是否同机（bridge 只支持同机回环）'),
  bridgeEnabled: z.boolean().default(true)
    .description('是否允许选择 bridge 模式（descriptor 存在且宿主在跑才会真正选中）'),
  needsRealtime: z.boolean().default(false)
    .description('默认是否要求实时（任务级可选择覆盖）'),
  dshHome: z.string().default('')
    .description('PC 宿主 DSH_HOME（查找 desktop-bridge.json）；留空 = 本机 $DSH_HOME'),
  prefix: z.string().default('/fang'),
  routes: z.object({ enabled: z.boolean().default(true) }).default({}),
  authToken: z.string().default('')
    .description('安装级鉴权 token；留空 = env DSH_FANG_AUTH_TOKEN 或 <dataDir>/fang-auth.json（0600，自动生成）'),
  authEnabled: z.boolean().default(true)
    .description('是否要求 /fang/api/route 携带安装级鉴权 token（默认开启；仅测试/本地调试可关）'),
})

/** Pure decision function; `deny` means the request cannot be satisfied honestly. */
export function chooseMode(context = {}, config = {}) {
  const sameMachine = context.sameMachine ?? config.sameMachine ?? true
  const bridgeEnabled = context.bridgeEnabled ?? config.bridgeEnabled ?? true
  const pcHostRunning = context.pcHostRunning === true
  const needsRealtime = context.needsRealtime ?? config.needsRealtime ?? false
  const oneTimeMigration = context.oneTimeMigration === true
  if (!sameMachine && needsRealtime) return 'deny'
  if (oneTimeMigration) return 'sync'
  if (sameMachine && bridgeEnabled && pcHostRunning && needsRealtime) return 'bridge'
  return 'sync'
}

export function apply(ctx, config) {
  const gate = roleGate('sessionRouter', { logger: ctx.logger })
  if (!gate.active) return
  const cfg = { ...Config({}), ...(config ?? {}) }
  const prefix = String(cfg.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'
  const authGuard = createHttpGuard({
    dataDir: resolveFangLayout().dataDir,
    token: cfg.authToken,
    enabled: cfg.authEnabled !== false,
  })

  const probe = (context = {}) => {
    const desc = readBridgeDescriptor({ dshHome: cfg.dshHome })
    const pcHostRunning = desc.ok
    const merged = {
      sameMachine: context.sameMachine ?? cfg.sameMachine,
      bridgeEnabled: context.bridgeEnabled ?? cfg.bridgeEnabled,
      needsRealtime: context.needsRealtime ?? cfg.needsRealtime,
      oneTimeMigration: context.oneTimeMigration === true,
      pcHostRunning,
    }
    const mode = chooseMode(merged, cfg)
    return {
      ok: true,
      role: gate.role,
      version: FANG_VERSION,
      mode,
      reason: mode === 'deny'
        ? '跨机 + 实时：bridge 只支持回环，sync 不满足实时'
        : mode === 'bridge'
          ? '同机 + PC 宿主在跑 + bridge 可用 + 需要实时'
          : '文件级同步（可离线 / 跨机 / 一次性迁移）',
      bridge: desc.ok ? { available: true, pid: desc.info.pid } : { available: false, code: desc.code, error: desc.error },
      context: merged,
    }
  }

  const service = {
    role: gate.role,
    version: FANG_VERSION,
    choose: (context) => chooseMode(context, cfg),
    probe,
  }
  ctx.effect(() => ctx.provide(SERVICE.sessionRouter, service))

  if (cfg.routes?.enabled === false) return
  ctx.inject(['webServer'], (child) => {
    let webServer = null
    try { webServer = child?.get?.('webServer') ?? child?.webServer ?? null } catch { webServer = null }
    if (!webServer || typeof webServer.register !== 'function') return
    webServer.register({
      kind: 'exact',
      path: `${prefix}/api/route`,
      method: 'GET',
      handler: async (req, res) => {
        const decision = authGuard.check(req)
        if (!decision.ok) {
          res.statusCode = decision.status
          res.setHeader?.('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: decision.code, code: decision.code }))
          return
        }
        if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') {
          res.statusCode = 405
          res.setHeader?.('allow', 'GET')
          res.end(JSON.stringify({ ok: false, error: 'method-not-allowed', code: 'method-not-allowed' }))
          return
        }
        const q = new URL(String(req?.url ?? '/'), 'http://fang.local').searchParams
        const out = probe({
          needsRealtime: q.get('realtime') === '1' || q.get('realtime') === 'true',
          oneTimeMigration: q.get('migration') === '1' || q.get('migration') === 'true',
        })
        res.statusCode = out.mode === 'deny' ? 409 : 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(out))
      },
    })
  })
}
