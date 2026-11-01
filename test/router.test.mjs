// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// T6 — fangRouter v2 测试（契约 docs/CONTRACTS-V2.md 5.3 / §1 / §7）。
//
// 覆盖：
//   * 角色门禁：router 在 mother 与 fork 都激活，decide/confirm 的 basis.{role,environment} 如实标注；
//     env(DSH_FANG_ROLE) 优先于 config.role，缺省 mother。
//   * decide（母体初判）：四路由（sandbox×2 / container×2 / deny×3）、veto 终局、来源可信度、
//     申报制、能力需求（assessment.signals 或现场 code quickScan）、basis 注解、fail-closed 降级。
//   * confirm（分身复核）：rank sandbox<container<deny 只升不降；container 不得降回 sandbox；
//     母体 deny 原样返回（不可推翻）；分身评分更糟 → container、E → deny；缺 decision → fail-closed。
//   * containerAvailable()：{ok,state,reason} 三态（disabled/unavailable/ready），v1 操作者断言兼容。
//   * runInContainer()：enabled=false → disabled；模块缺失/形状非法/宿主不可用/exec 抛错 → 降级返回，绝不抛。
// 纯逻辑测试：容器模块用假 loader 注入，不触发真实 AppContainer（契约 §7）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeCtx } from './helpers.mjs'
import { SERVICE, AUDIT, ROUTE, CONTAINER, ROLE, rolesOf } from '../src/kernel/index.mjs'
import * as router from '../src/plugins/router.mjs'

const CLEAN_ASSESSMENT = { grade: 'A', S: 0, veto: false, reasons: [] }
const GRADE_C_ASSESSMENT = { grade: 'C', S: 50, veto: false, reasons: [], signals: [{ id: 'S2-network', weight: 20 }] }
const GRADE_D_ASSESSMENT = { grade: 'D', S: 74, veto: false, reasons: [], signals: [] }
const VETO_ASSESSMENT = { grade: 'E', S: 100, veto: true, reasons: ['hotReload-false'] }
const CONTAINER_OK = { ok: true, reason: 'probe-ok', state: CONTAINER.READY }
const CONTAINER_NO = { ok: false, reason: 'caller-denied', state: CONTAINER.UNAVAILABLE }

/** 在指定角色下执行 fn（只影响 apply 时的 resolveRole；service 会把角色固化在 basis 里）。 */
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
  withRole(role, () => router.apply(ctx, router.Config(config)))
  return { ctx, service: ctx.get(SERVICE.router) }
}

/** 假容器模块：只实现 T8 契约里 router 用到的 createContainerHost/available/exec/dispose。 */
function fakeContainerModule({ state = CONTAINER.READY, execImpl = null } = {}) {
  const hosts = []
  const mod = {
    hosts,
    createContainerHost(opts) {
      const host = {
        opts,
        state,
        disposed: false,
        available() { return { ok: state === CONTAINER.READY, state, reason: state === CONTAINER.READY ? 'fake-ready' : `fake-${state}` } },
        async exec(req) {
          if (typeof execImpl === 'function') return execImpl(req, host)
          return { ok: true, stdout: `ran:${req.code}`, stderr: 'fake-warn', exitCode: 0, writes: [{ path: 'out.txt', bytes: 3 }] }
        },
        dispose() { host.disposed = true },
      }
      hosts.push(host)
      return host
    },
  }
  return mod
}

async function withContainerModule(loaderOrModule, fn) {
  const loader = typeof loaderOrModule === 'function' ? loaderOrModule : async () => loaderOrModule
  router._internals.setContainerModuleLoader(loader)
  try { return await fn(loaderOrModule) } finally { router._internals.resetContainerModuleLoader() }
}

function missingModuleLoader() {
  return async () => {
    const err = new Error("Cannot find module '../lib/container/index.mjs'")
    err.code = 'ERR_MODULE_NOT_FOUND'
    throw err
  }
}

// ───────────────────────────── 角色门禁 ─────────────────────────────

test('role gate: router activates in mother AND fork; basis names the environment', () => {
  assert.deepEqual(rolesOf('router'), [ROLE.MOTHER, ROLE.FORK], 'deployment matrix: router is a both-roles organ')

  const mother = fresh()
  const fork = fresh({}, ROLE.FORK)
  assert.ok(mother.service, 'router must register fangRouter in mother')
  assert.ok(fork.service, 'router must register fangRouter in fork')
  assert.equal(mother.service.role, ROLE.MOTHER)
  assert.equal(fork.service.role, ROLE.FORK)

  const fromMother = mother.service.decide({ assessment: CLEAN_ASSESSMENT, source: 'trusted' })
  const fromFork = fork.service.decide({ assessment: CLEAN_ASSESSMENT, source: 'trusted' })
  assert.equal(fromMother.route, ROUTE.SANDBOX)
  assert.equal(fromFork.route, ROUTE.SANDBOX)
  assert.equal(fromMother.basis.role, ROLE.MOTHER)
  assert.equal(fromMother.basis.environment, ROLE.MOTHER)
  assert.equal(fromFork.basis.role, ROLE.FORK)
  assert.equal(fromFork.basis.environment, ROLE.FORK)
  assert.notDeepEqual(fromMother.basis, fromFork.basis, 'same decision, different basis environment')

  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('role gate: env DSH_FANG_ROLE wins over config.role, config.role is the fallback, default is mother', () => {
  const byConfig = fresh({ role: ROLE.FORK }) // env cleared inside withRole(undefined)
  assert.equal(byConfig.service.role, ROLE.FORK, 'config.role is the second role source')

  const envWins = fresh({ role: ROLE.FORK }, ROLE.MOTHER)
  assert.equal(envWins.service.role, ROLE.MOTHER, 'environment wins: a fork cannot promote itself by config')

  const byDefault = fresh()
  assert.equal(byDefault.service.role, ROLE.MOTHER)

  byConfig.ctx.dispose()
  envWins.ctx.dispose()
  byDefault.ctx.dispose()
})

// ───────────────────────────── decide（母体初判）─────────────────────────────

test('decide: RouteDecision shape carries basis{role,environment,grade,source}', () => {
  const { service, ctx } = fresh()
  const out = service.decide({ plugin: { name: '@local/plug' }, assessment: CLEAN_ASSESSMENT, source: 'mother' })
  assert.equal(out.route, ROUTE.SANDBOX)
  assert.equal(out.reason, 'trusted-clean')
  assert.equal(out.needsApproval, false)
  assert.equal(out.grade, 'A')
  assert.equal(out.veto, false)
  assert.equal(out.basis.role, ROLE.MOTHER)
  assert.equal(out.basis.environment, ROLE.MOTHER)
  assert.equal(out.basis.grade, 'A')
  assert.equal(out.basis.source.name, '@local/plug', 'plugin is the identity, source string is the trust authority')
  assert.equal(out.basis.source.trusted, true)
  assert.equal(out.basis.source.via, 'trust-token')
  assert.equal(out.source.name, '@local/plug')
  ctx.dispose()
})

test('decide: route sandbox — trusted + declared writes; trusted clean', () => {
  const { service, ctx } = fresh()
  const declared = service.decide({
    assessment: CLEAN_ASSESSMENT,
    source: { trusted: true, declaredWrites: [{ path: 'index.js', reason: 'initial import' }] },
    containerAvailable: CONTAINER_NO,
  })
  assert.equal(declared.route, ROUTE.SANDBOX)
  assert.equal(declared.reason, 'trusted-declared-writes')
  assert.equal(declared.needsApproval, false)
  assert.equal(declared.source.declaredWrites, true)

  assert.equal(service.decide({ assessment: CLEAN_ASSESSMENT, source: 'trusted' }).reason, 'trusted-clean')
  assert.equal(service.decide({ assessment: CLEAN_ASSESSMENT, source: { trusted: true } }).route, ROUTE.SANDBOX)
  ctx.dispose()
})

test('decide: route container — untrusted source (even when grade is A) and trusted bare writes', () => {
  const { service, ctx } = fresh()
  const untrusted = service.decide({ assessment: CLEAN_ASSESSMENT, source: 'untrusted', containerAvailable: CONTAINER_OK })
  assert.equal(untrusted.route, ROUTE.CONTAINER)
  assert.equal(untrusted.reason, 'untrusted-source')
  assert.equal(untrusted.needsApproval, true)
  assert.equal(untrusted.grade, 'A', 'grade stays advisory: A-level untrusted still goes to the container')
  assert.equal(untrusted.container.ok, true)

  const dirty = service.decide({
    assessment: CLEAN_ASSESSMENT,
    source: { name: '@local/dirty', trusted: true, bareWrites: [{ path: 'extra.js' }] },
    containerAvailable: CONTAINER_OK,
  })
  assert.equal(dirty.route, ROUTE.CONTAINER)
  assert.equal(dirty.reason, 'trusted-bare-writes')
  assert.equal(dirty.source.bareWrites, true)

  // 缺省不可信 → fail-closed（缺省配置容器 disabled → deny）
  const missingSource = service.decide({ assessment: CLEAN_ASSESSMENT })
  assert.equal(missingSource.route, ROUTE.DENY)
  assert.equal(missingSource.source.trusted, false)
  assert.equal(missingSource.reason, 'container-unavailable:container-disabled')
  ctx.dispose()
})

test('decide: route deny — veto is terminal; untrusted + child-process; container unavailable', () => {
  const { service, ctx } = fresh({ containerAvailable: true })
  const vetoed = service.decide({
    assessment: VETO_ASSESSMENT,
    source: { trusted: true, declaredWrites: [{ path: 'index.js', reason: 'ok' }] },
    containerAvailable: CONTAINER_OK,
  })
  assert.equal(vetoed.route, ROUTE.DENY)
  assert.equal(vetoed.reason, 'veto:hotReload-false')
  assert.equal(vetoed.needsApproval, false)
  assert.equal(vetoed.veto, true)

  const child = service.decide({
    assessment: CLEAN_ASSESSMENT,
    source: { trusted: false },
    needsChildProcess: true,
    containerAvailable: CONTAINER_OK,
  })
  assert.equal(child.route, ROUTE.DENY)
  assert.equal(child.reason, 'untrusted-needs-child-process')
  assert.equal(child.container.ok, true, 'deny happens before container availability is consulted')

  const noContainer = service.decide({ assessment: CLEAN_ASSESSMENT, source: 'untrusted', containerAvailable: CONTAINER_NO })
  assert.equal(noContainer.route, ROUTE.DENY)
  assert.equal(noContainer.reason, 'container-unavailable:caller-denied')
  ctx.dispose()
})

test('decide: quickScan derives capabilities from assessment signals and from a raw code string', () => {
  const { service, ctx } = fresh()
  const fromSignals = service.decide({
    assessment: { grade: 'B', S: 28, veto: false, reasons: [], signals: [{ id: 'S1-child_process', weight: 30 }] },
    source: 'untrusted',
    containerAvailable: CONTAINER_OK,
  })
  assert.equal(fromSignals.route, ROUTE.DENY)
  assert.equal(fromSignals.reason, 'untrusted-needs-child-process')
  assert.deepEqual(fromSignals.quickScan.capabilities, ['child-process'])
  assert.equal(fromSignals.quickScan.needsChildProcess, true)

  const fromCode = service.decide({
    plugin: { name: '@local/u' },
    source: 'untrusted',
    code: "import { spawn } from 'node:child_process'\nexport const go = () => spawn('cmd')\n",
    containerAvailable: CONTAINER_OK,
  })
  assert.equal(fromCode.route, ROUTE.DENY)
  assert.equal(fromCode.reason, 'untrusted-needs-child-process')
  assert.equal(fromCode.quickScan.coverage, 'import-only')

  // 可信来源即使有子进程能力也可留在 sandbox（v1 语义：trust 强于评分）
  const trustedChild = service.decide({
    assessment: { grade: 'B', S: 28, veto: false, reasons: [], signals: [{ id: 'S1-child_process', weight: 30 }] },
    source: 'trusted',
  })
  assert.equal(trustedChild.route, ROUTE.SANDBOX)
  ctx.dispose()
})

test('decide: declaration honesty — writes with blank reasons are not declarations', () => {
  const { service, ctx } = fresh()
  const out = service.decide({
    source: { trusted: true, declaredWrites: [{ path: 'index.js', reason: '   ' }] },
    containerAvailable: CONTAINER_OK,
  })
  assert.equal(out.route, ROUTE.CONTAINER)
  assert.equal(out.reason, 'trusted-bare-writes')
  assert.equal(out.source.declaredWrites, false)
  assert.equal(out.source.bareWrites, true)
  ctx.dispose()
})

test('decide: config trustedPlugins + asserted container availability (v1 compatibility)', () => {
  const { service, ctx } = fresh({ containerAvailable: true, trustedPlugins: ['@local/trusted-x'] })
  assert.deepEqual(service.containerAvailable(), { ok: true, state: CONTAINER.READY, reason: 'configured' })
  assert.equal(service.policy.containerAvailable, true)
  assert.deepEqual(service.policy.trustedPlugins, ['@local/trusted-x'])

  const trusted = service.decide({ assessment: CLEAN_ASSESSMENT, source: { name: '@local/trusted-x' } })
  assert.equal(trusted.route, ROUTE.SANDBOX)
  assert.equal(trusted.source.via, 'trustedPlugins')

  const stranger = service.decide({ assessment: CLEAN_ASSESSMENT, source: { name: '@local/stranger' } })
  assert.equal(stranger.route, ROUTE.CONTAINER, 'configured container is reachable through the probe')
  ctx.dispose()
})

test('pure helpers: normalizeSource / mergeSourceInput / resolveContainer / decidePure with basis', () => {
  assert.equal(router.normalizeSource('first-party').trusted, true)
  assert.equal(router.normalizeSource('third-party').trusted, false)
  assert.equal(router.normalizeSource(null).trusted, false)
  assert.equal(router.normalizeSource({ trust: 'local' }).trusted, true)
  assert.equal(router.normalizeSource({ name: 'p', declaredWrites: [{ path: 'a', reason: 'r' }] }).declaredWrites, true)

  const merged = router.mergeSourceInput({ name: '@local/p' }, 'mother', [])
  assert.equal(merged.name, '@local/p')
  assert.equal(merged.trusted, true)
  assert.equal(merged.via, 'trust-token')

  assert.deepEqual(router.resolveContainer({ containerAvailable: true }, () => CONTAINER_NO), { ok: true, reason: 'caller-asserted' })
  assert.deepEqual(router.resolveContainer({}, () => ({ ok: false, reason: 'probe' })), { ok: false, reason: 'probe' })

  const out = router.decidePure(
    { assessment: CLEAN_ASSESSMENT, source: { trusted: true, declaredWrites: true }, containerAvailable: CONTAINER_OK },
    { config: { trustedPlugins: [] }, probe: () => CONTAINER_NO, role: ROLE.FORK, environment: ROLE.FORK },
  )
  assert.equal(out.route, ROUTE.SANDBOX)
  assert.equal(out.basis.role, ROLE.FORK)
  assert.equal(out.basis.environment, ROLE.FORK)
  assert.equal(out.basis.grade, 'A')
  assert.equal(router.decidePure({ source: 'untrusted', containerAvailable: true }, { config: {}, probe: () => CONTAINER_NO }).route, ROUTE.CONTAINER)
})

// ───────────────────────────── confirm（分身复核）─────────────────────────────

test('confirm: sandbox + worse fork assessment escalates to container (never downgrades)', () => {
  const mother = fresh()
  const fork = fresh({ containerAvailable: true }, ROLE.FORK)
  const decision = mother.service.decide({
    plugin: { name: '@local/plug' },
    assessment: CLEAN_ASSESSMENT,
    source: 'mother',
  })
  assert.equal(decision.route, ROUTE.SANDBOX)
  assert.equal(decision.basis.grade, 'A')

  const confirmed = fork.service.confirm({ decision, assessment: GRADE_C_ASSESSMENT })
  assert.equal(confirmed.route, ROUTE.CONTAINER, 'fork sees C where mother saw A → escalate one step to container')
  assert.equal(confirmed.escalated, true)
  assert.equal(confirmed.needsApproval, true)
  assert.match(confirmed.reason, /^escalated:sandbox->container:/)
  assert.match(confirmed.reason, /fork-grade-worse:A->C/)
  assert.equal(confirmed.basis.role, ROLE.FORK)
  assert.equal(confirmed.basis.environment, ROLE.FORK)
  assert.equal(confirmed.basis.escalated, true)
  assert.equal(confirmed.basis.grade, 'C')

  // 同一实例、同一 decision，D 级也至少 container
  const gradeD = fork.service.confirm({ decision, assessment: GRADE_D_ASSESSMENT })
  assert.equal(gradeD.route, ROUTE.CONTAINER)
  assert.equal(gradeD.escalated, true)

  // 分身评分不比母体差 → 不改路由
  const same = fork.service.confirm({ decision, assessment: { grade: 'A', S: 0, veto: false, reasons: [] } })
  assert.equal(same.route, ROUTE.SANDBOX)
  assert.equal(same.escalated, false)
  assert.equal(same.reason, decision.reason)
  assert.equal(same.needsApproval, false)

  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('confirm: mother deny is returned as-is and cannot be overturned', () => {
  const mother = fresh()
  const fork = fresh({ containerAvailable: true }, ROLE.FORK)
  const decision = mother.service.decide({ assessment: VETO_ASSESSMENT, source: 'trusted' })
  assert.equal(decision.route, ROUTE.DENY)

  for (const assessment of [CLEAN_ASSESSMENT, GRADE_C_ASSESSMENT]) {
    const confirmed = fork.service.confirm({ decision, assessment })
    assert.equal(confirmed.route, ROUTE.DENY, 'deny is terminal: fork review cannot overturn it')
    assert.equal(confirmed.reason, decision.reason)
    assert.equal(confirmed.needsApproval, false)
    assert.equal(confirmed.veto, true)
    assert.equal(confirmed.escalated, false)
    assert.equal(confirmed.basis.escalated, false)
    assert.equal(confirmed.basis.environment, ROLE.FORK)
  }
  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('confirm: container is not downgraded to sandbox even when the fork re-scores clean', () => {
  const fork = fresh({ containerAvailable: true }, ROLE.FORK)
  const decision = fork.service.decide({ assessment: CLEAN_ASSESSMENT, source: 'untrusted' })
  assert.equal(decision.route, ROUTE.CONTAINER)

  const confirmed = fork.service.confirm({ decision, assessment: CLEAN_ASSESSMENT })
  assert.equal(confirmed.route, ROUTE.CONTAINER, 'confirm can only raise the route rank')
  assert.equal(confirmed.escalated, false)
  assert.equal(confirmed.reason, decision.reason)
  assert.equal(confirmed.needsApproval, true)
  assert.equal(confirmed.basis.escalated, false)
  fork.ctx.dispose()
})

test('confirm: fork veto / fork grade E can raise a sandbox route to deny', () => {
  const mother = fresh()
  const fork = fresh({ containerAvailable: true }, ROLE.FORK)
  const decision = mother.service.decide({ plugin: { name: '@local/plug' }, assessment: CLEAN_ASSESSMENT, source: 'mother' })
  assert.equal(decision.route, ROUTE.SANDBOX)

  const vetoed = fork.service.confirm({ decision, assessment: VETO_ASSESSMENT })
  assert.equal(vetoed.route, ROUTE.DENY)
  assert.equal(vetoed.escalated, true)
  assert.equal(vetoed.needsApproval, false)
  assert.match(vetoed.reason, /^escalated:sandbox->deny:/)

  const gradeE = fork.service.confirm({ decision, assessment: { grade: 'E', S: 90, veto: false, reasons: [], signals: [] } })
  assert.equal(gradeE.route, ROUTE.DENY)
  assert.equal(gradeE.escalated, true)
  assert.match(gradeE.reason, /fork-grade-E/)

  mother.ctx.dispose()
  fork.ctx.dispose()
})

test('confirm: missing / invalid decision fails closed to deny with escalated:false', () => {
  const { service, ctx } = fresh({}, ROLE.FORK)
  for (const input of [{}, { decision: null }, { decision: { route: 'teleport' } }]) {
    const out = service.confirm(input)
    assert.equal(out.route, ROUTE.DENY)
    assert.equal(out.escalated, false)
    assert.equal(out.needsApproval, false)
    assert.match(out.reason, /^confirm:/)
    assert.equal(out.basis.role, ROLE.FORK)
    assert.equal(out.basis.environment, ROLE.FORK)
  }
  ctx.dispose()
})

// ───────────────────────────── containerAvailable / runInContainer ─────────────────────────────

test('containerAvailable: disabled by default, ready when operator asserts it (v1 compatibility)', async () => {
  const byDefault = fresh()
  assert.deepEqual(byDefault.service.containerAvailable(), {
    ok: false, state: CONTAINER.DISABLED, reason: 'container-disabled',
  })
  assert.equal(byDefault.service.policy.containerAvailable, false)
  assert.equal(byDefault.service.policy.container.enabled, false)
  assert.equal(byDefault.service.policy.container.powershellPath, 'powershell.exe')
  assert.equal(byDefault.service.policy.container.timeoutMs, 30000)

  // enabled=true 但容器模块尚未落地（T8）：state 只能是 unavailable，绝不假装 ready（用假 loader 注入，不碰真实模块）
  await withContainerModule(missingModuleLoader(), async () => {
    const enabledNoModule = fresh({ container: { enabled: true } })
    assert.equal(enabledNoModule.service.containerAvailable().ok, false)
    assert.equal(enabledNoModule.service.containerAvailable().state, CONTAINER.UNAVAILABLE)
    enabledNoModule.ctx.dispose()
  })
  byDefault.ctx.dispose()
})

test('runInContainer: enabled=false degrades to {ok:false,state:"disabled"} without throwing', async () => {
  const { service, ctx } = fresh()
  const out = await service.runInContainer({ code: 'console.log(1)' })
  assert.equal(out.ok, false)
  assert.equal(out.state, CONTAINER.DISABLED)
  assert.equal(out.reason, 'container-disabled')
  assert.equal(out.stdout, '')
  assert.equal(out.stderr, '')
  assert.equal(out.exitCode, null)
  assert.deepEqual(out.writes, [])
  ctx.dispose()
})

test('runInContainer: missing container module degrades to unavailable and never throws', async () => {
  await withContainerModule(missingModuleLoader(), async () => {
    const { service, ctx } = fresh({ container: { enabled: true } })
    const out = await service.runInContainer({ code: 'return 1' })
    assert.equal(out.ok, false)
    assert.equal(out.state, CONTAINER.UNAVAILABLE)
    assert.equal(out.reason, 'container-module-missing')
    assert.deepEqual(out.writes, [])

    assert.equal(service.containerAvailable().ok, false)
    assert.equal(service.containerAvailable().state, CONTAINER.UNAVAILABLE)
    assert.equal(service.containerAvailable().reason, 'container-module-missing')

    // 容器不可用 → 不可信来源 fail-closed 到 deny，原因透传
    const routed = service.decide({ assessment: CLEAN_ASSESSMENT, source: 'untrusted' })
    assert.equal(routed.route, ROUTE.DENY)
    assert.equal(routed.reason, 'container-unavailable:container-module-missing')
    ctx.dispose()
  })
})

test('runInContainer: invalid module shape and unavailable host degrade without throwing', async () => {
  await withContainerModule({}, async () => {
    const { service, ctx } = fresh({ container: { enabled: true } })
    const out = await service.runInContainer({ code: 'return 1' })
    assert.equal(out.ok, false)
    assert.equal(out.state, CONTAINER.UNAVAILABLE)
    assert.equal(out.reason, 'container-module-invalid')
    ctx.dispose()
  })

  await withContainerModule(fakeContainerModule({ state: CONTAINER.UNAVAILABLE }), async () => {
    const { service, ctx } = fresh({ container: { enabled: true } })
    const probe = await service.probeContainer()
    assert.equal(probe.ok, false)
    assert.equal(probe.state, CONTAINER.UNAVAILABLE)
    const out = await service.runInContainer({ code: 'return 1' })
    assert.equal(out.ok, false)
    assert.equal(out.state, CONTAINER.UNAVAILABLE)
    assert.match(out.reason, /^fake-unavailable$/)
    ctx.dispose()
  })
})

test('runInContainer: ready host executes inside the container and reports writes', async () => {
  await withContainerModule(fakeContainerModule(), async (mod) => {
    const { service, ctx } = fresh({ container: { enabled: true } })
    const probe = await service.probeContainer()
    assert.deepEqual(probe, { ok: true, state: CONTAINER.READY, reason: 'fake-ready' })
    assert.deepEqual(service.containerAvailable(), { ok: true, state: CONTAINER.READY, reason: 'fake-ready' })

    const out = await service.runInContainer({ code: 'return 42', declaredWrites: [{ path: 'a.txt' }], env: { K: 'V' } })
    assert.equal(out.ok, true)
    assert.equal(out.state, CONTAINER.READY)
    assert.equal(out.stdout, 'ran:return 42')
    assert.equal(out.stderr, 'fake-warn')
    assert.equal(out.exitCode, 0)
    assert.deepEqual(out.writes, [{ path: 'out.txt', bytes: 3 }])

    const host = mod.hosts[0]
    assert.deepEqual(host.opts, { powershellPath: 'powershell.exe', timeoutMs: 30000 })
    ctx.dispose()
    assert.equal(host.disposed, true, 'container host is disposed with the plugin fiber')
  })
})

test('runInContainer: exec failure/exception is reported, code is required, nothing throws', async () => {
  await withContainerModule(fakeContainerModule({ execImpl: async () => { throw new Error('boom') } }), async () => {
    const { service, ctx } = fresh({ container: { enabled: true } })
    const out = await service.runInContainer({ code: 'return 1' })
    assert.equal(out.ok, false)
    assert.match(out.reason, /^container-exec-error:boom$/)
    assert.equal(out.exitCode, null)
    assert.deepEqual(out.writes, [])

    const noCode = await service.runInContainer({})
    assert.equal(noCode.ok, false)
    assert.equal(noCode.reason, 'code-required')
    ctx.dispose()
  })
})

// ───────────────────────────── 审计 / 注册生命周期 ─────────────────────────────

test('audit ROUTE is emitted for decide+confirm, and tolerated when fangAudit is absent', () => {
  const calls = []
  const ctx = makeCtx({ services: { [SERVICE.auditor]: { append(kind, data) { calls.push({ kind, data }); return { kind, data } } } } })
  router.apply(ctx, router.Config({}))
  const service = ctx.get(SERVICE.router)
  const decision = service.decide({ assessment: CLEAN_ASSESSMENT, source: 'trusted' })
  service.confirm({ decision, assessment: CLEAN_ASSESSMENT })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.kind, AUDIT.ROUTE)
    assert.equal(call.data.component, 'fang-router')
  }
  assert.equal(calls[0].data.phase, 'decide')
  assert.equal(calls[0].data.route, ROUTE.SANDBOX)
  assert.equal(calls[0].data.environment, ROLE.MOTHER)
  assert.equal(calls[1].data.phase, 'confirm')
  assert.equal(calls[1].data.escalated, false)

  const bare = makeCtx()
  router.apply(bare, router.Config({}))
  assert.doesNotThrow(() => bare.get(SERVICE.router).decide({ source: 'untrusted' }))
  assert.doesNotThrow(() => bare.get(SERVICE.router).confirm({}))
  bare.dispose()
  ctx.dispose()
})

test('apply registers once, is disposed cleanly, and a duplicate registration throws', () => {
  const { ctx, service } = fresh()
  assert.equal(router.name, 'fang-router')
  assert.ok(Array.isArray(router.inject) && router.inject.length === 0)
  assert.equal(typeof service.decide, 'function')
  assert.equal(typeof service.confirm, 'function')
  assert.equal(typeof service.containerAvailable, 'function')
  assert.equal(typeof service.runInContainer, 'function')
  assert.equal(typeof service.probeContainer, 'function')
  assert.ok(service)
  assert.throws(() => router.apply(ctx, router.Config({})), /registered/)
  ctx.dispose()
  assert.equal(ctx.get(SERVICE.router), undefined)
})
