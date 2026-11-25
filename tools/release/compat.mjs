// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/compat.mjs — 跨 Node 版本的加载/兼容检查（可在 Linux CI 上跑，不执行 Windows-only 逻辑）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ROOT, readJson, readText } from './lib.mjs'

const checks = []
const add = (id, ok, detail = '') => checks.push({ id, ok, detail })
const pkg = readJson('package.json')
const major = Number(process.versions.node.split('.')[0])
add('engines: node >= 22', major >= 22, process.versions.node)
add('module: package type=module', pkg.type === 'module', String(pkg.type))

const modules = [
  'src/kernel/index.mjs',
  'src/lib/remote.mjs',
  'src/lib/container/index.mjs',
  'src/lib/session-format.mjs',
  ...fs.readdirSync(path.join(ROOT, 'src/plugins')).filter((f) => f.endsWith('.mjs') && f !== 'imports.mjs').map((f) => 'src/plugins/' + f),
]
for (const rel of modules) {
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, rel)).href)
    const ok = rel.includes('/plugins/') ? typeof mod.apply === 'function' : Object.keys(mod).length > 0
    add(`import: ${rel}`, ok)
  } catch (e) {
    add(`import: ${rel}`, false, String(e?.message ?? e).slice(0, 160))
  }
}

const clientCode = readText('client.js')
const clientSyntax = spawnSync(process.execPath, ['--check', path.join(ROOT, 'client.js')], { encoding: 'utf8' })
// client.js is a factory module (UMD-style `factory(require)`), not a top-level ESM module.
add('client: browser half parses cleanly', clientSyntax.status === 0 && !/^\s*(?:import|export)\s/m.test(clientCode), (clientSyntax.stderr ?? '').slice(0, 160))
add('license: AGPL declared', pkg.license === 'AGPL-3.0-or-later', String(pkg.license))

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(52)} ${c.detail}`)
const ok = checks.every((c) => c.ok)
console.log(`\n${ok ? 'COMPATIBLE' : 'INCOMPATIBLE'}  node ${process.versions.node} (${modules.length} modules)`)
process.exitCode = ok ? 0 : 1
