// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// approval-drill — 在隔离的临时 dataRoot 里真实执行一次“提升审批”闭环：
//   requestPromotion(red) → pending → decide(approved) → snapshot → 改动文件 → rollback
// 不触碰生产 dataDir、不加载真实插件、不写 profile；用于证明审批/快照/回滚链路可执行。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply as applyApprover } from '../plugins/approver.mjs'

/**
 * @returns {{
 *   ok:boolean, request:{id:string,kind:string,risk:string,outcome:string},
 *   pendingBefore:number, pendingAfter:number, snapshot:object, rollback:object,
 *   restored:boolean, target:string, dataRoot:string, cleanup:boolean
 * }}
 */
export async function runApprovalDrill() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-approval-drill-'))
  const target = path.join(dataRoot, 'target')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'plugin.mjs'), 'export const version = 1\n', 'utf8')

  const services = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => { try { dispose?.() } catch { /* ignore */ } }
    },
    provide(key, value) { services.set(key, value); return () => services.delete(key) },
    get(key) { return services.get(key) },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  }

  let approver = null
  let requestPromise = null
  try {
    applyApprover(ctx, {
      dataRoot,
      defaultTtlMs: 10000,
      authMode: 'manual',
      strictRedLine: true,
      snapshotGenerations: 3,
    })
    approver = services.get('fangApprover')
    if (!approver || typeof approver.requestPromotion !== 'function') {
      return { ok: false, error: 'approver-service-missing', dataRoot, cleanup: false }
    }

    requestPromise = approver.requestPromotion({
      pluginId: 'approval-drill',
      taskId: 'approval-drill',
      detail: '隔离审批 drill：验证 request→decide→snapshot→rollback',
      ttlMs: 10000,
    })
    // request() 同步入队；让出一次事件循环以确保 pending 可见。
    await new Promise((resolve) => setImmediate(resolve))
    const pendingBefore = approver.pending()
    if (pendingBefore.length !== 1) {
      return { ok: false, error: 'request-not-pending', pendingBefore: pendingBefore.length, dataRoot, cleanup: false }
    }
    const id = String(pendingBefore[0].id)
    const decided = approver.decide(id, 'approved', { by: 'approval-drill', note: 'isolated drill' })
    const outcome = await requestPromise
    const pendingAfter = approver.pending().length
    requestPromise = null

    const snapshot = await approver.snapshot({ tag: 'approval-drill', dir: target })
    fs.writeFileSync(path.join(target, 'plugin.mjs'), 'export const version = 2\n', 'utf8')
    const rollback = await approver.rollback({ tag: 'approval-drill', dir: target })
    const restored = fs.readFileSync(path.join(target, 'plugin.mjs'), 'utf8') === 'export const version = 1\n'

    return {
      ok: outcome?.outcome === 'approved' && decided?.ok === true && snapshot?.ok !== false && rollback?.ok === true && restored && pendingAfter === 0,
      request: { id, kind: 'promotion', risk: 'red', outcome: String(outcome?.outcome ?? '') },
      decided,
      pendingBefore: pendingBefore.length,
      pendingAfter,
      snapshot,
      rollback,
      restored,
      target,
      dataRoot,
      cleanup: false,
    }
  } finally {
    // 未决请求不能被遗留在计时器里：显式拒绝/超时结算。
    if (requestPromise) {
      const pending = approver?.pending?.() ?? []
      for (const item of pending) {
        try { approver.decide(item.id, 'denied', { by: 'approval-drill-cleanup' }) } catch { /* ignore */ }
      }
      await requestPromise.catch(() => {})
    }
    for (const dispose of disposers.reverse()) { try { dispose() } catch { /* ignore */ } }
  }
}

/** 删除 drill 的临时目录；返回是否已不存在。 */
export function cleanupApprovalDrill(result) {
  const dir = String(result?.dataRoot ?? '')
  if (!dir) return true
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  return !fs.existsSync(dir)
}

export const _internals = { runApprovalDrill, cleanupApprovalDrill }
