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
  ACTION_CATEGORIES,
  DEFAULT_ACTION_RULES,
  DECISION,
  DEFAULT_CREDENTIAL_PATTERNS,
  FLOOR_TABLES,
  GRADE_FLOOR,
  GRADE_FLOOR_STRICT,
  assertActionRule,
  baseLight,
  buildActionContext,
  createActionRuleSet,
  createUmbrella,
  decide,
  effectiveLight,
  gradeFloor,
  lightAtLeast,
  maxLight,
  normalizeGrade,
  normalizeLight,
  normalizePolicy,
  parseShellRedirects,
  parseUrlParts,
  rankOf,
  resolveFloorTable,
  scopeOf,
  tokenizeShell,
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

test('network allowlist URL prefixes respect host and path boundaries', () => {
  const originPolicy = normalizePolicy({ bufferRoot: BUF, networkAllowlist: ['https://api.example.com'] })
  assert.equal(baseLight({ tool: 'web_fetch', target: { kind: 'url', value: 'https://api.example.com/v1' } }, originPolicy).matchedRule, 'network-allowlisted')
  assert.equal(baseLight({ tool: 'web_fetch', target: { kind: 'url', value: 'https://api.example.com.evil/v1' } }, originPolicy).matchedRule, 'network-egress')

  const pathPolicy = normalizePolicy({ bufferRoot: BUF, networkAllowlist: ['https://api.example.com/v1'] })
  assert.equal(baseLight({ tool: 'web_fetch', target: { kind: 'url', value: 'https://api.example.com/v1/x' } }, pathPolicy).matchedRule, 'network-allowlisted')
  assert.equal(baseLight({ tool: 'web_fetch', target: { kind: 'url', value: 'https://api.example.com/v1' } }, pathPolicy).matchedRule, 'network-allowlisted')
  assert.equal(baseLight({ tool: 'web_fetch', target: { kind: 'url', value: 'https://api.example.com/v1evil' } }, pathPolicy).matchedRule, 'network-egress')
})

test('exec read-only prefix does not survive chained commands or substitution', () => {
  const p = normalizePolicy({ bufferRoot: BUF })
  for (const command of ['cat x; rm -rf /', 'cat x | tee y', 'cat x && echo y', 'cat $(rm x)', 'cat `rm x`']) {
    const out = baseLight({ tool: 'bash', args: { command } }, p)
    assert.notEqual(out.matchedRule, 'exec-read-only', command)
  }
  assert.equal(baseLight({ tool: 'bash', args: { command: 'git status' } }, p).matchedRule, 'exec-read-only')
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

test('cache key separates pluginId by dir and invalidate removes all dir variants', () => {
  const root = tmpDir('fang-umbrella-cache-')
  const dirA = path.join(root, 'a')
  const dirB = path.join(root, 'b')
  try {
    for (const dir of [dirA, dirB]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'same', version: '1.0.0', main: 'index.js' }), 'utf8')
      fs.writeFileSync(path.join(dir, 'index.js'), 'export const a = 1\n', 'utf8')
    }
    let scans = 0
    const scorer = {
      scoreDir(dir) {
        scans += 1
        return { grade: 'B', S: 28, color: 'blue', veto: false, degraded: false, signals: [], reasons: [], basis: {}, dir, entry: 'index.js' }
      },
    }
    const umb = createUmbrella({ scorer })
    assert.equal(umb.assessPlugin({ pluginId: 'same', dir: dirA }).fromCache, false)
    assert.equal(umb.assessPlugin({ pluginId: 'same', dir: dirB }).fromCache, false, 'same id in another dir must not share cache')
    assert.equal(scans, 2)
    assert.equal(umb.assessPlugin({ pluginId: 'same', dir: dirA }).fromCache, true)
    assert.ok(umb.invalidate('same') >= 2)
    assert.equal(umb.assessPlugin({ pluginId: 'same', dir: dirA }).fromCache, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cache fingerprint includes package.json mtime', () => {
  const dir = tmpDir('fang-umbrella-pkg-')
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-cache', version: '1.0.0', main: 'index.js' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'index.js'), 'export const a = 1\n', 'utf8')
    const scorer = {
      scoreDir(target) {
        return { grade: 'B', S: 28, color: 'blue', veto: false, degraded: false, signals: [], reasons: [], basis: {}, dir: target, entry: 'index.js' }
      },
    }
    const umb = createUmbrella({ scorer })
    assert.equal(umb.assessPlugin({ pluginId: 'pkg-cache', dir }).fromCache, false)
    assert.equal(umb.assessPlugin({ pluginId: 'pkg-cache', dir }).fromCache, true)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-cache', version: '1.0.1', main: 'index.js' }), 'utf8')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(dir, 'package.json'), later, later)
    assert.equal(umb.assessPlugin({ pluginId: 'pkg-cache', dir }).fromCache, false, 'package change must invalidate even when entry mtime is unchanged')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('withinPath resolves symlinked parents and blocks buffer escape', () => {
  const root = tmpDir('fang-umbrella-realpath-')
  const buffer = path.join(root, 'buffer')
  const outside = path.join(root, 'outside')
  try {
    fs.mkdirSync(buffer, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    assert.equal(baseLight({ tool: 'write', args: { path: path.join(buffer, 'inside.txt') } }, normalizePolicy({ bufferRoot: buffer })).matchedRule, 'write-in-buffer')
    try {
      fs.symlinkSync(outside, path.join(buffer, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // symlink creation can require privileges; the direct path case above still ran
    }
    const escaped = baseLight({ tool: 'write', args: { path: path.join(buffer, 'link', 'secret.txt') } }, normalizePolicy({ bufferRoot: buffer }))
    assert.equal(escaped.matchedRule, 'write-outside-buffer')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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

test('umbrella ASK emits a decision-center ticket when the service is available', () => {
  const submitted = []
  const center = { submit(item) { submitted.push(item); return { ok: true, ticket: { id: `dec_${submitted.length}` } } } }
  const umb = createUmbrella({ decisionCenter: center, policy: normalizePolicy({ bufferRoot: BUF }) })
  const green = umb.decideAction({ tool: 'read', args: { path: path.join(BUF, 'x') } }, { grade: 'A' })
  assert.equal(green.decision, 'allow')
  assert.equal(submitted.length, 0)

  const yellow = umb.decideAction({ tool: 'write', args: { path: path.resolve('C:/outside/x.txt') } }, { grade: 'A' })
  assert.equal(yellow.decision, 'ask')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].level, 'yellow')
  assert.equal(submitted[0].source, 'System')
  assert.equal(yellow.decisionTicketId, 'dec_1')
  assert.equal(yellow.decisionRecord.decisionTicketId, 'dec_1')

  const red = umb.decideAction({ tool: 'bash', args: { command: 'rm -rf build' } }, { grade: 'A' })
  assert.equal(red.decision, 'ask')
  assert.equal(red.severity, 'critical')
  assert.equal(submitted.length, 2)
  assert.equal(submitted[1].level, 'red')
  // 去重键：同一 action 重复 ASK 必须带同一个 dedupeKey，供决策中心合并。
  assert.ok(submitted[0].dedupeKey && submitted[0].dedupeKey.startsWith('umbrella:'))
  const repeat = umb.decideAction({ tool: 'write', args: { path: path.resolve('C:/outside/x.txt') } }, { grade: 'A' })
  assert.equal(repeat.decision, 'ask')
  assert.equal(submitted[2].dedupeKey, submitted[0].dedupeKey)
})

test('umbrella ASK links an async decision ticket (fork proxy/outbox)', async () => {
  const submitted = []
  const center = {
    async submit(item) { submitted.push(item); return { ok: true, ticket: { id: 'dec_async_fork' } } },
  }
  const umb = createUmbrella({ decisionCenter: center, policy: normalizePolicy({ bufferRoot: BUF }) })
  const out = umb.decideAction({ tool: 'write', args: { path: path.resolve('C:/outside/async.txt') } }, { grade: 'A' })
  assert.equal(out.decision, 'ask')
  assert.equal(out.decisionTicketId, null, 'async submit cannot fill the sync field')
  assert.equal(typeof out.decisionTicketPromise?.then, 'function')
  const linked = await out.decisionTicketPromise
  assert.equal(linked.ticket.id, 'dec_async_fork')
  assert.equal(out.decisionRecord.decisionTicketId, 'dec_async_fork')
  assert.equal(submitted.length, 1)

  // 异步 submit 失败不能产生 unhandled rejection；promise 解析为 null。
  const offline = {
    async submit() { throw new Error('mother offline') },
  }
  const umb2 = createUmbrella({ decisionCenter: offline, policy: normalizePolicy({ bufferRoot: BUF }) })
  const failed = umb2.decideAction({ tool: 'write', args: { path: path.resolve('C:/outside/async-offline.txt') } }, { grade: 'A' })
  assert.equal(failed.decision, 'ask')
  assert.equal(await failed.decisionTicketPromise, null)
  assert.equal(failed.decisionRecord.decisionTicketId, null)
})

test('evidence.trusted is an explicit caller assertion, never inferred', () => {
  const p = normalizePolicy({ bufferRoot: BUF })
  const evidence = { tool: 'read', args: { path: path.join(BUF, 'a.txt') } }
  assert.equal(baseLight(evidence, p).trusted, false)
  assert.equal(baseLight({ ...evidence, trusted: true }, p).trusted, true)

  const umb = createUmbrella({ scorer: null, policy: p })
  const action = umb.assessAction({ ...evidence, trusted: true }, { grade: 'A' })
  assert.equal(action.trusted, true)
  const decision = umb.decideAction({ ...evidence, trusted: true }, { grade: 'A' })
  assert.equal(decision.trusted, true)
  assert.equal(decision.decisionRecord.trusted, true)
})

test('decideAction marks auditDegraded when the auditor is missing', () => {
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  const ctx = makeCtx()
  try {
    umbrellaPlugin.apply(ctx, { baselineFile: ':none:', rulesWatch: false })
    const svc = ctx.get(SERVICE.umbrella)
    const out = svc.decideAction({ tool: 'read', args: { path: path.join(BUF, 'x') } }, { grade: 'A' })
    assert.equal(out.auditDegraded, true)
    assert.equal(out.decisionRecord.auditDegraded, true)
  } finally {
    ctx.dispose()
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
  }
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

// ── 声明式动作规则表（v2.7.8）────────────────────────────────────────────────

test('DEFAULT_ACTION_RULES: 15 条规则、顺序即优先级、冻结不可变', () => {
  assert.equal(DEFAULT_ACTION_RULES.length, 15)
  assert.equal(Object.isFrozen(DEFAULT_ACTION_RULES), true)
  assert.deepEqual(DEFAULT_ACTION_RULES.map((r) => r.id), [
    'dsh-lifecycle',
    'destructive-command',
    'credential-access',
    'network-allowlisted',
    'network-egress',
    'dynamic-import',
    'write-in-buffer',
    'write-in-allowlist',
    'write-production',
    'write-outside-buffer',
    'exec-read-only',
    'exec-side-effect',
    'read-in-buffer',
    'read-outside-buffer',
    'unknown-tool',
  ])
  for (const rule of DEFAULT_ACTION_RULES) {
    assert.ok(typeof rule.id === 'string' && rule.id.length > 0, 'rule.id')
    assert.ok(ACTION_CATEGORIES.includes(rule.category), `rule ${rule.id} category`)
    assert.ok(Object.prototype.hasOwnProperty.call(LIGHT_RANK, rule.light), `rule ${rule.id} light`)
    assert.equal(typeof rule.match, 'function', `rule ${rule.id} match`)
    assert.equal(typeof rule.evidence, 'function', `rule ${rule.id} evidence`)
    assert.ok(Array.isArray(rule.tags), `rule ${rule.id} tags`)
  }
  // 兜底永远在最后：前面任何规则漏判都会落到它这里
  assert.equal(DEFAULT_ACTION_RULES[DEFAULT_ACTION_RULES.length - 1].id, 'unknown-tool')
})

test('每条规则都能独立命中，并给出结构化证据', () => {
  const cases = [
    {
      name: 'dsh-lifecycle (tool)',
      ev: { tool: 'restart' },
      rule: 'dsh-lifecycle', category: 'lifecycle', light: 'red', pattern: 'tool:restart',
    },
    {
      name: 'dsh-lifecycle (scope)',
      ev: { tool: 'write', scope: 'process', target: { kind: 'path', value: 'C:/x' } },
      rule: 'dsh-lifecycle', category: 'lifecycle', light: 'red', pattern: 'scope:process',
    },
    {
      name: 'destructive-command',
      ev: { tool: 'bash', args: { command: 'rm -rf /tmp/x' } },
      rule: 'destructive-command', category: 'destructive', light: 'red', patternPrefix: 'pattern:',
    },
    {
      name: 'credential-access',
      ev: { tool: 'read', target: { kind: 'path', value: path.resolve('C:/home/u/.ssh/id_rsa') } },
      rule: 'credential-access', category: 'credential', light: 'red', patternPrefix: 'pattern:',
    },
    {
      name: 'network-allowlisted',
      ev: { tool: 'web_fetch', target: { kind: 'url', value: 'https://api.example.com/v1' } },
      rule: 'network-allowlisted', category: 'network', light: 'blue', pattern: 'allowlisted-host',
    },
    {
      name: 'network-egress',
      ev: { tool: 'web_fetch', target: { kind: 'url', value: 'https://evil.test/x' } },
      rule: 'network-egress', category: 'network', light: 'yellow', pattern: 'non-allowlisted-host',
    },
    {
      name: 'dynamic-import',
      ev: { tool: 'import', args: { specifier: './x.mjs' } },
      rule: 'dynamic-import', category: 'import', light: 'yellow', pattern: 'import-tool',
    },
    {
      name: 'write-in-buffer',
      ev: { tool: 'write', target: { kind: 'path', value: path.join(BUF, 'a.txt') } },
      rule: 'write-in-buffer', category: 'write', light: 'blue', pattern: 'in-buffer',
    },
    {
      name: 'write-in-allowlist',
      ev: { tool: 'write', target: { kind: 'path', value: path.join(ALLOW, 'a.txt') } },
      rule: 'write-in-allowlist', category: 'write', light: 'blue', pattern: 'in-allowlist',
    },
    {
      name: 'write-production',
      ev: { tool: 'write', target: { kind: 'path', value: path.join(PROD, 'a.txt') } },
      rule: 'write-production', category: 'write', light: 'yellow', pattern: 'production-root',
    },
    {
      name: 'write-outside-buffer',
      ev: { tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/a.txt') } },
      rule: 'write-outside-buffer', category: 'write', light: 'yellow', pattern: 'outside-buffer-and-allowlist',
    },
    {
      name: 'exec-read-only',
      ev: { tool: 'bash', args: { command: 'git status' } },
      rule: 'exec-read-only', category: 'exec', light: 'blue', pattern: 'read-only-prefix',
    },
    {
      name: 'exec-side-effect',
      ev: { tool: 'bash', args: { command: 'npm install left-pad' } },
      rule: 'exec-side-effect', category: 'exec', light: 'yellow', pattern: 'side-effect',
    },
    {
      name: 'read-in-buffer',
      ev: { tool: 'read', target: { kind: 'path', value: path.join(BUF, 'a.txt') } },
      rule: 'read-in-buffer', category: 'read', light: 'green', pattern: 'in-buffer',
    },
    {
      name: 'read-outside-buffer',
      ev: { tool: 'read', target: { kind: 'path', value: path.resolve('C:/fangs/other/a.txt') } },
      rule: 'read-outside-buffer', category: 'read', light: 'blue', pattern: 'outside-buffer',
    },
    {
      name: 'unknown-tool (fallback)',
      ev: { tool: 'mystery-tool' },
      rule: 'unknown-tool', category: 'fallback', light: 'yellow', pattern: 'fallback',
    },
  ]
  for (const c of cases) {
    const out = baseLight(c.ev, policy)
    assert.equal(out.matchedRule, c.rule, `${c.name}: rule`)
    assert.equal(out.category, c.category, `${c.name}: category`)
    assert.equal(out.light, c.light, `${c.name}: light`)
    if (c.pattern !== undefined) {
      assert.equal(out.evidence.matchedPattern, c.pattern, `${c.name}: matchedPattern`)
    }
    if (c.patternPrefix !== undefined) {
      assert.ok(String(out.evidence.matchedPattern).startsWith(c.patternPrefix), `${c.name}: matchedPattern ${out.evidence.matchedPattern}`)
    }
    assert.ok(out.evidence && typeof out.evidence === 'object', `${c.name}: evidence object`)
    assert.ok(Array.isArray(out.tags), `${c.name}: tags`)
  }
})

test('credential 规则的证据带命中的具体路径', () => {
  const ssh = path.resolve('C:/home/u/.ssh/id_rsa')
  const out = baseLight({ tool: 'read', target: { kind: 'path', value: ssh } }, policy)
  assert.equal(out.matchedRule, 'credential-access')
  assert.ok(out.evidence.paths.includes(ssh), JSON.stringify(out.evidence.paths))
  assert.ok(String(out.evidence.matchedPattern).startsWith('pattern:'))
})

test('parseShellRedirects 只取字面量目标，动态构造一律跳过', () => {
  const { writeTargets, readTargets } = parseShellRedirects('cat in.txt | tee out.txt', policy)
  assert.deepEqual(readTargets, [path.resolve('C:/fangs/in.txt')])
  assert.deepEqual(writeTargets, [path.resolve('C:/fangs/out.txt')])

  const redirect = parseShellRedirects('echo hi > out.txt && echo x >> second.txt', policy)
  assert.deepEqual(redirect.writeTargets, [path.resolve('C:/fangs/out.txt'), path.resolve('C:/fangs/second.txt')])

  // 动态路径（$VAR / $(...) / 通配）不静态解析 —— 由 fallback 判黄兜住
  const dynamic = parseShellRedirects('echo hi > $TMP/out.txt', policy)
  assert.deepEqual(dynamic.writeTargets, [])

  const pwsh = parseShellRedirects("Set-Content -Path out.txt 'x'", policy)
  assert.deepEqual(pwsh.writeTargets, [path.resolve('C:/fangs/out.txt')])

  const dd = parseShellRedirects('dd if=in.img of=out.img bs=1', policy)
  assert.deepEqual(dd.writeTargets, [path.resolve('C:/fangs/out.img')])
})

test('parseUrlParts 归一化 host / hostPort，坏 URL 返回 null', () => {
  assert.deepEqual(parseUrlParts('https://API.example.com:8443/x'), {
    raw: 'https://API.example.com:8443/x',
    host: 'api.example.com',
    hostPort: 'api.example.com:8443',
  })
  assert.equal(parseUrlParts('http://a.test/p').hostPort, 'a.test:80')
  assert.equal(parseUrlParts('not a url'), null)
  assert.equal(parseUrlParts(''), null)
})

test('buildActionContext 一次解析出 mode/target/path/url/pid/重定向', () => {
  const ctx = buildActionContext({
    tool: 'bash',
    args: { command: 'cat in.txt > out.txt' },
    target: { kind: 'command', value: 'cat in.txt > out.txt' },
  }, policy)
  assert.equal(ctx.mode, 'exec')
  assert.equal(ctx.target.kind, 'command')
  assert.deepEqual(ctx.readTargets, [path.resolve('C:/fangs/in.txt')])
  assert.deepEqual(ctx.writeTargets, [path.resolve('C:/fangs/out.txt')])

  const pathCtx = buildActionContext({ tool: 'write', target: { kind: 'path', value: 'buffer/a.txt' } }, policy)
  assert.equal(pathCtx.targetPath, path.resolve('C:/fangs/buffer/a.txt'))

  const urlCtx = buildActionContext({ tool: 'fetch', target: { kind: 'url', value: 'https://a.test/x' } }, policy)
  assert.equal(urlCtx.url.host, 'a.test')

  const pidCtx = buildActionContext({ tool: 'shell', target: { kind: 'pid', value: '4242' } }, policy)
  assert.equal(pidCtx.targetPid, 4242)

  assert.equal(scopeOf({ scope: 'system' }), 'system')
  assert.equal(scopeOf({ args: { scope: 'process' } }), 'process')
  assert.equal(scopeOf({ scope: 'session' }), 'session')
  assert.equal(scopeOf({}), null)
})

test('createActionRuleSet: register 必须指定插入位置，重复 id 必须抛错', () => {
  const set = createActionRuleSet()
  assert.deepEqual(set.ids(), DEFAULT_ACTION_RULES.map((r) => r.id))

  const custom = {
    id: 'secret-marker',
    category: 'write',
    light: 'red',
    reason: 'secret marker',
    tags: ['custom'],
    match: (ev, ctx) => String(ctx.targetPath ?? '').includes('secret'),
    evidence: () => ({ matchedPattern: 'secret-marker' }),
  }
  set.register(custom, { before: 'unknown-tool' })
  assert.equal(set.ids()[set.ids().length - 2], 'secret-marker')

  assert.throws(() => set.register(custom, { before: 'unknown-tool' }), /already registered/)
  assert.throws(() => set.register({ ...custom, id: 'no-position' }), /requires before\/after/)
  assert.throws(() => assertActionRule({ id: 'bad', category: 'write', light: 'red' }), /match\(\) is required/)
  assert.throws(() => assertActionRule({ ...custom, id: 'bad2', category: 'nope' }), /unknown category/)
  assert.throws(() => assertActionRule({ ...custom, id: 'bad3', light: 'purple' }), /unknown light/)
})

test('createActionRuleSet: override 改灯色/理由，remove 与 reset 生效', () => {
  const set = createActionRuleSet()
  const original = set.rules.find((r) => r.id === 'unknown-tool')
  set.override('unknown-tool', { light: 'blue', reason: 'overridden' })
  const overridden = set.rules[set.rules.length - 1]
  assert.equal(overridden.light, 'blue')
  assert.equal(overridden.reason, 'overridden')
  assert.equal(typeof overridden.match, 'function', 'override 保留未覆盖字段')
  assert.equal(typeof overridden.evidence, 'function')

  assert.throws(() => set.override('missing-rule', {}), /not found/)
  assert.equal(set.remove('unknown-tool'), true)
  assert.equal(set.ids().length, 14)
  assert.equal(set.remove('unknown-tool'), false)

  set.reset()
  assert.deepEqual(set.ids(), DEFAULT_ACTION_RULES.map((r) => r.id))
  assert.equal(set.rules[set.rules.length - 1], original, 'reset 恢复默认表')
})

test('umbrella 使用自定义规则集：注册、覆盖都影响真实评分与决策', () => {
  const set = createActionRuleSet()
  const umbrella = createUmbrella({ scorer: null, policy: { bufferRoot: BUF }, rules: set })
  assert.equal(umbrella.ruleIds().length, 15)

  umbrella.registerRule({
    id: 'no-secret-dir',
    category: 'write',
    light: 'red',
    reason: '禁止触碰 secret 目录',
    tags: ['custom'],
    match: (ev, ctx) => String(ctx.targetPath ?? '').includes('secret'),
    evidence: () => ({ matchedPattern: 'secret-dir' }),
  }, { before: 'unknown-tool' })

  const mystery = { tool: 'mystery', target: { kind: 'path', value: path.resolve('C:/x/secret/a.bin') } }
  const assessment = umbrella.assessAction(mystery, { grade: 'A' })
  assert.equal(assessment.baseLight, 'red')
  assert.equal(assessment.light, 'red')
  assert.equal(assessment.matchedRule, 'no-secret-dir')
  assert.equal(assessment.category, 'write')
  assert.deepEqual(assessment.tags, ['custom'])
  assert.equal(assessment.evidence.matchedPattern, 'secret-dir')

  const decision = umbrella.decideAction(mystery, { grade: 'A' })
  assert.equal(decision.decision, DECISION.ASK)
  assert.equal(decision.severity, 'critical')
  assert.equal(decision.decisionRecord.category, 'write')
  assert.deepEqual(decision.decisionRecord.evidence, { matchedPattern: 'secret-dir' })

  umbrella.overrideRule('unknown-tool', { light: 'blue', reason: 'demo override' })
  const fallback = umbrella.assessAction({ tool: 'mystery-tool' }, { grade: 'A' })
  assert.equal(fallback.baseLight, 'blue')
  assert.equal(fallback.reason, 'demo override')

  umbrella.resetRules()
  assert.equal(umbrella.ruleIds().length, 15)
  // 规则表只读视图是副本：外部 push 不影响内部
  const view = umbrella.rules
  view.push({ id: 'injected' })
  assert.equal(umbrella.ruleIds().length, 15)
})

test('规则表不因评分调用被改动（纯函数语义）', () => {
  const before = JSON.stringify(DEFAULT_ACTION_RULES.map((r) => r.id))
  const ev = Object.freeze({ tool: 'write', target: Object.freeze({ kind: 'path', value: path.join(BUF, 'a.txt') }) })
  const outer = baseLight(ev, policy)
  const inner = baseLight(ev, policy)
  assert.deepEqual(outer, inner)
  assert.equal(JSON.stringify(DEFAULT_ACTION_RULES.map((r) => r.id)), before)
})

// ── shell AST-lite 解析（v2.7.9）─────────────────────────────────────────────

const resolveTarget = (value) => path.resolve('C:/fangs', value)

test('AST-lite：所有重定向操作符按语义分类（fd 复制不是文件）', () => {
  const cases = [
    { cmd: 'echo x > out.txt', w: ['out.txt'], r: [] },
    { cmd: 'echo x >> out.txt', w: ['out.txt'], r: [] },
    { cmd: 'echo x >| out.txt', w: ['out.txt'], r: [] },
    { cmd: 'cmd &> out.txt', w: ['out.txt'], r: [] },
    { cmd: 'cmd &>> out.txt', w: ['out.txt'], r: [] },
    { cmd: 'cmd >& file.txt', w: ['file.txt'], r: [] },
    { cmd: 'grep x < in.txt > out.txt', w: ['out.txt'], r: ['in.txt'] },
    { cmd: 'cmd <& in.txt', w: [], r: ['in.txt'] },
    { cmd: 'cmd <> f.txt', w: ['f.txt'], r: ['f.txt'] },
    { cmd: 'cmd 2>&1', w: [], r: [] },
    { cmd: 'cmd 2> err.txt', w: ['err.txt'], r: [] },
    { cmd: 'cmd <<< "here"', w: [], r: [] },
  ]
  for (const c of cases) {
    const out = parseShellRedirects(c.cmd, policy)
    assert.deepEqual(out.writeTargets, c.w.map(resolveTarget), `${c.cmd} write`)
    assert.deepEqual(out.readTargets, c.r.map(resolveTarget), `${c.cmd} read`)
    assert.equal(out.parseFailed, false, `${c.cmd} parseFailed`)
  }
})

test('AST-lite：heredoc 正文整段跳过，正文里的 > 不算重定向', () => {
  const cmd = 'cat <<EOF > out.txt\nthis line contains > sneaky.txt and > $(rm -rf /)\nEOF\n'
  const out = parseShellRedirects(cmd, policy)
  assert.deepEqual(out.writeTargets, [resolveTarget('out.txt')])
  assert.deepEqual(out.readTargets, [])
  assert.equal(out.heredocs, 1)
  assert.equal(out.parseFailed, false)

  const tab = 'cat <<-EOF > out2.txt\n\tbody\n\tEOF\n'
  const out2 = parseShellRedirects(tab, policy)
  assert.deepEqual(out2.writeTargets, [resolveTarget('out2.txt')])
  assert.equal(out2.parseFailed, false)
})

test('AST-lite：引号内的 > 不是重定向；带空格的引号目标仍是字面量', () => {
  assert.deepEqual(parseShellRedirects('echo "a > b"', policy).writeTargets, [])
  assert.deepEqual(parseShellRedirects("echo x > 'out file.txt'", policy).writeTargets, [resolveTarget('out file.txt')])
  assert.deepEqual(parseShellRedirects('echo x > "out file.txt"', policy).writeTargets, [resolveTarget('out file.txt')])
  // 嵌套 shell 的字符串：外层看到的是引号内容，不做重定向解析（fail-closed 交给 exec 规则）
  assert.deepEqual(parseShellRedirects("bash -c 'echo x > out.txt'", policy).writeTargets, [])
})

test('AST-lite：动态目标（变量/命令替换/反引号/通配）不当作字面量路径', () => {
  for (const cmd of ['echo x > $DIR/f.txt', 'echo x > "$(mktemp)"', 'echo x > `mktemp`', 'echo x > *.txt']) {
    const out = parseShellRedirects(cmd, policy)
    assert.deepEqual(out.writeTargets, [], cmd)
    assert.equal(out.parseFailed, false, cmd)
    assert.ok(out.warnings.includes('>-dynamic-target'), `${cmd} warnings=${JSON.stringify(out.warnings)}`)
  }
})

test('AST-lite：命令边界分隔，重定向只归属自己那段命令', () => {
  const out = parseShellRedirects('git status; rm -rf build > out.txt && echo done', policy)
  assert.deepEqual(out.writeTargets, [resolveTarget('out.txt')])
  const piped = parseShellRedirects('cat in.txt | tee out.txt', policy)
  assert.deepEqual(piped.readTargets, [resolveTarget('in.txt')])
  assert.deepEqual(piped.writeTargets, [resolveTarget('out.txt')])
})

test('AST-lite：隐式文件命令（tee/dd/Set-Content/Get-Content）', () => {
  const tee = parseShellRedirects('tee -a out.txt', policy)
  assert.deepEqual(tee.writeTargets, [resolveTarget('out.txt')])

  const dd = parseShellRedirects('dd if=in.img of=out.img bs=1', policy)
  assert.deepEqual(dd.readTargets, [resolveTarget('in.img')])
  assert.deepEqual(dd.writeTargets, [resolveTarget('out.img')])

  const ps = parseShellRedirects("Set-Content -Path out.txt 'content'", policy)
  assert.deepEqual(ps.writeTargets, [resolveTarget('out.txt')])

  const gc = parseShellRedirects('Get-Content in.txt', policy)
  assert.deepEqual(gc.readTargets, [resolveTarget('in.txt')])

  const cat = parseShellRedirects('cat a.txt b.txt', policy)
  assert.deepEqual(cat.readTargets, [resolveTarget('a.txt'), resolveTarget('b.txt')])
})

test('AST-lite：语法错误 → parseFailed，规则 fail-closed 判黄而不是猜', () => {
  const unterminated = parseShellRedirects('echo "unclosed', policy)
  assert.equal(unterminated.parseFailed, true)
  assert.equal(unterminated.parseError, 'unterminated-double-quote')
  assert.deepEqual(unterminated.writeTargets, [])

  // 解析失败 + 命令里有 > ：write-outside-buffer 兜住（黄，需审批），证据标注 fail-closed
  const risky = baseLight({ tool: 'bash', args: { command: 'echo "x > out.txt' } }, policy)
  assert.equal(risky.light, 'yellow')
  assert.equal(risky.matchedRule, 'write-outside-buffer')
  assert.equal(risky.evidence.matchedPattern, 'unparsed-redirect-fail-closed')
  assert.equal(risky.evidence.parseFailed, true)

  // 解析失败但没有重定向符号：不宣称只读，落 exec-side-effect 判黄
  const noRedirect = baseLight({ tool: 'bash', args: { command: 'git status "unclosed' } }, policy)
  assert.equal(noRedirect.light, 'yellow')
  assert.equal(noRedirect.matchedRule, 'exec-side-effect')
  assert.equal(noRedirect.evidence.matchedPattern, 'unparsed-command-fail-closed')
})

test('tokenizeShell：fd 前缀与操作符被结构化（不是字符串猜测）', () => {
  const lex = tokenizeShell('cmd 2>&1 > out.txt')
  const redirects = lex.tokens.filter((t) => t.type === 'redirect')
  assert.equal(redirects.length, 2)
  assert.deepEqual({ op: redirects[0].op, fd: redirects[0].fd, target: redirects[0].target.value }, { op: '>&', fd: 2, target: '1' })
  assert.deepEqual({ op: redirects[1].op, fd: redirects[1].fd, target: redirects[1].target.value }, { op: '>', fd: null, target: 'out.txt' })
  assert.equal(lex.errors.length, 0)
})


