// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.9 — 升级后重算协调器。
//
// 职责：把 MirrorManager 的「升级成功」与 EssenceManager 的「批量重算」解耦：
//   MirrorManager 只持有一个 postUpgradeHook（fire-and-forget），
//   coordinator 负责去重并发重算、记录进度/结果，并暴露给 UI 轮询。
// 失败隔离：重算失败不影响升级结果；单个原身失败进入 failed，不中断整批。

export class MirrorUpgradeCoordinator {
  /**
   * @param {{essence: {recomputeAll: Function}, logger?: {info?:Function, warn?:Function},
   *   concurrency?: number, perEssenceTimeoutMs?: number}} options
   */
  constructor(options) {
    if (options === null || typeof options !== 'object' || options.essence === null || typeof options.essence !== 'object') {
      throw new Error('MirrorUpgradeCoordinator: essence required')
    }
    this.essence = options.essence
    this.logger = options.logger ?? {}
    this.concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 4))
    this.perEssenceTimeoutMs = Math.max(1, Math.floor(Number(options.perEssenceTimeoutMs) || 60_000))
    /** @type {Promise<void>|null} */
    this.currentRun = null
    /** @type {{running:boolean, startedAt:number|null, finishedAt:number|null, progress:Record<string,unknown>|null, lastResult:Record<string,unknown>|null, lastError:string|null}} */
    this.status = {
      running: false, startedAt: null, finishedAt: null,
      progress: null, lastResult: null, lastError: null,
    }
  }

  /** 返回状态快照（浅拷贝，避免调用方改内部对象）。 */
  getRecomputeStatus() {
    return {
      ...this.status,
      progress: this.status.progress === null ? null : { ...this.status.progress },
      lastResult: this.status.lastResult === null ? null : {
        ...this.status.lastResult,
        recomputed: [...(this.status.lastResult.recomputed ?? [])],
        skipped: [...(this.status.lastResult.skipped ?? [])],
        conflicted: [...(this.status.lastResult.conflicted ?? [])],
        failed: [...(this.status.lastResult.failed ?? [])],
      },
    }
  }

  /**
   * 由 postUpgradeHook 调用；若已有重算在跑则复用同一个 promise（不叠加批次）。
   * @returns {Promise<void>}
   */
  onUpgradeSuccess() {
    if (this.currentRun !== null) {
      this.logger.info?.('[coordinator] recompute already running, joining')
      return this.currentRun
    }
    this.currentRun = this.runRecompute().finally(() => { this.currentRun = null })
    return this.currentRun
  }

  /** 等待当前重算完成；无进行中批次时立即返回。 */
  async waitForRecompute() {
    if (this.currentRun !== null) await this.currentRun
  }

  async runRecompute() {
    const startedAt = Date.now()
    this.status = {
      running: true, startedAt, finishedAt: null,
      progress: { done: 0, total: 0, currentId: null, recomputed: 0, skipped: 0, conflicted: 0, failed: 0 },
      lastResult: null, lastError: null,
    }
    try {
      const result = await this.essence.recomputeAll({
        concurrency: this.concurrency,
        perEssenceTimeoutMs: this.perEssenceTimeoutMs,
        onProgress: (progress) => { this.status.progress = { ...progress } },
      })
      this.status = {
        ...this.status,
        running: false,
        finishedAt: Date.now(),
        progress: this.status.progress,
        lastResult: result,
        lastError: null,
      }
      this.logger.info?.('[coordinator] recompute completed', {
        recomputed: result.recomputed?.length ?? 0,
        skipped: result.skipped?.length ?? 0,
        conflicted: result.conflicted?.length ?? 0,
        failed: result.failed?.length ?? 0,
        aborted: result.aborted === true,
        durationMs: result.durationMs,
      })
    } catch (error) {
      this.status = {
        ...this.status,
        running: false,
        finishedAt: Date.now(),
        lastError: String(error instanceof Error ? error.message : error),
      }
      this.logger.warn?.('[coordinator] recompute failed', {
        error: String(error instanceof Error ? error.message : error),
      })
    }
  }
}

export const _internals = Object.freeze({})
