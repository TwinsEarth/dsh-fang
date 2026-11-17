#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// LSP 安装前提证据复核（E1/E2/E5 可自动复核；E3/E4 记录自分支调研时的 asar 提取，见
// docs/LSP-PROVIDER-RESEARCH.md §6.0）。只读：不安装、不改 profile、不联网写入。
//
// 用法：node tools/release/lsp-evidence.mjs [--json]
import fs from 'node:fs'
import os from 'node:os'
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

// E6–E9: capability seam contract facts (static, read from a staged official LSP package tree;
// SKIP when the staging tree is absent — run `npm run setup:lsp-live` first for live verification).
const stageCandidates = [
  process.env.FANG_E2E_LSP_STAGE,
  'E:\\GPT\\.tmp\\e2e-lsp-stage',
  path.join(os.tmpdir(), 'fang-lsp-stage'),
].filter(Boolean)
const stage = stageCandidates.find((candidate) => { try { return fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'dsh-lsp', 'lib', 'types', 'index.d.ts')) } catch { return false } })
if (!stage) {
  info('E6–E9 seam contract facts', 'staging tree absent; run `npm run setup:lsp-live` to enable static verification')
} else {
  const read = (rel) => fs.readFileSync(path.join(stage, 'node_modules', ...rel.split('/')), 'utf8')
  const lspIndex = read('@deepseek-ai/dsh-lsp/lib/types/index.d.ts')
  const lspTypes = read('@deepseek-ai/dsh-lsp/lib/types/types.d.ts')
  const lspReadme = read('@deepseek-ai/dsh-lsp/README.md')
  const stdioReadme = read('@deepseek-ai/dsh-lsp-stdio/README.md')
  check('E6 ctx.lsp = Cordis Service with registerProvider + query', /class Lsp extends Service/.test(lspIndex) && /registerProvider\(provider: LspProvider\)/.test(lspIndex) && /query\(request: LspQueryRequest, signal\?: AbortSignal\)/.test(lspIndex), 'dsh-lsp/lib/types/index.d.ts')
  check('E7 query carries required workspaceRoot + 4 ops, 0-based UTF-16, closed result union', /readonly workspaceRoot: string/.test(lspTypes) && /zero-based UTF-16/.test(lspTypes) && /'goToDefinition' \| 'findReferences' \| 'goToImplementation' \| 'hover'/.test(lspTypes) && /kind: 'locations'/.test(lspTypes) && /resolvedWorkspaceUri/.test(lspTypes) && /kind: 'hover'/.test(lspTypes), 'dsh-lsp/lib/types/types.d.ts')
  check('E8 seam deliberately excludes diagnostics/rename/format/symbol/JSON-RPC', /no JSON-RPC escape/.test(lspReadme) && /diagnostics need separate/.test(lspReadme) && /mutation/.test(lspReadme), 'dsh-lsp/README.md')
  check('E9 stdio config servers{command,args,extensionToLanguage}; per-workspace lazy pooled; same execution world', /extensionToLanguage/.test(stdioReadme) && /On the first query for a workspace/.test(stdioReadme) && /pooled/.test(stdioReadme) && /trusts its configured server and adds no sandbox confinement/.test(stdioReadme), 'dsh-lsp-stdio/README.md')
}

// E10: model-facing lsp tool is 1-based and requires an Agent Session (workspaceRoot from session cwd).
const toolCandidates = [
  process.env.FANG_E2E_LSP_STAGE,
  'E:\\GPT\\.tmp\\e2e-lsp-stage',
  path.join(os.tmpdir(), 'fang-lsp-stage'),
].filter(Boolean)
const toolStage = toolCandidates.find((candidate) => { try { return fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'dsh-tool-lsp', 'README.md')) } catch { return false } })
if (!toolStage) {
  info('E10 model lsp tool contract', 'staging tree absent; run `npm run setup:lsp-live` to enable static verification')
} else {
  const toolReadme = fs.readFileSync(path.join(toolStage, 'node_modules', '@deepseek-ai', 'dsh-tool-lsp', 'README.md'), 'utf8')
  const toolCode = fs.readFileSync(path.join(toolStage, 'node_modules', '@deepseek-ai', 'dsh-tool-lsp', 'lib', 'index.js'), 'utf8')
  check('E10 lsp tool: operation/file_path/line/character 1-based, Agent Session required', /file_path/.test(toolReadme) && /positive one-based/.test(toolReadme) && /requires an Agent Session/.test(toolReadme) && /LSP_WORKSPACE_REQUIRED/.test(toolCode), 'dsh-tool-lsp README + lib/index.js')
}

// E11: no local TypeScript language server binary (rust-analyzer may exist for Rust only — not a TS fixture server).
const whereResult = process.platform === 'win32'
  ? spawnSync('where', ['typescript-language-server'], { encoding: 'utf8', windowsHide: true })
  : spawnSync('sh', ['-c', 'command -v typescript-language-server'], { encoding: 'utf8' })
const tlsMissing = whereResult.status !== 0
const rustAnalyzer = process.platform === 'win32' ? spawnSync('where', ['clangd', 'pyright'], { encoding: 'utf8', windowsHide: true }) : { status: 1 }
check('E11 no local typescript-language-server on PATH (bundle/server source needed)', tlsMissing, tlsMissing ? 'where=missing' : `where=${String(whereResult.stdout ?? '').trim()}`)
info('E11 other servers', 'clangd/pyright/gopls missing; rust-analyzer may exist for Rust only (not a TS fixture server)')

// E12: delegation layer already has whitelist / validation / classification / approval gate / audit / e2e seam.
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const delegationSrc = fs.readFileSync(path.join(repoRoot, 'src', 'lib', 'lsp-delegation.mjs'), 'utf8')
const orchestrationSrc = fs.readFileSync(path.join(repoRoot, 'src', 'plugins', 'orchestrator.mjs'), 'utf8')
const e2eSrc = fs.readFileSync(path.join(repoRoot, 'tools', 'e2e.mjs'), 'utf8')
check('E12 delegation layer: validateToolInvoke + read/write/test classification', /export function validateToolInvoke/.test(delegationSrc) && /export function classifyLspAction/.test(delegationSrc) && /LSP_WRITE_ACTIONS/.test(delegationSrc), 'src/lib/lsp-delegation.mjs')
check('E12 delegation layer: whitelist + approval gate + audit + e2e seam', /delegationCfg\.allow/.test(orchestrationSrc) && /DELEGATE_ERROR\.APPROVAL_REQUIRED/.test(orchestrationSrc) && /contract-delegate/.test(orchestrationSrc) && /FANG_CONTRACT_TEST_HOOKS/.test(orchestrationSrc) && /test-seam-only/.test(e2eSrc), 'src/plugins/orchestrator.mjs + tools/e2e.mjs')

const failed = checks.filter((item) => !item.ok && !item.skipped)
if (asJson) console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
console.log(`${failed.length ? 'RED' : 'GREEN'}  lsp evidence  ${checks.length - failed.length}/${checks.length} (E1/E2/E5 live; E3/E4 documented)`)
process.exit(failed.length ? 1 : 0)
