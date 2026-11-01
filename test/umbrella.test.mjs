// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v2.7.6 保护伞（fang-umbrella）验收：
//   * 四个灯色的顺序/归一化
//   * A–E → 灯色下限（两张表）+ 只升不降
//   * 动作基础灯色的 12 条规则与优先级
//   * 决策矩阵（allow/mark/ask/delegate/deny）
//   * 插件评分缓存（指纹失效 / LRU / invalidate）与失败往坏里判
//   * 插件形态：角色矩阵、服务面、审计
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { makeCtx, tmpDir } from './helpers.mjs'
import { GRADE_COLOR, LIGHT, LIGHT_RANK, SERVICE } from '../src/kernel/index.mjs'
import {
  DECISION,
  DEFAULT_CREDENTIAL_PATTERNS,
  FLOOR_TABLES,
  GRADE_FLOOR,
  GRADE_FLOOR_STRICT,
  baseLight,
  createUmbrella,
  decide,
  effectiveLight,
  gradeFloor,
  lightAtLeast,
  maxLight,
  normalizeGrade,
  normalizeLight,
  normalizePolicy,
  rankOf,
  resolveFloorTable,
} from '../src/lib/umbrella.mjs'
import * as umbrellaPlugin from '../src/plugins/umbrella.mjs'

const BUF = path.resolve('C:/fangs/buffer')
const ALLOW = path.resolve('C:/fangs/allow')
const PROD = path.resolve('C:/fangs/prod')

const policy = normalizePolicy({
  root: path.resolve('C:/fangs'),
  bufferRoot: 'C:/fangs/buffer',
  productionRoot: 'C:/fangs/prod',
  allowPaths: ['C:/fangs/allow'],
  networkAllowlist: ['api.example.com', '*.example.org'],
})

function lightOf(evidence, customPolicy = policy) {
  return baseLight(evidence, customPolicy)
}

// ── 灯色词汇 ────────────────────────────────────────────────────────────────

test('light ranks order green < blue < yellow < red', () => {
  assert.equal(LIGHT_RANK.green, 1)
  assert.equal(LIGHT_RANK.red, 4)
  assert.ok(rankOf('green') < rankOf('blue'))
  assert.ok(rankOf('blue') < rankOf('yellow'))
  assert.ok(rankOf('yellow') < rankOf('red'))
  assert.equal(maxLight('green', 'yellow'), 'yellow')
  assert.equal(maxLight('red', 'blue'), 'red')
  assert.equal(lightAtLeast('blue', 'green'), true)
  assert.equal(lightAtLeast('green', 'blue'), false)
})

test('normalizeLight accepts case/spaces and conservatively maps unknown to yellow', () => {
  assert.equal(normalizeLight(' GREEN '), 'green')
  assert.equal(normalizeLight('Red'), 'red')
  assert.equal(normalizeLight('purple'), 'yellow')
  assert.equal(normalizeLight(undefined), 'yellow')
  assert.equal(normalizeLight('nope', 'red'), 'red') // 显式 fallback 生效
})

test('normalizeGrade maps unknown grades to E (fail-closed)', () => {
  for (const g of ['A', 'B', 'C', 'D', 'E']) assert.equal(normalizeGrade(g.toLowerCase()), g)
  assert.equal(normalizeGrade('F'), 'E')
  assert.equal(normalizeGrade(null), 'E')
})

// ── 等级下限 ────────────────────────────────────────────────────────────────

test('default floor table is the design table A/B green, C blue, D yellow, E red', () => {
  assert.deepEqual(GRADE_FLOOR, { A: 'green', B: 'green', C: 'blue', D: 'yellow', E: 'red' })
  for (const [grade, light] of Object.entries(GRADE_FLOOR)) assert.equal(gradeFloor(grade), light)
})

test('strict floor table equals kernel GRADE_COLOR (plugin self colour)', () => {
  assert.deepEqual(GRADE_FLOOR_STRICT, GRADE_COLOR)
  assert.deepEqual(FLOOR_TABLES.strict, GRADE_COLOR)
  for (const [grade, light] of Object.entries(GRADE_COLOR)) {
    assert.equal(gradeFloor(grade, { table: 'strict' }), light)
  }
})

test('gradeFloor fails closed on unknown grade and on unknown table name', () => {
  assert.equal(gradeFloor('Z'), 'red')
  assert.equal(gradeFloor(undefined), 'red')
  const unknown = resolveFloorTable('nope')
  assert.equal(unknown.degraded, true)
  assert.deepEqual(unknown.table, GRADE_FLOOR)
  // 自定义表：缺项回退默认表
  assert.equal(gradeFloor('C', { table: { C: 'red' } }), 'red')
  assert.equal(gradeFloor('A', { table: { C: 'red' } }), 'green')
})

test('effectiveLight never lowers an action and always reaches the floor', () => {
  const lights = ['green', 'blue', 'yellow', 'red']
  const grades = ['A', 'B', 'C', 'D', 'E', 'Z']
  for (const base of lights) {
    for (const grade of grades) {
      const eff = effectiveLight(base, grade)
      assert.ok(rankOf(eff.light) >= rankOf(base), `${base}/${grade} lowered the action`)
      assert.ok(rankOf(eff.light) >= rankOf(eff.gradeFloor), `${base}/${grade} below floor`)
      assert.equal(eff.raised, rankOf(eff.light) > rankOf(base))
    }
  }
  // 典型例子：C 级插件的绿动作被抬成蓝；A 级插件不能把红灯降成绿
  assert.equal(effectiveLight('green', 'C').light, 'blue')
  assert.equal(effectiveLight('green', 'A').light, 'green')
  assert.equal(effectiveLight('red', 'A').light, 'red')
})

// ── 动作基础灯色 ────────────────────────────────────────────────────────────

test('destructive commands are red', () => {
  const cases = [
    { tool: 'bash', args: { command: 'rm -rf /tmp/x' } },
    { tool: 'bash', args: { command: 'git push --force origin main' } },
    { tool: 'bash', args: { command: 'reg delete HKLM\\Software\\X' } },
    { tool: 'pwsh', args: { command: 'Remove-Item -Recurse -Force C:\\x' } },
  ]
  for (const ev of cases) {
    const r = lightOf(ev)
    assert.equal(r.light, 'red', ev.args.command)
    assert.equal(r.matchedRule, 'destructive-command')
  }
})

test('DSH lifecycle actions are red and flagged for delegation', () => {
  const toolCase = lightOf({ tool: 'restart', args: {} })
  assert.equal(toolCase.light, 'red')
  assert.equal(toolCase.matchedRule, 'dsh-lifecycle')
  assert.equal(toolCase.lifecycle, true)

  const procCase = lightOf({ tool: 'bash', args: { command: 'taskkill /im dsh.exe /f' } })
  assert.equal(procCase.matchedRule, 'dsh-lifecycle')

  const scoped = lightOf({ tool: 'write', scope: 'process', args: { path: 'C:/fangs/buffer/a' } })
  assert.equal(scoped.light, 'red')
  assert.equal(scoped.matchedRule, 'dsh-lifecycle')

  // 普通 taskkill 不是 DSH 生命周期，但仍属破坏性
  const plainKill = lightOf({ tool: 'bash', args: { command: 'taskkill /pid 4242' } })
  assert.equal(plainKill.light, 'red')
  assert.equal(plainKill.matchedRule, 'destructive-command')
})

test('credential paths are red and marked as hard-deny material', () => {
  for (const p of ['.ssh/id_rsa', '.aws/credentials', '.git-credentials', path.join('x', 'config', 'SAM')]) {
    const r = lightOf({ tool: 'read', args: { path: path.resolve('C:/home/u', p) } })
    assert.equal(r.light, 'red', p)
    assert.equal(r.matchedRule, 'credential-access')
    assert.equal(r.credential, true)
  }
  assert.ok(DEFAULT_CREDENTIAL_PATTERNS.length >= 10)
})

test('writes are classified by where they land', () => {
  assert.deepEqual(pick(lightOf({ tool: 'write', args: { path: path.join(BUF, 'a.txt') } })), ['blue', 'write-in-buffer'])
  assert.deepEqual(pick(lightOf({ tool: 'write', args: { path: path.join(ALLOW, 'a.txt') } })), ['blue', 'write-in-allowlist'])
  assert.deepEqual(pick(lightOf({ tool: 'write', args: { path: path.join(PROD, 'a.txt') } })), ['yellow', 'write-production'])
  assert.deepEqual(pick(lightOf({ tool: 'write', args: { path: path.resolve('C:/fangs/other/a.txt') } })), ['yellow', 'write-outside-buffer'])
})

test('reads are green only inside the buffer', () => {
  assert.deepEqual(pick(lightOf({ tool: 'read', args: { path: path.join(BUF, 'a.txt') } })), ['green', 'read-in-buffer'])
  assert.deepEqual(pick(lightOf({ tool: 'read', args: { path: path.resolve('C:/fangs/other/a.txt') } })), ['blue', 'read-outside-buffer'])
})

test('network egress: allowlisted is blue, unknown host is yellow', () => {
  assert.deepEqual(pick(lightOf({ tool: 'web_fetch', args: { url: 'https://api.example.com/v1/x' } })), ['blue', 'network-allowlisted'])
  assert.deepEqual(pick(lightOf({ tool: 'web_fetch', args: { url: 'https://sub.example.org/x' } })), ['blue', 'network-allowlisted'])
  assert.deepEqual(pick(lightOf({ tool: 'web_fetch', args: { url: 'https://evil.test/x' } })), ['yellow', 'network-egress'])
  assert.deepEqual(pick(lightOf({ tool: 'http', args: { url: 'not a url' } })), ['yellow', 'network-egress'])
})

test('dynamic import is yellow and exec splits into read-only blue vs side-effect yellow', () => {
  assert.deepEqual(pick(lightOf({ tool: 'import', args: { specifier: './x.mjs' } })), ['yellow', 'dynamic-import'])
  assert.deepEqual(pick(lightOf({ tool: 'bash', args: { command: 'git status' } })), ['blue', 'exec-read-only'])
  assert.deepEqual(pick(lightOf({ tool: 'bash', args: { command: 'npm install left-pad' } })), ['yellow', 'exec-side-effect'])
  assert.deepEqual(pick(lightOf({ tool: 'bash', args: { command: 'git status > out.txt' } })), ['yellow', 'exec-side-effect'])
})

test('unknown tools and missing targets fall back to yellow', () => {
  assert.deepEqual(pick(lightOf({ tool: 'mystery-tool' })), ['yellow', 'unknown-tool'])
  assert.deepEqual(pick(lightOf({})), ['yellow', 'unknown-tool'])
})

test('precedence: credential beats write rules, lifecycle beats destructive', () => {
  const credWrite = lightOf({ tool: 'write', args: { path: path.resolve('C:/home/u/.ssh/id_rsa') } })
  assert.equal(credWrite.matchedRule, 'credential-access')
  assert.equal(credWrite.light, 'red')

  const dshKill = lightOf({ tool: 'bash', args: { command: 'taskkill /im dsh.exe /f' } })
  assert.equal(dshKill.matchedRule, 'dsh-lifecycle')
})

test('explicit empty pattern array disables the builtin rule (caller takes over)', () => {
  const noCreds = normalizePolicy({ bufferRoot: 'C:/fangs/buffer', credentialPatterns: [] })
  const r = baseLight({ tool: 'read', args: { path: path.resolve('C:/home/u/.ssh/id_rsa') } }, noCreds)
  assert.notEqual(r.matchedRule, 'credential-access')
  assert.equal(r.light, 'blue') // 沙箱外只读
  // 缺省（undefined）仍然用内置规则
  const withDefaults = normalizePolicy({ bufferRoot: 'C:/fangs/buffer' })
  assert.equal(baseLight({ tool: 'read', args: { path: path.resolve('C:/home/u/.ssh/id_rsa') } }, withDefaults).matchedRule, 'credential-access')
})

test('relative paths are resolved against policy.root', () => {
  const relative = normalizePolicy({ root: 'C:/fangs', bufferRoot: 'C:/fangs/buffer' })
  const r = baseLight({ tool: 'write', args: { path: path.join('buffer', 'x.txt') } }, relative)
  assert.equal(r.matchedRule, 'write-in-buffer')
})

// ── 决策矩阵 ────────────────────────────────────────────────────────────────

test('decision matrix: green allow, blue mark, yellow ask', () => {
  assert.equal(decide({ light: 'green' }).decision, DECISION.ALLOW)
  assert.equal(decide({ light: 'blue' }).decision, DECISION.MARK)
  assert.equal(decide({ light: 'blue' }).elevated, true)
  assert.equal(decide({ light: 'yellow' }).decision, DECISION.ASK)
  assert.equal(decide({ light: 'yellow' }).severity, 'normal')
})

test('decision matrix: lifecycle yellow/red delegate to restart-guard with originLight', () => {
  const y = decide({ light: 'yellow', lifecycle: true })
  assert.equal(y.decision, DECISION.DELEGATE)
  assert.equal(y.target, 'restartGuard')
  assert.equal(y.originLight, 'yellow')

  const r = decide({ light: 'red', matchedRule: 'dsh-lifecycle' })
  assert.equal(r.decision, DECISION.DELEGATE)
  assert.equal(r.target, 'restartGuard')
  assert.equal(r.originLight, 'red')
  assert.equal(r.severity, 'critical')
})

test('decision matrix: red asks with critical severity, credential red denies outright', () => {
  const ask = decide({ light: 'red' })
  assert.equal(ask.decision, DECISION.ASK)
  assert.equal(ask.severity, 'critical')

  const deny = decide({ light: 'red', credential: true })
  assert.equal(deny.decision, DECISION.DENY)
  assert.equal(deny.severity, 'critical')
  assert.equal(deny.reason, 'credential-access')

  // 凭据 + 生命周期同时命中：硬拒绝优先（凭据不允许「一次批准」）
  assert.equal(decide({ light: 'red', credential: true, lifecycle: true }).decision, DECISION.DENY)
})

// ── 门面与缓存 ──────────────────────────────────────────────────────────────

function scorerStub(result = { grade: 'B', S: 28 }) {
  const calls = { scoreSource: 0, scoreDir: 0 }
  return {
    calls,
    scoreSource() {
      calls.scoreSource += 1
      return { color: 'blue', veto: false, degraded: false, signals: [], reasons: [], basis: { environment: 'mother' }, ...result }
    },
    scoreDir() {
      calls.scoreDir += 1
      return { color: 'blue', veto: false, degraded: false, signals: [], reasons: [], basis: { environment: 'mother' }, ...result }
    },
  }
}

test('assessPlugin caches by fingerprint and reports cache stats', () => {
  const scorer = scorerStub({ grade: 'B', S: 28 })
  const umb = createUmbrella({ scorer, policy: { bufferRoot: BUF } })
  const a1 = umb.assessPlugin({ pluginId: 'demo', source: 'export const a = 1' })
  assert.equal(a1.grade, 'B')
  assert.equal(a1.fromCache, false)
  assert.equal(scorer.calls.scoreSource, 1)

  const a2 = umb.assessPlugin({ pluginId: 'demo', source: 'export const a = 1' })
  assert.equal(a2.fromCache, true)
  assert.equal(scorer.calls.scoreSource, 1, 'cache hit must not rescan')
  assert.deepEqual([umb.cacheStats().hits, umb.cacheStats().misses], [1, 1])

  // refresh: true 强制重扫
  const a3 = umb.assessPlugin({ pluginId: 'demo', source: 'export const a = 1', refresh: true })
  assert.equal(a3.fromCache, false)
  assert.equal(umb.cacheStats().misses, 2)
})

test('dir-based assessment is invalidated when the entry file mtime moves', () => {
  const dir = tmpDir('fang-umbrella-dir-')
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', main: 'index.js' }), 'utf8')
    const entry = path.join(dir, 'index.js')
    fs.writeFileSync(entry, 'export const a = 1\n', 'utf8')

    const reads = []
    const scorer = {
      scoreDir() {
        const text = fs.readFileSync(entry, 'utf8')
        reads.push(text)
        const grade = text.includes('child_process') ? 'D' : 'B'
        return { grade, S: grade === 'D' ? 60 : 10, color: 'blue', veto: false, degraded: false, signals: [], reasons: [], basis: {}, dir, entry: 'index.js' }
      },
    }
    const umb = createUmbrella({ scorer })
    const first = umb.assessPlugin({ pluginId: 'demo-dir', dir })
    assert.equal(first.grade, 'B')
    assert.equal(reads.length, 1)
    assert.equal(umb.assessPlugin({ pluginId: 'demo-dir', dir }).fromCache, true)

    // 改写入口并推进 mtime：下一次必须重扫（不能沿用旧等级）
    fs.writeFileSync(entry, "import cp from 'node:child_process'\n", 'utf8')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(entry, later, later)
    const second = umb.assessPlugin({ pluginId: 'demo-dir', dir })
    assert.equal(second.fromCache, false)
    assert.equal(second.grade, 'D')
    assert.equal(reads.length, 2)
    assert.equal(umb.cacheStats().misses, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cache evicts the oldest entry when full and invalidate() forces a rescan', () => {
  const scorer = scorerStub()
  const umb = createUmbrella({ scorer, cacheSize: 2 })
  umb.assessPlugin({ pluginId: 'a', source: 'x' })
  umb.assessPlugin({ pluginId: 'b', source: 'y' })
  umb.assessPlugin({ pluginId: 'c', source: 'z' })
  assert.equal(umb.cacheStats().evictions, 1)
  assert.equal(umb.cacheStats().size, 2)

  assert.equal(umb.assessPlugin({ pluginId: 'a', source: 'x' }).fromCache, false, 'a was evicted')
  umb.assessPlugin({ pluginId: 'b', source: 'y' })
  assert.equal(umb.invalidate('b') >= 1, true)
  assert.equal(umb.assessPlugin({ pluginId: 'b', source: 'y' }).fromCache, false)
  assert.equal(umb.clearCache() >= 0, true)
  assert.equal(umb.cacheStats().size, 0)
})

test('missing scorer fails closed to E with a degraded reason', () => {
  const umb = createUmbrella({ scorer: null, policy: { bufferRoot: BUF } })
  const a = umb.assessPlugin({ pluginId: 'x', source: 'export const a = 1' })
  assert.equal(a.grade, 'E')
  assert.equal(a.degraded, true)
  assert.ok(a.reasons.some(r => r.includes('scorer')), a.reasons.join(','))
  // 未评分插件的动作至少红：绿动作被 E 下限抬成红
  const act = umb.assessAction({ tool: 'read', args: { path: path.join(BUF, 'x') } })
  assert.equal(act.baseLight, 'green')
  assert.equal(act.pluginGrade, 'E')
  assert.equal(act.light, 'red')
  assert.equal(act.gradeBasis, 'unscored-fail-closed')
})

test('assessAction couples plugin grade into the action light', () => {
  const umb = createUmbrella({ scorer: null, policy: { bufferRoot: BUF } })
  const inBuffer = { tool: 'read', args: { path: path.join(BUF, 'a.txt') } }

  const a = umb.assessAction(inBuffer, { grade: 'A' })
  assert.deepEqual([a.light, a.baseLight, a.gradeFloor, a.raised], ['green', 'green', 'green', false])

  const c = umb.assessAction(inBuffer, { grade: 'C' })
  assert.deepEqual([c.light, c.baseLight, c.gradeFloor, c.raised], ['blue', 'green', 'blue', true])

  const d = umb.assessAction(inBuffer, { grade: 'D' })
  assert.equal(d.light, 'yellow')
  assert.equal(d.gradeBasis, 'explicit-grade')

  // 证据里的 pluginGrade 与缓存里的等级都能被采用
  assert.equal(umb.assessAction({ ...inBuffer, pluginGrade: 'B' }).light, 'green')

  const plain = createUmbrella({
    scorer: scorerStub({ grade: 'C', S: 40 }),
    policy: { bufferRoot: BUF },
  })
  plain.assessPlugin({ pluginId: 'pkg-c', source: 'x' })
  const viaCache = plain.assessAction({ ...inBuffer, pluginId: 'pkg-c' })
  assert.equal(viaCache.pluginGrade, 'C')
  assert.equal(viaCache.gradeBasis, 'cached-plugin-grade')
  assert.equal(viaCache.light, 'blue')
})

test('decideAction audits exactly one umbrella-decision record with the full trail', () => {
  const records = []
  const umb = createUmbrella({
    scorer: null,
    policy: { bufferRoot: BUF },
    audit: (r) => records.push(r),
  })
  const out = umb.decideAction({ tool: 'write', args: { path: path.join(BUF, 'a.txt') }, pluginId: 'p1' }, { grade: 'C' })
  assert.equal(records.length, 1)
  const rec = records[0]
  assert.equal(rec.kind, 'umbrella-decision')
  assert.equal(rec.pluginGrade, 'C')
  assert.equal(rec.baseLight, 'blue')
  assert.equal(rec.light, 'blue')
  assert.equal(rec.matchedRule, 'write-in-buffer')
  assert.equal(rec.decision, DECISION.MARK)
  assert.equal(rec.pluginId, 'p1')
  assert.equal(out.decision, DECISION.MARK)
  assert.equal(out.decisionRecord.light, 'blue')
  assert.equal(typeof rec.at, 'number')
  assert.ok(rec.durationMs >= 0)

  // 审计回调抛错不得影响决策
  const noisy = createUmbrella({ scorer: null, policy: { bufferRoot: BUF }, audit: () => { throw new Error('boom') } })
  assert.equal(noisy.decideAction({ tool: 'read', args: { path: path.join(BUF, 'a') } }, { grade: 'A' }).decision, DECISION.ALLOW)
})

test('a policy function is re-read on every assessment (live buffer root)', () => {
  let bufferRoot = BUF
  const umb = createUmbrella({ scorer: null, policy: () => ({ bufferRoot }) })
  assert.equal(umb.baseLight({ tool: 'write', args: { path: path.join(BUF, 'a.txt') } }).matchedRule, 'write-in-buffer')

  bufferRoot = path.resolve('C:/fangs/other-buffer')
  assert.equal(umb.baseLight({ tool: 'write', args: { path: path.join(BUF, 'a.txt') } }).matchedRule, 'write-outside-buffer')
  assert.equal(umb.policy.bufferRoot, bufferRoot)
})

test('action scoring stays inside the latency budget (no AST work per call)', () => {
  const umb = createUmbrella({
    scorer: null,
    policy: { bufferRoot: BUF },
    audit: null,
  })
  const evidence = [
    { tool: 'read', args: { path: path.join(BUF, 'a.txt') }, pluginGrade: 'B' },
    { tool: 'write', args: { path: path.join(BUF, 'a.txt') }, pluginGrade: 'C' },
    { tool: 'bash', args: { command: 'git status' }, pluginGrade: 'A' },
    { tool: 'web_fetch', args: { url: 'https://api.example.com/x' }, pluginGrade: 'A' },
  ]
  const rounds = 250
  const started = process.hrtime.bigint()
  for (let i = 0; i < rounds; i += 1) {
    for (const ev of evidence) umb.assessAction(ev)
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const perCall = ms / (rounds * evidence.length)
  assert.ok(perCall < 2, `action assessment averaged ${perCall.toFixed(3)}ms (budget 2ms)`)
})

// ── 插件形态 ────────────────────────────────────────────────────────────────

test('plugin exports the loader shape', () => {
  assert.equal(umbrellaPlugin.name, 'fang-umbrella')
  assert.ok(Array.isArray(umbrellaPlugin.inject))
  assert.equal(typeof umbrellaPlugin.apply, 'function')
  assert.ok(umbrellaPlugin.Config)
})

test('plugin registers fangUmbrella in mother and fork, never in consumer', async () => {
  const previous = process.env.DSH_FANG_ROLE
  try {
    for (const role of ['mother', 'fork']) {
      process.env.DSH_FANG_ROLE = role
      const ctx = makeCtx()
      try {
        umbrellaPlugin.apply(ctx, {})
        const svc = ctx.get(SERVICE.umbrella)
        assert.ok(svc, `service must register in ${role}`)
        assert.equal(svc.environment, role)
        assert.equal(svc.floorTable, 'umbrella')
        assert.deepEqual(svc.floors, GRADE_FLOOR)
      } finally {
        ctx.dispose()
      }
    }
    process.env.DSH_FANG_ROLE = 'consumer'
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, {})
      assert.equal(ctx.get(SERVICE.umbrella), undefined, 'consumer must not get the umbrella service')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
})

test('plugin service: grades via fang-scorer, audits via fang-auditor, honours config', () => {
  const appended = []
  const bufferDir = tmpDir('fang-umbrella-buf-')
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  try {
    const ctx = makeCtx({
      services: {
        [SERVICE.scorer]: {
          scoreDir: (_dir, _manifest, opts) => ({
            grade: 'C', S: 40, color: 'yellow', veto: false, degraded: false,
            signals: [{ id: 'S3-fs-write', weight: 15 }], reasons: ['S3→D1'], basis: { environment: opts?.environment },
            dir: path.resolve('C:/demo'), entry: 'index.js',
          }),
        },
        [SERVICE.auditor]: { append: (kind, data) => appended.push({ kind, data }) },
        [SERVICE.buffer]: { dir: bufferDir },
      },
    })
    try {
      umbrellaPlugin.apply(ctx, { gradeFloorTable: 'strict', cacheSize: 5 })
      const svc = ctx.get(SERVICE.umbrella)
      assert.ok(svc)

      const plugin = svc.assessPlugin({ pluginId: 'demo', dir: path.resolve('C:/demo') })
      assert.equal(plugin.grade, 'C')
      assert.equal(plugin.basis.environment, 'mother')
      assert.equal(plugin.fromCache, false)
      assert.equal(svc.cachedGrade('demo'), 'C')

      // buffer root 来自 buffer-keeper 的实时 dir
      const inBuffer = svc.assessAction({ tool: 'write', args: { path: path.join(bufferDir, 'a.txt') } }, { grade: 'A' })
      assert.equal(inBuffer.baseLight, 'blue')
      assert.equal(inBuffer.matchedRule, 'write-in-buffer')

      // strict 表：B 级 → 蓝下限
      assert.equal(svc.gradeFloor('B'), 'blue')
      assert.equal(svc.effectiveLight('green', 'B').light, 'blue')

      const decision = svc.decideAction({ tool: 'write', args: { path: path.join(bufferDir, 'a.txt') } }, { grade: 'B' })
      assert.equal(decision.light, 'blue')
      assert.equal(decision.decision, DECISION.MARK)
      assert.equal(appended.length, 1)
      assert.equal(appended[0].kind, 'umbrella-decision')
      assert.equal(appended[0].data.light, 'blue')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
    fs.rmSync(bufferDir, { recursive: true, force: true })
  }
})

test('plugin without fang-scorer still answers, failing closed', () => {
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'fork'
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { auditDecisions: false })
      const svc = ctx.get(SERVICE.umbrella)
      const a = svc.assessPlugin({ pluginId: 'no-scorer', source: 'export const a = 1' })
      assert.equal(a.grade, 'E')
      assert.equal(a.degraded, true)
      assert.equal(svc.decideAction({ tool: 'read', args: { path: 'C:/x' } }).decision, DECISION.ASK)
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
})

test('unknown gradeFloorTable degrades to the umbrella table instead of throwing', () => {
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { gradeFloorTable: 'nonsense' })
      const svc = ctx.get(SERVICE.umbrella)
      assert.equal(svc.floorTable, 'umbrella')
      assert.equal(svc.floorDegraded, true)
      assert.equal(svc.gradeFloor('B'), 'green')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
})

function pick(result) {
  return [result.light, result.matchedRule]
}

// LIGHT 常量与 kernel 词汇一致性（防止两个模块各说各话）
test('lib re-uses the kernel light vocabulary', () => {
  assert.deepEqual(LIGHT, { GREEN: 'green', BLUE: 'blue', YELLOW: 'yellow', RED: 'red' })
  assert.equal(LIGHT_RANK.green < LIGHT_RANK.red, true)
})
