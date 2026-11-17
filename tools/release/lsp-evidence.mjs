#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// LSP 安装前提证据复核（E1/E2/E5 可自动复核；E3/E4 记录自分支调研时的 asar 提取，见
// docs/LSP-PROVIDER-RESEARCH.md §6.0）。只读：不安装、不改 profile、不联网写入。
//
// 用法：node tools/release/lsp-evidence.mjs [--json]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const asJson = process.argv.includes('--json')
const checks = []
const check = (id, ok, detail) => { checks.push({ id, ok: Boolean(ok), detail }); if (!asJson) console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(46)} ${detail}`) }
const info = (id, detail) => { checks.push({ id, ok: true, skipped: true, detail }); if (!asJson) console.log(`SKIP  ${id.padEnd(46)} ${detail}`) }

function nth(process, args, timeout = 120000) {
  const result = spawnSync(process, args, { encoding: 'utf8', timeout, shell: process.endsWith('.cmd'), windowsHide: true })
  return { status: result.status, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '').trim() }
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// E1: 运行版本 = 0.2.2-rc.3（Desktop asar 安装的 CLI 版本）
const CLI_CANDIDATES = [process.env.DSH_CLI_PATH, 'E:\\DSH\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd', 'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'].filter(Boolean)
const CLI = CLI_CANDIDATES.find((candidate) => { try { return fs.existsSync(candidate) } catch { return false } })
const version = CLI ? nth(CLI, ['--version']) : { status: -1, stdout: '', stderr: 'dsh CLI not found' }
check('E1 installed DSH runtime = 0.2.2-rc.3', /^0\.2\.2-rc\.3$/.test(version.stdout), version.stdout || version.stderr)

// E2: 官方 LSP 包在 npm 有 0.2.2-rc.3；latest tag 只指向 0.0.1-rc.1（必须显式按版本安装）
const officialVersions = nth(npm, ['view', '@deepseek-ai/dsh-lsp', 'versions', '--json'])
let versionList = []
try { versionList = JSON.parse(officialVersions.stdout) } catch { versionList = [] }
const officialLatest = nth(npm, ['view', '@deepseek-ai/dsh-lsp', 'dist-tags.latest'])
check('E2 @deepseek-ai/dsh-lsp has 0.2.2-rc.3 (explicit version needed)', Array.isArray(versionList) && versionList.includes('0.2.2-rc.3'), `latest=${officialLatest.stdout || '?'}`)
info('E3 desktop install ships no LSP trio', 'prior asar extraction: 331 @deepseek-ai packages, no dsh-lsp*; official bundles have no LSP optional bundle (docs §6.0)')
info('E4 LSP host deps exist in mother install', 'prior asar extraction: dsh-fs-local / dsh-subprocess-local / dsh-working-directory present (docs §6.0)')

// E5: 加速核 npm 已发布同版本 trio（3.5.0），但本机加速 CLI 未安装
const fork = ['@twinsearth/dsh-lsp', '@twinsearth/dsh-lsp-stdio', '@twinsearth/dsh-tool-lsp'].map((name) => ({ name, version: nth(npm, ['view', name, 'version']).stdout }))
const forkOk = fork.every((item) => /^\d+\.\d+\.\d+$/.test(item.version))
const accelRoot = process.env.FANG_ACCEL_CLI_PATH ? path.dirname(process.env.FANG_ACCEL_CLI_PATH) : 'D:\\ToFuture\\accel\\cli'
const accelScope = path.join(accelRoot, 'node_modules', '@twinsearth')
const accelLsp = fs.existsSync(accelScope) ? fs.readdirSync(accelScope).filter((name) => /^dsh-lsp/.test(name)) : []
check('E5 accelerated core has same-version LSP trio on npm', forkOk, fork.map((item) => `${item.name}@${item.version}`).join(' '))
check('E5 accelerated CLI does not ship LSP trio locally', accelLsp.length === 0, `accelScope=${accelScope} found=[${accelLsp.join(',')}]`)

const failed = checks.filter((item) => !item.ok && !item.skipped)
if (asJson) console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
console.log(`${failed.length ? 'RED' : 'GREEN'}  lsp evidence  ${checks.length - failed.length}/${checks.length} (E1/E2/E5 live; E3/E4 documented)`)
process.exit(failed.length ? 1 : 0)
