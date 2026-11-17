// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// LSP provider bundle 完整性：配置型 bundle 的依赖/挂载行/决策文档必须与契约口径一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'lsp-provider')
const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')
const readme = fs.readFileSync(path.join(BUNDLE, 'README.md'), 'utf8')

test('lsp bundle: config-only package with pinned official LSP stack + language server', () => {
  assert.equal(pkg.name, '@twinsearth/dsh-fang-lsp')
  assert.equal(pkg.private, true)
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-lsp'], '0.2.2-rc.3')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-lsp-stdio'], '0.2.2-rc.3')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-tool-lsp'], '0.2.2-rc.3')
  assert.equal(pkg.dependencies.typescript, '5.9.3', 'TS must stay 5.x: TS 7 native preview has no lib/typescript.js')
  assert.ok(pkg.dependencies['typescript-language-server'])
})

test('lsp bundle: patch inserts seam + stdio provider + model-facing tool (route A composition)', () => {
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id: fang-lsp-seam\s*\n\s*name: '@deepseek-ai\/dsh-lsp'/)
  assert.match(patch, /id: fang-lsp-stdio\s*\n\s*name: '@deepseek-ai\/dsh-lsp-stdio'/)
  assert.match(patch, /id: fang-lsp-tool\s*\n\s*name: '@deepseek-ai\/dsh-tool-lsp'/)
  assert.match(patch, /servers:/)
  assert.match(patch, /extensionToLanguage:/)
  assert.match(patch, /'\.ts': typescript/)
  assert.match(patch, /typescript-language-server/)
})

test('lsp bundle: read-only contract scope documented (no write mutations advertised)', () => {
  assert.match(readme, /写类 LSP（rename\/format）.*不提供/)
  assert.match(readme, /路线 A/)
  assert.match(readme, /路线 B/)
  assert.match(readme, /母体根 \+ 所有 fork 工作区根/)
  assert.match(readme, /includeForkWorktrees/)
  assert.match(readme, /dsh-tool-lsp/)
  assert.doesNotMatch(patch, /(?:rename|codeAction|apply)\s*:/, 'bundle must not wire write-class LSP operations')
})
