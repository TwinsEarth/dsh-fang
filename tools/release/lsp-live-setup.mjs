#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 路线 A 真实 LSP e2e 的依赖准备：把官方 LSP 三件套 + typescript-language-server + TypeScript 5
// 安装到一个隔离 staging 目录（不写用户 profile、不装进 dsh 安装）。
// 之后运行：node tools/e2e.mjs --lsp（或 npm run test:lsp-live）。
//
// Usage: node tools/release/lsp-live-setup.mjs [--stage <dir>]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? String(argv[index + 1] ?? '') : fallback
}
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
const STAGE = arg('stage', process.env.FANG_E2E_LSP_STAGE || path.join(repoRoot, 'scratch', 'e2e-lsp-stage'))
const PACKAGES = [
  '@deepseek-ai/dsh-lsp@0.2.2-rc.3',
  '@deepseek-ai/dsh-lsp-stdio@0.2.2-rc.3',
  '@deepseek-ai/dsh-tool-lsp@0.2.2-rc.3',
  'typescript-language-server@6.1.0',
  'typescript@5.9.3', // tls needs TS 5.x layout (TS 7 native preview has no lib/typescript.js)
]
fs.mkdirSync(STAGE, { recursive: true })
const pkgFile = path.join(STAGE, 'package.json')
if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, `${JSON.stringify({ name: 'fang-lsp-live-stage', private: true }, null, 2)}\n`)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npm, ['install', '--no-save', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', ...PACKAGES], {
  cwd: STAGE,
  stdio: 'inherit',
  shell: true,
  windowsHide: true,
})
if (result.status !== 0) { console.error(`FAIL lsp stage install exit=${result.status}`); process.exit(result.status ?? 1) }
const required = ['@deepseek-ai/dsh-lsp', '@deepseek-ai/dsh-lsp-stdio', '@deepseek-ai/dsh-tool-lsp', 'typescript-language-server', 'typescript']
const missing = required.filter((name) => !fs.existsSync(path.join(STAGE, 'node_modules', ...name.split('/'))))
if (missing.length) { console.error(`FAIL missing staged packages: ${missing.join(', ')}`); process.exit(1) }
console.log(`PASS lsp live stage ready: ${STAGE}`)
console.log('next: node tools/e2e.mjs --lsp   (or npm run test:lsp-live)')
