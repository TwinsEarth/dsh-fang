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
  const { registry } = registryWith(`${CONFIG_HEADER}rules:
  - id: credential-access
    enabled: false
  - id: write-outside-buffer
    light: red
    reason: CI 环境全部越界写需审批
    tags: ["ci-strict"]
`)
  assert.equal(registry.ids().includes('credential-access'), false)
  const ss = baseLight({ tool: 'read', target: { kind: 'path', value: path.resolve('C:/home/u/.ssh/id_rsa') } }, policy, registry)
  assert.notEqual(ss.matchedRule, 'credential-access')
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
  - id: credential-access
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
    writeRules(file, `${CONFIG_HEADER}rules:\n  - id: credential-access\n    enabled: false\n`)
    const registry = createRuleRegistry(DEFAULT_ACTION_RULES)
    const results = []
    const watcher = watchRuleConfigFile(file, registry, (r) => results.push(r), { debounceMs: 10 })
    try {
      watcher.reload()
      assert.equal(results.at(-1).applied, true)
      assert.equal(registry.ids().includes('credential-access'), false)

      // 坏 YAML：保留旧规则
      writeRules(file, 'version: 1\nrules: [\n')
      watcher.reload()
      assert.equal(results.at(-1).applied, false)
      assert.equal(registry.ids().includes('credential-access'), false, '失败必须保留上一次有效规则')

      // 再次有效：恢复
      writeRules(file, `${CONFIG_HEADER}rules:\n  - id: destructive-command\n    enabled: false\n`)
      watcher.reload()
      assert.equal(results.at(-1).applied, true)
      assert.equal(registry.ids().includes('destructive-command'), false)
      assert.equal(registry.ids().includes('credential-access'), true, '重新应用整份配置（不是增量）')
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
  writeRules(file, `${CONFIG_HEADER}rules:\n  - id: credential-access\n    enabled: false\n`)
  try {
    const ctx = makeCtx()
    try {
      umbrellaPlugin.apply(ctx, { rulesFile: file, rulesWatch: false })
      const svc = ctx.get(SERVICE.umbrella)
      assert.ok(svc)
      const status = svc.ruleConfigStatus()
      assert.equal(status.source, 'yaml')
      assert.equal(status.applied, true)
      assert.equal(status.rules.includes('credential-access'), false)

      // 规则真的生效：凭据路径不再命中 credential-access
      const decision = svc.decideAction({ tool: 'read', target: { kind: 'path', value: path.resolve('C:/home/u/.ssh/id_rsa') } }, { grade: 'A' })
      assert.notEqual(decision.matchedRule, 'credential-access')

      // 改文件 → reloadRules
      writeRules(file, `${CONFIG_HEADER}rules:\n  - id: destructive-command\n    enabled: false\n`)
      const reloaded = svc.reloadRules()
      assert.equal(reloaded.applied, true)
      assert.equal(svc.ruleConfigStatus().rules.includes('destructive-command'), false)
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
      umbrellaPlugin.apply(ctx, { rulesFile: file, rulesWatch: false })
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
