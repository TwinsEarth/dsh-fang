// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// 路线 B（fork-local）bundle 完整性：依赖域必须是 @twinsearth 3.5.0，默认关闭，不经过契约委托。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'lsp-provider-fork')
const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')
const patchBody = patch.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
const readme = fs.readFileSync(path.join(BUNDLE, 'README.md'), 'utf8')

test('fork lsp bundle: accelerated-core dependency domain (@twinsearth 3.5.0 trio, pinned TS + language server)', () => {
  assert.equal(pkg.name, '@twinsearth/dsh-fang-lsp-fork')
  assert.equal(pkg.private, true)
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dependencies['@twinsearth/dsh-lsp'], '3.5.0')
  assert.equal(pkg.dependencies['@twinsearth/dsh-lsp-stdio'], '3.5.0')
  assert.equal(pkg.dependencies['@twinsearth/dsh-tool-lsp'], '3.5.0')
  assert.equal(pkg.dependencies['typescript-language-server'], '6.1.0', 'language server pinned exactly')
  assert.equal(pkg.dependencies.typescript, '5.9.3')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-lsp'], undefined, 'fork variant must not mix official 0.2.2-rc.3 packages')
})

test('fork lsp bundle: patch mounts @twinsearth seam/provider/tool (fork-local, no contract delegation)', () => {
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id: fang-lsp-fork-seam\s*\n\s*name: '@twinsearth\/dsh-lsp'/)
  assert.match(patch, /id: fang-lsp-fork-stdio\s*\n\s*name: '@twinsearth\/dsh-lsp-stdio'/)
  assert.match(patch, /id: fang-lsp-fork-tool\s*\n\s*name: '@twinsearth\/dsh-tool-lsp'/)
  assert.match(patch, /servers:/)
  assert.match(patch, /extensionToLanguage:/)
  assert.doesNotMatch(patchBody, /@deepseek-ai/, 'fork profile resolves the accelerated @twinsearth scope')
  assert.doesNotMatch(patchBody, /(?:rename|codeAction|apply|format)\s*:/, 'read-only composition only')
})

test('fork lsp bundle: install is OFF by default and documented as local (not delegated)', () => {
  assert.match(readme, /路线 B/)
  assert.match(readme, /默认关闭/)
  assert.match(readme, /不经过契约委托/)
  assert.match(readme, /@twinsearth\/dsh-lsp@3\.5\.0/)
  assert.match(readme, /fork-local/)
  assert.match(readme, /provider: 'mother' \| 'fork-local'/)
})
