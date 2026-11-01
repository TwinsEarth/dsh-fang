#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-SDK.
// fangctl — dsh-Fang 离线运维 CLI。
//   node tools/fangctl.mjs status   [--profile <name>] [--data-root <dir>]
//   node tools/fangctl.mjs forks
//   node tools/fangctl.mjs verify            # 校验审计哈希链
//   node tools/fangctl.mjs tail [n]          # 最近 n 条审计
//   node tools/fangctl.mjs doctor            # 环境自检（不修改任何东西）
//
// 离线只读：fork/reap/promote 由宿主内的 orchestrator 服务与 /fang 路由完成，
// 这里不模拟它们，避免"CLI 说成功、宿主没执行"的假象。
import fs from 'node:fs'
import path from 'node:path'

import {
  resolveFangLayout, resolveProfileDir, resolveDshHome, parseWebUrl,
  exists, readJson, readJsonl, isLink, verifyChain, FANG_VERSION,
} from '../src/kernel/index.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile' && argv[i + 1]) { args.profile = argv[++i]; continue }
    if (a.startsWith('--profile=')) { args.profile = a.slice(10); continue }
    if (a === '--data-root' && argv[i + 1]) { args.dataRoot = argv[++i]; continue }
    if (a.startsWith('--data-root=')) { args.dataRoot = a.slice(12); continue }
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
  case 'verify': code = cmdVerify(layout); break
  case 'tail': code = cmdTail(layout, Number(args._[1] ?? 20)); break
  case 'doctor': code = cmdDoctor(layout); break
  case 'parse-url': {
    const parsed = parseWebUrl(args._.slice(1).join(' '))
    console.log(JSON.stringify(parsed, null, 2))
    code = parsed ? 0 : 1
    break
  }
  default:
    console.log('usage: fangctl.mjs <status|forks|verify|tail [n]|doctor|parse-url <line>> [--profile name] [--data-root dir]')
    code = 64
}
process.exitCode = code
