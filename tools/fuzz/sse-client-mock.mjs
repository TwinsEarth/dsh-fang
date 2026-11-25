// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.7.0 — ForkSseClient（createAdapterClient SSE 层）的可编程 mock HTTP 服务器。
//
// 真实 HTTP 服务器 + 真实 fetch/undici 流式读取：测的是网络层状态机，而不是替换 fetch。
// 能力：
//   * /fang/adapter/version /state /events 三个端点；
//   * 按 plan 返回 200/401/409/410/503；
//   * 200 流式响应：按预切好的 chunk 写出、可插心跳注释、可 hold/end/destroy；
//   * 按 since 过滤帧（模拟 EventLog 的真实语义），并记录每次请求的 since/session；
//   * destroy 前等待 write 回调 + 短延迟，保证已写字节到达客户端（减少 flake）。
import http from 'node:http'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @typedef {{cursor:string, chunks:string[]}} MockFrame
 * @typedef {{status?:200|401|409|410|503, serve?:number|'all', ending?:'hold'|'end'|'destroy', heartbeat?:boolean}} MockPlan
 * @typedef {{frames:MockFrame[], plans:MockPlan[], sessionId?:string, lastCursor?:string}} MockScript
 */

export class MockSseServer {
  /** @param {{sessionId?:string, lastCursor?:string}} [options] */
  constructor(options = {}) {
    this.snapshot = {
      sessionId: String(options.sessionId ?? 's-fuzz-1'),
      lastCursor: String(options.lastCursor ?? '0'),
    }
    this.frames = []
    this.plans = []
    this.planIndex = 0
    this.queries = []
    this.stateRequests = 0
    this.openResponses = new Set()
    this.server = http.createServer((req, res) => this.route(req, res))
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    return this
  }

  async stop() {
    for (const res of [...this.openResponses]) {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    }
    this.openResponses.clear()
    this.server.closeAllConnections?.()
    await new Promise((resolve) => this.server.close(() => resolve()))
  }

  get baseUrl() {
    const address = this.server.address()
    return `http://127.0.0.1:${address.port}`
  }

  /** 设置状态快照（409/410 resync 时客户端会重新拉它）。 */
  setSnapshot(patch = {}) {
    Object.assign(this.snapshot, patch)
    return this
  }

  /** 每个 fuzz case 调用一次：重置帧、计划、请求记录与计划游标。 */
  configure(script = {}) {
    this.frames = Array.isArray(script.frames) ? script.frames : []
    this.plans = Array.isArray(script.plans) ? script.plans : []
    this.planIndex = 0
    this.queries = []
    this.stateRequests = 0
    if (script.sessionId !== undefined) this.snapshot.sessionId = String(script.sessionId)
    if (script.lastCursor !== undefined) this.snapshot.lastCursor = String(script.lastCursor)
    return this
  }

  route(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (url.pathname.endsWith('/adapter/version')) return this.handleVersion(res)
    if (url.pathname.endsWith('/adapter/state')) return this.handleState(res)
    if (url.pathname.endsWith('/adapter/events')) return this.handleEvents(req, res, url)
    res.statusCode = 404
    res.end(JSON.stringify({ code: 'not-found' }))
  }

  handleVersion(res) {
    this.writeJson(res, 200, {
      ok: true,
      protocol: 3,
      sessionId: this.snapshot.sessionId,
      adapter: 'mock',
      version: '2.7.0',
    })
  }

  handleState(res) {
    this.stateRequests += 1
    this.writeJson(res, 200, {
      ok: true,
      sessionId: this.snapshot.sessionId,
      protocolVersion: 3,
      taskId: 'task-fuzz',
      status: 'running',
      uptimeMs: 0,
      metrics: { activeSessions: 0, runningTools: 0, handleCount: 0, rssBytes: 0 },
      plugins: [],
      approvals: [],
      buffer: { dirtyFiles: 0, flushStatus: 'idle' },
      lastCursor: this.snapshot.lastCursor,
    })
  }

  handleEvents(req, res, url) {
    const since = url.searchParams.get('since') ?? '0'
    const session = url.searchParams.get('session')
    this.queries.push({ since, session })

    const plan = this.plans[this.planIndex] ?? { status: 200, serve: 'all', ending: 'hold' }
    this.planIndex += 1

    if (plan.status && plan.status !== 200) {
      const code = plan.status === 409 ? 'session-changed' : plan.status === 410 ? 'cursor-expired' : 'error'
      this.writeJson(res, plan.status, { code, error: code })
      return
    }

    const sinceNum = Number(since)
    let start = 0
    while (start < this.frames.length && Number(this.frames[start].cursor) <= sinceNum) start += 1
    const available = this.frames.slice(start)
    const serve = plan.serve === 'all' || plan.serve === undefined
      ? available.length
      : Math.max(0, Math.min(available.length, Number(plan.serve) || 0))
    const served = available.slice(0, serve)

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    this.openResponses.add(res)
    res.once('close', () => this.openResponses.delete(res))

    void this.streamFrames(req, res, served, plan).catch(() => {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
  }

  async streamFrames(req, res, frames, plan) {
    for (const frame of frames) {
      if (res.destroyed || res.writableEnded || req.destroyed) return
      if (plan.heartbeat) await this.writeChunk(res, ': heartbeat\n\n')
      for (const chunk of frame.chunks) {
        if (res.destroyed || res.writableEnded || req.destroyed) return
        await this.writeChunk(res, chunk)
        await Promise.resolve()
      }
    }

    const ending = plan.ending ?? 'hold'
    if (ending === 'end') {
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
    if (ending === 'destroy') {
      // 等最后一个 write 真正出队，再硬断；模拟网络中断而不是正常 EOF。
      await sleep(5)
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    }
    // hold：不结束，等客户端主动断开或服务器 stop
  }

  writeChunk(res, text) {
    return new Promise((resolve) => {
      if (res.destroyed || res.writableEnded) return resolve()
      try {
        res.write(text, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  writeJson(res, status, body) {
    try {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    } catch {
      /* ignore */
    }
  }
}

export { sleep }
