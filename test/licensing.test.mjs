// SPDX-License-Identifier: AGPL-3.0-or-later
// 许可分层的回归测试：文件存在、SPDX 标注不缺、package.json 许可字段、第三方归属。
// 这是"防止许可漂移"的自动闸门 —— 新文件没标 SPDX、或把商业层代码混进开源层，都会在这里红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

function walk(dir, filter, out = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, out)
    else if (filter(p)) out.push(p)
  }
  return out
}
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/')
const isCode = (p) => /\.(mjs|js|cs|ps1)$/.test(p)

test('licensing: the five license artefacts exist and are the right documents', () => {
  for (const f of ['LICENSE-CORE', 'LICENSE-SDK', 'LICENSE-COMMERCIAL', 'CLA.md', 'NOTICE', 'docs/LICENSING.md']) {
    assert.ok(exists(f), `${f} must exist`)
  }
  const core = read('LICENSE-CORE')
  assert.ok(core.length > 30_000, `LICENSE-CORE must be the full AGPL text (got ${core.length} bytes)`)
  assert.match(core, /GNU AFFERO GENERAL PUBLIC LICENSE/)
  assert.match(core, /Version 3, 19 November 2007/)
  assert.match(read('LICENSE-SDK'), /MIT License/)
  assert.match(read('CLA.md'), /再许可|relicense/)
  assert.match(read('CLA.md'), /商业闭源许可|commercial/)
  assert.match(read('LICENSE-COMMERCIAL'), /商业许可/)
  assert.ok(exists('LICENSES/cordis-MIT.txt'), 'vendored third-party attribution')
})

test('licensing: package.json declares AGPL and ships the license files', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.license, 'AGPL-3.0-or-later')
  for (const f of ['LICENSE-CORE', 'LICENSE-SDK', 'LICENSE-COMMERCIAL', 'NOTICE', 'CLA.md']) {
    assert.ok((pkg.files ?? []).includes(f), `package.json files must ship ${f}`)
  }
})

test('licensing: every core source file carries the AGPL SPDX header', () => {
  const files = [
    path.join(ROOT, 'client.js'),
    ...walk(path.join(ROOT, 'src'), isCode),
    ...walk(path.join(ROOT, 'probes'), isCode),
    ...walk(path.join(ROOT, 'test'), isCode),
    ...walk(path.join(ROOT, 'tools'), isCode),
  ].filter((p) => !p.includes(`${path.sep}vendor${path.sep}`))
    .filter((p) => !p.endsWith('fangctl.mjs'))
  for (const f of files) {
    const head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 4).join('\n')
    assert.match(head, /SPDX-License-Identifier: AGPL-3\.0-or-later/, `${rel(f)} must declare AGPL`)
  }
})

test('licensing: vendored cordis files keep their upstream MIT and attribution', () => {
  for (const name of ['schemastery.mjs', 'cosmokit.mjs']) {
    const head = read(`src/kernel/vendor/${name}`).split('\n').slice(0, 5).join('\n')
    assert.match(head, /SPDX-License-Identifier: MIT/, `${name} must stay MIT`)
    assert.match(head, /Shigma|cordis/, `${name} must attribute the upstream project`)
  }
})

test('licensing: the ecosystem layer is MIT (SDK, template, example, CLI)', () => {
  const mit = [
    'tools/fangctl.mjs',
    'sdk/README.md',
    'sdk/templates/plugin/index.js',
    'sdk/templates/plugin/client.js',
    'sdk/examples/status-badge/index.js',
    'sdk/examples/status-badge/client.js',
  ]
  for (const f of mit) {
    const text = read(f)
    if (f.endsWith('.js') || f.endsWith('.mjs')) {
      assert.match(text.split('\n').slice(0, 4).join('\n'), /SPDX-License-Identifier: MIT/, `${f} must be MIT`)
    }
  }
  for (const f of walk(path.join(ROOT, 'sdk'), isCode)) {
    const head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 4).join('\n')
    assert.match(head, /SPDX-License-Identifier: MIT/, `${rel(f)} must be MIT (ecosystem layer)`)
  }
  const tpl = JSON.parse(read('sdk/templates/plugin/package.json'))
  assert.equal(tpl.license, 'MIT')
  assert.ok(tpl.dsh?.bundle?.patch, 'template is a real bundle')
  const ex = JSON.parse(read('sdk/examples/status-badge/package.json'))
  assert.equal(ex.license, 'MIT')
})

test('licensing: the commercial layer is not open source and carries commercial terms', () => {
  for (const dir of ['relay-server', 'enterprise']) {
    const text = read(`${dir}/README.md`)
    assert.match(text, /不是开源软件/, `${dir} must say it is not open source`)
    assert.match(text, /LICENSE-COMMERCIAL|商业许可/, `${dir} must point at commercial terms`)
  }
  // commercial code must not exist inside the open-source package tree
  const shipped = walk(path.join(ROOT, 'src'), isCode).map(rel)
  assert.equal(shipped.some((f) => f.includes('relay-server') || f.includes('enterprise')), false)
})

test('licensing: bundle YAML headers and NOTICE layer map are present', () => {
  for (const f of ['cordis.patch.yml', 'cordis.patch.single-row.yml']) {
    assert.match(read(f).split('\n').slice(0, 3).join('\n'), /SPDX-License-Identifier: AGPL-3\.0-or-later/, `${f} header`)
  }
  const notice = read('NOTICE')
  for (const token of ['AGPL-3.0', 'MIT', 'LICENSE-COMMERCIAL', 'src/plugins', 'sdk/', 'relay-server/', 'probes/']) {
    assert.ok(notice.includes(token), `NOTICE must mention ${token}`)
  }
})

test('licensing: the boundary analysis documents the process-boundary migration', () => {
  const doc = read('docs/LICENSING.md')
  assert.match(doc, /进程边界/)
  assert.match(doc, /fangd/)
  assert.match(doc, /MIT bridge|bridge/i)
  assert.match(doc, /不是法律意见/)
})
