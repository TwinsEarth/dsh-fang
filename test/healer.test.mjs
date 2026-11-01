// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T2 — fangHealer 测试：selfCheck / evidence / G1–G12 门禁（pass+fail+unknown 阻断）/ suggestFix / 不写盘。
// 静态 fixture 在 test/fixtures/t2/{clean-plugin,risky-plugin}；边界目录用 mkdtemp 现场生成。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers.mjs'
import { SERVICE, AUDIT, removeTree, digestTree, sha256 } from '../src/kernel/index.mjs'
import * as healer from '../src/plugins/healer.mjs'
// v2 deployment matrix: this plugin is fork-only; pin the role before apply().
process.env.DSH_FANG_ROLE = 'fork'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 't2')
const CLEAN = path.join(FIXTURES, 'clean-plugin')
const RISKY = path.join(FIXTURES, 'risky-plugin')

const tmpRoots = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-t2-healer-'))
  tmpRoots.push(dir)
  return dir
}
function writePluginDir(pkg, files = {}) {
  const dir = tempDir()
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  for (const [rel, src] of Object.entries(files)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, src, 'utf8')
  }
  return dir
}
after(() => { for (const d of tmpRoots) removeTree(d) })

function fresh(config = {}) {
  const ctx = makeCtx()
  healer.apply(ctx, healer.Config(config))
  return { ctx, service: ctx.get(SERVICE.healer) }
}
const CLEAN_MIN_SRC = "export const inject = []\nexport function apply(ctx) { ctx.effect(() => ctx.provide('svc', {})) }\n"
const FACTS = { application: 'applied', observedAt: Date.now() + 60_000, signals: [], score: 0, digest: 'deadbeef' }

test('registers fangHealer service with all contract methods', () => {
  const { service, ctx } = fresh()
  assert.equal(healer.name, 'fang-healer')
  assert.ok(Array.isArray(healer.inject) && healer.inject.length === 0)
  assert.equal(typeof service.selfCheck, 'function')
  assert.equal(typeof service.evidence, 'function')
  assert.equal(typeof service.gates, 'function')
  assert.equal(typeof service.suggestFix, 'function')
  assert.equal(service.policy.blockingOnUnknown, true)
  assert.deepEqual(service.policy.reservedIds, [])
  ctx.dispose()
})

test('selfCheck(clean) is ok: only info/warn findings, grade A', () => {
  const { service, ctx } = fresh()
  const out = service.selfCheck(CLEAN)
  assert.equal(out.ok, true)
  assert.equal(out.grade, 'A')
  assert.equal(out.dir, path.resolve(CLEAN))
  assert.ok(Array.isArray(out.findings) && out.findings.length >= 3)
  assert.equal(out.findings.some(f => f.level === 'block'), false)
  assert.ok(out.findings.some(f => f.id === 'entry-ok'))
  assert.ok(out.findings.some(f => f.id === 'inject-minimal'))
  assert.ok(out.findings.some(f => f.id === 'effect-ok'))
  ctx.dispose()
})

test('selfCheck(risky) reports block findings: effect/deps/inject/timer', () => {
  const { service, ctx } = fresh()
  const out = service.selfCheck(RISKY)
  assert.equal(out.ok, false)
  assert.equal(out.grade, 'B', 'child_process alone gives S=28 → B')
  const ids = out.findings.map(f => f.id)
  assert.ok(ids.includes('no-effect-wrap'))
  assert.ok(ids.includes('deps-not-allowed'))
  assert.ok(ids.includes('inject-missing'))
  assert.ok(ids.includes('bare-timer'))
  const deps = out.findings.find(f => f.id === 'deps-not-allowed')
  assert.deepEqual(deps.evidence.deps.sort(), ['express', 'left-pad'])

  // 一个什么都没有的模块：no-effect-wrap 与 no-provide 必须同时阻断
  const hollow = writePluginDir(
    { name: '@local/t2-hollow', version: '1.0.0', type: 'module' },
    { 'index.js': 'export const inject = []\nexport function apply() {}\n' },
  )
  const hollowIds = service.selfCheck(hollow).findings.map(f => f.id)
  assert.ok(hollowIds.includes('no-effect-wrap'))
  assert.ok(hollowIds.includes('no-provide'))
  ctx.dispose()
})

test('selfCheck on a manifest-less dir and on a hotReload=false plugin', () => {
  const { service, ctx } = fresh()
  const empty = tempDir()
  const out = service.selfCheck(empty)
  assert.equal(out.ok, false)
  assert.equal(out.grade, 'E')
  assert.ok(out.findings.some(f => f.id === 'manifest-missing' && f.level === 'block'))
  assert.ok(out.findings.some(f => f.id === 'entry-missing' && f.level === 'block'))

  const vetoed = writePluginDir(
    { name: '@local/t2-veto', version: '1.0.0', type: 'module', dsh: { hotReload: false } },
    { 'index.js': CLEAN_MIN_SRC },
  )
  const veto = service.selfCheck(vetoed)
  assert.equal(veto.grade, 'E')
  assert.equal(veto.ok, true, 'veto is a warning in selfCheck; hard stop happens in gates/router')
  assert.ok(veto.findings.some(f => f.id === 'hotreload-veto' && f.level === 'warn'))
  ctx.dispose()
})

test('gates(clean): 12 gates, static pass; host-fact gates deferred at load stage', () => {
  const { service, ctx } = fresh()
  const gs = service.gates(CLEAN)
  assert.equal(gs.gates.length, 12)
  assert.deepEqual(gs.gates.map(g => g.id), healer.GATE_IDS)
  assert.deepEqual(gs.gates.map(g => g.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12'])
  assert.equal(gs.pass, true, 'static pre-load check passes for a clean plugin')
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9']) {
    assert.equal(gs.gates.find(g => g.id === id).verdict, 'pass', `${id} should pass on the clean fixture`)
  }
  const g10 = gs.gates.find(g => g.id === 'G10')
  assert.equal(g10.verdict, 'skip')
  assert.equal(g10.ok, true, 'skip is not a block')
  const g11 = gs.gates.find(g => g.id === 'G11')
  const g12 = gs.gates.find(g => g.id === 'G12')
  assert.equal(g11.verdict, 'skip', 'activation is only observable after load')
  assert.equal(g12.verdict, 'skip')
  assert.equal(g11.ok, true)
  assert.equal(g12.ok, true)
  assert.equal(gs.summary.skip, 3)
  ctx.dispose()
})

test('gates(clean, {stage:"promote"}) fails closed on missing host facts', () => {
  const { service, ctx } = fresh()
  const gs = service.gates(CLEAN, { stage: 'promote' })
  assert.equal(gs.pass, false, 'no host facts → UNKNOWN must block at promote stage')
  const g11 = gs.gates.find(g => g.id === 'G11')
  const g12 = gs.gates.find(g => g.id === 'G12')
  assert.equal(g11.verdict, 'unknown')
  assert.equal(g12.verdict, 'unknown')
  assert.equal(g11.ok, false)
  assert.equal(g12.ok, false)
  assert.equal(gs.summary.unknown, 2)
  ctx.dispose()
})

test('gates(clean, {stage:"promote", facts}) passes once host evidence is supplied', () => {
  const { service, ctx } = fresh()
  const gs = service.gates(CLEAN, { stage: 'promote', facts: FACTS })
  assert.equal(gs.pass, true)
  assert.equal(gs.summary.fail, 0)
  assert.equal(gs.summary.unknown, 0)
  assert.equal(gs.gates.find(g => g.id === 'G11').verdict, 'pass')
  assert.equal(gs.gates.find(g => g.id === 'G12').verdict, 'pass')
  ctx.dispose()
})

test('gates(clean, {stage:"promote"}) can be non-blocking on UNKNOWN when configured', () => {
  const { service, ctx } = fresh({ blockingOnUnknown: false })
  const gs = service.gates(CLEAN, { stage: 'promote' })
  assert.equal(gs.pass, true)
  assert.equal(gs.blockingOnUnknown, false)
  assert.equal(gs.gates.find(g => g.id === 'G11').verdict, 'unknown')
  assert.equal(gs.gates.find(g => g.id === 'G11').ok, true)
  ctx.dispose()
})

test('gates(risky) fails G3/G4/G5/G6/G8/G9 with evidence', () => {
  const { service, ctx } = fresh()
  const gs = service.gates(RISKY)
  assert.equal(gs.pass, false)
  assert.equal(gs.gates.find(g => g.id === 'G1').verdict, 'pass')
  assert.equal(gs.gates.find(g => g.id === 'G2').verdict, 'pass')
  for (const id of ['G3', 'G4', 'G5', 'G6', 'G8', 'G9']) {
    const gate = gs.gates.find(g => g.id === id)
    assert.equal(gate.verdict, 'fail', `${id} should fail on the risky fixture`)
    assert.equal(gate.ok, false)
  }
  const g5 = gs.gates.find(g => g.id === 'G5')
  assert.deepEqual(g5.disallowed.sort(), ['express', 'left-pad'])
  const g3 = gs.gates.find(g => g.id === 'G3')
  assert.ok(Array.isArray(g3.sites) && g3.sites.length >= 1)
  const g4 = gs.gates.find(g => g.id === 'G4')
  assert.ok(Array.isArray(g4.imports) && g4.imports.length === 1)
  ctx.dispose()
})

test('gates fail closed on missing entry and on dishonest exemption', () => {
  const { service, ctx } = fresh()
  const noEntry = writePluginDir({ name: '@local/t2-noentry', version: '1.0.0', type: 'module' })
  const gs = service.gates(noEntry)
  assert.equal(gs.pass, false)
  assert.equal(gs.gates.find(g => g.id === 'G2').verdict, 'fail')
  assert.equal(gs.gates.find(g => g.id === 'G3').verdict, 'unknown')
  assert.equal(gs.gates.find(g => g.id === 'G3').ok, false, 'unknown blocks by default')

  const dishonest = writePluginDir(
    { name: '@local/t2-accept-risk', version: '1.0.0', type: 'module', dsh: { acceptRisk: true } },
    { 'index.js': CLEAN_MIN_SRC },
  )
  const g7 = service.gates(dishonest).gates.find(g => g.id === 'G7')
  assert.equal(g7.verdict, 'fail')
  assert.match(g7.detail, /acceptRisk/)
  ctx.dispose()
})

test('evidence(clean) is structured JSON with contract sections', () => {
  const { service, ctx } = fresh()
  const ev = service.evidence(CLEAN)
  assert.deepEqual(Object.keys(ev).sort(), ['checks', 'entry', 'files', 'imports', 'plugin', 'resources'])
  assert.equal(ev.plugin.name, '@local/fang-fixture-clean')
  assert.equal(ev.entry.rel, 'index.js')
  assert.ok(ev.files.includes('index.js'))
  assert.ok(ev.files.includes('package.json'))
  const onDisk = fs.readFileSync(path.join(CLEAN, 'index.js'), 'utf8')
  assert.equal(ev.entry.sha256, sha256(onDisk))
  assert.equal(ev.imports.items.length, 1)
  assert.equal(ev.imports.coverage, 'import-only')
  assert.equal(ev.resources.hasEffect, true)
  assert.equal(ev.checks.gates.length, 12)
  assert.ok(ev.checks.selfCheck.some(c => c.id === 'entry-ok'))
  ctx.dispose()
})

test('suggestFix(risky) returns patches and writes nothing to disk', () => {
  const { service, ctx } = fresh()
  const before = digestTree(RISKY)
  const out = service.suggestFix(RISKY)
  const after = digestTree(RISKY)
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'suggestFix must not touch the plugin dir')
  assert.equal(out.applied, false)
  assert.ok(Array.isArray(out.patches) && out.patches.length >= 4)
  for (const p of out.patches) {
    assert.equal(typeof p.target, 'string')
    assert.ok(p.target.length > 0)
    assert.equal(typeof p.yaml, 'string')
    assert.ok(p.yaml.length > 0)
    assert.equal(typeof p.why, 'string')
    assert.ok(p.why.length > 0)
  }
  const targets = new Set(out.patches.map(p => p.target))
  assert.ok(targets.has('cordis.patch.yml'), 'dependency allow-list patch targets cordis.patch.yml')
  assert.ok(targets.has('index.js'), 'code-shape patches target the entry file')
  const depPatch = out.patches.find(p => p.why.startsWith('G5'))
  assert.ok(depPatch.yaml.includes('left-pad'))
  assert.equal(out.before.grade, 'B')
  assert.equal(out.after.grade, 'A', 'projected grade after removing child_process')
  assert.equal(typeof out.after.note, 'string')
  ctx.dispose()
})

test('suggestFix(clean) has no patches and preserves the grade', () => {
  const { service, ctx } = fresh()
  const out = service.suggestFix(CLEAN)
  assert.deepEqual(out.patches, [])
  assert.equal(out.before.grade, 'A')
  assert.equal(out.after.grade, 'A')
  ctx.dispose()
})

test('audit is used when fangAudit exists and tolerated when absent', () => {
  const calls = []
  const ctx = makeCtx({ services: { [SERVICE.auditor]: { append(kind, data) { calls.push({ kind, data }); return { kind, data } } } } })
  healer.apply(ctx, healer.Config({}))
  const service = ctx.get(SERVICE.healer)
  service.selfCheck(CLEAN)
  service.gates(CLEAN)
  service.suggestFix(CLEAN)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(c => c.kind === AUDIT.SCORE))
  assert.ok(calls.every(c => c.data.component === 'fang-healer'))
  assert.deepEqual(calls.map(c => c.data.check), ['self-check', 'gates', 'suggest-fix'])

  const bare = makeCtx()
  healer.apply(bare, healer.Config({}))
  assert.doesNotThrow(() => bare.get(SERVICE.healer).selfCheck(CLEAN))
  bare.dispose()
  ctx.dispose()
})

test('apply is disposed cleanly and a duplicate registration throws', () => {
  const { ctx, service } = fresh()
  assert.ok(service)
  assert.throws(() => healer.apply(ctx, healer.Config({})), /registered/)
  ctx.dispose()
  assert.equal(ctx.get(SERVICE.healer), undefined)
})
