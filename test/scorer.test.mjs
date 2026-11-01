// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T6 — fangScorer v2 测试（契约 docs/CONTRACTS-V2.md 5.4 / §1 / §7）。
//
// 覆盖：
//   * v1 评分数学原样（母体阈值 = v1 分档 20/40/60/80）：权重/族去重/C3 宽限/grade 分档/veto/degraded/颜色。
//   * 角色门禁：scorer 在 mother 与 fork 都激活；缺省 basis.environment = 本实例部署环境。
//   * 环境阈值分叉：同一份源码（test/fixtures/t2/vm-plugin，S=22，落在母体 A 上界 20 与分身 A 上界 25 之间）
//     母体判 B、分身判 A；另有 S=44（40~45 区间）样本证明分档表差异。
//   * opts.environment 覆盖（母体实例按分身阈值/分身实例按母体阈值复核，编排器 promoteTask 用母体阈值）。
//   * 每个 scoreSource/scoreDir/scoreIntent 返回 basis{environment,thresholds,note}；错误路径同样带 basis。
// 零外部依赖：node:test + node:assert/strict；真实插件目录用 mkdtemp 现场写或 test/fixtures/t2 静态样本。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCtx } from './helpers.mjs'
import { SERVICE, AUDIT, ROLE, GRADE_COLOR, removeTree, rolesOf } from '../src/kernel/index.mjs'
import * as scorer from '../src/plugins/scorer.mjs'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 't2')
const VM_PLUGIN = path.join(FIXTURES, 'vm-plugin')

const tmpRoots = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-t6-scorer-'))
  tmpRoots.push(dir)
  return dir
}
/** 写一个真实插件目录；files 为 {相对路径: 源码}。 */
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

function withRole(role, fn) {
  const saved = process.env.DSH_FANG_ROLE
  try {
    if (role === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = role
    return fn()
  } finally {
    if (saved === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = saved
  }
}

function fresh(config = {}, role = undefined) {
  const ctx = makeCtx()
  withRole(role, () => scorer.apply(ctx, scorer.Config(config)))
  return { ctx, service: ctx.get(SERVICE.scorer) }
}

const CLEAN_SRC = "export const name = 'x'\nexport const inject = []\nexport function apply(ctx) { ctx.effect(() => () => {}) }\n"
const CHILD_PROCESS_SRC = "import { spawn } from 'node:child_process'\nexport function apply() { return spawn }\n"
/** 单个 node:vm 命中：S4-vm weight 25 → D1 sev 4 → S=22。母体 A 上界 20 < 22 ≤ 分身 A 上界 25。 */
const VM_SRC = "import { runInNewContext } from 'node:vm'\nexport const evaluate = (src) => runInNewContext(src, {})\n"

// ───────────────────────────── 注册 / 形状 / 角色门禁 ─────────────────────────────

test('registers fangScorer; module shape, v1 exports and v2 threshold policy are stable', () => {
  const { service, ctx } = fresh({ allowlist: ['left-pad'] })
  assert.equal(scorer.name, 'fang-scorer')
  assert.ok(Array.isArray(scorer.inject) && scorer.inject.length === 0, 'inject must be []')
  assert.equal(typeof scorer.Config, 'function')
  assert.equal(typeof service.scoreSource, 'function')
  assert.equal(typeof service.scoreDir, 'function')
  assert.equal(typeof service.scoreIntent, 'function')
  assert.deepEqual(service.policy.allowlist, ['left-pad'])
  assert.deepEqual(scorer.DIM_WEIGHT, { D1: 28, D2: 22, D3: 18, D4: 14, D5: 10, D6: 8 })
  assert.equal(Object.values(scorer.DIM_WEIGHT).reduce((a, b) => a + b, 0), 100, 'D1–D6 weights sum to 100')

  // v2 thresholds：母体 = v1 分档，分身更宽
  assert.deepEqual(scorer.BAND_DEFAULTS.mother, { a: 20, b: 40, c: 60, d: 80 })
  assert.deepEqual(scorer.BAND_DEFAULTS.fork, { a: 25, b: 45, c: 65, d: 85 })
  assert.deepEqual(service.policy.thresholds, scorer.BAND_DEFAULTS)
  assert.deepEqual(service.thresholds, scorer.BAND_DEFAULTS)
  assert.equal(service.environment, ROLE.MOTHER)
  assert.deepEqual(service.thresholdsFor(ROLE.MOTHER), { a: 20, b: 40, c: 60, d: 80 })
  assert.deepEqual(service.thresholdsFor(ROLE.FORK), { a: 25, b: 45, c: 65, d: 85 })
  ctx.dispose()
})

test('role gate: scorer activates in mother AND fork; the default basis.environment follows the deployment role', () => {
  assert.deepEqual(rolesOf('scorer'), [ROLE.MOTHER, ROLE.FORK], 'deployment matrix: scorer is a both-roles organ')

  const mother = fresh()
  const fork = fresh({}, ROLE.FORK)
  assert.ok(mother.service, 'scorer must register fangScorer in mother')
  assert.ok(fork.service, 'scorer must register fangScorer in fork')
  assert.equal(mother.service.environment, ROLE.MOTHER)
  assert.equal(fork.service.environment, ROLE.FORK)

  const fromMother = mother.service.scoreSource(CLEAN_SRC)
  const fromFork = fork.service.scoreSource(CLEAN_SRC)
  assert.equal(fromMother.basis.environment, ROLE.MOTHER)
  assert.equal(fromFork.basis.environment, ROLE.FORK)
  assert.equal(fromMother.basis.note, '本评分基于 mother 阈值')
  assert.equal(fromFork.basis.note, '本评分基于 fork 阈值')
  assert.deepEqual(fromMother.basis.thresholds, { a: 20, b: 40, c: 60, d: 80 })
  assert.deepEqual(fromFork.basis.thresholds, { a: 25, b: 45, c: 65, d: 85 })

  // env 优先于 config.role（与 kernel resolveRole 一致）
  const envWins = fresh({ role: ROLE.MOTHER }, ROLE.FORK)
  assert.equal(envWins.service.environment, ROLE.FORK)
  const byConfig = fresh({ role: ROLE.FORK })
  assert.equal(byConfig.service.environment, ROLE.FORK)

  mother.ctx.dispose()
  fork.ctx.dispose()
  envWins.ctx.dispose()
  byConfig.ctx.dispose()
})

// ───────────────────────────── 环境阈值分叉（验收核心） ─────────────────────────────

test('threshold fork: the SAME source grades B in mother and A in fork (S=22 between 20 and 25)', () => {
  const mother = fresh()
  const fork = fresh({}, ROLE.FORK)
  const m = mother.service.scoreSource(VM_SRC)
  const f = fork.service.scoreSource(VM_SRC)

  assert.equal(m.S, 22)
  assert.equal(f.S, 22, 'the scoring math is identical — only the grade bands differ')
  assert.equal(m.grade, 'B')
  assert.equal(f.grade, 'A')
  assert.equal(m.color, 'blue')
  assert.equal(f.color, 'green')
  assert.notEqual(m.grade, f.grade, 'the mother/fork split is real, not cosmetic')
  assert.match(m.basis.note, /母体|mother/)
  assert.match(f.basis.note, /fork/)

  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('threshold fork: scoreDir over the static fixture shows the same B/A divergence', () => {
  const mother = fresh()
  const fork = fresh({}, ROLE.FORK)
  const m = mother.service.scoreDir(VM_PLUGIN)
  const f = fork.service.scoreDir(VM_PLUGIN)

  assert.equal(m.dir, path.resolve(VM_PLUGIN))
  assert.equal(f.dir, path.resolve(VM_PLUGIN))
  assert.equal(m.entry, 'index.js')
  assert.equal(f.entry, 'index.js')
  assert.equal(m.S, 22)
  assert.equal(f.S, 22)
  assert.equal(m.grade, 'B')
  assert.equal(f.grade, 'A')
  assert.equal(m.basis.environment, ROLE.MOTHER)
  assert.equal(f.basis.environment, ROLE.FORK)
  assert.deepEqual(m.signals, [{ id: 'S4-vm', weight: 25 }])

  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('threshold fork: S=44 sample (40~45 band) flips C(mother) vs B(fork) through the pure scorer', () => {
  const signals = [
    { id: 'S4-vm', weight: 25 },
    { id: 'C3-svc', weight: 30, evidence: { services: ['sessions'] } },
  ]
  const m = scorer.scoreScan(signals, {}, scorer.BAND_DEFAULTS.mother)
  const f = scorer.scoreScan(signals, {}, scorer.BAND_DEFAULTS.fork)
  assert.equal(m.S, 44)
  assert.equal(f.S, 44)
  assert.equal(m.grade, 'C', 'mother: 44 > B bound 40 → C')
  assert.equal(f.grade, 'B', 'fork: 44 ≤ B bound 45 → B')
  assert.equal(scorer.gradeOf(22, scorer.BAND_DEFAULTS.mother), 'B')
  assert.equal(scorer.gradeOf(22, scorer.BAND_DEFAULTS.fork), 'A')
  assert.equal(scorer.gradeOf(0, scorer.BAND_DEFAULTS.mother), 'A')
  assert.equal(scorer.gradeOf(100, scorer.BAND_DEFAULTS.fork), 'E')
})

test('opts.environment overrides the instance environment (mother rescoring inside a fork, and vice versa)', () => {
  const mother = fresh()
  const fork = fresh({}, ROLE.FORK)

  const motherAsFork = mother.service.scoreSource(VM_SRC, {}, { environment: ROLE.FORK })
  assert.equal(motherAsFork.grade, 'A')
  assert.equal(motherAsFork.basis.environment, ROLE.FORK)
  assert.equal(motherAsFork.basis.note, '本评分基于 fork 阈值')

  const forkAsMother = fork.service.scoreSource(VM_SRC, {}, { environment: ROLE.MOTHER })
  assert.equal(forkAsMother.grade, 'B', 'mother-side promotion uses the stricter mother thresholds')
  assert.equal(forkAsMother.basis.environment, ROLE.MOTHER)
  assert.deepEqual(forkAsMother.basis.thresholds, { a: 20, b: 40, c: 60, d: 80 })

  // 编排器 promoteTask 的真实调用形态：scoreDir(dir, null, {environment:'mother'})
  const dirAsMother = fork.service.scoreDir(VM_PLUGIN, null, { environment: ROLE.MOTHER })
  assert.equal(dirAsMother.grade, 'B')
  assert.equal(dirAsMother.basis.environment, ROLE.MOTHER)

  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('thresholds can be configured per environment; partial overrides keep the other defaults', () => {
  const { service, ctx } = fresh({ thresholds: { fork: { a: 10 } } })
  assert.deepEqual(service.thresholds.mother, { a: 20, b: 40, c: 60, d: 80 })
  assert.deepEqual(service.thresholds.fork, { a: 10, b: 45, c: 65, d: 85 }, 'partial config keeps the schema defaults')

  const out = service.scoreSource(VM_SRC, {}, { environment: ROLE.FORK })
  assert.equal(out.S, 22)
  assert.equal(out.grade, 'B', 'S=22 > configured fork A bound 10')
  assert.deepEqual(out.basis.thresholds, { a: 10, b: 45, c: 65, d: 85 })
  ctx.dispose()
})

test('basis is attached to scoreSource/scoreDir/scoreIntent, including error paths', () => {
  const { service, ctx } = fresh()
  const fromSource = service.scoreSource(VM_SRC)
  const fromIntent = service.scoreIntent({ digests: ['sha256:abc'] })
  for (const out of [fromSource, fromIntent]) {
    assert.equal(out.basis.environment, ROLE.MOTHER)
    assert.deepEqual(out.basis.thresholds, { a: 20, b: 40, c: 60, d: 80 })
    assert.equal(out.basis.note, '本评分基于 mother 阈值')
  }

  const emptyDir = writePluginDir({ name: '@local/t6-noentry', version: '1.0.0', type: 'module' })
  const missing = service.scoreDir(emptyDir)
  assert.equal(missing.error, 'no-entry-file')
  assert.equal(missing.basis.environment, ROLE.MOTHER)
  assert.deepEqual(missing.basis.thresholds, { a: 20, b: 40, c: 60, d: 80 })
  assert.equal(missing.basis.note, '本评分基于 mother 阈值')
  ctx.dispose()
})

// ───────────────────────────── v1 评分数学原样（母体阈值） ─────────────────────────────

test('v1 math: clean source scores A/green with no signals', () => {
  const { service, ctx } = fresh()
  const r = service.scoreSource(CLEAN_SRC)
  assert.equal(r.grade, 'A')
  assert.equal(r.S, 0)
  assert.equal(r.color, 'green')
  assert.equal(r.veto, false)
  assert.equal(r.degraded, false)
  assert.deepEqual(r.signals, [])
  assert.ok(Array.isArray(r.reasons) && r.reasons.length === 0)
  assert.equal(r.coverage, 'import-only')
  ctx.dispose()
})

test('v1 math: child_process import scores 28 = B, and B is never green', () => {
  const { service, ctx } = fresh()
  const r = service.scoreSource(CHILD_PROCESS_SRC)
  assert.deepEqual(r.signals, [{ id: 'S1-child_process', weight: 30 }])
  assert.equal(r.S, 28)
  assert.equal(r.grade, 'B')
  assert.equal(r.color, 'blue')
  assert.notEqual(r.color, 'green', 'a single dangerous capability must not be green')
  assert.equal(r.veto, false)
  ctx.dispose()
})

test('v1 math: family dedupe — same capability imported twice yields one signal', () => {
  const { service, ctx } = fresh()
  const src = "import { spawn } from 'node:child_process'\nimport * as cp from 'child_process'\nexport { spawn, cp }\n"
  const r = service.scoreSource(src)
  assert.equal(r.signals.length, 1, 'duplicate family signal deduped')
  assert.equal(r.S, 28)
  ctx.dispose()
})

test('v1 math: grade bands + dimension aggregation (pure scoreScan, mother bands default)', () => {
  const { scoreScan } = scorer
  assert.equal(scoreScan([]).grade, 'A')
  assert.equal(scoreScan([{ id: 'S1-a', weight: 30 }]).grade, 'B') // 28
  // D1(28) + D2(22) = 50 → C
  assert.equal(scoreScan([
    { id: 'S1-a', weight: 30 },
    { id: 'C3-svc', weight: 30, evidence: { services: ['sessions'] } },
  ]).S, 50)
  // D1(28) + D2(22) + D4(14) + D5(10) = 74 → D
  const d = scoreScan([
    { id: 'S1-a', weight: 30 },
    { id: 'C3-svc', weight: 30, evidence: { services: ['sessions'] } },
    { id: 'C2-net', weight: 30 },
    { id: 'S6-x', weight: 30 },
  ])
  assert.equal(d.S, 74)
  assert.equal(d.grade, 'D')
  // E 只能来自 veto / 无法评估（import 层信号上限 D）
  assert.equal(scoreScan([{ id: 'S1-a', weight: 30 }], { dsh: { hotReload: false } }).grade, 'E')
  // 缺省第三参数 = 母体 v1 分档，与不传完全一致
  assert.deepEqual(scoreScan([{ id: 'S1-a', weight: 30 }]), scoreScan([{ id: 'S1-a', weight: 30 }], {}, scorer.BAND_DEFAULTS.mother))
})

test('v1 math: C3 service grace and family dedupe helpers', () => {
  const { scoreScan, dedupeByFamily } = scorer
  const graced = scoreScan([{ id: 'C3-svc', weight: 30, evidence: { services: ['a', 'b'] } }])
  assert.equal(graced.S, 0)
  assert.ok(graced.reasons.some(r => r.includes('C3-service-grace')))
  const kept = scoreScan([{ id: 'C3-svc', weight: 30, evidence: { services: ['sessions'] } }])
  assert.equal(kept.S, 22)
  const many = scoreScan([{ id: 'C3-svc', weight: 30, evidence: { services: Array.from({ length: 9 }, (_, i) => `s${i}`) } }])
  assert.equal(many.S, 22)
  assert.equal(dedupeByFamily([{ id: 'S1-a' }, { id: 'S1-b' }, { id: 'S2-c' }]).length, 2)
})

test('v1 math: gradeToColor matches kernel GRADE_COLOR (B=blue, C=yellow, D/E=red)', () => {
  for (const grade of ['A', 'B', 'C', 'D', 'E']) {
    assert.equal(scorer.gradeToColor(grade), GRADE_COLOR[grade])
  }
  assert.equal(scorer.gradeToColor('A'), 'green')
  assert.equal(scorer.gradeToColor('B'), 'blue')
})

test('v1 math: dsh.hotReload === false is an E veto (S=100, red, reason recorded) under both environments', () => {
  const mother = fresh()
  const fork = fresh({}, ROLE.FORK)
  for (const { service } of [mother, fork]) {
    const r = service.scoreSource(CLEAN_SRC, { dsh: { hotReload: false } })
    assert.equal(r.grade, 'E')
    assert.equal(r.veto, true)
    assert.equal(r.S, 100)
    assert.equal(r.color, 'red')
    assert.ok(r.reasons.includes('hotReload-false'))
  }
  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('v1 math: degraded parse warnings force A/B down to C', () => {
  const { service, ctx } = fresh()
  const src = "const name = 'x'\nconst mod = await import(name)\nexport { mod }\n"
  const r = service.scoreSource(src)
  assert.equal(r.warnings, 1)
  assert.equal(r.degraded, true)
  assert.equal(r.grade, 'C')
  assert.equal(r.color, 'yellow')
  ctx.dispose()
})

test('v1 math: scoreDir scores a real temp plugin directory (package.json + index.js)', () => {
  const { service, ctx } = fresh()
  const dir = writePluginDir(
    { name: '@local/t6-child', version: '1.0.0', type: 'module', main: 'index.js' },
    { 'index.js': CHILD_PROCESS_SRC },
  )
  const r = service.scoreDir(dir)
  assert.equal(r.dir, path.resolve(dir))
  assert.equal(r.entry, 'index.js')
  assert.equal(r.grade, 'B')
  assert.equal(r.S, 28)
  assert.equal(r.color, 'blue')
  assert.equal(r.signals[0].id, 'S1-child_process')
  ctx.dispose()
})

test('v1 math: scoreDir honours manifest.entry and veto from package.json', () => {
  const { service, ctx } = fresh()
  const custom = writePluginDir(
    { name: '@local/t6-custom', version: '1.0.0', type: 'module' },
    { 'custom.js': CLEAN_SRC },
  )
  const r = service.scoreDir(custom, { entry: 'custom.js' })
  assert.equal(r.entry, 'custom.js')
  assert.equal(r.grade, 'A')

  const vetoed = writePluginDir(
    { name: '@local/t6-veto', version: '1.0.0', type: 'module', dsh: { hotReload: false } },
    { 'index.js': CLEAN_SRC },
  )
  const v = service.scoreDir(vetoed)
  assert.equal(v.entry, 'index.js')
  assert.equal(v.grade, 'E')
  assert.equal(v.veto, true)
  assert.equal(v.color, 'red')
  ctx.dispose()
})

test('v1 math: scoreDir without an entry fails closed (E/degraded/red, no veto)', () => {
  const { service, ctx } = fresh()
  const dir = writePluginDir({ name: '@local/t6-empty', version: '1.0.0', type: 'module' })
  const r = service.scoreDir(dir)
  assert.equal(r.grade, 'E')
  assert.equal(r.S, 100)
  assert.equal(r.veto, false)
  assert.equal(r.degraded, true)
  assert.equal(r.color, 'red')
  assert.equal(r.entry, null)
  assert.equal(r.error, 'no-entry-file')
  assert.ok(r.reasons.includes('no-entry-file'))
  ctx.dispose()
})

test('v1 behavior: scoreIntent action light is unchanged and now carries basis', () => {
  const { service, ctx } = fresh()
  const base = service.scoreIntent({})
  assert.equal(base.light, 'yellow')
  assert.deepEqual(base.notes, ['unbound-digest'])
  assert.equal(base.basis.environment, ROLE.MOTHER)
  assert.equal(service.scoreIntent({ digests: ['sha256:abc'] }).light, 'blue')
  assert.equal(service.scoreIntent({ scope: 'session' }).light, 'yellow')
  assert.equal(service.scoreIntent({ scope: 'process' }).light, 'red')
  assert.equal(service.scoreIntent({ scope: 'system' }).light, 'red')
  const inherited = service.scoreIntent({ originLight: 'blue' })
  assert.equal(inherited.light, 'blue')
  assert.ok(inherited.notes.includes('inherited-originLight'))
  for (const intent of [{}, { digests: ['x'] }, { scope: 'session' }, { scope: 'process' }]) {
    assert.notEqual(service.scoreIntent(intent).light, 'green')
  }
  // 环境覆盖同样反映在 scoreIntent 的 basis 上
  assert.equal(service.scoreIntent({}, { environment: ROLE.FORK }).basis.environment, ROLE.FORK)
  ctx.dispose()
})

// ───────────────────────────── 审计 / 注册生命周期 ─────────────────────────────

test('audit is used when fangAudit exists (with environment) and tolerated when absent', () => {
  const calls = []
  const ctx = makeCtx({ services: { [SERVICE.auditor]: { append(kind, data) { calls.push({ kind, data }); return { kind, data } } } } })
  scorer.apply(ctx, scorer.Config({}))
  const service = ctx.get(SERVICE.scorer)
  service.scoreSource(CLEAN_SRC) // scoreSource 不审计（热路径）
  assert.equal(calls.length, 0)
  const dir = writePluginDir({ name: '@local/t6-audit', version: '1.0.0', type: 'module' }, { 'index.js': CHILD_PROCESS_SRC })
  service.scoreDir(dir)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, AUDIT.SCORE)
  assert.equal(calls[0].data.component, 'fang-scorer')
  assert.equal(calls[0].data.grade, 'B')
  assert.equal(calls[0].data.environment, ROLE.MOTHER)

  const bare = makeCtx() // 无 auditor
  scorer.apply(bare, scorer.Config({}))
  assert.doesNotThrow(() => bare.get(SERVICE.scorer).scoreDir(dir))
  bare.dispose()
  ctx.dispose()
})

test('apply registers once, is disposed cleanly, and a duplicate registration throws', () => {
  const { ctx, service } = fresh()
  assert.ok(service)
  assert.throws(() => scorer.apply(ctx, scorer.Config({})), /registered/)
  ctx.dispose()
  assert.equal(ctx.get(SERVICE.scorer), undefined, 'service removed on dispose')
})
