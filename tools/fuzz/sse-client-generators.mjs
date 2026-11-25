// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang v2.7.0 — ForkSseClient 网络层模糊生成器：
// 逻辑事件序列 + 每帧随机切块 + 断连策略（无断/单断/多断/心跳）。
import { XorShift128 } from './sse-rng.mjs'

export const SSE_CLIENT_STRATEGIES = Object.freeze([
  'noDisconnect',
  'singleDisconnect',
  'multiDisconnect',
  'withHeartbeats',
])

/** @param {XorShift128} rng @param {number} count */
export function generateEvents(rng, count) {
  const out = []
  for (let i = 1; i <= count; i += 1) {
    const kind = rng.pick(['audit', 'plugin-state', 'command-progress', 'approval-requested'])
    let event
    if (kind === 'audit') {
      event = { kind, event: { at: i, kind: 'fuzz', detail: { i } } }
    } else if (kind === 'plugin-state') {
      event = { kind, pluginId: `p${i}`, state: rng.pick(['active', 'loading', 'failed']) }
    } else if (kind === 'command-progress') {
      event = { kind, trackingId: `t${i}`, progress: rng.int(100) }
    } else {
      event = {
        kind,
        approval: { approvalId: `a${i}`, action: 'fuzz', light: 'yellow', createdAt: i, expiresAt: i + 1000 },
      }
    }
    out.push({ cursor: String(i), sessionId: 's-fuzz-1', at: 1000 + i, event })
  }
  return out
}

/** @param {object} envelope */
export function encodeFrame(envelope) {
  return `id: ${envelope.cursor}\nevent: adapter\ndata: ${JSON.stringify(envelope)}\n\n`
}

/** @param {XorShift128} rng @param {string} frame @returns {string[]} */
export function splitFrame(rng, frame) {
  if (frame.length < 4) return [frame]
  const mode = rng.int(4)
  if (mode === 0) return [frame]
  if (mode === 1) {
    const size = 1 + rng.int(frame.length)
    const chunks = []
    for (let i = 0; i < frame.length; i += size) chunks.push(frame.slice(i, i + size))
    return chunks.filter(Boolean)
  }
  if (mode === 2) {
    const chunks = []
    let start = 0
    for (let i = 0; i < frame.length; i += 1) {
      if (frame[i] === '\n') {
        chunks.push(frame.slice(start, i + 1))
        start = i + 1
      }
    }
    if (start < frame.length) chunks.push(frame.slice(start))
    return chunks.filter(Boolean)
  }
  const a = 1 + rng.int(Math.max(1, frame.length - 2))
  const b = a + rng.int(Math.max(1, frame.length - a))
  return [frame.slice(0, a), frame.slice(a, b), frame.slice(b)].filter(Boolean)
}

/**
 * 生成一个 fuzz case。
 * @param {XorShift128} rng
 * @returns {{events:object[], frames:Array<{cursor:string,chunks:string[]}>, plans:object[], strategy:string, description:string}}
 */
export function generateCase(rng) {
  const count = 3 + rng.int(8) // 3..10
  const events = generateEvents(rng, count)
  const frames = events.map((envelope) => ({ cursor: envelope.cursor, chunks: splitFrame(rng, encodeFrame(envelope)) }))
  const strategy = rng.pick(SSE_CLIENT_STRATEGIES)

  if (strategy === 'noDisconnect') {
    return {
      events,
      frames,
      strategy,
      description: `${count} events, no disconnect, heartbeat=${false}`,
      plans: [{ serve: 'all', ending: 'hold', heartbeat: false }],
    }
  }

  if (strategy === 'singleDisconnect') {
    const cut = 1 + rng.int(count - 1)
    return {
      events,
      frames,
      strategy,
      description: `${count} events, disconnect after frame ${cut}`,
      plans: [
        { serve: cut, ending: 'destroy', heartbeat: false },
        { serve: 'all', ending: 'hold', heartbeat: false },
      ],
    }
  }

  if (strategy === 'multiDisconnect') {
    const requested = 1 + rng.int(3)
    const cuts = [...new Set(Array.from({ length: requested }, () => 1 + rng.int(count - 1)))].sort((a, b) => a - b)
    const plans = []
    let previous = 0
    for (const cut of cuts) {
      plans.push({ serve: cut - previous, ending: 'destroy', heartbeat: false })
      previous = cut
    }
    plans.push({ serve: 'all', ending: 'hold', heartbeat: false })
    return {
      events,
      frames,
      strategy,
      description: `${count} events, ${cuts.length} disconnect(s) at ${cuts.join(',')}`,
      plans,
    }
  }

  // withHeartbeats：可选单次断连，验证心跳注释既不影响事件也不影响 cursor 续传。
  if (rng.bool(0.5) && count > 1) {
    const cut = 1 + rng.int(count - 1)
    return {
      events,
      frames,
      strategy,
      description: `${count} events, heartbeats + disconnect after frame ${cut}`,
      plans: [
        { serve: cut, ending: 'destroy', heartbeat: true },
        { serve: 'all', ending: 'hold', heartbeat: true },
      ],
    }
  }
  return {
    events,
    frames,
    strategy,
    description: `${count} events, heartbeats only`,
    plans: [{ serve: 'all', ending: 'hold', heartbeat: true }],
  }
}

/**
 * 计算每个 200 plan 对应的请求 since（未计非 200 plan）。
 * @param {Array<{cursor:string}>} frames
 * @param {object[]} plans
 * @returns {string[]}
 */
export function expectedSinceFor(frames, plans) {
  const expected = []
  let index = 0
  for (const plan of plans) {
    if (plan.status && plan.status !== 200) continue
    expected.push(index === 0 ? '0' : frames[index - 1].cursor)
    const serve = plan.serve === 'all' || plan.serve === undefined ? frames.length - index : Number(plan.serve) || 0
    index = Math.min(frames.length, index + Math.max(0, serve))
  }
  return expected
}
