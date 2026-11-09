#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-SDK.
// fangctl — dsh-Fang 离线运维 CLI。
//   node tools/fangctl.mjs status   [--profile <name>] [--data-root <dir>]
//   node tools/fangctl.mjs forks
//   node tools/fangctl.mjs verify            # 校验审计哈希链
//   node tools/fangctl.mjs tail [n]          # 最近 n 条审计
//   node tools/fangctl.mjs doctor            # 环境自检（不修改任何东西）
//   node tools/fangctl.mjs restart-status    # 只读：重启守卫状态 + 授权清单摘要（--json 可机读；--url 读运行中宿主）
//   node tools/fangctl.mjs approvals [--json] --url <host> [--token <t>]
//   node tools/fangctl.mjs approve <source:id> --url <host> [--token <t>] [--note text]
//   node tools/fangctl.mjs deny    <source:id> --url <host> [--token <t>] [--note text]
//
// 离线只读：fork/reap/promote 由宿主内的 orchestrator 服务与 /fang 路由完成，
// 这里不模拟它们，避免"CLI 说成功、宿主没执行"的假象。
import fs from 'node:fs'
import path from 'node:path'

import {
  resolveFangLayout, resolveProfileDir, resolveDshHome, parseWebUrl,
  exists, readJson, readJsonl, isLink, verifyChain, FANG_VERSION,
} from '../src/kernel/index.mjs'
import { readRestartStatus } from '../src/lib/restart-contract.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile' && argv[i + 1]) { args.profile = argv[++i]; continue }
    if (a.startsWith('--profile=')) { args.profile = a.slice(10); continue }
    if (a === '--data-root' && argv[i + 1]) { args.dataRoot = argv[++i]; continue }
    if (a.startsWith('--data-root=')) { args.dataRoot = a.slice(12); continue }
    if (a === '--url' && argv[i + 1]) { args.url = argv[++i]; continue }
    if (a.startsWith('--url=')) { args.url = a.slice(6); continue }
    if (a === '--token' && argv[i + 1]) { args.token = argv[++i]; continue }
    if (a.startsWith('--token=')) { args.token = a.slice(8); continue }
    if (a === '--note' && argv[i + 1]) { args.note = argv[++i]; continue }
    if (a.startsWith('--note=')) { args.note = a.slice(7); continue }
    if (a === '--by' && argv[i + 1]) { args.by = argv[++i]; continue }
    if (a.startsWith('--by=')) { args.by = a.slice(5); continue }
    if (a === '--json') { args.json = true; continue }
    args._.push(a)
  }
  return args
}

function layoutOf(args) {
  const argv = args.profile ? ['node', 'fangctl', '--profile', args.profile] : process.argv
  return resolveFangLayout({ dataRoot: args.dataRoot ?? '', argv, env: process.env })
}

function fmtTime(ms) {
  if (!ms) return '—'
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) } catch { return String(ms) }
}

/** HTTP base for approval commands; accepts host, host/fang, or host/fang/api. */
function apiBase(args) {
  const raw = String(args.url ?? process.env.FANG_URL ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    let pathname = url.pathname.replace(/\/+$/, '')
    if (pathname.endsWith('/fang/api')) pathname = pathname.slice(0, -9)
    else if (pathname.endsWith('/fang')) pathname = pathname.slice(0, -5)
    else pathname = ''
    return `${url.origin}${pathname}`
  } catch { return '' }
}

async function resolveToken(args, base) {
  const direct = String(args.token ?? process.env.FANG_TOKEN ?? '').trim()
  if (direct) return direct
  try {
    const res = await fetch(`${base}/fang/api/auth-token`, { headers: { accept: 'application/json' } })
    const body = await res.json()
    if (res.ok && body?.ok && body.token) return String(body.token)
  } catch { /* fall through */ }
  return ''
}

async function approvalRequest(args, pathname, options = {}) {
  const base = apiBase(args)
  if (!base) throw new Error('--url is required for HTTP commands')
  const token = await resolveToken(args, base)
  if (!token) throw new Error('token unavailable; pass --token or FANG_TOKEN')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(`${base}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-fang-auth': token,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    return { status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

function printApprovals(body, json) {
  if (json) {
    console.log(JSON.stringify(body, null, 2))
    return
  }
  const items = Array.isArray(body?.items) ? body.items : []
  if (!items.length) { console.log('(no pending approvals)'); return }
  console.log(`${'SOURCE'.padEnd(7)} ${'APPROVAL'.padEnd(28)} ${'RISK'.padEnd(7)} ${'DEADLINE'.padEnd(12)} TITLE`)
  for (const item of items) {
    console.log([
      String(item.source ?? '').padEnd(7),
      String(item.approvalId ?? '').padEnd(28),
      String(item.risk ?? '').padEnd(7),
      String(fmtTime(Number(item.deadlineAt))).padEnd(12),
      String(item.title ?? ''),
    ].join(' '))
  }
  for (const failed of Array.isArray(body?.failed) ? body.failed : []) {
    console.log(`! unavailable: ${failed.taskId ?? 'mother'} ${failed.error ?? ''}`)
  }
}

function parseApprovalTarget(raw, items) {
  const parts = String(raw ?? '').split(':').filter(Boolean)
  const source = parts[0]
  if (source !== 'mother' && source !== 'fork') return null
  if (source === 'mother') {
    const approvalId = parts.slice(1).join(':')
    return approvalId ? { source, taskId: null, approvalId } : null
  }
  if (parts.length >= 3) return { source, taskId: parts[1], approvalId: parts.slice(2).join(':') }
  const approvalId = parts.slice(1).join(':')
  if (!approvalId) return null
  const matches = (items ?? []).filter((item) => item.source === 'fork' && item.approvalId === approvalId)
  if (matches.length !== 1) return null
  return { source: 'fork', taskId: matches[0].taskId, approvalId }
}

async function cmdApprovals(args) {
  const result = await approvalRequest(args, '/fang/api/approvals')
  if (result.status !== 200 || result.body?.ok === false) {
    console.error(JSON.stringify(result.body ?? { status: result.status, text: result.text }))
    return 1
  }
  printApprovals(result.body, args.json)
  return result.body?.degraded ? 2 : 0
}

async function cmdDecide(args, outcome) {
  const raw = args._[1]
  if (!raw) { console.error('usage: fangctl approve|deny <source:id> [--note ...]'); return 64 }
  const listed = await approvalRequest(args, '/fang/api/approvals')
  const target = parseApprovalTarget(raw, Array.isArray(listed.body?.items) ? listed.body.items : [])
  if (!target) { console.error(`cannot resolve approval target: ${raw}`); return 64 }
  const result = await approvalRequest(args, '/fang/api/approvals/decide', {
    method: 'POST',
    body: {
      ...target,
      outcome,
      note: args.note ?? null,
      by: args.by ?? 'fangctl',
    },
  })
  if (args.json) console.log(JSON.stringify(result.body ?? { status: result.status }, null, 2))
  else if (result.status === 200 && result.body?.ok !== false) console.log(`${outcome}: ${target.source}:${target.approvalId}`)
  else console.error(`${result.status}: ${result.body?.error ?? result.text ?? 'failed'}`)
  if (result.status === 200 && result.body?.ok !== false) return 0
  return result.status === 409 ? 2 : 1
}

function readForks(layout) {
  const raw = readJson(layout.forksFile, [])
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.forks) ? raw.forks : []
  return list
}

function cmdStatus(layout) {
  const forks = readForks(layout)
  console.log(`dsh-Fang ${FANG_VERSION}`)
  console.log(`  profile   : ${layout.profileTag}`)
  console.log(`  DSH_HOME   : ${layout.dshHome}`)
  console.log(`  data dir   : ${layout.dataDir}${exists(layout.dataDir) ? '' : '  (不存在：该 profile 未启动过 Fang)'}`)
  console.log(`  ledger     : ${layout.ledgerFile}${exists(layout.ledgerFile) ? '' : '  (尚未写入)'}`)
  console.log(`  buffer     : ${layout.bufferDir}`)
  console.log(`  forks      : ${forks.length}`)
  for (const f of forks) {
    console.log(`    - ${f.forkId}  ${f.status ?? '?'}  port=${f.port ?? '—'}  pid=${f.pid ?? '—'}  ${f.taskTitle ?? ''}`)
  }
  if (exists(layout.ledgerFile)) {
    const v = verifyChain(layout.ledgerFile)
    console.log(`  audit      : ${v.ok ? 'OK' : 'CORRUPT'} (${v.count} 条${v.ok ? '' : `, 首个坏行 #${v.badIndex} ${v.reason}`})`)
  }
  return 0
}

function cmdVerify(layout) {
  if (!exists(layout.ledgerFile)) {
    console.log(`no ledger at ${layout.ledgerFile}`)
    return 1
  }
  const v = verifyChain(layout.ledgerFile)
  console.log(JSON.stringify(v, null, 2))
  return v.ok ? 0 : 2
}

function cmdTail(layout, n = 20) {
  const lines = readJsonl(layout.ledgerFile)
  const tail = lines.slice(-n)
  for (const r of tail) {
    const data = r.data && typeof r.data === 'object' ? r.data : {}
    const brief = Object.keys(data).slice(0, 4).map(k => `${k}=${JSON.stringify(data[k])}`).join(' ')
    console.log(`${String(r.seq).padStart(3)} ${fmtTime(r.at)} ${String(r.kind).padEnd(18)} ${brief}`)
  }
  if (!tail.length) console.log('(no audit records)')
  return 0
}

function cmdForks(layout) {
  const forks = readForks(layout)
  if (!forks.length) { console.log('(no forks recorded)'); return 0 }
  for (const f of forks) {
    console.log(`${f.forkId}\t${f.status}\tport=${f.port ?? '—'}\tpid=${f.pid ?? '—'}\t${f.taskTitle ?? ''}`)
  }
  return 0
}

/**
 * 只读：重启守卫状态 + 授权清单摘要。
 *   有 --url：走 GET /fang/api/restart（验证运行中的宿主是否已载入新 bundle）
 *   无 --url：offline 读 <dataDir>/restart（与 HTTP/UI 同一投影）
 * 两种模式都不触发任何执行。
 */
async function cmdRestartStatus(layout, args) {
  if (args.url) {
    const result = await approvalRequest(args, '/fang/api/restart')
    if (args.json) {
      console.log(JSON.stringify({ status: result.status, ...(result.body ?? {}) }, null, 2))
      return result.status === 200 ? 0 : 1
    }
    if (result.status !== 200) {
      console.error(`HTTP ${result.status}: ${result.body?.error ?? result.text ?? 'restart route unavailable'}`)
      console.error('提示：旧 bundle 没有 /fang/api/restart；需重启 DSH Desktop 载入新代码。')
      return 1
    }
    return printRemoteRestartStatus(result.body)
  }
  const limitArg = Number(args._[1])
  const status = readRestartStatus(layout.dataDir, {
    limit: Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 50,
  })
  if (args.json) {
    console.log(JSON.stringify(status, null, 2))
    return 0
  }
  printLocalRestartStatus(status)
  return 0
}

function printRemoteRestartStatus(body) {
  if (!body || body.ok === false || body.available === false) {
    console.error(`restart-guard unavailable: ${body?.error ?? 'service missing'}`)
    return 1
  }
  const s = body.state ?? {}
  const p = body.policy ?? {}
  const counts = body.approvals?.counts ?? {}
  console.log('restart guard (remote, read-only)')
  const pending = s.pending?.id ? `  (pending ${s.pending.id} risk=${s.pending.risk ?? '?'} phase=${s.pending.phase ?? '?'})` : ''
  console.log(`  state      : ${s.state ?? 'unknown'}${pending}`)
  console.log(`  mode       : ${p.mode ?? '—'}  authMode=${p.authMode ?? '—'}  strictRedLine=${p.strictRedLine === false ? 'false（红灯可自动放行）' : 'true'}`)
  const armedNow = p.mode === 'enforce' && p.allowProcessRestart === true
  console.log(`  armed      : ${armedNow ? 'yes' : 'no'}  (enforce + allowProcessRestart=true)`)
  console.log(`  approvals  : total=${counts.total ?? 0} authorized=${counts.authorized ?? 0} executed=${counts.executed ?? 0} stale=${counts.stale ?? 0} notArmed=${counts.notArmed ?? 0} invalid=${counts.invalid ?? 0}`)
  console.log(`  contract   : decision-only; no execution; executed-proof = receipt execution.executed===true`)
  return 0
}

function printLocalRestartStatus(status) {
  const counts = status.approvals.counts
  console.log(`restart guard @ ${status.stateDir}${exists(status.stateDir) ? '' : '  (不存在：守卫尚未启动或未产生状态)'}`)
  const pending = status.pending?.id ? `  (pending ${status.pending.id} risk=${status.pending.risk ?? '?'} phase=${status.pending.phase ?? '?'})` : ''
  console.log(`  state      : ${status.state}${pending}`)
  console.log(`  state file : ${exists(path.join(status.stateDir, 'state.json')) ? 'present' : 'missing'}${status.stateAt ? `  (at ${fmtTime(status.stateAt)})` : ''}`)
  if (status.lastInterrupted) {
    console.log(`  interrupted: ${status.lastInterrupted.id ?? '?'} previousState=${status.lastInterrupted.previousState ?? '?'} at=${fmtTime(status.lastInterrupted.at)}`)
  }
  console.log(`  approvals  : total=${counts.total} authorized=${counts.authorized} executed=${counts.executed} stale=${counts.stale} notArmed=${counts.notArmed} invalid=${counts.invalid}`)
  if (status.approvals.items.length) {
    console.log(`${'ID'.padEnd(22)} ${'RISK'.padEnd(7)} ${'OUTCOME'.padEnd(11)} ${'STATE'.padEnd(14)} ${'APPROVAL'.padEnd(20)} EXPIRES`)
    for (const item of status.approvals.items) {
      console.log([
        String(item.id ?? '').padEnd(22),
        String(item.risk ?? '').padEnd(7),
        String(item.outcome ?? '').padEnd(11),
        String(item.state ?? '').padEnd(14),
        String(item.approvalId ?? '—').padEnd(20),
        item.expiresAt ? fmtTime(item.expiresAt) : '—',
      ].join(' '))
    }
  } else {
    console.log('  (no approval manifests)')
  }
  console.log('  contract   : decision-only; no execution; executed-proof = receipt execution.executed===true')
}

function cmdDoctor(layout) {
  const checks = []
  const check = (id, ok, detail) => checks.push({ id, ok, detail })

  const [major, minor] = process.versions.node.split('.').map(Number)
  check('node', major >= 22, `node ${process.versions.node}（需要 >= 22 才有 node:test 稳定行为）`)
  check('data-dir', exists(layout.dataDir), layout.dataDir)
  check('roster', exists(layout.forksFile) || true, 'forks.json 可缺省（首次启动创建）')
  if (exists(layout.ledgerFile)) {
    const v = verifyChain(layout.ledgerFile)
    check('ledger', v.ok, `${v.count} 条，${v.ok ? '链完整' : `${v.reason} @${v.badIndex}`}`)
  } else {
    check('ledger', true, '尚未写入（未启动或未产生审计）')
  }

  const profileDir = resolveProfileDir(layout.profileTag)
  check('profile', exists(profileDir), profileDir)
  // Bundle rows do not live in cordis.patch.yml: a bundle is listed in the profile
  // package.json (dsh.profile.bundles) and contributes its own patch layer.
  let pkg = null
  try { pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')) } catch { /* ignore */ }
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const installed = bundles.includes('@local/dsh-fang') || Boolean(pkg?.dependencies?.['@local/dsh-fang'])
  check('bundle-installed', installed, installed ? `profiles/${layout.profileTag} 的 bundles 含 @local/dsh-fang` : 'profile package.json 未列出 @local/dsh-fang（bundle 未安装）')

  const template = resolveProfileDir(layout.profileTag)
  check('fork-template', exists(template), `${template}（分身 profile 模板；可用 config.profileTemplate 覆盖）`)
  const nodeModules = path.join(template, 'node_modules')
  check('template-node_modules', exists(nodeModules), `${nodeModules}（分身通过 junction 共享）`)

  const cliCandidates = ['E:\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd', 'dsh']
  const foundCli = cliCandidates.find(c => c === 'dsh' ? true : exists(c))
  check('dsh-cli', !!foundCli, foundCli === 'dsh' ? '仅在 PATH 中假定可用' : foundCli)

  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(22)} ${c.detail}`)
  const failed = checks.filter(c => !c.ok).length
  console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 项失败（这些项会影响派生/加载，见上）。`)
  return failed === 0 ? 0 : 1
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0] ?? 'status'
const layout = layoutOf(args)

let code = 0
switch (cmd) {
  case 'status': code = cmdStatus(layout); break
  case 'forks': code = cmdForks(layout); break
  case 'restart-status': {
    try { code = await cmdRestartStatus(layout, args) } catch (error) { console.error(String(error?.message ?? error)); code = 1 }
    break
  }
  case 'verify': code = cmdVerify(layout); break
  case 'tail': code = cmdTail(layout, Number(args._[1] ?? 20)); break
  case 'doctor': code = cmdDoctor(layout); break
  case 'approvals': {
    try { code = await cmdApprovals(args) } catch (error) { console.error(String(error?.message ?? error)); code = 1 }
    break
  }
  case 'approve':
  case 'deny': {
    try { code = await cmdDecide(args, cmd === 'approve' ? 'approved' : 'denied') } catch (error) { console.error(String(error?.message ?? error)); code = 1 }
    break
  }
  case 'parse-url': {
    const parsed = parseWebUrl(args._.slice(1).join(' '))
    console.log(JSON.stringify(parsed, null, 2))
    code = parsed ? 0 : 1
    break
  }
  default:
    console.log('usage: fangctl.mjs <status|forks|verify|tail [n]|doctor|restart-status [limit]|parse-url <line>|approvals|approve <source:id>|deny <source:id>> [--profile name] [--data-root dir] [--url url] [--token token] [--note text] [--by who] [--json]')
    code = 64
}
process.exitCode = code
