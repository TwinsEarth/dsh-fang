// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 MCP stdio server: JSON-RPC 2.0, 8 default tools + opId polling.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TOOLS, OpStore, listTools } from './tools.mjs'

const META_TOOLS = [
  { name: 'get_op', description: '轮询长任务 opId（不假取消）', inputSchema: { type: 'object', properties: { opId: { type: 'string' } }, required: ['opId'] } },
  { name: 'abandon_op', description: '放弃轮询；不宣称已停止服务端任务', inputSchema: { type: 'object', properties: { opId: { type: 'string' } }, required: ['opId'] } },
]

export function createHandlers({ callTool, clock = Date.now } = {}) {
  const ops = new OpStore({ clock })
  const defs = [...listTools(), ...META_TOOLS]
  const names = new Set(defs.map((tool) => tool.name))
  const call = async (name, args = {}) => {
    if (name === 'get_op') return ops.get(args.opId)
    if (name === 'abandon_op') return ops.abandon(args.opId)
    if (!names.has(name)) throw new Error('tool-not-found: ' + name)
    const spec = TOOLS.find((tool) => tool.name === name)
    if (spec?.kind === 'op') return ops.start(name, args, () => callTool(name, args))
    return callTool(name, args)
  }
  return { defs, call }
}

export function createServer({ callTool } = {}) {
  const handlers = createHandlers({ callTool })
  return async function handleRequest(request) {
    const { id = null, method, params } = request || {}
    const reply = (result) => ({ jsonrpc: '2.0', id, result })
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
    try {
      if (method === 'initialize') {
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-fang', version: '3.0.8' },
        })
      }
      if (method === 'ping') return reply({})
      if (method === 'tools/list') {
        return reply({ tools: handlers.defs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      }
      if (method === 'tools/call') {
        const name = String(params?.name || '')
        const result = await handlers.call(name, params?.arguments || {})
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: Boolean(result && result.ok === false) })
      }
      return fail(-32601, 'method not found: ' + method)
    } catch (error) {
      return fail(-32603, String(error?.message ?? error))
    }
  }
}

export function createHttpCallTool({ baseUrl, token, fetchImpl = fetch }) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const route = {
    status: ['GET', '/fang/api/status'],
    tasks: ['GET', '/fang/api/tasks'],
    task_status: ['GET', '/fang/api/tasks/status'],
    essence_list: ['GET', '/fang/api/essence/list'],
    upgrade_status: ['GET', '/fang/api/upgrade/status'],
    compat: ['GET', '/fang/api/compat'],
    derive: ['POST', '/fang/api/derive'],
    archive: ['POST', '/fang/api/tasks/archive'],
  }
  return async function callTool(name, args = {}) {
    const entry = route[name]
    if (!entry) throw new Error('tool-not-configured: ' + name)
    const [method, routePath] = entry
    let url = base + routePath
    if (name === 'task_status') url += '?taskId=' + encodeURIComponent(String(args.taskId || ''))
    const headers = { accept: 'application/json' }
    if (token) headers['x-fang-auth'] = token
    const init = { method, headers }
    if (method === 'POST') {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(args)
    }
    const response = await fetchImpl(url, init)
    const body = await response.json().catch(() => ({}))
    return { ok: response.ok && body.ok !== false, status: response.status, body }
  }
}

async function main() {
  const readline = await import('node:readline')
  const baseUrl = process.env.FANG_URL || process.env.FANG_UPSTREAM || 'http://127.0.0.1:61758'
  const token = process.env.FANG_TOKEN || process.env.DSH_FANG_AUTH_TOKEN || ''
  const handle = createServer({ callTool: createHttpCallTool({ baseUrl, token }) })
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    if (!line.trim()) return
    let request
    try { request = JSON.parse(line) } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
      return
    }
    const response = await handle(request)
    if (response) process.stdout.write(JSON.stringify(response) + '\n')
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exit(1) })
}
