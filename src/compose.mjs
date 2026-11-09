// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang compose mode — mounts the orchestrator and every sub-plugin as nested
// fibers of one loader row. This is the fallback composition used when the split-row
// patch (`./cordis.patch.yml`) cannot resolve subpath entries; it is behaviourally
// identical because every sub-plugin is the same module the split rows would load.
import { z } from './kernel/index.mjs'
import * as auditor from './plugins/auditor.mjs'
import * as forker from './plugins/forker.mjs'
import * as bufferKeeper from './plugins/buffer-keeper.mjs'
import * as scorer from './plugins/scorer.mjs'
import * as umbrella from './plugins/umbrella.mjs'
import * as healer from './plugins/healer.mjs'
import * as router from './plugins/router.mjs'
import * as approver from './plugins/approver.mjs'
import * as hotReloader from './plugins/hot-reloader.mjs'
import * as restartGuard from './plugins/restart-guard.mjs'
import * as adapter from './plugins/adapter.mjs'
import * as orchestrator from './plugins/orchestrator.mjs'
import * as sessionBridge from './plugins/session-bridge.mjs'
import * as sessionSync from './plugins/session-sync.mjs'
import * as sessionRouter from './plugins/session-router.mjs'
import * as decisionCenter from './plugins/decision-center.mjs'

export const name = 'fang-compose'
export const inject = []

export const Config = z.object({
  auditor: z.object({}).default({}).description('审计子插件配置'),
  forker: z.object({}).default({}).description('派生器配置'),
  bufferKeeper: z.object({}).default({}).description('缓冲管理器配置'),
  scorer: z.object({}).default({}).description('评分配置'),
  umbrella: z.object({}).default({}).description('保护伞（动作灯色 + 决策）配置'),
  healer: z.object({}).default({}).description('修复子插件配置'),
  router: z.object({}).default({}).description('路由决策配置'),
  approver: z.object({}).default({}).description('审批子插件配置'),
  hotReloader: z.object({}).default({}).description('热更新引擎配置'),
  restartGuard: z.object({}).default({}).description('红线守卫配置'),
  adapter: z.object({}).default({}).description('分身侧 Adapter 配置'),
  orchestrator: z.object({}).default({}).description('编排器配置'),
  sessionBridge: z.object({}).default({}).description('桥接（实时驱动 PC 会话）配置'),
  sessionSync: z.object({}).default({}).description('同步（勾选会话搬运）配置'),
  sessionRouter: z.object({}).default({}).description('混合路由配置'),
  decisionCenter: z.object({}).default({}).description('决策中心配置'),
}).description('dsh-Fang 单行装载模式配置')

export function apply(ctx, config) {
  const cfg = config ?? {}
  ctx.plugin(auditor, cfg.auditor ?? {})
  ctx.plugin(forker, cfg.forker ?? {})
  ctx.plugin(bufferKeeper, cfg.bufferKeeper ?? {})
  ctx.plugin(scorer, cfg.scorer ?? {})
  ctx.plugin(umbrella, cfg.umbrella ?? {})
  ctx.plugin(healer, cfg.healer ?? {})
  ctx.plugin(router, cfg.router ?? {})
  ctx.plugin(approver, cfg.approver ?? {})
  ctx.plugin(hotReloader, cfg.hotReloader ?? {})
  ctx.plugin(restartGuard, cfg.restartGuard ?? {})
  ctx.plugin(adapter, cfg.adapter ?? {})
  ctx.plugin(orchestrator, cfg.orchestrator ?? {})
  ctx.plugin(sessionBridge, cfg.sessionBridge ?? {})
  ctx.plugin(sessionSync, cfg.sessionSync ?? {})
  ctx.plugin(sessionRouter, cfg.sessionRouter ?? {})
  ctx.plugin(decisionCenter, cfg.decisionCenter ?? {})
}

export const _modules = { auditor, forker, bufferKeeper, scorer, umbrella, healer, router, approver, hotReloader, restartGuard, adapter, orchestrator, sessionBridge, sessionSync, sessionRouter, decisionCenter }
