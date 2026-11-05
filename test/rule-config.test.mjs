// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// v2.8.0 YAML 规则配置层验收：
//   * YAML 子集解析（块映射/序列/引号标量/flow 列表/注释/明确拒绝不支持的语法）
//   * schema 校验（version / settings / 规则字段 / matcher kind / pattern 限制）
//   * 声明式 matcher + evidence 编译
//   * RuleRegistry：禁用 / 灯色覆盖 / 优先级 / 追加正则 / 新增声明式规则 / fail-safe
//   * 文件加载与热加载管线
//   * 插件接线（rulesFile → 生效、reloadRules、ruleConfigStatus）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { makeCtx, tmpDir } from './helpers.mjs'
import { LIGHT_RANK, SERVICE } from '../src/kernel/index.mjs'
import { DEFAULT_ACTION_RULES, baseLight, createUmbrella, normalizePolicy } from '../src/lib/umbrella.mjs'
import {
  DEFAULT_RULE_PRIORITIES,
  MATCHER_KINDS,
  createRuleRegistry,
  isSafePatternSource,
  loadRuleConfigFile,
  parseYamlSubset,
  validateRuleConfig,
  watchRuleConfigFile,
} from '../src/lib/rule-registry.mjs'
import * as umbrellaPlugin from '../src/plugins/umbrella.mjs'

const policy = normalizePolicy({
  root: path.resolve('C:/fangs'),
  bufferRoot: 'C:/fangs/buffer',
  productionRoot: 'C:/fangs/prod',
  allowPaths: ['C:/fangs/allow'],
  networkAllowlist: ['api.example.com'],
})
const BUF = path.resolve('C:/fangs/buffer')
const ALLOW = path.resolve('C:/fangs/allow')

const CONFIG_HEADER = 'version: 1\n'

function registryWith(yamlText) {
  const parsed = parseYamlSubset(yamlText)
  assert.deepEqual(parsed.errors, [], 'yaml parse errors')
  const validated = validateRuleConfig(parsed.value)
  assert.deepEqual(validated.errors, [], 'schema errors')
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const applied = registry.applyConfig(validated.config)
  assert.equal(applied.errors.length, 0, JSON.stringify(applied.errors))
  return { registry, applied, config: validated.config }
}

// ── YAML 子集解析 ───────────────────────────────────────────────────────────

test('YAML：块映射 / 序列 / 引号标量 / flow 列表 / 注释', () => {
  const parsed = parseYamlSubset(`
# 顶部注释
version: 1
settings:
  failOnUnknownRule: true
rules:
  - id: credential-access
    enabled: false
  - id: write-outside-buffer
    light: red
    tags: [ci-strict, "audit"]
    reason: "CI 环境：越界写需审批"
  - id: net
    match:
      kind: url-host-in
      hosts:
        - api.example.com
        - "*.corp.example"
`)
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.value.version, 1)
  assert.deepEqual(parsed.value.settings, { failOnUnknownRule: true })
  assert.equal(parsed.value.rules.length, 3)
  assert.deepEqual(parsed.value.rules[0], { id: 'credential-access', enabled: false })
  assert.deepEqual(parsed.value.rules[1], {
    id: 'write-outside-buffer',
    light: 'red',
    tags: ['ci-strict', 'audit'],
    reason: 'CI 环境：越界写需审批',
  })
  assert.deepEqual(parsed.value.rules[2], {
    id: 'net',
    match: { kind: 'url-host-in', hosts: ['api.example.com', '*.corp.example'] },
  })
})

test('YAML：tab 缩进 / 多文档 / 结构错误被明确拒绝（不静默）', () => {
  assert.match(parseYamlSubset('version: 1\n\trules: []').errors.join('\n'), /tab indentation/)
  assert.match(parseYamlSubset('---\nversion: 1').errors.join('\n'), /multi-document/)
  const bad = parseYamlSubset('version: 1\nrules:\n  - id: x\n broken: 1')
  assert.ok(bad.errors.length > 0, JSON.stringify(bad.errors))
})

// ── schema 校验 ─────────────────────────────────────────────────────────────

test('schema：version / 未知 matcher / 灯色 / id 形状 / pattern 限制', () => {
  assert.ok(validateRuleConfig({ version: 2 }).errors.some((e) => e.includes('version')))
  assert.ok(validateRuleConfig({ version: 1, rules: [{ id: 'Bad Id' }] }).errors.some((e) => e.includes('id')))
  assert.ok(validateRuleConfig({ version: 1, rules: [{ id: 'x', light: 'purple' }] }).errors.some((e) => e.includes('light')))
  assert.ok(validateRuleConfig({ version: 1, rules: [{ id: 'x', match: { kind: 'nope' } }] }).errors.some((e) => e.includes('unknown matcher')))
  assert.ok(validateRuleConfig({ version: 1, rules: [{ id: 'x', match: { kind: 'command-pattern', patterns: [] } }] }).errors.some((e) => e.includes('1..')))
  assert.ok(validateRuleConfig({ version: 1, rules: [{ id: 'x', match: { kind: 'command-pattern', patterns: [{ re: 'a'.repeat(600) }] } }] }).errors.some((e) => e.includes('longer')))
  assert.ok(validateRuleConfig({ version: 1, rules: [{ id: 'x', evidence: { kind: 'nope' } }] }).errors.some((e) => e.includes('unknown evidence')))
  const ok = validateRuleConfig({ version: 1, rules: [{ id: 'x', enabled: true }] })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.config.settings.rejectUnsafeRegex, true)
})

test('正则安全启发式：明显灾难回溯被拒，普通模式通过', () => {
  assert.equal(isSafePatternSource('\\brm\\s+-rf\\b'), true)
  assert.equal(isSafePatternSource('(a+)+'), false)
  assert.equal(isSafePatternSource('(.*)*'), false)
  assert.equal(isSafePatternSource('a'.repeat(600)), false)
})

// ── 声明式 matcher ──────────────────────────────────────────────────────────

test('声明式规则：command-pattern / path-pattern / url-host-in / tool-in / always / never', () => {
  const { registry } = registryWith(`${CONFIG_HEADER}rules:
  - id: block-build-delete
    category: destructive
    light: red
    reason: 禁止删除构建目录
    priority: 5
    match:
      kind: command-pattern
      patterns:
        - re: "\\\\brm\\\\s+-rf\\\\s+(?:dist|build)\\\\b"
          label: delete build
    evidence:
      kind: pattern-match
  - id: deny-dsh-secrets
    category: credential
    light: red
    reason: DSH secrets 目录
    priority: 6
    match:
      kind: path-pattern
      scope: all
      patterns:
        - re: "\\\\.dsh[\\\\\\\\/]secrets"
    evidence:
      kind: list-match
  - id: corp-network
    category: network
    light: blue
    reason: 公司内网
    priority: 7
    match:
      kind: url-host-in
      hosts: ["*.corp.example.com"]
    evidence:
      kind: static
      payload:
        allowlist: company
  - id: tool-block
    category: write
    light: red
    reason: 禁用某工具
    priority: 8
    match:
      kind: tool-in
      tools: ["danger-write"]
    evidence:
      kind: static
      payload:
        source: tool
  - id: never-rule
    category: fallback
    light: green
    reason: 永不命中
    priority: 9
    match:
      kind: never
`)

  const destroy = baseLight({ tool: 'bash', args: { command: 'rm -rf build' } }, policy, registry)
  assert.equal(destroy.matchedRule, 'block-build-delete')
  assert.equal(destroy.light, 'red')

  const secret = baseLight({ tool: 'read', target: { kind: 'path', value: path.resolve('C:/home/u/.dsh/secrets/key') } }, policy, registry)
  assert.equal(secret.matchedRule, 'deny-dsh-secrets')

  const corp = baseLight({ tool: 'web_fetch', target: { kind: 'url', value: 'https://api.corp.example.com/x' } }, policy, registry)
  assert.equal(corp.matchedRule, 'corp-network')
  assert.equal(corp.light, 'blue')
  assert.deepEqual(corp.evidence, { allowlist: 'company' })

  const tool = baseLight({ tool: 'danger-write', target: { kind: 'path', value: path.join(BUF, 'a') } }, policy, registry)
  assert.equal(tool.matchedRule, 'tool-block')

  // never 规则永不命中：普通读仍走 read-in-buffer
  const read = baseLight({ tool: 'read', target: { kind: 'path', value: path.join(BUF, 'a') } }, policy, registry)
  assert.equal(read.matchedRule, 'read-in-buffer')
})

// ── Registry：开关 / 覆盖 / 优先级 / 追加正则 ───────────────────────────────

test('Registry：默认 15 条按 DEFAULT_RULE_PRIORITIES 排序，unknown-tool 永远最后', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  assert.equal(registry.ids().length, 15)
  assert.equal(registry.ids()[0], 'dsh-lifecycle')
  assert.equal(registry.ids().at(-1), 'unknown-tool')
  assert.equal(DEFAULT_RULE_PRIORITIES['unknown-tool'], 9999)
})

test('Registry：enabled:false 禁用内置规则；light/reason/tags 覆盖', () => {
  // 注意：credential-access / dsh-lifecycle / destructive-command 带 hard-deny 标签 = 不可协商，
  // 关闭它们会被拒绝（见「硬规则锁定」用例）。这里用可调规则做演示。
  const { registry } = registryWith(`${CONFIG_HEADER}rules:
  - id: dynamic-import
    enabled: false
  - id: write-outside-buffer
    light: red
    reason: CI 环境全部越界写需审批
    tags: ["ci-strict"]
`)
  assert.equal(registry.ids().includes('dynamic-import'), false)
  const imp = baseLight({ tool: 'import', args: { specifier: './x.mjs' } }, policy, registry)
  assert.notEqual(imp.matchedRule, 'dynamic-import')
  assert.equal(imp.matchedRule, 'unknown-tool')
  const write = baseLight({ tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/a') } }, policy, registry)
  assert.equal(write.matchedRule, 'write-outside-buffer')
  assert.equal(write.light, 'red')
  assert.equal(write.reason, 'CI 环境全部越界写需审批')
  assert.deepEqual(write.tags, ['ci-strict'])
})

test('Registry：priority 覆盖改变匹配顺序（稳定排序）', () => {
  // 把 read-outside-buffer 提前到 unknown-tool 之前，并给 write-outside-buffer 更高优先级
  const { registry } = registryWith(`${CONFIG_HEADER}rules:
  - id: unknown-tool
    priority: 1
  - id: read-in-buffer
    priority: 2
`)
  assert.deepEqual(registry.ids().slice(0, 2), ['unknown-tool', 'read-in-buffer'])
  const read = baseLight({ tool: 'read', target: { kind: 'path', value: path.join(BUF, 'a') } }, policy, registry)
  assert.equal(read.matchedRule, 'unknown-tool', 'unknown-tool 被提前后先命中（证明顺序真的生效）')
})

test('Registry：给内置规则追加 command/path 正则（不改代码）', () => {
  const { registry } = registryWith(`${CONFIG_HEADER}rules:
  - id: destructive-command
    commandPatterns:
      - re: "\\\\bdelete-everything\\\\b"
        label: internal wiper
  - id: credential-access
    pathPatterns:
      - re: "\\\\.npmrc$"
        label: npm token
`)
  const wiped = baseLight({ tool: 'bash', args: { command: 'delete-everything now' } }, policy, registry)
  assert.equal(wiped.matchedRule, 'destructive-command')
  const npmrc = baseLight({ tool: 'read', target: { kind: 'path', value: path.resolve('C:/home/u/.npmrc') } }, policy, registry)
  assert.equal(npmrc.matchedRule, 'credential-access')
})

test('Registry：未知 id 警告；failOnUnknownRule 时整体拒绝（保留旧规则）', () => {
  const warn = registryWith(`${CONFIG_HEADER}rules:
  - id: no-such-rule
    enabled: false
`)
  assert.ok(warn.applied.warnings.some((w) => w.includes('no-such-rule')))

  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const before = registry.ids()
  const parsed = parseYamlSubset(`${CONFIG_HEADER}settings:
  failOnUnknownRule: true
rules:
  - id: no-such-rule
    enabled: false
`)
  const validated = validateRuleConfig(parsed.value)
  const applied = registry.applyConfig(validated.config)
  assert.equal(applied.applied, false)
  assert.deepEqual(registry.ids(), before, '失败时保留旧规则（事务化）')
})

test('Registry：failOnInvalidPattern 时编译错误导致整体拒绝，保留旧规则', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const before = registry.ids()
  const yamlText = `${CONFIG_HEADER}settings:
  failOnInvalidPattern: true
  rejectUnsafeRegex: false
rules:
  - id: bad-regex
    category: destructive
    light: red
    reason: bad
    match:
      kind: command-pattern
      patterns:
        - re: "(["
`
  const parsed = parseYamlSubset(yamlText)
  const validated = validateRuleConfig(parsed.value)
  assert.deepEqual(validated.errors, [])
  const applied = registry.applyConfig(validated.config)
  assert.equal(applied.applied, false)
  assert.ok(applied.errors.length > 0)
  assert.deepEqual(registry.ids(), before)
})

test('Registry：resetToBuiltin 恢复 15 条并回到 builtin 来源', () => {
  const { registry } = registryWith(`${CONFIG_HEADER}rules:
  - id: dynamic-import
    enabled: false
`)
  assert.equal(registry.ids().length, 14)
  registry.resetToBuiltin()
  assert.equal(registry.ids().length, 15)
  assert.equal(registry.status().source, 'builtin')
})

// ── 文件加载与热加载管线 ────────────────────────────────────────────────────

function writeRules(file, yaml) {
  fs.writeFileSync(file, yaml, 'utf8')
}

test('loadRuleConfigFile：存在 / 不存在 / YAML 坏 / schema 坏', () => {
  const dir = tmpDir('fang-rules-')
  try {
    const good = path.join(dir, 'good.yaml')
    writeRules(good, `${CONFIG_HEADER}rules:\n  - id: credential-access\n    enabled: false\n`)
    const loaded = loadRuleConfigFile(good)
    assert.equal(loaded.found, true)
    assert.equal(loaded.errors.length, 0)
    assert.equal(loaded.config.rules[0].id, 'credential-access')

    const missing = loadRuleConfigFile(path.join(dir, 'nope.yaml'))
    assert.deepEqual([missing.found, missing.config, missing.errors], [false, null, []])

    const brokenYaml = path.join(dir, 'broken.yaml')
    writeRules(brokenYaml, 'version: 1\nrules: [\n')
    assert.ok(loadRuleConfigFile(brokenYaml).errors.length > 0)

    const brokenSchema = path.join(dir, 'schema.yaml')
    writeRules(brokenSchema, 'version: 9\nrules: []\n')
    assert.ok(loadRuleConfigFile(brokenSchema).errors.some((e) => e.includes('version')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('热加载管线：重读文件 → 应用；坏文件 → 保留旧规则', () => {
  const dir = tmpDir('fang-rules-watch-')
  try {
    const file = path.join(dir, 'rules.yaml')
    writeRules(file, `${CONFIG_HEADER}rules:\n  - id: dynamic-import\n    enabled: false\n`)
    const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
    const results = []
    const watcher = watchRuleConfigFile(file, registry, (r) => results.push(r), { debounceMs: 10 })
    try {
      watcher.reload()
      assert.equal(results.at(-1).applied, true)
      assert.equal(registry.ids().includes('dynamic-import'), false)

      // 坏 YAML：保留旧规则
      writeRules(file, 'version: 1\nrules: [\n')
      watcher.reload()
      assert.equal(results.at(-1).applied, false)
      assert.equal(registry.ids().includes('dynamic-import'), false, '失败必须保留上一次有效规则')

      // 再次有效：恢复
      writeRules(file, `${CONFIG_HEADER}rules:\n  - id: exec-read-only\n    enabled: false\n`)
      watcher.reload()
      assert.equal(results.at(-1).applied, true)
      assert.equal(registry.ids().includes('exec-read-only'), false)
      assert.equal(registry.ids().includes('dynamic-import'), true, '重新应用整份配置（不是增量）')
    } finally {
      watcher.stop()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 插件接线 ────────────────────────────────────────────────────────────────

test('插件：rulesFile 生效、reloadRules 重读、ruleConfigStatus 报告来源', async () => {
  const dir = tmpDir('fang-rules-plugin-')
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  const file = path.join(dir, 'rules.yaml')
  writeRules(file, `${CONFIG_HEADER}rules:\n  - id: dynamic-import\n    enabled: false\n`)
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { rulesFile: file, rulesWatch: false, baselineFile: '' })
      const svc = ctx.get(SERVICE.umbrella)
      assert.ok(svc)
      const status = svc.ruleConfigStatus()
      assert.equal(status.applied, true)
      assert.equal(status.rules.includes('dynamic-import'), false)

      // 规则真的生效：import 工具不再命中 dynamic-import
      const decision = svc.decideAction({ tool: 'import', args: { specifier: './x.mjs' } }, { grade: 'A' })
      assert.notEqual(decision.matchedRule, 'dynamic-import')

      // 改文件 → reloadRules
      writeRules(file, `${CONFIG_HEADER}rules:\n  - id: exec-read-only\n    enabled: false\n`)
      const reloaded = svc.reloadRules()
      assert.equal(reloaded.applied, true)
      assert.equal(svc.ruleConfigStatus().rules.includes('exec-read-only'), false)
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('插件：坏 rulesFile 不崩、回退纯内置并报告错误', () => {
  const dir = tmpDir('fang-rules-broken-')
  const previous = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  const file = path.join(dir, 'rules.yaml')
  writeRules(file, 'version: 1\nrules: [\n')
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { rulesFile: file, rulesWatch: false, baselineFile: ':none:' })
      const svc = ctx.get(SERVICE.umbrella)
      assert.ok(svc)
      const status = svc.ruleConfigStatus()
      assert.equal(status.applied, false)
      assert.ok(status.errors.length > 0)
      assert.equal(status.rules.length, 15, '回退到纯内置 15 条')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('umbrella 门面：传入 registry 时 baseLight/assessAction 用注册表规则', () => {
  const { registry } = registryWith(`${CONFIG_HEADER}rules:
  - id: project-block
    category: destructive
    light: red
    reason: 项目级拦截
    priority: 1
    match:
      kind: command-pattern
      patterns:
        - re: "\\\\bdropdb\\\\b"
    evidence:
      kind: pattern-match
`)
  const umbrella = createUmbrella({ scorer: null, policy, registry })
  assert.equal(umbrella.ruleIds()[0], 'project-block')
  assert.equal(umbrella.ruleRegistry, registry)
  const assessment = umbrella.assessAction({ tool: 'bash', args: { command: 'dropdb prod' } }, { grade: 'A' })
  assert.equal(assessment.matchedRule, 'project-block')
  assert.equal(assessment.light, 'red')
})

test('MATCHER_KINDS 覆盖文档声明的 9 种声明式 matcher', () => {
  assert.deepEqual(MATCHER_KINDS, [
    'command-pattern', 'path-pattern', 'path-outside',
    'url-host-in', 'url-host-not-in', 'tool-in', 'pid-equal', 'always', 'never',
  ])
  // LIGHT_RANK 与 matcher 无关但确认灯色词汇可用（防止 schema 使用未知灯色）
  assert.equal(LIGHT_RANK.red, 4)
})

// ── 推荐基线 + 分层 + 硬规则锁定（v2.8.1）────────────────────────────────────

const BASELINE_PATH = path.resolve(import.meta.dirname ?? process.cwd(), '..', 'defaults', 'umbrella-rules.yaml')

test('基线文件：随包默认值可解析、硬规则带 non-negotiable 标签', () => {
  const loaded = loadRuleConfigFile(BASELINE_PATH)
  assert.deepEqual(loaded.errors, [])
  assert.ok(loaded.config)
  const ids = loaded.config.rules.map((r) => r.id)
  for (const id of ['dsh-lifecycle', 'destructive-command', 'credential-access', 'unknown-tool']) {
    assert.ok(ids.includes(id), `baseline must lock ${id}`)
  }
  const hard = loaded.config.rules.find((r) => r.id === 'credential-access')
  assert.ok(hard.tags.includes('non-negotiable'))
  assert.equal(hard.enabled, true)
  // 基线设置：正则错误整层拒绝
  assert.equal(loaded.config.settings.failOnInvalidPattern, true)
})

test('分层：基线 → 项目 → 环境，后层按 id 覆盖；锁定规则不可关闭/不可降级', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const base = validateRuleConfig(parseYamlSubset(`version: 1
settings: { failOnInvalidPattern: true }
rules:
  - id: credential-access
    enabled: true
    light: red
    tags: [hard-deny, non-negotiable]
  - id: write-outside-buffer
    light: red
    reason: baseline strict
`).value)
  assert.deepEqual(base.errors, [])
  const first = registry.applyLayer(base.config)
  assert.equal(first.applied, true)
  assert.equal(registry.status().source, 'layered')

  const project = validateRuleConfig(parseYamlSubset(`version: 1
settings: { failOnInvalidPattern: true }
rules:
  - id: write-outside-buffer
    light: yellow
    reason: project relaxed
  - id: credential-access
    enabled: false
`).value)
  assert.deepEqual(project.errors, [])
  const second = registry.applyLayer(project.config)
  // 锁定规则被尝试关闭 → 该层 fatal（failOnInvalidPattern: true）→ 保留上一次有效规则
  assert.equal(second.applied, false)
  assert.ok(second.errors.some((e) => e.includes('cannot be disabled')))
  const write = baseLight({ tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/x') } }, policy, registry)
  assert.equal(write.light, 'red', '失败的层不得生效（保留基线值）')
  assert.equal(write.reason, 'baseline strict')

  // 下一层：只覆盖可调规则 → 生效
  const env = validateRuleConfig(parseYamlSubset(`version: 1
rules:
  - id: write-outside-buffer
    light: yellow
    reason: env relaxed
`).value)
  const third = registry.applyLayer(env.config)
  assert.equal(third.applied, true)
  const after = baseLight({ tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/x') } }, policy, registry)
  assert.equal(after.light, 'yellow')
  assert.equal(after.reason, 'env relaxed')
  // 被拒绝的项目层已从层栈弹出（只保留 baseline + env 两层）
  assert.equal(registry.layerCount(), 2)
})

test('锁定：允许追加 pattern / 提升灯色，拒绝降级与关闭', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const baseline = validateRuleConfig(parseYamlSubset(`version: 1
rules:
  - id: credential-access
    enabled: true
    light: red
    tags: [hard-deny, non-negotiable]
`).value)
  assert.equal(registry.applyLayer(baseline.config).applied, true)

  const downgrade = validateRuleConfig(parseYamlSubset(`version: 1
rules:
  - id: credential-access
    light: yellow
`).value)
  const rejected = registry.applyLayer(downgrade.config)
  assert.equal(rejected.applied, false)
  assert.ok(rejected.errors.some((e) => e.includes('cannot be lowered')))

  // 追加 pattern 允许（硬规则扩面）
  const extend = validateRuleConfig(parseYamlSubset(`version: 1
rules:
  - id: credential-access
    pathPatterns:
      - re: "\\\\.dsh[\\\\\\\\/]secrets"
`).value)
  assert.deepEqual(extend.errors, [])
  const ok = registry.applyLayer(extend.config)
  assert.equal(ok.applied, true)
  const hit = baseLight({ tool: 'read', target: { kind: 'path', value: path.resolve('C:/home/u/.dsh/secrets/k') } }, policy, registry)
  assert.equal(hit.matchedRule, 'credential-access')
})

test('插件：默认自动加载随包基线；项目层尝试关闭硬规则被拒绝并保留基线', () => {
  const dir = tmpDir('fang-rules-layers-')
  const previousRole = process.env.DSH_FANG_ROLE
  const previousEnv = process.env.UMBRELLA_RULES_PATH
  process.env.DSH_FANG_ROLE = 'mother'
  delete process.env.UMBRELLA_RULES_PATH
  const projectFile = path.join(dir, 'project.yaml')
  fs.writeFileSync(projectFile, `version: 1
settings: { failOnInvalidPattern: true }
rules:
  - id: credential-access
    enabled: false
`, 'utf8')
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { rulesFile: projectFile, rulesWatch: false })
      const svc = ctx.get(SERVICE.umbrella)
      const status = svc.ruleConfigStatus()
      const baselineLayer = status.layers.find((l) => l.name === 'baseline')
      const projectLayer = status.layers.find((l) => l.name === 'project')
      assert.ok(baselineLayer, 'baseline layer must be loaded by default')
      assert.equal(baselineLayer.applied, true)
      assert.equal(projectLayer.applied, false, 'project layer must be rejected (hard rule lock)')
      assert.ok(status.rules.includes('credential-access'), 'baseline hard rule still active')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previousRole === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previousRole
    if (previousEnv === undefined) delete process.env.UMBRELLA_RULES_PATH
    else process.env.UMBRELLA_RULES_PATH = previousEnv
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('插件：环境层 UMBRELLA_RULES_PATH 叠加在基线与项目之后', () => {
  const dir = tmpDir('fang-rules-env-')
  const previousRole = process.env.DSH_FANG_ROLE
  const previousEnv = process.env.UMBRELLA_RULES_PATH
  process.env.DSH_FANG_ROLE = 'mother'
  const envFile = path.join(dir, 'env.yaml')
  fs.writeFileSync(envFile, `version: 1
rules:
  - id: write-outside-buffer
    light: yellow
    reason: env layer
`, 'utf8')
  process.env.UMBRELLA_RULES_PATH = envFile
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { baselineFile: ':none:', rulesWatch: false })
      const svc = ctx.get(SERVICE.umbrella)
      const status = svc.ruleConfigStatus()
      const envLayer = status.layers.find((l) => l.name === 'env')
      assert.ok(envLayer)
      assert.equal(envLayer.applied, true)
      const decision = svc.decideAction({ tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/z') } }, { grade: 'A' })
      assert.equal(decision.reason, 'env layer')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previousRole === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previousRole
    if (previousEnv === undefined) delete process.env.UMBRELLA_RULES_PATH
    else process.env.UMBRELLA_RULES_PATH = previousEnv
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── inherit:false 严格模式（v2.8.2）─────────────────────────────────────────

function strictConfig(yamlBody) {
  const body = String(yamlBody ?? '').trim()
  const rulesSection = body === '' || body === '[]' ? 'rules: []' : `rules:\n${yamlBody}`
  const parsed = parseYamlSubset(`version: 1
inherit: false
settings: { failOnInvalidPattern: true }
${rulesSection}`)
  assert.deepEqual(parsed.errors, [])
  const validated = validateRuleConfig(parsed.value)
  assert.deepEqual(validated.errors, [])
  return validated.config
}

const FALLBACK_ID = 'unknown-tool'

test('严格模式：无规则定义 = 只剩硬规则 + 兜底（合法的极简安全模式）', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const applied = registry.applyLayer(strictConfig('  []'))
  assert.equal(applied.applied, true)
  assert.equal(applied.source, 'strict-replaced')
  assert.deepEqual(registry.ids().sort(), ['credential-access', 'destructive-command', 'dsh-lifecycle', FALLBACK_ID].sort())
  assert.ok(applied.strictMode)
  assert.deepEqual(applied.strictMode.preservedHardRules.sort(), ['credential-access', 'destructive-command', 'dsh-lifecycle'].sort())
  assert.deepEqual(applied.strictMode.preservedFallback, [FALLBACK_ID])
  assert.equal(applied.strictMode.discardedRuleCount, DEFAULT_ACTION_RULES.length - 4)
  // 可调规则消失：写越界不再命中 write-outside-buffer，落到兜底
  const write = baseLight({ tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/a') } }, policy, registry)
  assert.equal(write.matchedRule, FALLBACK_ID)
  assert.equal(write.light, 'yellow')
})

test('严格模式：只保留用户重新定义的可调规则', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const config = strictConfig(`  - id: write-outside-buffer
    light: red
    reason: strict write
  - id: read-in-buffer
    light: green
    priority: 80
`)
  const applied = registry.applyLayer(config)
  assert.equal(applied.applied, true)
  const ids = registry.ids()
  assert.ok(ids.includes('write-outside-buffer'))
  assert.ok(ids.includes('read-in-buffer'))
  assert.ok(!ids.includes('network-egress'), '未定义的可调规则必须消失')
  assert.ok(!ids.includes('dynamic-import'))
})

test('严格模式：硬规则不可关闭/不可降级（整层拒绝，保留旧规则）', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const before = registry.ids()
  const disable = strictConfig(`  - id: credential-access
    enabled: false
`)
  const rejected = registry.applyLayer(disable)
  assert.equal(rejected.applied, false)
  assert.ok(rejected.errors.some((e) => e.includes('cannot be disabled')))
  assert.deepEqual(registry.ids(), before, '拒绝后保留旧规则（层被弹出）')

  const downgrade = strictConfig(`  - id: destructive-command
    light: yellow
`)
  const rejected2 = registry.applyLayer(downgrade)
  assert.equal(rejected2.applied, false)
  assert.ok(rejected2.errors.some((e) => e.includes('cannot be lowered')))
})

test('严格模式之后的 inherit:true 层叠加，不回退内置全集', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  assert.equal(registry.applyLayer(strictConfig('  []')).applied, true)
  const stacked = parseYamlSubset(`version: 1
settings: { failOnInvalidPattern: true }
rules:
  - id: read-in-buffer
    light: green
    priority: 80
`)
  const validated = validateRuleConfig(stacked.value)
  assert.deepEqual(validated.errors, [])
  const applied = registry.applyLayer(validated.config)
  assert.equal(applied.applied, true)
  const ids = registry.ids()
  assert.ok(ids.includes('read-in-buffer'))
  assert.ok(!ids.includes('network-egress'), '后续 inherit:true 层不得恢复内置可调规则')
  assert.equal(registry.status().source, 'strict-replaced')
  assert.ok(registry.status().strictMode)
})

test('较晚的 inherit:false 覆盖较早层（丢弃其覆盖值）', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const first = validateRuleConfig(parseYamlSubset(`version: 1
rules:
  - id: write-outside-buffer
    light: red
    reason: first layer
`).value)
  assert.equal(registry.applyLayer(first.config).applied, true)
  assert.equal(registry.ids().includes('write-outside-buffer'), true)

  assert.equal(registry.applyLayer(strictConfig('  []')).applied, true)
  assert.equal(registry.ids().includes('write-outside-buffer'), false, '严格模式丢弃了第一层的可调规则')
  assert.equal(registry.layerCount(), 2)
  assert.equal(registry.status().strictMode.layerIndex, 1)
})

test('schema：inherit 缺省 true、显式 false、非布尔报错', () => {
  assert.equal(validateRuleConfig({ version: 1 }).config.inherit, true)
  assert.equal(validateRuleConfig({ version: 1, inherit: false }).config.inherit, false)
  assert.ok(validateRuleConfig({ version: 1, inherit: 'no' }).errors.some((e) => e.includes('inherit')))
})

test('插件：严格模式出现在 ruleConfigStatus 并落审计事件', () => {
  const dir = tmpDir('fang-rules-strict-')
  const previousRole = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  const file = path.join(dir, 'strict.yaml')
  fs.writeFileSync(file, `version: 1
inherit: false
settings: { failOnInvalidPattern: true }
rules:
  - id: write-outside-buffer
    light: red
`, 'utf8')
  const audit = []
  try {
    const ctx = makeCtx({ services: { [SERVICE.auditor]: { append: (kind, data) => audit.push({ kind, data }) } } })
    try {
      umbrellaPlugin.apply(ctx, { rulesFile: file, rulesWatch: false, baselineFile: ':none:' })
      const svc = ctx.get(SERVICE.umbrella)
      const status = svc.ruleConfigStatus()
      assert.equal(status.source, 'strict-replaced')
      assert.ok(status.strictMode)
      assert.equal(status.strictMode.preservedHardRules.length, 3)
      assert.ok(audit.some((record) => record.kind === 'umbrella-strict-mode'))
      const strictRecord = audit.find((record) => record.kind === 'umbrella-strict-mode')
      assert.equal(strictRecord.data.discardedRuleCount, DEFAULT_ACTION_RULES.length - 4)
      assert.ok(Array.isArray(strictRecord.data.preservedHardRules))
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previousRole === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previousRole
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 组 4 扩展：严格模式 + 语法/编译错误的回退语义（v2.8.3）─────────────────

/** 一份"能通过 schema、但编译期失败（非法正则）"的严格模式配置。 */
function brokenStrictConfig() {
  const parsed = parseYamlSubset(`version: 1
inherit: false
settings: { failOnInvalidPattern: true }
rules:
  - id: broken-declarative
    category: destructive
    light: red
    reason: bad regex
    match:
      kind: command-pattern
      patterns:
        - re: "(["
`)
  assert.deepEqual(parsed.errors, [])
  const validated = validateRuleConfig(parsed.value)
  assert.deepEqual(validated.errors, [])
  return validated.config
}

function goodLayerConfig(body) {
  const text = String(body ?? '').trim()
  const rulesSection = text === '' || text === '[]' ? 'rules: []' : `rules:\n${body}`
  const parsed = parseYamlSubset(`version: 1
settings: { failOnInvalidPattern: true }
${rulesSection}`)
  assert.deepEqual(parsed.errors, [])
  const validated = validateRuleConfig(parsed.value)
  assert.deepEqual(validated.errors, [])
  return validated.config
}

test('组4A：严格模式层编译失败 → 整层拒绝，回退到上一个成功层（default）', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const defaultLayer = goodLayerConfig(`  - id: write-outside-buffer
    light: red
    reason: default layer
`)
  assert.equal(registry.applyLayer(defaultLayer).applied, true)

  const failed = registry.applyLayer(brokenStrictConfig())
  assert.equal(failed.applied, false)
  assert.ok(failed.errors.length > 0)
  assert.equal(failed.revertedToLayerIndex, 0, '回退到第 0 层（default）')

  // 仍是 default 层的规则集：可调规则都在，write-outside-buffer 用 default 的覆盖
  const ids = registry.ids()
  assert.ok(ids.includes('dynamic-import'))
  assert.ok(ids.includes('network-egress'))
  assert.equal(registry.layerCount(), 1, '失败层不进入层栈')
  const write = baseLight({ tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/x') } }, policy, registry)
  assert.equal(write.light, 'red')
  assert.equal(write.reason, 'default layer')
})

test('组4B：第二个严格层失败 → 回退到第一个严格层（不是内置全集）', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const strictGood = strictConfig(`  - id: write-outside-buffer
    light: red
    reason: 第一个严格层
  - id: read-in-buffer
    light: green
    priority: 80
`)
  const first = registry.applyLayer(strictGood)
  assert.equal(first.applied, true)
  assert.equal(first.source, 'strict-replaced')
  assert.deepEqual(first.strictMode.preservedHardRules.sort(), ['credential-access', 'destructive-command', 'dsh-lifecycle'].sort())

  const second = registry.applyLayer(brokenStrictConfig())
  assert.equal(second.applied, false)
  assert.equal(second.revertedToLayerIndex, 0)

  // 仍是第一个严格层的结果：可调规则只剩显式定义的两条 + 硬规则 + 兜底
  const ids = registry.ids().sort()
  assert.deepEqual(ids, ['credential-access', 'destructive-command', 'dsh-lifecycle', 'read-in-buffer', 'unknown-tool', 'write-outside-buffer'].sort())
  assert.ok(!ids.includes('dynamic-import'))
  assert.equal(registry.status().source, 'strict-replaced')
  assert.ok(registry.status().strictMode, 'strictMode 仍是第一个严格层的信息')
  assert.equal(registry.status().strictMode.discardedRuleCount, DEFAULT_ACTION_RULES.length - 4)
  const write = baseLight({ tool: 'write', target: { kind: 'path', value: path.resolve('C:/fangs/other/x') } }, policy, registry)
  assert.equal(write.reason, '第一个严格层')
})

test('组4C：严格层失败后，后续 inherit:true 层叠加到上一个成功层（失败层不可见）', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const defaultLayer = goodLayerConfig(`  - id: write-outside-buffer
    light: red
    reason: default layer
`)
  assert.equal(registry.applyLayer(defaultLayer).applied, true)
  assert.equal(registry.applyLayer(brokenStrictConfig()).applied, false)
  assert.equal(registry.layerCount(), 1)

  const envLayer = goodLayerConfig(`  - id: network-egress
    light: blue
    reason: env layer
`)
  const applied = registry.applyLayer(envLayer)
  assert.equal(applied.applied, true)
  assert.equal(registry.layerCount(), 2)
  assert.equal(applied.revertedToLayerIndex, undefined)

  // 叠加在 default 上：可调规则都在（严格模式没生效），env 覆盖生效
  const ids = registry.ids()
  assert.ok(ids.includes('dynamic-import'))
  assert.ok(ids.includes('read-in-buffer'))
  const egress = baseLight({ tool: 'web_fetch', target: { kind: 'url', value: 'https://evil.test/x' } }, policy, registry)
  assert.equal(egress.light, 'blue')
  assert.equal(egress.reason, 'env layer')
  assert.equal(registry.status().strictMode, null)
})

test('组4D：失败层状态隔离（layers/effective/strictMode 均不被污染）', () => {
  const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
  const beforeIds = registry.ids()
  const beforeStatus = registry.status()

  // 首个层就失败：回退到内置全集（revertedToLayerIndex = -1）
  const failed = registry.applyLayer(brokenStrictConfig())
  assert.equal(failed.applied, false)
  assert.equal(failed.revertedToLayerIndex, -1)
  assert.equal(registry.layerCount(), 0)
  assert.deepEqual(registry.ids(), beforeIds)
  assert.equal(registry.status().source, 'builtin')
  assert.equal(registry.status().strictMode, null)
  assert.equal(beforeStatus.source, 'builtin')

  // 后续成功层不受影响
  assert.equal(registry.applyLayer(goodLayerConfig('  []')).applied, true)
  assert.equal(registry.layerCount(), 1)
  assert.equal(registry.status().source, 'layered')
})

test('组4E：插件层——项目严格层编译失败被拒绝，状态报告层与回退', () => {
  const dir = tmpDir('fang-rules-strict-fail-')
  const previousRole = process.env.DSH_FANG_ROLE
  process.env.DSH_FANG_ROLE = 'mother'
  const projectFile = path.join(dir, 'project.yaml')
  fs.writeFileSync(projectFile, `version: 1
inherit: false
settings: { failOnInvalidPattern: true }
rules:
  - id: broken-declarative
    category: destructive
    light: red
    reason: bad regex
    match:
      kind: command-pattern
      patterns:
        - re: "(["
`, 'utf8')
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { rulesFile: projectFile, rulesWatch: false, baselineFile: ':none:' })
      const svc = ctx.get(SERVICE.umbrella)
      const status = svc.ruleConfigStatus()
      const projectLayer = status.layers.find((layer) => layer.name === 'project')
      assert.ok(projectLayer)
      assert.equal(projectLayer.applied, false)
      assert.ok(projectLayer.errors.length > 0)
      assert.equal(status.strictMode, null, '失败层不得让严格模式生效')
      assert.equal(status.rules.length, DEFAULT_ACTION_RULES.length, '回退到内置全集')
    } finally {
      ctx.dispose()
    }
  } finally {
    if (previousRole === undefined) delete process.env.DSH_FANG_ROLE
    else process.env.DSH_FANG_ROLE = previousRole
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
