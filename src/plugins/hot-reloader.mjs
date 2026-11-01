// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-hot-reloader — 2.5 热更新（分身内，不升红）
//
// 硬边界（CONTRACTS §1.4）：失败不升红 —— 能回滚就回滚；回滚不了由编排器 reap 分身重新派生。
// 本插件只做一件事：把磁盘上的**新代码字节**换进来，并证明它换得住：
//   1) `?rev=<contentHash>` 动态 import（同一份字节复用同一 ESM 实例，改一字节就是新模块）
//   2) 在「临时等待位」里编译/初始化 —— 旧 fiber 此时完全没被触碰
//   3) 健康窗采样 `process.getActiveResourcesInfo`（kernel sampleResources/diffResources）
//   4) 只有健康窗通过才 dispose 旧 fiber；初始化失败或句柄泄漏 => dispose 新 fiber、旧 fiber 原样留下
//
// 不做：进程重启（归 restart-guard）、审批（审批面在 restart-guard/approver）、fork/缓冲区逻辑。
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { SERVICE, diffResources, sampleResources, sha256File, z } from '../kernel/index.mjs'
import { roleGate } from '../kernel/index.mjs'

export const name = 'fang-hot-reloader'
export const inject = []

const DEFAULTS = Object.freeze({
  healthWindowMs: 300,
  healthMaxNewHandles: 2,
  requireApprovalForSwap: true,
})

export const Config = z.object({
  healthWindowMs: z.number().min(50).max(10000).default(300)
    .description('swap 后的健康窗（毫秒）：窗口内新增被引用句柄超过阈值即回滚'),
  healthMaxNewHandles: z.number().min(0).max(100).default(2)
    .description('健康窗允许的最大新增被引用资源数（超过即 dispose 新 fiber 并回滚）'),
  requireApprovalForSwap: z.boolean().default(true)
    .description('保留字段（bundle 配置兼容）：v1.0.0 的审批发生在 restart-guard/approver 面，swap() 自身不等待审批'),
})

// 本插件的 import 列表避开了 kernel barrel 的歧义导出（core/fsx 都导出 sleep），用本地实现。
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const errText = (e) => String(e?.message ?? e)
const safeGet = (ctx, key) => { try { return ctx.get(key) } catch { return undefined } }

/** Cordis Fiber state: PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4 */
const FIBER_FAILED = 3

let idSeq = 0
function nextId() {
  idSeq = (idSeq + 1) % 1e6
  return `hl_${Date.now().toString(36)}${idSeq.toString(36)}`
}

export function apply(ctx, config) {
  const gate = roleGate('hotReloader', { cfgRole: config?.role, logger: ctx.logger })
  // v2 deployment matrix: this plugin is not deployed in this role — register nothing.
  if (!gate.active) return
  // 宿主已用 Config 校验过；直接调用 apply 时也走一次，保证两条路径同保护。
  let validated
  try { validated = Config(config ?? {}) } catch (e) {
    throw new Error(`[fang-hot-reloader] config invalid: ${errText(e).replace(/^\$\./, '')}`)
  }
  const cfg = { ...DEFAULTS, ...validated }

  /** name -> { id, name, file, rev, url, mod, handle, slot, config, sessionId, swappedAt } */
  const mounted = new Map()
  const stats = {
    windowMs: cfg.healthWindowMs,
    maxNewHandles: cfg.healthMaxNewHandles,
    samples: 0,
    swaps: 0,
    rollbacks: 0,
    lastDiff: null,
  }
  const log = (level, msg) => { try { ctx.logger?.[level]?.(`[fang-hot-reloader] ${msg}`) } catch { /* logging must never break a swap */ } }

  /**
   * 临时等待位：新代码先在隔离的作用域里初始化，失败时整块丢掉，旧 fiber 从未被触碰。
   * 真宿主（Cordis）的 ctx.inject 返回 disposable 而不是子 ctx，拿不到子 ctx 就退化为原地挂载：
   * 顺序仍是「先挂新、健康后才 dispose 旧」，只是隔离性弱一档，结果里如实标 degraded。
   */
  const createWaitingSlot = () => {
    let captured = null
    if (typeof ctx.inject === 'function') {
      try {
        const returned = ctx.inject([], (child) => { captured = child; return child })
        const scope = (returned && typeof returned.plugin === 'function')
          ? returned
          : (captured && typeof captured.plugin === 'function' ? captured : null)
        if (scope) return { scope, temporary: true, degrade: null }
      } catch { /* 宿主不支持/签名不同 => 退化 */ }
    }
    return { scope: ctx, temporary: false, degrade: 'no-child-scope' }
  }

  /** 把一个已 import 的模块挂到 scope 上，归一化成可 await / 可 dispose 的 handle。 */
  const mountIn = (scope, mod, pluginConfig) => {
    if (!scope || typeof scope.plugin !== 'function') throw new Error('ctx.plugin unavailable')
    const raw = scope.plugin(mod, pluginConfig ?? {})
    let dispose = null
    if (raw && typeof raw.dispose === 'function') dispose = () => raw.dispose()
    else if (typeof raw === 'function') dispose = () => raw()
    return {
      raw,
      dispose, // null = 依赖等待位整体释放（测试 ctx 的 apply() 无返回值）
      await: raw && typeof raw.await === 'function' ? () => raw.await() : null,
      state: () => { try { return raw?.state ?? null } catch { return null } },
      disposed: false,
    }
  }

  /** dispose 新 fiber（以及临时等待位）——失败只记录，绝不让回滚本身变成异常路径。 */
  const disposeHandle = async (handle, slot) => {
    const errors = []
    if (handle && !handle.disposed) {
      handle.disposed = true
      try { if (handle.dispose) await handle.dispose() } catch (e) { errors.push(errText(e)) }
    }
    if (slot?.temporary && slot.scope && typeof slot.scope.dispose === 'function') {
      try { await slot.scope.dispose() } catch (e) { errors.push(errText(e)) }
    }
    return errors
  }

  /** 健康窗：等一段时间后看「仍被引用的资源」净增，> maxNewHandles 即判泄漏。 */
  const runHealthWindow = async (baseline) => {
    await sleep(cfg.healthWindowMs)
    const diff = diffResources(baseline, sampleResources())
    stats.samples += 1
    stats.lastDiff = { ...diff, windowMs: cfg.healthWindowMs, at: Date.now() }
    return diff
  }

  const healthPayload = (diff, fiberState) => ({
    leakedRefed: diff?.leakedRefed ?? 0,
    freed: diff?.freed ?? 0,
    windowMs: cfg.healthWindowMs,
    fiberState,
  })

  /**
   * swap({name, file, config, sessionId?}) -> Promise<{ok, phase, ...}>
   * 成功：{ok:true, phase:'swapped', from, to, url, fiber, health}
   * 初始化失败：{ok:false, phase:'init-failed', reason:'import-failed'|'mount-failed'}
   * 健康窗回滚：{ok:false, phase:'rolled-back', rolledBack:true, reason:'health-window'|'fiber-failed'}
   * 两条失败路径下旧 fiber 都没被 dispose。
   */
  const swap = async ({ name, file, config: pluginConfig = {}, sessionId = null } = {}) => {
    const t0 = Date.now()
    const entryName = String(name ?? '')
    const filePath = file ? path.resolve(String(file)) : ''
    if (!entryName || !filePath) {
      return { ok: false, phase: 'init-failed', reason: 'bad-request', error: 'swap({name,file}) requires both' }
    }
    const prev = mounted.get(entryName) ?? null
    const rev = sha256File(filePath) // 内容哈希：字节决定版本，mtime 不参与
    const url = pathToFileURL(filePath).href + `?rev=${encodeURIComponent(rev ?? 'missing')}`

    // 1) 预检 import：失败时旧 fiber 完全没被动过
    let mod
    try {
      mod = await import(url)
    } catch (e) {
      log('warn', `import failed for ${entryName}: ${errText(e)}`)
      return {
        ok: false, phase: 'init-failed', reason: 'import-failed', error: errText(e),
        name: entryName, file: filePath, from: prev?.rev ?? null, to: rev, url,
        health: { leakedRefed: 0, windowMs: cfg.healthWindowMs },
      }
    }

    // 2) 临时等待位里初始化
    const slot = createWaitingSlot()
    const baseline = sampleResources()
    let handle = null
    try {
      handle = mountIn(slot.scope, mod, pluginConfig)
      if (handle.await) await handle.await()
      if (handle.state() === FIBER_FAILED) throw new Error('fiber failed during init')
    } catch (e) {
      const disposeErrors = await disposeHandle(handle, slot)
      log('warn', `init failed for ${entryName}: ${errText(e)}`)
      return {
        ok: false, phase: 'init-failed', reason: 'mount-failed', error: errText(e),
        name: entryName, file: filePath, from: prev?.rev ?? null, to: rev, url,
        health: { leakedRefed: 0, windowMs: cfg.healthWindowMs },
        ...(disposeErrors.length ? { disposeErrors } : {}),
      }
    }

    // 3) 健康窗
    const diff = await runHealthWindow(baseline)
    const fiberState = handle.state()
    const unstable = fiberState === FIBER_FAILED || diff.leakedRefed > cfg.healthMaxNewHandles
    if (unstable) {
      const disposeErrors = await disposeHandle(handle, slot)
      stats.rollbacks += 1
      log('warn', `rolled back ${entryName}: leakedRefed=${diff.leakedRefed} state=${fiberState}`)
      return {
        ok: false, phase: 'rolled-back', rolledBack: true,
        reason: fiberState === FIBER_FAILED ? 'fiber-failed' : 'health-window',
        name: entryName, file: filePath, from: prev?.rev ?? null, to: rev, url,
        health: healthPayload(diff, fiberState),
        ...(disposeErrors.length ? { disposeErrors } : {}),
        degraded: slot.degrade ?? null,
        ms: Date.now() - t0,
      }
    }

    // 4) 健康 => 现在才 dispose 旧 fiber
    let disposedOld = false
    let oldDisposeError = null
    if (prev) {
      const errs = await disposeHandle(prev.handle, prev.slot)
      disposedOld = errs.length === 0
      if (errs.length) oldDisposeError = errs.join('; ')
    }

    const record = {
      id: nextId(), name: entryName, file: filePath, rev, url, mod,
      handle, slot, config: { ...(pluginConfig ?? {}) }, sessionId, swappedAt: Date.now(),
    }
    mounted.set(entryName, record)
    stats.swaps += 1
    return {
      ok: true, phase: 'swapped', name: entryName, from: prev?.rev ?? null, to: rev, url,
      fiber: { id: record.id, name: entryName, rev, url, state: handle.state() },
      health: healthPayload(diff, handle.state()),
      disposedOld: prev ? disposedOld : null,
      ...(oldDisposeError ? { oldDisposeError } : {}),
      ...(slot.degrade ? { degraded: slot.degrade } : {}),
      ms: Date.now() - t0,
    }
  }

  /** unload({name}) -> {ok}：卸载后该名字回到「未装载」，可再次 swap。 */
  const unload = async ({ name } = {}) => {
    const entryName = String(name ?? '')
    const record = mounted.get(entryName)
    if (!record) return { ok: false, phase: 'not-loaded', reason: 'not-loaded', name: entryName }
    mounted.delete(entryName) // 先摘表：即使 dispose 部分失败也不再有活动记录
    const errors = await disposeHandle(record.handle, record.slot)
    if (errors.length) {
      log('warn', `unload ${entryName} dispose errors: ${errors.join('; ')}`)
      return { ok: false, phase: 'dispose-failed', name: entryName, from: record.rev, disposeErrors: errors }
    }
    return { ok: true, phase: 'unloaded', name: entryName, from: record.rev }
  }

  /** health() -> {windowMs, samples, lastDiff}（另附只读的装载快照，便于面板排障） */
  const health = () => ({
    windowMs: cfg.healthWindowMs,
    samples: stats.samples,
    lastDiff: stats.lastDiff ? { ...stats.lastDiff } : null,
    maxNewHandles: cfg.healthMaxNewHandles,
    swaps: stats.swaps,
    rollbacks: stats.rollbacks,
    loaded: [...mounted.values()].map(r => ({ name: r.name, rev: r.rev, url: r.url, swappedAt: r.swappedAt })),
  })

  const service = { swap, unload, health }
  ctx.effect(() => ctx.provide(SERVICE.hotReloader, service))

  // 插件卸载：把还挂着的 fiber 尽量拆掉（dispose 可能是异步的，这里不阻塞 effect 清理）。
  // 临时等待位（子作用域）由父作用域自行回收，这里不重复 dispose：宿主对子 fiber 的 ownership
  // 已经在 dispose 父 ctx 时生效（测试 helpers 的 ctx.dispose 也会回收 children）。
  ctx.effect(() => () => {
    for (const rec of mounted.values()) {
      try {
        const p = rec.handle?.dispose ? rec.handle.dispose() : null
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch { /* ignore */ }
    }
    mounted.clear()
  })

  return service
}
