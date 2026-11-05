// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 MCP tool registry: 8 default tools, 4 high-risk hidden, opId idempotency, no fake cancel.
import crypto from 'node:crypto'

export const HIGH_RISK_TOOLS = Object.freeze(['promote', 'delete', 'restart', 'mirror_upgrade'])

export const TOOLS = Object.freeze([
  { name: 'status', description: '母体/宿主状态（只读）', kind: 'sync', inputSchema: { type: 'object', properties: {} } },
  { name: 'tasks', description: '分身任务列表（只读）', kind: 'sync', inputSchema: { type: 'object', properties: {} } },
  { name: 'task_status', description: '单个分身任务状态（只读）', kind: 'sync', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'derive', description: '派生新分身', kind: 'op', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'archive', description: '归档分身（保留 home）', kind: 'op', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'essence_list', description: '元主/原身列表（只读）', kind: 'sync', inputSchema: { type: 'object', properties: {} } },
  { name: 'upgrade_status', description: '升级状态（只读）', kind: 'sync', inputSchema: { type: 'object', properties: {} } },
  { name: 'compat', description: 'compat 门禁状态（只读）', kind: 'sync', inputSchema: { type: 'object', properties: {} } },
  ...HIGH_RISK_TOOLS.map((name) => ({
    name, description: '高风险工具（默认不暴露）', kind: 'op', highRisk: true,
    inputSchema: { type: 'object', properties: {} },
  })),
])

export function listTools({ includeHighRisk = false } = {}) {
  return TOOLS.filter((tool) => includeHighRisk || !tool.highRisk)
}

export class OpStore {
  constructor({ clock = Date.now, timeoutMs = 120_000 } = {}) {
    this.clock = clock
    this.timeoutMs = timeoutMs
    this.ops = new Map()
    this.keys = new Map()
  }

  start(name, args = {}, run) {
    const key = args.idempotencyKey ? `${name}:${args.idempotencyKey}` : ''
    if (key && this.keys.has(key)) return { ok: true, opId: this.keys.get(key), deduped: true }
    const opId = 'op_' + crypto.randomBytes(8).toString('hex')
    this.ops.set(opId, { opId, name, state: 'running', abandoned: false, startedAt: this.clock(), result: null, error: null })
    if (key) this.keys.set(key, opId)
    Promise.resolve().then(run).then((result) => {
      const op = this.ops.get(opId)
      if (!op || op.state !== 'running') return
      op.state = 'completed'; op.result = result ?? null
    }).catch((error) => {
      const op = this.ops.get(opId)
      if (!op || op.state !== 'running') return
      op.state = 'failed'; op.error = String(error?.message ?? error)
    })
    return { ok: true, opId, deduped: false }
  }

  get(opId) {
    const op = this.ops.get(String(opId))
    if (!op) return { ok: false, error: 'op-not-found' }
    if (op.state === 'running' && this.clock() - op.startedAt > this.timeoutMs) op.state = 'timeout'
    return { ok: true, opId: op.opId, name: op.name, state: op.state, abandoned: op.abandoned, result: op.result, error: op.error }
  }

  abandon(opId) {
    const op = this.ops.get(String(opId))
    if (!op) return { ok: false, error: 'op-not-found' }
    op.abandoned = true
    return { ok: true, opId: op.opId, state: op.state, abandoned: true }
  }
}
