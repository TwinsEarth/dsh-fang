// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// fang-orchestrator — dsh-Fang 母体的「大脑」（v2.0.0）。
//
// 三层拓扑里的第一层：只做任务语义（create / status / promote / archive），
// 进程机制全部交给 Forker，跨进程控制全部交给分身的 Adapter + src/lib/remote.mjs。
// 边界：母体不可变；分身零共享；分身崩溃/回收不经过 restart-guard。
//
// 所有子插件服务通过 ctx.get(SERVICE.x) 可选获取，缺失时显式降级，
// 绝不假装成功。orchestrator 自身只在 mother 角色激活（roleGate）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  z, roleGate, resolveFangLayout, resolveProfileDir, resolveSessionsLayout,
  SERVICE, AUDIT, TASK_STATUS, FORK_STATUS, FANG_VERSION, ADAPTER_OP,
  exists, ensureDir, ensureModuleMirror, readJson, writeJsonAtomic, writeFileAtomic, sha256, removeTree, copyTree, digestTree,
  newId, iso, nowMs, bus, sleep, parseWebUrl, probeWebUrl,
  invokeCommercial, commercialConfigSchemaDefaults,
} from '../kernel/index.mjs'
import { parseWorkspaceIndex, scanSessionDirs, readBoundedEvents, extractSessionTitle, encodeWorkspaceKey } from '../lib/session-format.mjs'
import { ensureEssenceRuntimePnpmConfig, readNodeLinker } from '../lib/pnpm-store.mjs'
import { captureRuntimeProfileIntoEssence } from '../lib/runtime-capture.mjs'
import { cleanupApprovalDrill, runApprovalDrill } from '../lib/approval-drill.mjs'
import { negotiateProtocol } from '../lib/adapter-protocol.mjs'
import { describeMotherLink, probeLink, readSharedProfileSummary } from '../lib/mother-link.mjs'
import { MirrorManager } from '../lib/mirror.mjs'
import { buildMirrorStatusResponse } from '../lib/mirror-etag.mjs'
import { PreferencesStore } from '../lib/preferences.mjs'
import { EssenceManager, OFFICIAL_ESSENCE_ID, VIP_QUOTAS } from '../lib/essence.mjs'
import { applyForkConfigLock, setProfileConfigReadonly } from '../lib/fork-config-lock.mjs'
import { ensureForkEmptySession, enforceForkSessionCap, summarizeForkSessions, FORK_SESSION_MAX, FORK_SESSION_MIN } from '../lib/fork-sessions.mjs'
import { DEFAULT_ESSENCE_NAME, planDefaultEssence } from '../lib/default-essence.mjs'
import { MirrorUpgradeCoordinator } from '../lib/upgrade-coordinator.mjs'
import { createBusinessProducers } from '../lib/business-producers.mjs'
import { createManifestOfficialSource } from '../lib/mirror-official-source.mjs'
import { clearForkConfigLock } from '../lib/fork-config-lock.mjs'
import { readForkSupervisionSettings, writeForkSupervisionSettings } from '../lib/fork-supervision-settings.mjs'
import { DEFAULT_EXPECTED_ROUTE_COUNT, readCompatStatus, runCompatGate, writeCompatStatus } from '../lib/compat.mjs'
import { buildUpgradeStatus } from '../lib/upgrade-status.mjs'
import { openDecisionEventStream } from '../lib/decision-events.mjs'
import { authErrorBody, checkRequestAuth, loadAuthToken } from '../lib/http-auth.mjs'
import { buildEssenceActions, buildTaskActions } from '../lib/ui-actions.mjs'
// P0: the former "accelerated Web sidecar" (a second mother Web) was retired — the
// accelerator serves fork Web UIs only. See /fang/api/fork-core.
import { readForkCoreSettings, resolveForkCoreState, writeForkCoreSettings } from '../lib/fork-core-settings.mjs'
import {
  capabilityCatalog, checkDelegation, createDelegationGate, DELEGATE_ERROR, delegationAuditRecord,
  DEFAULT_READ_ALLOW, exceedPayloadLimit, normalizeDelegationConfig, runDelegated,
} from '../lib/contract-delegation.mjs'
import {
  PRO_CAPABILITIES, PRO_STAGE, checkProGate, createProApprovalStore, normalizeProConfig,
  proAuditRecord, proParamsDigest, providerMissingResult, runProCapability,
} from '../lib/pro-delegation.mjs'
import { validateToolInvoke } from '../lib/lsp-delegation.mjs'
import { LSP_PROVIDER_TEST, advertisedActionsFromSeam, checkWorkspaceRoot, collectForkWorkspaceRoots, describeLspProvider, lspAuditRecord, queryMotherLsp, resolveLspAllowedRoots } from '../lib/lsp-provider.mjs'
import { buildChatImportDryRun, validateChatImport } from '../lib/chat-import-delegation.mjs'
import { detectForkLspSupport, normalizeCoreMode, pruneAliasStubs, sanitizeAcceleratedForkSessions } from '../lib/accelerated-fork.mjs'
import { accelNodeModulesRoot, resolveAcceleratedCore } from '../lib/accelerated-install.mjs'
import { BranchStore } from '../lib/branch-store.mjs'
import { ComposerJournal } from '../lib/composer-journal.mjs'
import { fileURLToPath } from 'node:url'
import {
  createContractServer, startFileContractServer, createResponse,
  createRelayStore, relayHandlers,               // v3.1.35：contract 1.1 回流接口
  METHODS as CONTRACT_METHODS, CONTRACT_VERSION,
} from '../contract/index.js'
import zlib from 'node:zlib'

/**
 * Commit a promoted directory by copy → digest → directory swap.
 * The old target is only removed after the new tree has been verified and renamed in.
 */
export function atomicReplaceDir(sourceDir, targetDir) {
  const suffix = newId('promote')
  const tmp = `${targetDir}.tmp-${suffix}`
  const old = `${targetDir}.old-${suffix}`
  const digestOf = (dir) => {
    const tree = digestTree(dir)
    const keys = Object.keys(tree).sort()
    return sha256(keys.map((key) => `${key}\u0000${tree[key]}`).join('\n'))
  }
  try {
    removeTree(tmp)
    removeTree(old)
    copyTree(sourceDir, tmp)
    const digest = digestOf(tmp)
    if (digest !== digestOf(sourceDir)) throw new Error('promote-digest-mismatch')
    const hadOld = exists(targetDir)
    if (hadOld) fs.renameSync(targetDir, old)
    try {
      fs.renameSync(tmp, targetDir)
    } catch (error) {
      if (hadOld && !exists(targetDir)) {
        try { fs.renameSync(old, targetDir) } catch { /* best effort restore */ }
      }
      throw error
    }
    if (hadOld) removeTree(old)
    return { digest }
  } catch (error) {
    removeTree(tmp)
    if (exists(old) && !exists(targetDir)) {
      try { fs.renameSync(old, targetDir) } catch { /* best effort restore */ }
    }
    throw error
  }
}


const FORK_BUNDLE_NAMES = Object.freeze(['@twinsearth/fang-dsh-plugin', '@twinsearth/dsh-fang', '@local/dsh-fang'])
// build.mjs rewrites @local/dsh-fang to the published package name.
const CURRENT_FANG_BUNDLE = '@local/dsh-fang'

function profileBundles(profileDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(String(profileDir ?? ''), 'package.json'), 'utf8'))
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : []
    const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : []
    return { bundles, deps, pkg }
  } catch {
    return { bundles: [], deps: [], pkg: null }
  }
}

/**
 * v3.3.7: an essence captured by an older release can still declare the legacy
 * `@twinsearth/dsh-fang` bundle while the current fork has no such package.
 * Such an essence is not a valid fork template; deriving from it creates a
 * process whose Adapter never mounts (404). Treat it as stale and fall back to
 * the clean template instead of silently producing a zombie fork.
 */
export function profileUsesCurrentFangBundle(profileDir) {
  const { bundles, deps, pkg } = profileBundles(profileDir)
  if (!pkg) return true // unknown template: don't reject (caller has its own checks)
  const declared = new Set([...bundles, ...deps])
  const current = declared.has(CURRENT_FANG_BUNDLE) || declared.has('@twinsearth/fang-dsh-plugin')
  if (!current) {
    // Only a positively-declared legacy bundle is stale. Templates that don't
    // declare fang at all (unit-test fixtures, custom hosts) are left to the
    // existing forkBundlePath probe.
    return !(declared.has('@twinsearth/dsh-fang') || declared.has('@local/dsh-fang-legacy'))
  }
  // v3.3.8: same package name but an older exact version is stale too. This is
  // the normal upgrade case (3.3.7 essence after installing 3.3.8).
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const declaredVersion = String(
    dependencies['@twinsearth/fang-dsh-plugin'] ||
    dependencies['@local/dsh-fang'] ||
    dependencies['@twinsearth/dsh-fang'] ||
    '',
  ).replace(/^[~^]/, '')
  if (/^\d+\.\d+\.\d+/.test(declaredVersion) && declaredVersion !== FANG_VERSION) return false
  return true
}

/** 分身 profile 可解析的 fang bundle 路径（npm 安装名/开发 link 名都接受）。 */
function forkBundlePath(profileDir) {
  for (const name of FORK_BUNDLE_NAMES) {
    const candidate = path.join(String(profileDir ?? ''), 'node_modules', ...name.split('/'))
    if (exists(candidate)) return candidate
  }
  return null
}

export const name = 'fang-orchestrator'
export const inject = []

/**
 * v3.3.5: a fork participates in the mother's approval aggregation only while it
 * is actually alive. Failed/stopped/reaped forks are offline state, not approval
 * failures; they must not turn the inbox `degraded`.
 */
export function isLiveForkForApprovals(_task, status) {
  return status === TASK_STATUS.READY || status === TASK_STATUS.RUNNING
}

export const Config = z.object({
  role: z.union([z.const('mother'), z.const('fork')]).default('mother')
    .description('配置层角色；环境 DSH_FANG_ROLE 优先（forker 派生的分身自动为 fork）'),
  officialSourceUrl: z.string().default('')
    .description('官方源 manifest 基础 URL（https；留空 = 无官方源，升级显式 official-source-unavailable）'),
  officialSourceToken: z.string().default('')
    .description('官方源 Bearer token（可选；不会写进日志/状态）'),
  maxForks: z.number().min(1).max(64).default(8)
    .description('同时存活的任务/分身上限'),
  motherProfile: z.string().default('')
    .description('母体 profile 名；留空 = 当前 profile（分身模板来源）'),
  profileTemplate: z.string().default('')
    .description('分身 profile 模板目录；留空 = 当前 profile 目录（Forker 的 cleanTemplate 会覆盖）'),
  fangHome: z.string().default('')
    .description('三区数据根（相当于 FANG_HOME）；留空 = 自动（新装默认 D:\\ToFuture，已有旧数据沿用旧布局）'),
  defaultEssenceAuto: z.boolean().default(true)
    .description('新用户自动生成“默认元宝”（仅当没有任何用户元主、且默认插件已有安装时；失败不影响启动）'),
  cliPath: z.string().default('')
    .description('dsh 启动器路径；留空自动探测（PATH 上的 dsh / 安装目录 dsh.cmd）'),
  accelerated: z.object({
    cliPath: z.string().default('').description('加速版 DSH CLI 入口（@twinsearth/dsh 的 bin；留空 = FANG_ACCEL_CLI）'),
    profile: z.string().default('fang-accelerated').description('加速版 sidecar 的 profile 名'),
    port: z.number().min(1).max(65535).default(18080).description('加速版 sidecar 的固定端口'),
    home: z.string().default('').description('加速版 sidecar 的 DSH_HOME；留空 = 当前 DSH_HOME'),
    enabled: z.boolean().default(false).description('允许母体面板启动加速版 sidecar'),
  }).default({}),
  dataRoot: z.string().default('')
    .description('数据根目录；留空 = $DSH_HOME/fang/<profileTag>'),
  forksRoot: z.string().default('')
    .description('分身 home 根目录；留空 = <dataRoot>/forks'),
  mirrorRoot: z.string().default('')
    .description('母体镜像根目录；留空 = <dataRoot>/mirror（备份/恢复/升级都在这一个文件夹里）'),
  adapterTimeoutMs: z.number().min(100).max(120000).default(10000)
    .description('派生后等待分身 Adapter 就绪的上限（毫秒）；超时任务记为 running（adapter 未就绪）'),
  adapterPollMs: z.number().min(50).max(5000).default(400)
    .description('Adapter 握手轮询间隔（毫秒）'),
  importMaxBytes: z.number().min(0).max(268435456).default(33554432)
    .description('派生时导入母体历史会话日志的大小上限（字节）；超过则只保留交接摘要，不复制历史'),
  allowProcessRestart: z.boolean().default(false)
    .description('是否允许编排器主动重启母体（默认禁止；重启一律交给 restart-guard）'),
  autoReapIdleMinutes: z.number().min(0).max(1440).default(0)
    .description('空闲多少分钟后自动回收任务（0 = 不自终）'),
  archiveStopTimeoutMs: z.number().min(100).max(30000).default(3000)
    .description('归档时等待分身进程真正退出的上限（毫秒）'),
  commercial: z.object({
    collaboration: z.boolean().default(false).description('联合开发（需 fangCommercial provider）'),
    git: z.boolean().default(false).description('本地 Git 快照（需 provider）'),
    backup: z.boolean().default(false).description('云备份（需 provider）'),
    tokenApi: z.boolean().default(false).description('Token API（不在本插件内实现）'),
    teams: z.boolean().default(false).description('团队权限（需 provider）'),
  }).default({}),
  routes: z.object({
    enabled: z.boolean().default(true).description('是否注册 /fang 路由'),
    prefix: z.string().default('/fang').description('路由前缀'),
  }).default({}),
  authToken: z.string().default('')
    .description('v3.0.5/B1：安装级鉴权 token；留空 = 读 DSH_FANG_AUTH_TOKEN 或 <dataDir>/fang-auth.json（0600，自动生成）'),
  authEnabled: z.boolean().default(true)
    .description('v3.0.5/B1：是否要求 /fang/api 携带鉴权 token（默认开启；仅测试/本地调试可关）'),
  contract: z.object({
    enabled: z.boolean().default(true).description('v3.1.15：是否启用 fang-master 契约端点/服务'),
    token: z.string().default('').description('契约 HTTP Bearer token（留空 = HTTP 契约端点禁用；不写日志/状态）'),
    fileDir: z.string().default('').description('可选：文件 outbox 兜底目录（同机 fallback；留空 = 关闭）'),
    pathPrefix: z.string().default('/fang/api/contract').description('契约路由前缀'),
    // B 契约委托：加速分身 → 母体 的无头能力委托（默认只读白名单）
    delegate: z.object({
      enabled: z.boolean().default(true).description('是否允许委托调用（默认开启；仍受 allow 白名单约束）'),
      allow: z.array(z.string()).default([...DEFAULT_READ_ALLOW]).description('允许委托的能力方法名；默认只读白名单'),
      maxPayloadBytes: z.number().min(1024).max(16 * 1024 * 1024).default(64 * 1024),
      readTimeoutMs: z.number().min(100).max(120000).default(5000),
      writeTimeoutMs: z.number().min(100).max(600000).default(30000),
      maxConcurrent: z.number().min(1).max(64).default(4).description('委托并发上限；超过立即 contract-rate-limited（fail-closed，不排队）'),
      pro: z.object({
        enabled: z.boolean().default(false).description('B-8 专业版总开关：默认 false，未开启时 fang.code.run 一律拒绝'),
        allow: z.array(z.string()).default([]).description('逐项手动授权激活列表（每项独立显式 allow）'),
        approvalTtlMs: z.number().min(1000).max(3600000).default(120000),
        maxConcurrent: z.number().min(1).max(8).default(1),
        timeoutMs: z.number().min(100).max(600000).default(30000),
        maxOutputBytes: z.number().min(1024).max(1048576).default(65536),
      }).default({}),
      lsp: z.object({
        allowedRoots: z.array(z.string()).default([]).description('LSP 委托允许的 workspaceRoot 前缀（空 = 拒绝，fail-closed；realpath 包含校验）'),
        includeForkWorktrees: z.boolean().default(true).description('自动登记所有 fork 任务的工作区根（母体根 + fork 工作区根，显式登记）'),
        maxLocations: z.number().min(1).max(1000).default(200).description('locations 结果上限（超出裁剪并标记 truncated）'),
        maxResultChars: z.number().min(256).max(200000).default(20000).description('hover 等文本结果上限（超出裁剪并标记 truncated）'),
      }).default({}),
    }).default({}),
  }).default({}),
})

const HTML_ESCAPE = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/** v3.0.5/B4：对外的任务 URL 一律去掉 ?token=（token 只在内存/打开时临时下发）。 */
export function stripUrlToken(url) {
  const raw = String(url ?? '')
  if (!raw) return raw || null
  try {
    const parsed = new URL(raw)
    if (!parsed.searchParams.has('token')) return raw
    parsed.searchParams.delete('token')
    return parsed.toString()
  } catch {
    return raw.replace(/([?&])token=[^&#]*&?/i, (_, sep) => (sep === '?' ? '?' : '')).replace(/[?&]$/, '')
  }
}

/** Find a runnable dsh launcher. `.cmd` wrappers are spawned through a shell by the forker. */
export function resolveCliPath(explicit = '', env = process.env, execPath = process.execPath) {
  // v3.1.33：平台感知。v3.1.32 及以前只探测 Windows 的 dsh.cmd + 硬编码盘符，
  // 在 macOS 上必然找不到 launcher → 回落裸 'dsh' → spawn ENOENT → spawn-error。
  // （MacMini 实测：runtime-spawn-failed: spawn-error, profile=essence-runtime）
  const isWindows = process.platform === 'win32'
  // win 用 resources，mac 的 .app 是 Contents/Resources（大写）——按平台给真实大小写优先。
  const binDirNames = isWindows ? ['resources', 'Resources'] : ['Resources', 'resources']
  const binNames = isWindows ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh', 'dsh.sh']
  const candidates = []
  const push = (value) => { if (value) candidates.push(value) }

  if (explicit) push(explicit)
  if (env.DSH_CLI) push(env.DSH_CLI)
  if (env.DSH_INSTALL_DIR) {
    for (const dir of binDirNames) {
      for (const name of binNames) push(path.join(env.DSH_INSTALL_DIR, dir, 'runtime', 'cli', 'bin', name))
    }
  }
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of binNames) push(path.join(dir, name))
  }
  // 从当前宿主可执行文件反推安装根：
  //   win : <install>\DeepSeek Harness.exe → <install>\resources\runtime\cli\bin\dsh.cmd
  //   mac : <app>/Contents/MacOS/DeepSeek Harness → <app>/Contents/Resources/runtime/cli/bin/dsh
  try {
    let dir = path.dirname(String(execPath ?? ''))
    for (let i = 0; i < 6 && dir; i += 1) {
      for (const sub of binDirNames) {
        for (const name of binNames) {
          push(path.join(dir, sub, 'runtime', 'cli', 'bin', name))
          push(path.join(dir, 'runtime', 'cli', 'bin', name))
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* keep legacy candidates */ }

  if (isWindows) {
    push('E:\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd')
    push('C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd')
  } else {
    // macOS / Linux 常见安装位置（含 .app 包内 CLI）
    push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
    push(path.join(String(env.HOME ?? ''), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'))
    push('/opt/homebrew/bin/dsh')
    push('/usr/local/bin/dsh')
    push('/usr/bin/dsh')
  }

  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch { /* next */ }
  }
  return explicit || 'dsh'
}

export function isShellLauncher(cliPath) {
  return /\.(cmd|bat)$/i.test(String(cliPath))
}

/** Durable task registry (v1 files stay readable: they carry the same forkId field). */
function loadRegistry(file) {
  const raw = readJson(file, [])
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.forks)) return raw.forks
  return []
}

function saveRegistry(file, entries) {
  writeJsonAtomic(file, { version: 2, at: iso(), forks: entries })
}

/** Normalize a lineage seed payload; returns null when absent. Bounded by 64 KiB. */
export function normalizeSeed(seed) {
  if (!seed || typeof seed !== 'object') return null
  const sessionId = String(seed.sessionId ?? '').trim()
  const markdown = String(seed.markdown ?? '')
  if (!sessionId && !markdown) return null
  if (markdown.length > 64 * 1024) throw new Error('seed-too-large')
  return { sessionId, markdown: markdown || `# lineage seed\n\n- session: ${sessionId}\n- mode: lineage-only\n` }
}

export function apply(ctx, config) {
  const cfg = { ...Config({}), ...(config ?? {}) }
  const gate = roleGate('orchestrator', { cfgRole: cfg.role, logger: ctx.logger })
  if (!gate.active) return
  const role = gate.role

  const layout = resolveFangLayout({ dataRoot: cfg.dataRoot, forksRoot: cfg.forksRoot, fangHome: cfg.fangHome })
  // P1：分身核心开关（只影响新派生/重启的分身；母体与元主不读它）。
  const forkCoreSettings = () => readForkCoreSettings(layout.dataDir)
  /** 当前开关期望的分身核心。 */
  const desiredForkCoreMode = () => normalizeCoreMode(forkCoreSettings().mode)
  /**
   * 开关不是热更新：重新打开（restore/autostart）分身时才应用。
   * 分身是生产盘——每次打开本来就会从模板重放 profile 配置，因此换核等价于重放一次：
   *   official ←→ accelerated 需要重新 provision（profile 形状不同），会话目录不动。
   * @returns {{ok:boolean, switched:boolean, coreMode:string, error?:string, detail?:string}}
   */
  const syncForkCoreMode = async (task, options = {}) => {
    const force = options?.force === true
    const desired = desiredForkCoreMode()
    const current = normalizeCoreMode(task?.coreMode)
    // 2026-11-22：重新打开/换核前先捕获元主 Web 的最新插件设置，保证分身与元主同步。
    if (task?.essenceId) captureEssenceRuntimeIfPresent(task.essenceId)
    if (!task || (desired === current && !force)) return { ok: true, switched: false, coreMode: current || desired }
    const f = forker()
    if (!f || typeof f.provision !== 'function') return { ok: false, switched: false, coreMode: current, error: 'forker-unavailable' }
    let provisioned
    if (desired === 'accelerated') {
      // 原身派生的分身：重新打开换加速核时同步原身插件面（与 createTask 一致）。
      let sourceProfileDir = ''
      if (task.sourceEssence?.id) {
        try { sourceProfileDir = essenceManager.mergedProfileDir(task.sourceEssence.id) } catch { sourceProfileDir = '' }
      }
      provisioned = await f.provision({
        forkId: task.taskId,
        taskTitle: task.title,
        homeDir: task.homeDir,
        profile: task.profile,
        coreMode: 'accelerated',
        ...(sourceProfileDir ? { sourceProfileDir } : {}),
      })
    } else {
      provisioned = await f.provision({
        forkId: task.taskId,
        taskTitle: task.title,
        homeDir: task.homeDir,
        profile: task.profile,
        profileTemplate: templateDir(),
        cleanTemplate: true,
        coreMode: 'stock',
        nodeModulesSource: path.join(templateDir(), 'node_modules'),
      })
    }
    if (!provisioned || provisioned.ok === false) {
      return { ok: false, switched: false, coreMode: current, error: desired === 'accelerated' ? 'accelerated-provision-failed' : 'stock-provision-failed', detail: provisioned?.error }
    }
    task.prevCoreMode = current
    task.coreMode = desired
    if (provisioned?.accelerated?.sync) task.acceleratedSync = provisioned.accelerated.sync
    task.updatedAt = nowMs()
    persist()
    try { audit('fang/fork-core-switched', { taskId: task.taskId, from: current, to: desired }) } catch { /* audit optional */ }
    try { bus.emit('fang/fork-core-switched', { taskId: task.taskId, from: current, to: desired }) } catch { /* bus optional */ }
    return { ok: true, switched: true, coreMode: desired }
  }
  const branchStore = new BranchStore(layout.dataDir)
  const composerJournal = new ComposerJournal(layout.dataDir)
  // v3.0.5/B1：安装级 token（0600 文件 / env / 显式配置）；关闭仅限测试
  const authToken = cfg.authEnabled === false
    ? ''
    : loadAuthToken(layout.dataDir, cfg.authToken || process.env.DSH_FANG_AUTH_TOKEN)
  const motherProfile = cfg.motherProfile || layout.profileTag
  ensureDir(layout.dataDir)
  ensureDir(layout.forkHomesDir)

  /** @type {Map<string, any>} */
  const tasks = new Map()
  // v2 owns tasks.json. A v1 install only has forks.json; read it once so a live upgrade
  // does not lose the task list, but never write it back (the forker owns that file).
  const registrySource = exists(layout.tasksFile) ? layout.tasksFile : layout.forksFile
  for (const f of loadRegistry(registrySource)) {
    if (f && typeof f.forkId === 'string') {
      const task = normalizeTask(f)
      tasks.set(task.taskId, task)
    }
  }

  const safeGet = (key) => { try { return ctx.get(key) } catch { return undefined } }
  // v3.3.3: queue journal is an optional sub-plugin. Its host half provides
  // SERVICE.queueJournal; without it the journal/queue routes must fail closed
  // and the client half is never registered (row disabled -> no UI).
  const queueJournalEnabled = () => Boolean(safeGet(SERVICE.queueJournal))
  /**
   * 宿主内部生产者 → 决策中心（best-effort，绝不改变原流程结果）。
   * 用于 MirrorUpgrade / EssenceManager 这类仓内对象；外部系统（PM/PJM/Worker/
   * HarnessMM/PluginUpdater/SuperAgent）走 POST /fang/api/decisions/ingest 桥。
   */
  const raiseDecisionTicket = (spec = {}) => {    try {
      const center = safeGet(SERVICE.decisionCenter)
      if (!center || typeof center.submit !== 'function') return null
      const submitted = center.submit({
        level: spec.level ?? 'yellow',
        title: spec.title,
        context: spec.context,
        options: spec.options,
        actions: spec.actions,
        timeoutMinutes: spec.timeoutMinutes ?? 1440,
        dedupeKey: spec.dedupeKey,
        source: {
          sessionId: String(spec.sessionId ?? 'orchestrator'),
          agentRole: spec.agentRole ?? 'system',
          roleSource: 'host:orchestrator',
          roleTrusted: true,
          taskName: String(spec.sourceName ?? spec.producer ?? 'orchestrator'),
        },
        metadata: spec.metadata,
      })
      return submitted?.ok ? submitted.ticket : null
    } catch { return null }
  }
  const businessProducers = createBusinessProducers({ submit: (spec) => raiseDecisionTicket(spec) })
  // R15：审计失败不再完全静默——累计失败数 + 限频告警，并暴露在 /fang/api/status.audit。
  // 失败语义保持不变（audit() 不抛：审计不可用不能把普通业务路径打挂）；安全关键路径用 auditStrict()。
  let auditFailures = 0
  let lastAuditError = null
  let lastAuditWarnAt = 0
  const recordAuditFailure = (kind, error) => {
    auditFailures += 1
    lastAuditError = String(error?.message ?? error ?? 'audit-append-failed').slice(0, 300)
    const now = Date.now()
    if (now - lastAuditWarnAt >= 60_000) {
      lastAuditWarnAt = now
      try { ctx.logger?.warn?.(`[fang] 审计写入失败（kind=${String(kind)}）：${lastAuditError}`) } catch { /* logger optional */ }
    }
  }
  const audit = (kind, data) => {
    try {
      const auditor = safeGet(SERVICE.auditor)
      if (auditor && typeof auditor.append === 'function') {
        const record = auditor.append(kind, data)
        if (record === null || record === undefined) throw new Error('audit-append-failed')
      }
    } catch (error) {
      recordAuditFailure(kind, error)
    }
    try { bus.emit('fang/audit', { kind, data }) } catch { /* ignore */ }
  }
  /**
   * 安全关键路径的审计：必须确实写入链，否则抛错让调用方 fail-closed
   * （R15：静默丢失比拒绝更危险；审计服务缺失时仍允许“跳过”，与旧部署兼容）。
   */
  const auditStrict = (kind, data) => {
    const auditor = safeGet(SERVICE.auditor)
    if (!auditor) return { ok: true, skipped: true }
    let record = null
    try {
      if (typeof auditor.appendStrict === 'function') record = auditor.appendStrict(kind, data)
      else {
        record = typeof auditor.append === 'function' ? auditor.append(kind, data) : null
        if (record === null || record === undefined) throw new Error('audit-append-failed')
      }
    } catch (error) {
      recordAuditFailure(kind, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
    try { bus.emit('fang/audit', { kind, data }) } catch { /* ignore */ }
    return { ok: true, record }
  }
  /** 审计健康快照（只读）：auditor 自述 + 本进程观察到的失败。 */
  const auditHealth = () => {
    let auditorStatus = null
    try {
      const auditor = safeGet(SERVICE.auditor)
      if (auditor && typeof auditor.status === 'function') auditorStatus = auditor.status()
    } catch { auditorStatus = null }
    return {
      ...(auditorStatus ?? {}),
      processFailures: auditFailures,
      processLastError: lastAuditError,
      ok: auditFailures === 0 && (auditorStatus === null || auditorStatus.ok !== false),
    }
  }
  const persist = () => {
    try {
      // v3.0.5/B4：tasks.json 不落 token，URL 也不带 ?token=（打开时走 open-url 临时下发）
      saveRegistry(layout.tasksFile, [...tasks.values()].map(task => ({
        ...task, token: '', url: stripUrlToken(task.url),
      })))
    } catch { /* best effort */ }
  }
  const forker = () => safeGet(SERVICE.forker)
  const cliPath = () => (cfg.cliPath ? cfg.cliPath : resolveCliPath('', process.env))
  // The booted profile's own directory is authoritative (launcher sets DSH_PROFILE_DIR);
  // resolving "$DSH_HOME/profiles/<tag>" from argv can point at a template that never existed.
  // 分身模板必须来自一个**真的装了本 bundle** 的 profile；否则分身的 node_modules junction
  // 指到一个没有 @local/dsh-fang 的 profile，fork 里所有 /fang 路由都会 404（实测事故）。
  const templateDir = () => {
    const candidates = [cfg.profileTemplate, process.env.DSH_PROFILE_DIR, resolveProfileDir(motherProfile), resolveProfileDir(layout.profileTag)]
    const usable = candidates.filter((dir) => typeof dir === "string" && dir.trim()
      && exists(path.join(dir, "node_modules", "@local", "dsh-fang")))
    if (usable.length > 0) return usable[0]
    return candidates.find((dir) => typeof dir === "string" && dir.trim()) ?? resolveProfileDir(layout.profileTag)
  }
  const commercialHooks = commercialConfigSchemaDefaults()
  for (const key of Object.keys(commercialHooks)) {
    if (cfg.commercial && cfg.commercial[key] === true) commercialHooks[key] = true
  }

  function normalizeTask(f) {
    const taskId = f.taskId ?? f.forkId
    const status = f.status === FORK_STATUS.RUNNING ? TASK_STATUS.RUNNING
      : f.status === FORK_STATUS.CRASHED ? TASK_STATUS.FAILED
        : f.status === FORK_STATUS.STOPPED ? TASK_STATUS.ARCHIVED
          : f.status ?? TASK_STATUS.PROVISIONING
    return {
      taskId,
      forkId: taskId,
      title: f.title ?? f.taskTitle ?? taskId,
      taskTitle: f.title ?? f.taskTitle ?? taskId,
      profile: f.profile,
      homeDir: f.homeDir,
      status,
      createdAt: f.createdAt ?? nowMs(),
      restarts: f.restarts ?? 0,
      pid: f.pid ?? null,
      port: f.port ?? null,
      url: f.url ?? null,
      token: f.token ?? (f.url ? extractTokenSafe(f.url) : ''),
      adapter: f.adapter ?? { ok: false, error: 'not-handshaked' },
      collaborators: Array.isArray(f.collaborators) ? f.collaborators : [],
      template: f.template ?? '',
      essenceId: f.essenceId ?? null,
      sourceEssence: f.sourceEssence ?? null,
    }
  }

  function extractTokenSafe(url) {
    try {
      const u = new URL(String(url))
      return u.searchParams.get('token') ?? ''
    } catch { return '' }
  }

  /** Layout of one fork's private $DSH_HOME (its buffer lives inside it). */
  function forkLayout(info) {
    return resolveFangLayout({
      env: { ...process.env, DSH_HOME: info.homeDir },
      argv: ['--profile', info.profile],
    })
  }

  // ── 跨进程 remote 客户端（懒加载，模块缺失时显式降级）────────────────────────
  let remoteModulePromise = null
  const remoteModule = async () => {
    if (!remoteModulePromise) {
      remoteModulePromise = import('../lib/remote.mjs').catch(() => null)
    }
    return remoteModulePromise
  }
  const remoteCache = new Map()
  async function remoteFor(task) {
    if (!task?.url) return null
    // v3 Bearer token 只从 Forker 内存取（不落盘、不进 task 持久化字段）。
    const adapterToken = (() => {
      try {
        const f = forker()
        return f && typeof f.adapterToken === 'function' ? String(f.adapterToken(task.taskId) ?? '') : ''
      } catch {
        return ''
      }
    })()
    const cached = remoteCache.get(task.taskId)
    if (cached && cached.url === task.url && cached.adapterToken === adapterToken) return cached.client
    const mod = await remoteModule()
    if (!mod || typeof mod.createRemote !== 'function') return null
    const client = mod.createRemote({
      url: task.url,
      token: task.token || (mod.extractToken ? mod.extractToken(task.url) : ''),
      adapterToken,
      timeoutMs: 8000,
    })
    remoteCache.set(task.taskId, { url: task.url, adapterToken, client })
    return client
  }

  /** Poll the fork-side Adapter until it answers hello (bounded by adapterTimeoutMs). */
  async function handshake(task) {
    const client = await remoteFor(task)
    if (!client) {
      task.adapter = { ok: false, error: 'remote-module-missing', at: nowMs() }
      return task.adapter
    }
    const deadline = nowMs() + cfg.adapterTimeoutMs
    let last = null
    while (nowMs() < deadline) {
      const res = await client.hello()
      if (res?.ok && res.data?.ok) {
        // v3 版本协商（PROTOCOL-V3 §2）：旧分身没有 /adapter/version（404）→ 按 legacy 接受；
        // 新分身回 protocol 且超出母体支持区间 → fail-closed，绝不假装 READY。
        let protocol = Number(res.data.protocol) || 0
        let sessionId = String(res.data.sessionId ?? '')
        try {
          const ver = typeof client.version === 'function' ? await client.version() : null
          if (ver?.ok && ver.data) {
            const negotiated = negotiateProtocol(ver.data.protocol)
            if (!negotiated.ok) {
              task.adapter = { ok: false, error: negotiated.reason, protocol: ver.data.protocol, at: nowMs() }
              audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: false, error: negotiated.reason, protocol: ver.data.protocol })
              return task.adapter
            }
            protocol = negotiated.protocol
            sessionId = String(ver.data.sessionId ?? sessionId)
          }
        } catch {
          /* 版本探测失败不改变 hello 的结论；按 hello 自报的 protocol 记录 */
        }
        task.adapter = {
          ok: true,
          version: res.data.version ?? '',
          protocol,
          sessionId,
          role: res.data.role ?? 'fork',
          taskId: res.data.taskId ?? task.taskId,
          at: nowMs(),
        }
        audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: true, version: task.adapter.version, protocol })
        return task.adapter
      }
      last = res
      await sleep(cfg.adapterPollMs)
    }
    task.adapter = { ok: false, error: last?.error ?? last?.kind ?? 'timeout', at: nowMs() }
    audit(AUDIT.ADAPTER_HANDSHAKE, { taskId: task.taskId, ok: false, error: task.adapter.error })
    return task.adapter
  }

  function taskView(t) {
    const live = forker()?.status?.(t.taskId)
    const running = live ? !!live.running : t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.READY
    const status = !running ? (t.status === TASK_STATUS.ARCHIVED ? TASK_STATUS.ARCHIVED : TASK_STATUS.FAILED)
      : (t.adapter?.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING)
    const phase = !running
      ? (t.status === TASK_STATUS.ARCHIVED ? 'archived' : (t.status === TASK_STATUS.FAILED ? 'failed' : 'stopped'))
      : (t.adapter?.ok ? 'running' : 'starting')
    return {
      taskId: t.taskId,
      forkId: t.taskId,
      coreMode: t.coreMode === 'accelerated' ? 'accelerated' : 'stock',
      // D2：加速分身的插件面同步报告（映射成功/不支持清单/被复制插件），无则不出现。
      acceleratedSync: t.acceleratedSync ?? null,
      title: t.title,
      taskTitle: t.title,
      status,
      phase,
      health: { adapter: t.adapter?.ok ? 'ok' : 'pending', error: t.adapter?.error ?? '' },
      // v3.0.7/S1：动作可用性由服务端给出，UI 不再自行推断
      ...(() => {
        const ui = buildTaskActions({ running, archived: t.status === TASK_STATUS.ARCHIVED })
        return { actions: ui.actions, blocks: ui.blocks }
      })(),
      sessionTitle: t.importedSession?.title ?? t.seed?.title ?? '',
      startedAt: t.startedAt ?? live?.startedAt ?? null,
      updatedAt: t.updatedAt ?? live?.exitedAt ?? t.createdAt,
      projectBytes: t.projectBytes ?? 0,
      essenceId: t.essenceId ?? null,
      // 视图层才扫描会话（normalizeTask 在 apply 早期执行，不能引用后声明的 scanForkSessions）。
      sessions: (() => { const list = scanForkSessions(t); return { count: list.length, min: FORK_SESSION_MIN, max: FORK_SESSION_MAX, violation: list.length > FORK_SESSION_MAX, belowFloor: list.length < FORK_SESSION_MIN } })(),
      // 来源原身已被删除：分身仍可运行/归档/还原/删除，但不能重新派生。
      essenceDeleted: Boolean(t.essenceId) && (t.essenceDeleted === true || isTombstoned(t.essenceId)),
      // 方案 B：同一分身可挂多个分支会话，但同时只有一个 active。
      branch: (() => {
        try {
          const store = branchStore.list(t.taskId)
          return { activeBranchId: store.activeBranchId ?? t.activeBranchId ?? null, sessionId: store.sessionId ?? null, count: Array.isArray(store.branches) ? store.branches.length : 0 }
        } catch {
          return { activeBranchId: t.activeBranchId ?? null, sessionId: null, count: 0 }
        }
      })(),
      pid: live?.pid ?? t.pid ?? null,
      port: t.port ?? null,
      url: stripUrlToken(t.url),
      homeDir: t.homeDir,
      profile: t.profile,
      createdAt: t.createdAt,
      restarts: t.restarts ?? 0,
      adapter: { ok: !!t.adapter?.ok, version: t.adapter?.version ?? '', protocol: t.adapter?.protocol ?? 0, error: t.adapter?.error ?? '' },
      collaborators: t.collaborators ?? [],
      seed: t.seed ?? null,
      importedSession: t.importedSession ?? null,
      archivedAt: t.archivedAt ?? null,
      archiveRemote: t.archiveRemote ?? null,
    }
  }

  /**
   * 把一个母体会话日志有界地导入分身自己的 $DSH_HOME（会话目录 + workspace 索引），
   * 让分身原生 UI 能看到这段历史；超过 importMaxBytes 则不复制，只保留交接种子。
   */
  const importSessionIntoFork = (homeDir, meta) => {
    const sessionId = String(meta?.sessionId ?? '').trim()
    const sourceFile = String(meta?.sourceFile ?? '').trim()
    if (!sessionId || !sourceFile) return { ok: false, reason: 'bad-import-meta' }
    let bytes = 0
    try { bytes = fs.statSync(sourceFile).size } catch { return { ok: false, reason: 'source-missing' } }
    if (bytes > cfg.importMaxBytes) return { ok: false, reason: 'too-large', bytes, limit: cfg.importMaxBytes }
    const workspacePath = String(meta?.workspacePath ?? '').trim() || 'imported-session'
    const workspaceKey = encodeWorkspaceKey(workspacePath)
    const workspaceTitle = String(meta?.workspaceTitle ?? '').trim() || '导入的会话'
    const destDir = path.join(homeDir, 'sessions', workspaceKey, sessionId)
    ensureDir(destDir)
    fs.copyFileSync(sourceFile, path.join(destDir, 'session.v4.jsonl.zstd'))

    const storagesDir = path.join(homeDir, 'storages')
    ensureDir(storagesDir)
    const indexFile = path.join(storagesDir, 'workspace.json')
    let doc = null
    try { doc = readJson(indexFile) } catch { doc = null }
    if (!doc || typeof doc !== 'object') {
      doc = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } }
    }
    doc.tables = doc.tables && typeof doc.tables === 'object' ? doc.tables : {}
    doc.tables.workspaces = doc.tables.workspaces && typeof doc.tables.workspaces === 'object' ? doc.tables.workspaces : {}
    doc.global = doc.global && typeof doc.global === 'object' ? doc.global : { initialized: true, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
    doc.global.workspaceIds = Array.isArray(doc.global.workspaceIds) ? doc.global.workspaceIds : []
    const workspaceId = `ws-${sha256(workspacePath).slice(0, 12)}`
    const existing = doc.tables.workspaces[workspaceId]
    const sessionIds = Array.isArray(existing?.sessionIds) ? existing.sessionIds.filter((id) => typeof id === 'string') : []
    if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    doc.tables.workspaces[workspaceId] = {
      path: workspacePath,
      title: workspaceTitle,
      sessionIds,
      createdAt: existing?.createdAt ?? (Number.isFinite(meta?.createdAt) ? iso(meta.createdAt) : iso(nowMs())),
      updatedAt: iso(nowMs()),
    }
    if (!doc.global.workspaceIds.includes(workspaceId)) doc.global.workspaceIds.push(workspaceId)
    if (!doc.global.defaultWorkspaceId) doc.global.defaultWorkspaceId = workspaceId
    doc.global.initialized = true
    writeJsonAtomic(indexFile, doc)
    return { ok: true, bytes, sessionId, workspacePath, workspaceKey, workspaceTitle, indexFile }
  }

  // v3.1.35：分身会话数约束 1..3（用户规格）。
  //   · 下限 1：分身 Web 里至少有一个会话（空白派生时自动补空会话）；
  //   · 上限 3：多出的移到 quarantine-sessions/（不删除）；
  const scanForkSessions = (task) => {
    const root = path.join(String(task?.homeDir ?? ''), 'sessions')
    const out = []
    try {
      for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue
        const wsDir = path.join(root, workspace.name)
        for (const session of fs.readdirSync(wsDir, { withFileTypes: true })) {
          if (!session.isDirectory()) continue
          const full = path.join(wsDir, session.name)
          let mtime = 0
          try { mtime = fs.statSync(full).mtimeMs } catch { mtime = 0 }
          out.push({ workspaceKey: workspace.name, sessionId: session.name, path: full, mtime })
        }
      }
    } catch { /* 没有 sessions 目录 */ }
    return out.sort((a, b) => b.mtime - a.mtime)
  }
  const applyForkSessionGuard = (task) => {
    // 受管的分支子会话不参与“单会话”隔离（它们由分支库登记，属于同一分身的合法分支）。
    const branchSessionIds = new Set()
    try {
      for (const branch of branchStore.list(task.taskId).branches ?? []) {
        if (branch?.sessionId) branchSessionIds.add(String(branch.sessionId))
      }
      const storeSession = branchStore.load?.(task.taskId)?.sessionId
      if (storeSession) branchSessionIds.add(String(storeSession))
    } catch { /* 无分支库 */ }
    const sessions = scanForkSessions(task).filter((session) => !branchSessionIds.has(session.sessionId))
    const bindBranches = (keptId) => { try { branchStore?.bindSession?.(task.taskId, keptId) } catch { /* ignore */ } }
    if (sessions.length <= FORK_SESSION_MAX) {
      const kept = sessions[0]?.sessionId ?? null
      bindBranches(kept)
      return { ok: true, kept, keptCount: sessions.length, quarantined: [] }
    }
    const keep = sessions[0]
    const rest = sessions.slice(FORK_SESSION_MAX)
    const stamp = String(nowMs())
    const quarantined = []
    for (const session of rest) {
      const target = path.join(task.homeDir, 'quarantine-sessions', stamp, session.workspaceKey, session.sessionId)
      try {
        ensureDir(path.dirname(target))
        try { fs.renameSync(session.path, target) } catch { copyTree(session.path, target); removeTree(session.path) }
        quarantined.push({ workspaceKey: session.workspaceKey, sessionId: session.sessionId, movedTo: target, at: nowMs() })
      } catch { /* 移动失败保留原样，不破坏数据 */ }
    }
    if (quarantined.length > 0) {
      task.quarantinedSessions = (Array.isArray(task.quarantinedSessions) ? task.quarantinedSessions : []).concat(quarantined)
      persist()
      audit('fork-session-quarantined', { taskId: task.taskId, kept: keep.sessionId, moved: quarantined.length })
    }
    bindBranches(keep.sessionId)
    return { ok: true, kept: keep.sessionId, keptCount: FORK_SESSION_MAX, quarantined }
  }

  /**
   * v3.1.35：分身会话下限。已有会话则不动；没有则造一个空会话（DSH 合法格式）。
   * 分支会话也算已有会话——它们属于同一分身。
   */
  const ensureForkSessionFloor = async ({ homeDir, task, cwd }) => {
    const existing = summarizeForkSessions(homeDir)
    if (!existing.belowFloor) return { ok: true, created: false, count: existing.count }
    const workspacePath = String(cwd ?? '').trim()
      || String(task?.importedSession?.workspacePath ?? '').trim()
      || layout.forkHomesDir
    const created = ensureForkEmptySession(homeDir, {
      workspacePath,
      workspaceTitle: path.basename(workspacePath) || '新会话',
    })
    // 补完空会话后立刻套用上限，避免越界。
    try { enforceForkSessionCap(homeDir, { max: FORK_SESSION_MAX }) } catch { /* 上限失败不阻塞派生 */ }
    return { ...created, count: summarizeForkSessions(homeDir).count }
  }

  const tombstonesFile = path.join(layout.dataDir, 'deleted-essences.json')
  const loadTombstones = () => {
    try {
      const doc = readJson(tombstonesFile, {})
      return Array.isArray(doc?.ids) ? doc.ids.map(String) : []
    } catch { return [] }
  }
  const isTombstoned = (essenceId) => loadTombstones().includes(String(essenceId ?? ''))
  const addTombstone = (essenceId, name) => {
    const ids = new Set(loadTombstones())
    ids.add(String(essenceId))
    writeJsonAtomic(tombstonesFile, { ids: [...ids], updatedAt: nowMs(), last: { id: String(essenceId), name: String(name ?? ''), at: nowMs() } })
  }

  // v3.0.9 默认元宝：新用户免创建，自动生成一个带默认插件清单的元主。
  const defaultEssenceFile = path.join(layout.dataDir, 'default-essence.json')
  const readDefaultEssenceId = () => {
    try { return String(readJson(defaultEssenceFile, {})?.essenceId ?? '') } catch { return '' }
  }
  const writeDefaultEssenceId = (essenceId) => writeJsonAtomic(defaultEssenceFile, { essenceId: String(essenceId), at: nowMs() })
  // v3.3.8: after an upgrade the default essence still pins the previous fang
  // version. Auto-capture the current mother profile as a fresh essence and make
  // it default, so future forks never start from an old snapshot.
  let autoRefreshPromise = null
  let lastAutoRefresh = null
  const refreshStaleDefaultEssenceIfNeeded = () => {
    if (autoRefreshPromise) return autoRefreshPromise
    autoRefreshPromise = (async () => {
      // 2026-11-22：官方「开发者推荐（官方）」存在时它就是默认底座，不再自动捕获
      // “默认元宝 · 自动同步”快照（旧逻辑每次宿主重启都会新增一个，永不收敛）。
      const official = essenceManager.getMeta(OFFICIAL_ESSENCE_ID)
      if (official?.id && official.archived !== true) {
        return (lastAutoRefresh = { ok: true, skipped: 'official-essence-default' })
      }
      // Two defaults exist: default-essence.json (quick derive) and the mirror
      // default used by the essence list/UI. Accept either; capture({setDefault})
      // writes only the mirror default, so reading the file alone would skip.
      const mirrorDefault = typeof essenceManager.getDefault === 'function' ? essenceManager.getDefault() : null
      const essenceId = readDefaultEssenceId() || String(mirrorDefault?.essenceId ?? '')
      if (!essenceId) return (lastAutoRefresh = { ok: true, skipped: 'no-default-essence' })
      const meta = essenceManager.getMeta(essenceId)
      if (!meta?.id) return (lastAutoRefresh = { ok: false, skipped: 'default-essence-missing', essenceId })
      const mergedDir = essenceManager.mergedProfileDir(essenceId)
      if (profileUsesCurrentFangBundle(mergedDir)) {
        return (lastAutoRefresh = { ok: true, skipped: 'already-current', essenceId })
      }
      try {
        const captured = essenceManager.captureFromProfile(templateDir(), {
          name: `${DEFAULT_ESSENCE_NAME} · 自动同步 ${FANG_VERSION}`,
          tier: meta.tier ?? 'free',
          includeDependencies: true,
          includeSettings: true,
        })
        essenceManager.setDefault(captured.meta.id)
        writeDefaultEssenceId(captured.meta.id)
        audit('essence-auto-refreshed', {
          from: essenceId, to: captured.meta.id, fromVersion: String(meta?.fangVersion ?? 'unknown'), version: FANG_VERSION,
        })
        return (lastAutoRefresh = {
          ok: true, from: essenceId, to: captured.meta.id, version: FANG_VERSION,
          name: captured.meta.name,
        })
      } catch (error) {
        const detail = String(error?.message ?? error)
        audit('essence-auto-refresh-failed', { from: essenceId, error: detail })
        return (lastAutoRefresh = { ok: false, from: essenceId, error: detail })
      }
    })().finally(() => { autoRefreshPromise = null })
    return autoRefreshPromise
  }
  const listInstalledPlugins = async () => {
    try {
      const pm = safeGet('pluginManager')
      if (!pm || typeof pm.listPlugins !== 'function') return null
      const out = await pm.listPlugins()
      if (Array.isArray(out)) return out
      if (Array.isArray(out?.plugins)) return out.plugins
      return null
    } catch { return null }
  }

  /**
   * 只读：重启守卫 + supervisor 契约状态。
   * status() 只带摘要（Client Header 用），/fang/api/restart 带完整视图。
   * 任何字段缺失都按「不可用/未知」返回，绝不伪造已武装或已执行。
   */
  const restartView = () => {
    const guard = safeGet(SERVICE.restart)
    if (!guard) return { available: false }
    try {
      const state = typeof guard.state === 'function' ? guard.state() : null
      const policy = typeof guard.policy === 'function' ? guard.policy() : null
      const contract = typeof guard.executionContract === 'function' ? guard.executionContract() : null
      const approvals = typeof guard.approvals === 'function' ? guard.approvals({ limit: 20 }) : null
      return { available: true, state, policy, contract, approvals, decisionOnly: true, executed: false }
    } catch (error) {
      return { available: true, error: 'restart-guard-status-failed', detail: String(error?.message ?? error) }
    }
  }

  const restartSummary = (view) => {
    if (!view?.available) return { available: false }
    if (view.error) return { available: true, error: view.error }
    const s = view.state ?? {}
    const p = view.policy ?? {}
    return {
      available: true,
      state: s.state ?? null,
      pending: s.pending ?? null,
      mode: p.mode ?? s.mode ?? null,
      authMode: p.authMode ?? s.authMode ?? null,
      strictRedLine: p.strictRedLine ?? null,
      redLineAutoAllowed: p.redLineAutoAllowed === true || s.redLineAutoAllowed === true,
      allowProcessRestart: p.allowProcessRestart === true || s.allowProcessRestart === true,
      tempEffectiveManual: p.tempEffectiveManual === true || s.tempEffectiveManual === true,
      decisionOnly: true,
      contractVersion: s.contractVersion ?? null,
      manifestTtlMs: p.manifestTtlMs ?? s.manifestTtlMs ?? null,
      approvals: view.approvals?.counts ?? null,
    }
  }

  const service = {
    role,
    version: FANG_VERSION,
    dataDir: layout.dataDir,

    /** v2 主入口：派生一个任务（= 一个分身）。 */
    async createTask(input = {}) {
      const title = String(input.title ?? input.taskTitle ?? '').trim() || `任务 ${tasks.size + 1}`
      const running = [...tasks.values()].filter(t => {
        const s = taskView(t).status
        return s === TASK_STATUS.RUNNING || s === TASK_STATUS.READY
      }).length
      if (running >= cfg.maxForks) {
        return { ok: false, error: 'quota-exceeded', detail: `已达上限 ${cfg.maxForks}，请先归档旧任务` }
      }
      const f = forker()
      if (!f || typeof f.spawn !== 'function') {
        return { ok: false, error: 'forker-unavailable', detail: 'fang-forker 未加载' }
      }

      const taskId = newId('task')
      const profile = `fang-${taskId.replace(/^task_/, '').slice(0, 12)}`
      const homeDir = path.join(layout.forkHomesDir, taskId)
      const template = String(input.template ?? '').trim()
      // v3.0.9：从原身派生时，模板来源是该原身的 merged/profile（分身只生产，不回写原身）。
      // v3.0.9：未指定来源时，若存在“默认元宝”，快速派生直接以它为模板（新用户小白路径）。
      let essenceIdInput = String(input.essenceId ?? '').trim()
      if (!essenceIdInput && !template) {
        const presetId = readDefaultEssenceId()
        if (presetId && essenceManager.getMeta(presetId)?.id) essenceIdInput = presetId
      }
      let sourceEssence = null
      let templateFallback = null
      if (essenceIdInput) {
        const essenceId = essenceIdInput
        const meta = essenceManager.getMeta(essenceId)
        if (!meta || typeof meta.id !== 'string') {
          return { ok: false, error: isTombstoned(essenceId) ? 'essence-deleted' : 'unknown-essence' }
        }
        if (meta.archived === true) return { ok: false, error: 'essence-archived' }
        captureEssenceRuntimeIfPresent(essenceId)
        await essenceManager.ensureFresh(essenceId)
        const fresh = essenceManager.getMeta(essenceId)
        const mergedDir = essenceManager.mergedProfileDir(essenceId)
        // v3.3.7: an old essence can still declare the legacy bundle while the
        // current profile has no such package. Deriving from it produces a
        // process whose Adapter never mounts (404), so fall back to the clean
        // template built from the current mother instead of a zombie fork.
        if (!profileUsesCurrentFangBundle(mergedDir)) {
          templateFallback = { from: essenceId, name: String(meta.name ?? ''), reason: 'stale-legacy-bundle' }
          audit('fork-template-stale', { essenceId, name: String(meta.name ?? ''), fallback: 'clean-template' })
        } else {
          sourceEssence = { id: essenceId, name: meta.name, fingerprint: fresh?.lastMergedFingerprint ?? null }
        }
      }
      const profileTemplate = sourceEssence
        ? essenceManager.mergedProfileDir(sourceEssence.id)
        : (template || templateDir())
      const task = normalizeTask({
        taskId,
        title,
        profile,
        homeDir,
        status: TASK_STATUS.PROVISIONING,
        createdAt: nowMs(),
        collaborators: Array.isArray(input.collaborators) ? input.collaborators : [],
        template,
        templateFallback,
        essenceId: sourceEssence?.id ?? null,
        sourceEssence,
        adapter: { ok: false, error: 'handshaking' },
      })
      tasks.set(taskId, task)
      persist()

      // P1：核心选择只作用于分身。显式 input.coreMode 优先，否则读面板开关。
      const coreSettings = forkCoreSettings()
      const coreMode = normalizeCoreMode(input.coreMode ?? coreSettings.mode)
      // 会话策略：加速核默认只新会话；`copy` 允许把旧会话复制进分身（新副本，绝不原地挂载）。
      const allowSessionImport = coreMode !== 'accelerated' || coreSettings.sessionMode === 'copy'
      task.coreMode = coreMode
      task.sessionMode = coreSettings.sessionMode

      try {
        const provisioned = await f.provision({
          forkId: taskId,
          taskTitle: title,
          homeDir,
          profile,
          profileTemplate,
          coreMode,
          // 加速档 + 原身派生：同步原身插件面（第三方包复制 + @deepseek-ai/* 别名桩包）。
          ...(coreMode === 'accelerated' && sourceEssence ? { sourceProfileDir: profileTemplate } : {}),
          // node_modules：优先元主自己的模块树；默认元宝/新建原身可能尚未物化 node_modules，
          // 此时回退母体模块树，保证分身仍能解析 @local/dsh-fang（否则是僵尸分身）。
          ...(sourceEssence ? {
            cleanTemplate: false,
            nodeModulesSource: (() => {
              const essenceModules = path.join(profileTemplate, 'node_modules')
              if (exists(essenceModules)) return essenceModules
              return path.join(templateDir(), 'node_modules')
            })(),
          } : {}),
        })
        if (provisioned && provisioned.ok === false) {
          task.status = TASK_STATUS.FAILED
          persist()
          return { ok: false, error: 'provision-failed', detail: provisioned.error }
        }
        // D2：记录加速分身的插件面同步结果（哪些映射成功、哪些不支持、哪些插件被复制）。
        if (provisioned?.accelerated?.sync) {
          task.acceleratedSync = provisioned.accelerated.sync
          persist()
        }
        audit(AUDIT.FORK_CREATED, { taskId, forkId: taskId, title, homeDir, profile, templateFallback })

        // 防御：分身的 profile 必须能解析本 bundle；否则派生出来的是一个"没有 /fang 路由"的
        // 僵尸分身（adapter 握手会得到 http-404）。发现即回收并如实报错。
        // npm 安装名是 @twinsearth/fang-dsh-plugin；旧包名 @twinsearth/dsh-fang 与开发 link @local/dsh-fang 继续兼容。
        const forkProfileDir = path.join(homeDir, 'profiles', profile)
        const forkBundle = forkBundlePath(forkProfileDir)
        if (!forkBundle) {
          task.status = TASK_STATUS.FAILED
          tasks.delete(taskId)
          persist()
          try { await f.reap(taskId) } catch { /* 回收失败不改变结论 */ }
          audit(AUDIT.FORK_CRASHED, { taskId, error: 'fork-bundle-unavailable', forkProfileDir })
          return { ok: false, error: 'fork-bundle-unavailable', detail: forkProfileDir }
        }


        // v2.1 lineage seed: a bounded handoff digest copied into the fork's own home.
        // The fork reads it; the mother stays immutable (no session mount/copy).
        const seed = normalizeSeed(input.seed ?? (input.seedSessionId ? { sessionId: input.seedSessionId } : null))
        if (seed) {
          try {
            const seedsDir = path.join(homeDir, 'fang-seeds')
            ensureDir(seedsDir)
            const seedId = newId('seed')
            const seedPath = path.join(seedsDir, seedId + '.md')
            writeFileAtomic(seedPath, seed.markdown)
            task.seed = {
              seedId,
              path: seedPath,
              sessionId: seed.sessionId ?? '',
              sha256: sha256(seed.markdown),
              bytes: Buffer.byteLength(seed.markdown, 'utf8'),
            }
            audit(AUDIT.FORK_CREATED + '-seed', { taskId, seedId, sessionId: task.seed.sessionId, bytes: task.seed.bytes })
          } catch (e) {
            task.seed = null
            audit(AUDIT.FORK_CRASHED + '-seed', { taskId, error: String(e?.message ?? e) })
          }
        }

        if (!allowSessionImport) {
          task.importedSession = { ok: false, reason: 'accelerated-new-session' }
          audit(AUDIT.FORK_CREATED + '-import-skipped', { taskId, reason: 'accelerated-new-session', coreMode })
          persist()
        } else if (input.importSession && typeof input.importSession === 'object') {
          const importSpec = input.importSession
          // 加速分身（sessionMode:'copy'）：旧会话只以**复制副本**进入分身 home，绝不原地读原会话。
          const copyMode = coreMode === 'accelerated'
          // 新入口：只给 sessionId（元主栏“派生”按钮）→ 由会话目录整目录复制进分身。
          if (importSpec.sessionId && !importSpec.sourceFile) {
            try {
              const imported = importSessionsInto(homeDir, [importSpec.sessionId])
              task.importedSession = imported[0] ? { ok: true, ...imported[0], copied: true, source: 'copy' } : { ok: false, reason: 'not-imported' }
              audit(AUDIT.FORK_CREATED + '-import', { taskId, ...task.importedSession })
            } catch (e) {
              task.importedSession = { ok: false, reason: 'import-failed', error: String(e?.message ?? e) }
              audit(AUDIT.FORK_CRASHED + '-import', { taskId, error: task.importedSession.error })
            }
            persist()
          } else {
            try {
              task.importedSession = importSessionIntoFork(homeDir, importSpec)
              audit(AUDIT.FORK_CREATED + '-import', { taskId, ...task.importedSession })
            } catch (e) {
              task.importedSession = { ok: false, reason: 'import-failed', error: String(e?.message ?? e) }
              audit(AUDIT.FORK_CRASHED + '-import', { taskId, error: task.importedSession.error })
            }
            persist()
          }
        }

        // v3.1.35：分身会话下限 1 —— 没有导入会话时补一个空会话，
        // 让分身 Web 打开就有可用的会话（用户规格：默认不能为 0）。
        if (coreMode === 'accelerated') {
          // 2026-11-22: accelerated core 3.5.0 cannot read catalog v3 facts; sessions copied
          // from a stock mother must be downgraded before the fork reads them.
          try {
            const sanitized = sanitizeAcceleratedForkSessions(homeDir)
            if (sanitized.changedEvents > 0) audit(AUDIT.FORK_CREATED + '-catalog-downgraded', { taskId, ...sanitized })
          } catch (error) {
            audit(AUDIT.FORK_CREATED + '-catalog-sanitize-failed', { taskId, error: String(error?.message ?? error) })
          }
        }
        try {
          const floors = await ensureForkSessionFloor({ homeDir, task, cwd: input.cwd })
          task.sessionFloor = floors
          if (floors?.created) {
            audit(AUDIT.FORK_CREATED + '-session-floor', { taskId, sessionId: floors.sessionId, workspaceKey: floors.workspaceKey })
          }
        } catch (e) {
          task.sessionFloor = { ok: false, error: String(e?.message ?? e) }
          audit(AUDIT.FORK_CREATED + '-session-floor-failed', { taskId, error: task.sessionFloor.error })
        }

        const started = await f.spawn({
          forkId: taskId,
          homeDir,
          profile,
          // 加速档只解析加速核入口；stock 母体 CLI 绝不能传入（v3.5.2 起会误判/失败）。
          ...(coreMode === 'accelerated' ? {} : { cliPath: cliPath() }),
          coreMode,
          env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: taskId, DSH_FANG_MOTHER: layout.dataDir },
        })
        if (!started || started.ok === false) {
          task.status = TASK_STATUS.FAILED
          task.lastError = started?.error ?? 'spawn-failed'
          persist()
          audit(AUDIT.FORK_CRASHED, { taskId, error: started?.error ?? 'spawn-failed', coreMode })
          bus.emit('fang/task-failed', { taskId, error: started?.error ?? 'spawn-failed' })
          return {
            ok: false,
            error: started?.error === 'accelerated-cli-missing' ? 'accelerated-cli-missing' : 'spawn-failed',
            detail: started?.error ?? 'unknown',
            ...(Array.isArray(started?.searched) ? { searched: started.searched } : {}),
            // 失败可见性：spawn 失败时把子进程退出码/信号/输出尾部带回任务接口，避免只剩 "exited"。
            ...(started && started.error !== 'accelerated-cli-missing'
              ? {
                exit: started.exit ?? null,
                signal: started.signal ?? null,
                kind: started.kind ?? null,
                log: Array.isArray(started.log) ? started.log : [],
              }
              : {}),
          }
        }
        task.status = TASK_STATUS.RUNNING
        task.pid = started.pid ?? null
        task.port = started.port ?? null
        task.url = started.url ?? null
        task.token = started.token ?? extractTokenSafe(task.url)
        persist()
        audit(AUDIT.FORK_STARTED, { taskId, pid: task.pid, port: task.port, profile })
        bus.emit('fang/task-created', { taskId, forkId: taskId, title, url: task.url, port: task.port })

        const reachable = await probeWebUrl(task.url).catch(() => ({ ok: false }))
        const adapter = await handshake(task)
        task.status = adapter.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING
        persist()
        audit(AUDIT.TASK_READY, { taskId, adapter, reachable: !!reachable.ok })

        // 商用钩子：联合开发（无 provider 时返回 not-configured，不阻塞）。
        if (task.collaborators.length && commercialHooks.collaboration) {
          await invokeCommercial({
            commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'collaboration',
            method: 'publishChange', args: [{ taskId, pluginId: '', files: [] }],
          })
        }

        return {
          ok: true,
          taskId,
          forkId: taskId,
          title,
          url: stripUrlToken(task.url),
          port: task.port,
          homeDir,
          profile,
          adapter: { ok: adapter.ok, version: adapter.version ?? '', error: adapter.error ?? '' },
          reachable: !!reachable.ok,
          seed: task.seed,
        }
      } catch (e) {
        task.status = TASK_STATUS.FAILED
        persist()
        audit(AUDIT.FORK_CRASHED, { taskId, error: String(e?.message ?? e) })
        bus.emit('fang/task-failed', { taskId, error: String(e?.message ?? e) })
        return { ok: false, error: 'create-task-threw', detail: String(e?.message ?? e) }
      }
    },

    /** v1 兼容别名：fork 就是一个任务。 */
    async fork(request = {}) {
      return service.createTask({ title: request.taskTitle ?? request.title, template: request.basePlugin })
    },

    listTasks() {
      return [...tasks.values()].map(taskView).sort((a, b) => a.createdAt - b.createdAt)
    },

    /** v3.0.6：任务重命名（archived 拒绝；1–80 字符）。 */
    renameTask(taskId, title) {
      const id = String(taskId ?? '').trim()
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status === TASK_STATUS.ARCHIVED) return { ok: false, error: 'task-archived' }
      const clean = String(title ?? '').trim()
      if (clean.length === 0 || clean.length > 80) return { ok: false, error: 'invalid-title' }
      task.title = clean
      task.updatedAt = nowMs()
      persist()
      audit(AUDIT.FORK_CREATED + '-rename', { taskId: id, title: clean })
      return { ok: true, task: taskView(task) }
    },

    /** v3.0.6：复制分身访问信息（不克隆实例；token 不返回，打开走 open-url）。 */
    copyTaskInfo(taskId) {
      const task = tasks.get(String(taskId ?? '').trim())
      if (!task) return { ok: false, error: 'unknown-task' }
      return { ok: true, taskId: task.taskId, title: task.title, url: stripUrlToken(task.url), port: task.port ?? null }
    },

    /** v3.0.6：导出分身元数据清单（完整项目/会话打包留给后续版本）。 */
    downloadTaskManifest(taskId) {
      const task = tasks.get(String(taskId ?? '').trim())
      if (!task) return { ok: false, error: 'unknown-task' }
      return {
        ok: true,
        manifest: {
          version: 1,
          taskId: task.taskId,
          title: task.title,
          createdAt: task.createdAt,
          status: taskView(task).phase,
          port: task.port ?? null,
          importedSession: task.importedSession ?? null,
          seed: task.seed ?? null,
          files: [],
          note: 'v3.0.6 metadata-only; full project/session archive is planned for v3.0.7',
        },
      }
    },

    listForks() {
      return service.listTasks()
    },

    /** 分身看护开关：持久化设置 + forker 运行时 supervise 状态。 */
    forkSupervision() {
      const persisted = readForkSupervisionSettings(layout.dataDir)
      const f = forker()
      const live = f && typeof f.getSupervision === 'function' ? f.getSupervision() : null
      return {
        ok: true,
        persisted: {
          autostartForks: persisted.autostartForks,
          supervise: persisted.supervise,
          updatedAt: persisted.updatedAt,
          exists: persisted.exists,
        },
        effective: {
          autostartForks: persisted.autostartForks,
          supervise: live ? live.enabled : persisted.supervise,
        },
        forker: live,
      }
    },

    /** 更新看护开关；supervise 会立即应用到 forker，无需重启宿主。 */
    setForkSupervision(input = {}) {
      const patch = {}
      if (typeof input?.autostartForks === 'boolean') patch.autostartForks = input.autostartForks
      if (typeof input?.supervise === 'boolean') patch.supervise = input.supervise
      if (!Object.keys(patch).length) return { ok: false, error: 'no-settings' }
      const written = writeForkSupervisionSettings(layout.dataDir, patch)
      if (!written.ok) return written
      let applied = null
      if (patch.supervise !== undefined) {
        const f = forker()
        if (f && typeof f.setSupervise === 'function') applied = f.setSupervise(patch.supervise)
      }
      try { audit(AUDIT.FORK_SUPERVISION, { ...patch, applied: applied?.enabled ?? null }) } catch { /* audit optional */ }
      return { ...service.forkSupervision(), applied }
    },

    async getTaskStatus(taskId) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      const view = taskView(task)
      const client = task.adapter?.ok ? await remoteFor(task) : null
      let adapterStatus = null
      if (client) {
        const res = await client.status()
        adapterStatus = res.ok ? res.data : { ok: false, error: res.error ?? res.kind }
      }
      return {
        ok: true,
        taskId: task.taskId,
        status: view.status,
        title: view.title,
        fork: {
          pid: view.pid, port: view.port, url: view.url, homeDir: view.homeDir,
          profile: view.profile, createdAt: view.createdAt,
        },
        adapter: view.adapter,
        adapterStatus,
      }
    },

    async getForkHealth(forkId) {
      const status = await service.getTaskStatus(forkId)
      if (status.ok === false) return status
      const probe = status.fork.url
        ? await probeWebUrl(status.fork.url).catch(() => ({ ok: false }))
        : { ok: false, reason: 'no-url' }
      return {
        ok: probe.ok,
        forkId,
        taskId: forkId,
        status: status.status,
        pid: status.fork.pid,
        port: status.fork.port,
        url: status.fork.url,
        probe,
        adapter: status.adapter,
      }
    },

    /**
     * v2 提升：从分身取回插件源码 → 母体阈值复核 → Router 初判 → 审批 → A/B → staging。
     * 与 v1 的 promote() 区别：走 Adapter 跨进程取源码与分身评分，不再假设母体能读分身磁盘。
     */
    async promoteTask(taskId, pluginId) {
      const id = String(taskId ?? '')
      const plugin = String(pluginId ?? '').trim()
      if (!id) return { ok: false, error: 'task-id-required' }
      if (!plugin) return { ok: false, error: 'plugin-id-required' }
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (!task.adapter?.ok) return { ok: false, error: 'adapter-unavailable', detail: task.adapter?.error ?? '' }

      const client = await remoteFor(task)
      if (!client) return { ok: false, error: 'remote-unavailable' }

      const read = await client.command(ADAPTER_OP.READ_PLUGIN, { pluginId: plugin })
      if (!read.ok || read.data?.ok === false) {
        return { ok: false, error: 'read-plugin-failed', detail: read.data?.error ?? read.error ?? '' }
      }
      const files = read.data?.result?.files ?? {}
      if (!Object.keys(files).length) return { ok: false, error: 'plugin-not-found', detail: plugin }

      const forkScore = await client.command(ADAPTER_OP.SCORE_PLUGIN, { pluginId: plugin })
      const forkAssessment = forkScore.ok && forkScore.data?.ok ? forkScore.data.result : null

      // Materialize the fetched source into a mother-side work dir, then re-score with
      // the MOTHER threshold policy (母体更严格，且这是真正写进生产的判定).
      const workDir = path.join(layout.dataDir, 'work', `${id}-${plugin}`)
      const discardWorkDir = () => { try { removeTree(workDir) } catch { /* best effort */ } }
      try {
        removeTree(workDir)
        ensureDir(workDir)
        for (const [rel, content] of Object.entries(files)) {
          const target = resolveInside(workDir, rel)
          if (!target) { discardWorkDir(); return { ok: false, error: 'unsafe-plugin-path', detail: rel } }
          writeFileAtomic(target, String(content))
        }
      } catch (e) {
        discardWorkDir()
        return { ok: false, error: 'materialize-failed', detail: String(e?.message ?? e) }
      }

      const scorer = safeGet(SERVICE.scorer)
      const motherAssessment = scorer?.scoreDir ? scorer.scoreDir(workDir, null, { environment: 'mother', deep: true }) : null
      if (!motherAssessment) { discardWorkDir(); return { ok: false, error: 'scorer-unavailable' } }
      if (motherAssessment.grade === 'D' || motherAssessment.grade === 'E') {
        discardWorkDir()
        return { ok: false, error: 'grade-too-low', grade: motherAssessment.grade, score: motherAssessment.S }
      }

      const router = safeGet(SERVICE.router)
      const route = router?.decide
        ? router.decide({
          plugin: { name: plugin, source: 'local-author' },
          assessment: motherAssessment,
          source: 'mother',
        })
        : null
      if (route && route.route !== 'sandbox') {
        discardWorkDir()
        return { ok: false, error: 'route-refused', route: route.route, reason: route.reason }
      }

      const approver = safeGet(SERVICE.approver)
      if (!approver) { discardWorkDir(); return { ok: false, error: 'approver-unavailable' } }

      // 团队权限钩子（无 provider 时放行并记录 basis）。
      let teamBasis = { commercial: false }
      if (commercialHooks.teams) {
        const check = await invokeCommercial({
          commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'teams',
          method: 'check', args: [{ action: 'promote', group: plugin }],
        })
        teamBasis = { commercial: true, ...(check.ok ? check.value : { allowed: true, error: check.error }) }
        if (teamBasis.allowed === false) { discardWorkDir(); return { ok: false, error: 'team-denied', basis: teamBasis } }
      }

      const decision = typeof approver.requestPromotion === 'function'
        ? await approver.requestPromotion({
          pluginId: plugin,
          taskId: id,
          detail: `来源任务 ${task.title}`,
          impact: { taskId: id, pluginId: plugin, forkGrade: forkAssessment?.grade ?? null, motherGrade: motherAssessment.grade },
        })
        : await approver.request({
          kind: 'promotion',
          risk: 'red',
          title: `提升插件 ${plugin} → 母体`,
          detail: `来源任务 ${id}（${task.title}）`,
          impact: { taskId: id, pluginId: plugin, grade: motherAssessment.grade },
        })
      const outcome = decision?.outcome ?? 'timeout'
      audit(AUDIT.APPROVAL_DECIDED, { kind: 'promotion', taskId: id, pluginId: plugin, outcome })
      if (outcome !== 'approved') { discardWorkDir(); return { ok: false, error: 'denied', outcome } }

      const target = path.join(layout.dataDir, 'promoted', plugin)
      try {
        if (exists(target)) {
          const snap = await approver.snapshot?.({ tag: plugin, dir: target })
          if (!snap || snap.ok === false) {
            discardWorkDir()
            return { ok: false, error: 'snapshot-failed', detail: String(snap?.error ?? snap?.reason ?? 'snapshot unavailable') }
          }
        }
        const commit = atomicReplaceDir(workDir, target)
        discardWorkDir()
        audit(AUDIT.PROMOTE_COMMITTED, {
          taskId: id, pluginId: plugin, target, digest: commit.digest,
          forkGrade: forkAssessment?.grade ?? null, motherGrade: motherAssessment.grade,
        })
      } catch (e) {
        discardWorkDir()
        audit(AUDIT.PROMOTE_FAILED, { taskId: id, pluginId: plugin, error: String(e?.message ?? e) })
        return { ok: false, error: 'promote-failed', detail: String(e?.message ?? e) }
      }

      // 商用钩子：云备份（不阻塞、失败只记录）。
      let backup = { ok: false, error: 'not-configured' }
      if (commercialHooks.backup) {
        backup = await invokeCommercial({
          commercialHooks, provider: safeGet(SERVICE.commercial), capability: 'backup',
          method: 'upload', args: [{ kind: 'plugin', id: plugin, key: plugin, body: files }],
        })
      }

      return {
        ok: true,
        outcome: 'approved',
        taskId: id,
        pluginId: plugin,
        target,
        forkAssessment,
        motherAssessment,
        route: route?.route ?? null,
        teamBasis,
        backup,
        note: '已写入母体 staging；重启母体后生效（重启需 restart-guard 审批）',
      }
    },

    /** v1 兼容提升：本地路径直接读分身 buffer（同机、旧流程）。 */
    async promote(forkId, pluginId) {
      const info = tasks.get(String(forkId ?? ''))
      if (!info) return { ok: false, error: 'unknown-fork' }
      if (!pluginId) return { ok: false, error: 'plugin-id-required' }
      const src = path.join(forkLayout(info).bufferDir, String(pluginId))
      if (!exists(src)) return { ok: false, error: 'not-in-fork-buffer', detail: src }

      const scorer = safeGet(SERVICE.scorer)
      const assessment = scorer?.scoreDir ? scorer.scoreDir(src, null, { environment: 'mother' }) : null
      if (assessment && (assessment.grade === 'D' || assessment.grade === 'E')) {
        return { ok: false, error: 'grade-too-low', grade: assessment.grade, score: assessment.S }
      }
      const approver = safeGet(SERVICE.approver)
      if (!approver) return { ok: false, error: 'approver-unavailable' }
      const decision = await approver.request({
        kind: 'promotion',
        risk: 'red',
        title: `提升插件 ${pluginId} → 母体`,
        detail: `来源分身 ${forkId}（${info.title}）`,
        impact: { forkId, pluginId, grade: assessment?.grade ?? 'unknown' },
      })
      if ((decision?.outcome ?? 'timeout') !== 'approved') {
        return { ok: false, error: 'denied', outcome: decision?.outcome ?? 'timeout' }
      }
      const target = path.join(layout.dataDir, 'promoted', String(pluginId))
      try {
        if (exists(target)) {
          const snap = await approver.snapshot?.({ tag: String(pluginId), dir: target })
          if (!snap || snap.ok === false) {
            return { ok: false, error: 'snapshot-failed', detail: String(snap?.error ?? snap?.reason ?? 'snapshot unavailable') }
          }
        }
        const commit = atomicReplaceDir(src, target)
        audit(AUDIT.PROMOTE_COMMITTED, { forkId, pluginId, target, digest: commit.digest })
      } catch (e) {
        return { ok: false, error: 'promote-failed', detail: String(e?.message ?? e) }
      }
      return { ok: true, outcome: 'approved', target, pluginId, assessment }
    },

    /**
     * v2.1 门户入口：派生一个任务，可选地用母体只读会话做 lineage 种子。
     * 只读会话目录（session catalog）缺失时退化为 lineage-only，不阻塞派生。
     */
    async derive(input = {}) {
      // v3.1.30：派生分身必须导入「一个」进行中会话。
      //   · 不传 sessionId      → 明确拒绝（不再静默退化成空白分身）
      //   · 传了多个 sessionIds → 拒绝（一次只能导入一个，避免来源混淆）
      // 元主 Web 自身启动不经过这里，因此「元主无对话启动」不受影响。
      const rawMulti = Array.isArray(input.sessionIds)
        ? input.sessionIds.map((id) => String(id ?? '').trim()).filter(Boolean)
        : []
      if (rawMulti.length > 1) {
        return { ok: false, error: 'session-multi-not-allowed', detail: '一次只能导入一个会话（收到 ' + rawMulti.length + ' 个）' }
      }
      const sessionId = (rawMulti[0] ?? String(input.sessionId ?? '')).trim()
      if (!sessionId) {
        return { ok: false, error: 'session-required', detail: '派生分身需要先选择一个进行中的会话（一次只能导入一个）' }
      }
      let seed = null
      let importSession = null
      {
        const catalog = safeGet(SERVICE.sessionCatalog)
        if (!catalog || typeof catalog.seed !== 'function') {
          return { ok: false, error: 'session-catalog-unavailable' }
        }
        const seeded = await catalog.seed(sessionId)
        if (!seeded || seeded.ok === false) {
          const code = seeded?.code ?? seeded?.error ?? 'unknown'
          return { ok: false, error: code === 'session-empty' ? 'session-empty' : 'session-seed-failed', detail: code }
        }
        seed = { sessionId, markdown: seeded.markdown }
        importSession = {
          sessionId,
          sourceFile: seeded.sourceFile,
          workspacePath: seeded.workspacePath,
          workspaceTitle: seeded.workspaceTitle,
          workspaceId: seeded.workspaceId,
          createdAt: seeded.createdAt,
          cwd: seeded.cwd,
          agentPreset: seeded.agentPreset,
          sourceBytes: seeded.sourceBytes,
        }
      }
      const title = String(input.title ?? '').trim()
        || (seed ? `从会话继续 · ${seed.sessionId.slice(-8)}` : `派生任务 ${tasks.size + 1}`)
      const out = await service.createTask({ title, seed, importSession, collaborators: input.collaborators })
      return { ...out, derivedFrom: seed ? { sessionId: seed.sessionId } : null, importedSession: out.importedSession ?? null }
    },

    /**
     * 分身（任务）内部的会话目录：只读该分身自己的 $DSH_HOME/sessions。
     * 用于控制面板右栏「分身项目 & 会话」；有界解帧取会话标题，未知/超限如实降级。
     */
    async listForkSessions(taskId, options = {}) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      const limit = Math.min(50, Math.max(1, Number(options.limit) || 20))
      const sessionsRoot = path.join(task.homeDir, "sessions")
      const storagesRoot = path.join(task.homeDir, "storages")
      if (!exists(sessionsRoot)) return { ok: true, taskId: task.taskId, sessions: [], degraded: ['sessions-root-missing'] }
      let index = { workspaces: [], global: { archivedSessionIds: [], pinnedSessionIds: [] }, degraded: [] }
      try {
        index = parseWorkspaceIndex(fs.readFileSync(path.join(storagesRoot, "workspace.json"), "utf8"))
      } catch (e) {
        index = { workspaces: [], global: { archivedSessionIds: [], pinnedSessionIds: [] }, degraded: [e?.code === 'ENOENT' ? 'index-not-found' : 'index-read-failed'] }
      }
      const fsApi = { statSync: fs.statSync, readdirSync: fs.readdirSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync }
      let dirs = []
      try {
        dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
          .filter((entry) => entry && typeof entry.isDirectory === "function" && entry.isDirectory())
          .map((entry) => entry.name)
      } catch { /* 空目录/权限 */ }
      const rows = scanSessionDirs({
        sessionsDir: sessionsRoot,
        workspaceIds: dirs,
        archivedSessionIds: index.global.archivedSessionIds,
        pinnedSessionIds: index.global.pinnedSessionIds,
        fsApi,
      }).slice(0, limit)
      const keyMap = new Map()
      for (const ws of index.workspaces) keyMap.set(encodeWorkspaceKey(ws.path), ws)
      const sessions = rows.map((row) => {
        const workspace = keyMap.get(row.workspaceId) ?? null
        let title = null; let titleSource = null; let preview = null
        const file = path.join(sessionsRoot, row.workspaceId, row.sessionId, "session.v4.jsonl.zstd")
        try {
          if (exists(file)) {
            const decoded = readBoundedEvents({ file, maxFrames: 32, maxCompressedBytes: 1024 * 1024, fsApi, zstdDecompressSync: zlib.zstdDecompressSync })
            const meta = extractSessionTitle(decoded.events)
            title = meta.title; titleSource = meta.titleSource; preview = meta.preview
          }
        } catch { /* 标题失败不阻塞列出会话 */ }
        return {
          sessionId: row.sessionId,
          title: title ?? (workspace ? workspace.title : "未命名会话"),
          titleSource: titleSource ?? 'workspace',
          preview,
          updatedAt: row.updatedAt,
          workspaceTitle: workspace ? workspace.title : row.workspaceId,
          archived: row.archived,
          pinned: row.pinned,
        }
      })
      return { ok: true, taskId: task.taskId, sessions, degraded: index.degraded ?? [] }
    },
    /** v2 归档：先让分身 flush + 落审计，再**停止进程但保留 home**（读档/还原/删除见 restoreTask/deleteArchived）。 */
    async archiveTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status === TASK_STATUS.ARCHIVED) {
        return { ok: true, archived: true, already: true, taskId: id, title: task.title, homeKept: true }
      }
      const summary = taskView(task)
      let remote = { ok: false, error: 'adapter-unavailable' }
      if (task.adapter?.ok) {
        const client = await remoteFor(task)
        if (client) {
          const res = await client.command(ADAPTER_OP.ARCHIVE, {})
          remote = { ok: !!(res.ok && res.data?.ok !== false), error: res.data?.error ?? res.error }
        }
      }

      // 归档 = 停止进程 + 保留 home；必须确认进程真的退了，否则把失败如实返回，
      // 不能把「列表里没了、进程还在」当成归档成功。
      const f = forker()
      if (!f || typeof f.stop !== 'function') return { ok: false, error: 'forker-unavailable', taskId: id, remote }
      try {
        const stopped = await f.stop(id)
        if (stopped && stopped.ok === false && stopped.error !== 'not-found') {
          return { ok: false, error: 'stop-failed', detail: stopped.error ?? 'stop-failed', taskId: id, remote }
        }
      } catch (e) {
        return { ok: false, error: 'stop-failed', detail: String(e?.message ?? e), taskId: id, remote }
      }
      const deadline = nowMs() + cfg.archiveStopTimeoutMs
      let alive = true
      while (nowMs() < deadline) {
        alive = typeof f.alive === 'function' ? !!f.alive(id) : !!(f.status?.(id)?.running)
        if (!alive) break
        await sleep(100)
      }
      if (alive) {
        audit(AUDIT.TASK_ARCHIVED, { taskId: id, title: task.title, ok: false, error: 'stop-failed', remote })
        return { ok: false, error: 'stop-failed', detail: 'fork process is still alive after stop', taskId: id, remote, alive: true }
      }

      task.status = TASK_STATUS.ARCHIVED
      task.archivedAt = nowMs()
      task.archiveRemote = remote
      task.pid = null
      task.port = null
      task.url = null
      task.token = ''
      task.adapter = { ok: false, error: 'archived', at: nowMs() }
      persist()
      remoteCache.delete(id)
      audit(AUDIT.TASK_ARCHIVED, { taskId: id, title: task.title, remote, stopped: true, homeKept: true })
      bus.emit('fang/task-archived', { taskId: id, title: task.title })
      return {
        ok: true,
        archived: true,
        taskId: id,
        title: task.title,
        summary,
        remote,
        stopped: true,
        homeKept: true,
      }
    },

    /** 还原存档：用原 home/profile 重新 spawn（新端口 + 新 token），再握手。 */
    /** 分身配置重置：把来源原身的 merged/profile 重新覆盖到分身 profile（保留 node_modules 与会话）。 */
    async resetForkConfig(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (!task.essenceId) return { ok: false, error: 'no-source-essence' }
      const meta = essenceManager.getMeta(task.essenceId)
      if (!meta || typeof meta.id !== 'string') return { ok: false, error: 'source-essence-missing' }
      if (meta.archived === true) return { ok: false, error: 'source-essence-archived' }
      await essenceManager.ensureFresh(task.essenceId)
      const source = essenceManager.mergedProfileDir(task.essenceId)
      const target = path.join(task.homeDir, 'profiles', task.profile)
      if (!exists(target)) return { ok: false, error: 'fork-profile-missing' }
      setProfileConfigReadonly(target, false)
      const picked = []
      for (const rel of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
        const from = path.join(source, rel)
        if (!exists(from)) continue
        fs.copyFileSync(from, path.join(target, rel))
        picked.push(rel)
      }
      const settings = path.join(source, 'settings')
      if (exists(settings)) {
        const to = path.join(target, 'settings')
        if (exists(to)) removeTree(to)
        copyTree(settings, to)
        picked.push('settings/')
      }
      // 重置后重新加回“生产盘”锁（插件安装/设置入口仍禁用），并把配置设回只读。
      const configLock = applyForkConfigLock(target)
      const profileReadonly = setProfileConfigReadonly(target, true)
      task.configSyncedAt = nowMs()
      task.configSyncedFrom = task.essenceId
      persist()
      audit('fork-config-reset', { taskId: id, essenceId: task.essenceId, files: picked, configLock, profileReadonly })
      return { ok: true, taskId: id, essenceId: task.essenceId, files: picked, configLock, profileReadonly }
    },

    /**
     * v3.1.35：分身会话护栏（原「强制单会话」）。运行中拒绝；
     * 停止/归档态把超过 FORK_SESSION_MAX(3) 的会话移到 quarantine-sessions/（不删除）。
     * 方法名保留 enforceSingleSession 以免破坏既有调用方与存档。
     */
    enforceSingleSession(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      const live = forker()?.status?.(id)
      if (live?.running) return { ok: false, error: 'task-running', taskId: id }
      return { ...applyForkSessionGuard(task), taskId: id }
    },

    async restoreTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      // 已归档任务与「启动失败/崩溃」任务都可以从保留的 home 直接复位；
      // 不再要求先归档（旧客户端曾因此把 failed 任务强制归档，见 2026-11-22 报告）。
      if (task.status !== TASK_STATUS.ARCHIVED && task.status !== TASK_STATUS.FAILED) return { ok: false, error: 'not-archived', taskId: id }
      if (!task.homeDir || !exists(task.homeDir)) {
        return { ok: false, error: 'archive-home-missing', taskId: id, homeDir: task.homeDir ?? '' }
      }
      try { assertInside(layout.forkHomesDir, task.homeDir, 'fork-home') } catch (error) {
        return { ok: false, error: 'path-escape', taskId: id, detail: String(error?.message ?? error) }
      }
      const forkProfileDir = path.join(task.homeDir, 'profiles', task.profile)
      const forkBundle = forkBundlePath(forkProfileDir)
      if (!forkBundle) {
        return { ok: false, error: 'fork-bundle-unavailable', taskId: id, detail: forkProfileDir }
      }
      const f = forker()
      if (!f || typeof f.spawn !== 'function') return { ok: false, error: 'forker-unavailable', taskId: id }
      // 从原身派生的分身：还原前先把配置重置回来源原身（分身只生产，不保留配置改动）。
      // 先捕获元主 Web 的最新插件改动，避免 reset 用旧快照覆盖。
      if (task.essenceId) captureEssenceRuntimeIfPresent(task.essenceId)
      let configReset = null
      if (task.essenceId) {
        try { configReset = await service.resetForkConfig(id) } catch (error) {
          configReset = { ok: false, error: String(error?.message ?? error) }
        }
      }
      // 还原前强制单会话（多余会话移到 quarantine，不删除），再做配置重置后的启动。
      let sessionGuard = null
      try { sessionGuard = applyForkSessionGuard(task) } catch { sessionGuard = { ok: false } }
      // 开关不是热更新：重新打开分身时按当前开关换核（重新 provision profile；会话目录不动）。
      // resetForkConfig 刚把 profile 重置回 stock 形状；即使 coreMode 未变也必须强制 reprovision，
      // 否则加速分身会以 stock 配置 + accelerated CLI 启动而永远不 ready（2026-11-22 实测 timeout）。
      const coreSync = await syncForkCoreMode(task, { force: true })
      if (coreSync.ok !== true) {
        task.status = TASK_STATUS.FAILED
        persist()
        audit(AUDIT.TASK_RESTORED, { taskId: id, ok: false, error: coreSync.error })
        return { ok: false, error: coreSync.error, detail: coreSync.detail ?? null, taskId: id }
      }
      const started = await f.spawn({
        forkId: id,
        homeDir: task.homeDir,
        profile: task.profile,
        ...(coreSync.coreMode === 'accelerated' ? {} : { cliPath: cliPath() }),
        coreMode: coreSync.coreMode,
        env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: id, DSH_FANG_MOTHER: layout.dataDir },
      })
      if (!started || started.ok === false) {
        audit(AUDIT.TASK_RESTORED, { taskId: id, ok: false, error: started?.error ?? 'spawn-failed' })
        return {
          ok: false,
          error: started?.error === 'accelerated-cli-missing' ? 'accelerated-cli-missing' : 'spawn-failed',
          detail: started?.error ?? 'unknown',
          taskId: id,
          ...(Array.isArray(started?.searched) ? { searched: started.searched } : {}),
        }
      }
      task.status = TASK_STATUS.RUNNING
      task.archivedAt = null
      task.archiveRemote = null
      task.pid = started.pid ?? null
      task.port = started.port ?? null
      task.url = started.url ?? null
      task.token = started.token ?? extractTokenSafe(task.url)
      task.adapter = { ok: false, error: 'handshaking' }
      persist()
      audit(AUDIT.FORK_STARTED, { taskId: id, pid: task.pid, port: task.port, profile: task.profile, restored: true })
      const adapter = await handshake(task)
      task.status = adapter.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING
      persist()
      audit(AUDIT.TASK_RESTORED, { taskId: id, ok: true, adapter })
      bus.emit('fang/task-restored', { taskId: id, url: task.url, port: task.port })
      return { ok: true, restored: true, taskId: id, title: task.title, url: task.url, port: task.port, adapter, configReset, sessionGuard }
    },

    /**
     * 一键修复（2026-11-22）：把「起不来」的常见原因逐项处理后再拉起，不删除 home/会话。
     * 步骤：停残留进程 → 清加速别名桩 → 按来源原身重置 profile → 归位任务状态 → restore 重新 spawn
     * （spawn 内部还会修复 node_modules mirror 并再次清理别名桩）。
     * 每一步结果都返回给 UI，失败时给出具体 step。
     */
    async repairTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (!task.homeDir || !exists(task.homeDir)) return { ok: false, error: 'archive-home-missing', taskId: id }
      if (!task.profile) return { ok: false, error: 'fork-profile-missing', taskId: id }
      const f = forker()
      if (!f || typeof f.spawn !== 'function') return { ok: false, error: 'forker-unavailable' }
      const steps = []
      // 1) 停掉可能残留的半死进程（pid 在、adapter 失联）——不清 home。
      let live = null
      try { live = f.status?.(id) ?? null } catch { live = null }
      if (live?.running === true || live?.pid) {
        try {
          f.stop?.(id)
          steps.push({ step: 'stop-stale', ok: true })
        } catch (error) {
          steps.push({ step: 'stop-stale', ok: false, error: String(error?.message ?? error) })
        }
      } else {
        steps.push({ step: 'stop-stale', ok: true, skipped: true })
      }
      // 2) 清 stock 下残留的加速别名桩（核心切换后它们会遮挡官方包，启动即崩）。
      const profileDir = path.join(task.homeDir, 'profiles', task.profile)
      const pruned = pruneAliasStubs(profileDir)
      steps.push({ step: 'prune-alias-stubs', ok: pruned.ok !== false, removed: pruned.removed.length })
      // 3) 有来源原身时，按源配置重置 profile（与 restore 的配置归位一致；无源则跳过）。
      if (task.essenceId) {
        let configReset = null
        try { configReset = await service.resetForkConfig(id) } catch (error) {
          configReset = { ok: false, error: String(error?.message ?? error) }
        }
        steps.push({ step: 'reset-profile-config', ok: configReset?.ok === true, error: configReset?.error ?? null })
      } else {
        steps.push({ step: 'reset-profile-config', ok: true, skipped: true })
      }
      // 4) 归位任务状态：restoreTask 只接受 archived/failed；运行中的先置 failed。
      if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.READY || task.status === TASK_STATUS.PROVISIONING) {
        task.status = TASK_STATUS.FAILED
      }
      persist()
      // 5) 重新拉起（新端口、新 token；spawn 会做 mirror 修复 + 再次 prune）。
      const restored = await service.restoreTask(id)
      steps.push({ step: 'spawn', ok: restored?.ok === true, error: restored?.error ?? null, detail: restored?.detail ?? null })
      const ok = restored?.ok === true
      audit('task-repaired', { taskId: id, ok, steps })
      if (!ok) {
        return {
          ok: false,
          taskId: id,
          error: restored?.error ?? 'repair-failed',
          detail: restored?.detail ?? null,
          steps,
        }
      }
      return { ok: true, taskId: id, steps, url: restored.url, port: restored.port, adapter: restored.adapter }
    },

    /**
     * watchdog 启动时的恢复入口：把「已登记但进程没在跑」的非归档任务重新 spawn。
     * 不创建新任务、不动归档任务；失败的任务不重试（避免崩溃循环），只如实报告。
     * @param {{taskIds?: string[]}} [input]
     */
    async autostartForks(input = {}) {
      const f = forker()
      if (!f || typeof f.spawn !== 'function') {
        return { ok: false, error: 'forker-unavailable', started: [], failed: [], skipped: [] }
      }
      const wanted = Array.isArray(input?.taskIds) && input.taskIds.length
        ? new Set(input.taskIds.map(String))
        : null
      const report = { ok: true, started: [], failed: [], skipped: [] }
      for (const task of tasks.values()) {
        const id = task.taskId
        if (wanted && !wanted.has(id)) continue
        if (task.status === TASK_STATUS.ARCHIVED) {
          report.skipped.push({ taskId: id, reason: 'archived' })
          continue
        }
        let live = null
        try { live = f.status?.(id) ?? null } catch { live = null }
        if (live?.running === true || live?.state === 'running') {
          report.skipped.push({ taskId: id, reason: 'already-running' })
          continue
        }
        if (!task.homeDir || !exists(task.homeDir) || !task.profile) {
          report.failed.push({ taskId: id, error: 'home-missing' })
          continue
        }
        try { assertInside(layout.forkHomesDir, task.homeDir, 'fork-home') } catch {
          report.failed.push({ taskId: id, error: 'path-escape' })
          continue
        }
        const forkBundle = forkBundlePath(path.join(task.homeDir, 'profiles', task.profile))
        if (!forkBundle) {
          report.failed.push({ taskId: id, error: 'fork-bundle-unavailable' })
          continue
        }
        task.status = TASK_STATUS.PROVISIONING
        persist()
        let started
        try {
          const coreSync = await syncForkCoreMode(task)
          if (coreSync.ok !== true) {
            report.failed.push({ taskId: id, error: coreSync.error })
            audit(AUDIT.FORK_CRASHED, { taskId: id, error: coreSync.error, reason: 'autostart-core-switch' })
            continue
          }
          started = await f.spawn({
            forkId: id,
            homeDir: task.homeDir,
            profile: task.profile,
            ...(coreSync.coreMode === 'accelerated' ? {} : { cliPath: cliPath() }),
            coreMode: coreSync.coreMode,
            env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: id, DSH_FANG_MOTHER: layout.dataDir },
          })
        } catch (error) {
          started = { ok: false, error: String(error?.message ?? error) }
        }
        if (!started || started.ok === false) {
          task.status = TASK_STATUS.FAILED
          persist()
          audit(AUDIT.FORK_CRASHED, { taskId: id, error: started?.error ?? 'spawn-failed', reason: 'autostart' })
          report.failed.push({ taskId: id, error: started?.error ?? 'spawn-failed' })
          continue
        }
        task.status = TASK_STATUS.RUNNING
        task.pid = started.pid ?? null
        task.port = started.port ?? null
        task.url = started.url ?? null
        task.token = started.token ?? extractTokenSafe(task.url)
        task.adapter = { ok: false, error: 'handshaking' }
        persist()
        audit(AUDIT.FORK_STARTED, { taskId: id, pid: task.pid, port: task.port, profile: task.profile, reason: 'autostart' })
        bus.emit('fang/fork-started', { taskId: id, forkId: id, pid: task.pid, port: task.port })
        report.started.push({ taskId: id, pid: task.pid, port: task.port })
        // 握手放到后台：watchdog 的启动请求不应该被 N 个分身的启动时间串行阻塞。
        void handshake(task).then((adapter) => {
          if (!adapter?.ok) return
          const current = tasks.get(id)
          if (!current || current.pid !== task.pid) return
          current.status = TASK_STATUS.READY
          current.adapter = adapter
          persist()
        }).catch(() => {})
      }
      return report
    },

    /** 永久删除存档：reap（杀进程 + 删 home + 删记录）；forker 记录已丢时按 home 兜底清理。 */
    async deleteArchivedTask(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status !== TASK_STATUS.ARCHIVED) return { ok: false, error: 'not-archived', taskId: id }
      const f = forker()
      let reaped = { ok: true }
      try {
        if (f && typeof f.reap === 'function') reaped = await f.reap(id)
      } catch (e) {
        reaped = { ok: false, error: String(e?.message ?? e) }
      }
      if (reaped && reaped.ok === false && reaped.error !== 'not-found') {
        return { ok: false, error: 'reap-failed', detail: reaped.error, taskId: id }
      }
      // forker 记录不存在（宿主重启/旧归档）时，仍清理 task.homeDir（限定在 forks 根内）。
      if (reaped?.error === 'not-found' && task.homeDir) {
        const root = path.resolve(layout.forkHomesDir) + path.sep
        const target = path.resolve(task.homeDir)
        if (target.startsWith(root) && exists(target)) {
          try { removeTree(target) } catch (e) { return { ok: false, error: 'remove-failed', detail: String(e?.message ?? e), taskId: id } }
        }
      }
      tasks.delete(id)
      remoteCache.delete(id)
      persist()
      audit(AUDIT.FORK_REAPED, { taskId: id, title: task.title, archivedDelete: true })
      bus.emit('fang/fork-reaped', { forkId: id })
      return { ok: true, deleted: true, taskId: id, title: task.title }
    },

    async reap(taskId) {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-fork' }
      const f = forker()
      let reaped = { ok: true }
      try {
        reaped = f && typeof f.reap === 'function' ? await f.reap(task.taskId) : { ok: true }
      } catch (e) {
        reaped = { ok: false, error: String(e?.message ?? e) }
      }
      if (reaped && reaped.ok === false) {
        task.status = TASK_STATUS.FAILED
        persist()
        return { ok: false, error: 'reap-failed', detail: reaped.error }
      }
      tasks.delete(task.taskId)
      remoteCache.delete(task.taskId)
      persist()
      audit(AUDIT.FORK_REAPED, { taskId: task.taskId })
      bus.emit('fang/fork-reaped', { forkId: task.taskId })
      return { ok: true, forkId: task.taskId, removed: reaped?.removed ?? true }
    },

    status() {
      const list = [...tasks.values()].map(taskView)
      const ready = list.filter(t => t.status === TASK_STATUS.READY).length
      const running = list.filter(t => t.status === TASK_STATUS.RUNNING).length
      return {
        version: FANG_VERSION,
        role,
        profileTag: layout.profileTag,
        dataDir: layout.dataDir,
        // 三区路径（无需 D: 访问即可在面板/接口核对目录是否已迁移）
        layout: {
          fangHome: layout.fangHome || '',
          dataDir: layout.dataDir,
          essenceRoot: layout.essenceRoot,
          forkHomesDir: layout.forkHomesDir,
          runtimeRoot: layout.runtimeRoot,
          sessionsRoot: layout.sessionsRoot || '',
        },
        mother: { profile: motherProfile, cliPath: cliPath(), template: templateDir() },
        essenceAutoRefresh: lastAutoRefresh,
        tasks: { total: list.length, ready, running, max: cfg.maxForks, list },
        // v1 兼容视图：Client 徽标与旧调用方仍读 forks.*
        forks: { total: list.length, running: ready + running, max: cfg.maxForks, list },
        audit: (() => {
          const health = auditHealth()
          return {
            checkedAt: bootState.at,
            ok: bootState.ok === true && health.ok !== false,
            findings: bootState.findings,
            // R15 健康面：链完整性/追加失败次数/最后失败时间；UI 与运维据此发现“静默丢失”。
            health,
            failures: health.processFailures,
            lastError: health.processLastError,
          }
        })(),
        commercial: { ...commercialHooks },
        services: {
          forker: !!safeGet(SERVICE.forker),
          scorer: !!safeGet(SERVICE.scorer),
          healer: !!safeGet(SERVICE.healer),
          approver: !!safeGet(SERVICE.approver),
          hotReloader: !!safeGet(SERVICE.hotReloader),
          restart: !!safeGet(SERVICE.restart),
          buffer: !!safeGet(SERVICE.buffer),
          auditor: !!safeGet(SERVICE.auditor),
          router: !!safeGet(SERVICE.router),
          adapter: !!safeGet(SERVICE.adapter),
          commercial: !!safeGet(SERVICE.commercial),
          sessionCatalog: !!safeGet(SERVICE.sessionCatalog),
          decisionCenter: !!safeGet(SERVICE.decisionCenter),
          queueJournal: queueJournalEnabled(),
        },
        // 重启守卫摘要（只读）：Client Header 用它显示 mode/红灯策略；无守卫时 available:false。
        restart: restartSummary(restartView()),
      }
    },

    /** v3.3.8：手动/启动后检测默认元主是否落后，旧则自动 capture 并 setDefault。 */
    refreshDefaultEssence: () => refreshStaleDefaultEssenceIfNeeded(),

    /** 母体重启的唯一入口：转交 restart-guard，自身永不直接退出进程。 */
    async requestMotherRestart(reason = 'manual', options = {}) {
      // v3.3.6: human restart requires two explicit confirmations:
      //   1) forkChecked — user has checked the impact in a fork;
      //   2) finalConfirm — the second red confirmation click.
      // API callers that omit them are refused before touching the guard.
      const confirmation = options?.confirmation && typeof options.confirmation === 'object' ? options.confirmation : null
      if (!confirmation || confirmation.forkChecked !== true || confirmation.finalConfirm !== true) {
        return {
          ok: false,
          error: 'restart-confirmation-required',
          required: { forkChecked: true, finalConfirm: true },
          detail: '请先在分身确认影响，再进行第二次确认；缺失确认时不会创建重启请求。',
        }
      }
      const guard = safeGet(SERVICE.restart)
      if (!guard || typeof guard.request !== 'function') {
        return { ok: false, error: 'restart-guard-unavailable' }
      }
      const decision = await guard.request({
        reason: String(reason),
        risk: 'red',
        scope: 'mother',
        origin: 'fang:orchestrator',
        confirmation: {
          forkChecked: true,
          finalConfirm: true,
          at: Number(confirmation.at) || Date.now(),
          forkId: confirmation.forkId ? String(confirmation.forkId).slice(0, 200) : null,
        },
      })
      // auto-allow is a successful policy decision, not a denial.
      const allowed = decision?.outcome === 'approved' || decision?.outcome === 'auto-allow'
      return { ok: allowed, ...decision }
    },
  }

  ctx.effect(() => ctx.provide(SERVICE.orchestrator, service))
  // v3.3.8：启动后异步自愈默认元主；不阻塞 boot，不 unref 也不会阻止退出。
  {
    const timer = setTimeout(() => { void refreshStaleDefaultEssenceIfNeeded() }, 1500)
    timer.unref?.()
    ctx.effect(() => () => clearTimeout(timer))
  }

  // v3.1.15：fang-master 契约服务（dsh-Master 通过 local/http/file/legacy 四层传输调用）。
  const contractCfg = {
    enabled: true,
    token: '',
    fileDir: '',
    pathPrefix: '/fang/api/contract',
    ...(config && typeof config.contract === 'object' ? config.contract : {}),
  }
  const contractEnv = (env) => {
    const out = {}
    if (!env || typeof env !== 'object') return out
    for (const [key, value] of Object.entries(env)) {
      if (!String(key).startsWith('DSH_MASTER_')) continue
      if (typeof value === 'string') out[String(key)] = value.slice(0, 32_000)
    }
    return out
  }
  const contractService = (key, method, required = true) => {
    const found = safeGet(SERVICE[key])
    if (found && typeof found[method] === 'function') return found
    if (!required) return null
    const error = new Error(`fang service ${key}.${method} is unavailable`)
    error.code = 'fang-service-unavailable'
    throw error
  }
  // v3.1.35：contract 1.1 的回流存储。peerLabel 是对端自报标识（不参与鉴权），
  // 必须写 'dsh-fang-bundle' —— 房主按此判定「已与真实瓮城对接」。
  const relayStore = createRelayStore({
    peerLabel: 'dsh-fang-bundle',
    role: gate.role,
    instanceId: `fang-${gate.role}-${process.pid}`,
    // M5 回流批次约定（房主合同口径：maxBatch=32、maxPayloadBytes=512000）。
    // vendored contract 1.2.0 库默认 maxBatch=128；运行时在此按 M5 约定收敛，不改 vendor 实现。
    limits: { maxBatch: 32, maxPayloadBytes: 512000 },
  })
  const delegationCfg = normalizeDelegationConfig(cfg.contract?.delegate ?? {})
  const delegationGate = createDelegationGate({ maxConcurrent: delegationCfg.maxConcurrent })
  const proCfg = normalizeProConfig(cfg.contract?.delegate?.pro ?? {})
  const proGate = createDelegationGate({ maxConcurrent: proCfg.maxConcurrent })
  const proApprovals = createProApprovalStore()

  // B-6 路线 A：母体 LSP 能力缝（ctx.lsp）。未安装官方 LSP 栈时显式不可用，不假装成功。
  const lspService = (() => { try { return typeof ctx.get === 'function' ? ctx.get('lsp') : null } catch { return null } })()
  const lspCfg = {
    allowedRoots: Array.isArray(cfg.contract?.delegate?.lsp?.allowedRoots) ? cfg.contract.delegate.lsp.allowedRoots.map((root) => String(root)) : [],
    includeForkWorktrees: cfg.contract?.delegate?.lsp?.includeForkWorktrees !== false,
    maxLocations: Number.isInteger(cfg.contract?.delegate?.lsp?.maxLocations) ? cfg.contract.delegate.lsp.maxLocations : 200,
    maxResultChars: Number.isInteger(cfg.contract?.delegate?.lsp?.maxResultChars) ? cfg.contract.delegate.lsp.maxResultChars : 20000,
  }
  /** 显式登记：母体配置根 + 所有 fork 任务工作区根（任务 registry 即登记来源）。 */
  const resolveLspRootsForTask = () => {
    let forkRoots = []
    try {
      const registryFile = exists(layout.tasksFile) ? layout.tasksFile : layout.forksFile
      const homes = loadRegistry(registryFile).map((task) => task?.homeDir).filter(Boolean)
      forkRoots = collectForkWorkspaceRoots(homes)
    } catch { /* registry unavailable → configured roots only */ }
    return resolveLspAllowedRoots({ configuredRoots: lspCfg.allowedRoots, forkRoots, includeForkWorktrees: lspCfg.includeForkWorktrees })
  }
  const lspHooksEnabled = process.env.FANG_CONTRACT_TEST_HOOKS === '1'
  /**
   * 路线 B（fork-local）就绪信息：只读探测加速核是否含同版本 LSP trio。
   * 语义：fork-local 的 LSP 跑在分身自己的 workspace/worktree，不经过契约委托；
   * 这里只用于能力目录显式区分 provider: 'mother' | 'fork-local'，不改变执行路径。
   */
  const forkLspInfo = (() => {
    try {
      const accelHome = String(layout?.fangHome ?? '').trim()
        || (layout?.dataDir ? path.resolve(layout.dataDir, '..') : '')
      const resolved = resolveAcceleratedCore({ cliPath: cfg.acceleratedCliPath ?? '', env: process.env, fangHome: accelHome })
      if (resolved?.ok !== true || !resolved.cliPath) return { available: false, error: 'accelerated-cli-missing' }
      const info = detectForkLspSupport(accelNodeModulesRoot(resolved.cliPath))
      return { ...info, cliPath: resolved.cliPath }
    } catch (error) {
      return { available: false, error: String(error?.message ?? error) }
    }
  })()
  const lspProviderInfo = describeLspProvider({
    lspService,
    hooksEnabled: lspHooksEnabled,
    forkLocal: Boolean(forkLspInfo?.available),
    forkLspInfo,
    supportedActions: advertisedActionsFromSeam(lspService),
  })
  const delegateUnavailable = (message, code = DELEGATE_ERROR.UNAVAILABLE) => { const error = new Error(message); error.code = code; throw error }
  const contractServer = createContractServer({
    role: gate.role,
    instanceId: `fang-${gate.role}-${process.pid}`,
    handlers: {
      // v3.1.35：fang.relay.publish / fang.relay.status（按注册表自动进 hello().methods）
      ...relayHandlers(relayStore),
      [CONTRACT_METHODS.FORK_SPAWN]: async (params) => {
        const forker = contractService('forker', 'spawn')
        const input = params && typeof params === 'object' ? params : {}
        const coreMode = normalizeCoreMode(input.coreMode ?? forkCoreSettings().mode)
        const { cliPath: requestedCliPath, ...rest } = input
        return await forker.spawn({
          ...rest,
          ...(coreMode === 'accelerated' ? {} : { cliPath: String(requestedCliPath ?? '') }),
          coreMode,
          env: contractEnv(input.env),
        })
      },
      [CONTRACT_METHODS.FORK_STOP]: async (params) => {
        const forker = contractService('forker', 'stop', false)
        if (!forker) { const error = new Error('fang forker stop is unavailable'); error.code = 'fang-service-unavailable'; throw error }
        return await forker.stop(String(params?.forkId ?? params?.taskId ?? ''))
      },
      [CONTRACT_METHODS.FORK_LIST]: async () => {
        const forker = contractService('forker', 'list', false)
        if (forker) return await forker.list()
        return service.listForks()
      },
      [CONTRACT_METHODS.DECISION_CREATE]: async (params) => await contractService('decisionCenter', 'create').create(params ?? {}),
      [CONTRACT_METHODS.DECISION_RESOLVE]: async (params) => await contractService('decisionCenter', 'resolve').resolve(params?.id, params?.option, { by: params?.by ?? 'dsh-master-contract', note: params?.note, custom: params?.custom }),
      [CONTRACT_METHODS.SESSION_LIST]: async (params) => {
        const catalog = contractService('sessionCatalog', 'list', false)
        if (catalog) return await catalog.list(params ?? {})
        return delegateUnavailable('fang session catalog is unavailable', 'fang-service-unavailable')
      },
      [CONTRACT_METHODS.ORCHESTRATOR_STATUS]: async () => service.status(),
      // ── B 委托：只读能力（白名单在 invoke 路由统一校验；这里只做能力实现）──
      [CONTRACT_METHODS.CAPABILITY_LIST]: async () => ({
        enabled: true,
        contractVersion: CONTRACT_VERSION,
        capabilities: capabilityCatalog(delegationCfg.allow).map((item) => (
          item.method === 'fang.tool.invoke'
            ? { ...item, actions: [...lspProviderInfo.actions], provider: lspProviderInfo }
            : item
        )),
        lspProvider: lspProviderInfo,
        allow: delegationCfg.allow,
        limits: { maxPayloadBytes: delegationCfg.maxPayloadBytes, readTimeoutMs: delegationCfg.readTimeoutMs, writeTimeoutMs: delegationCfg.writeTimeoutMs },
      }),
      'fang.session.events': async (params) => {
        const catalog = contractService('sessionCatalog', 'readHead', false)
        if (!catalog) return delegateUnavailable('fang session catalog is unavailable', 'fang-service-unavailable')
        const sessionId = String(params?.sessionId ?? '').trim()
        if (!sessionId) {
          const error = new Error('sessionId is required')
          error.code = DELEGATE_ERROR.INVALID
          throw error
        }
        const limit = Math.min(200, Math.max(1, Number(params?.limit) || 50))
        const maxChars = Math.min(256 * 1024, Math.max(0, Number(params?.maxChars) || 64 * 1024))
        const head = await catalog.readHead(sessionId, { maxLines: limit, maxChars })
        if (!head || head.ok === false) return head ?? delegateUnavailable('session read failed', 'fang-service-unavailable')
        return {
          sessionId: head.sessionId ?? sessionId,
          events: (Array.isArray(head.lines) ? head.lines : []).slice(0, limit).map((line, index) => ({ index, line })),
          redactions: head.redactions ?? 0,
          bytesRead: head.bytesRead ?? 0,
          degraded: Array.isArray(head.degraded) ? head.degraded : [],
        }
      },
      // B-6：LSP 工具委托。官方能力缝只读（definition/references/implementation/hover）；
      // 路线 A 优先用母体 ctx.lsp；路线 B（fork-local）作为增强，同一契约按 provider 区分。
      'fang.tool.invoke': async (params) => {
        const validated = validateToolInvoke(params)
        if (validated.ok !== true) {
          const error = new Error(validated.message)
          error.code = validated.error ?? DELEGATE_ERROR.INVALID
          throw error
        }
        if (validated.kind === 'write') {
          const error = new Error('lsp write actions require fang approval; no side effect performed')
          error.code = DELEGATE_ERROR.APPROVAL_REQUIRED
          error.detail = { tool: 'lsp', action: validated.action, approval: 'required' }
          throw error
        }
        if (validated.kind === 'test-only') {
          // diagnostics 仅 e2e 测试缝可用：不进入能力目录、真实 provider 下不可用。
          if (!lspService && lspHooksEnabled) {
            return {
              tool: 'lsp',
              action: validated.action,
              file: validated.file,
              line: validated.line,
              character: validated.character,
              ok: true,
              provider: LSP_PROVIDER_TEST,
              testSeam: true,
              nonProduction: true,
              diagnostics: [{ file: validated.file, line: validated.line, character: validated.character, severity: 'info', message: 'stub diagnostics (test hook only, non-production)' }],
            }
          }
          const error = new Error(`lsp action '${validated.action}' is test-seam only and not provided by the official LSP seam`)
          error.code = DELEGATE_ERROR.UNSUPPORTED
          error.detail = { tool: 'lsp', action: validated.action, reason: 'test-seam-only' }
          throw error
        }
        if (lspService) {
          // 母体委托最小正确路径（E7）：直接走官方能力缝 ctx.get('lsp').query({operation,filePath,position,workspaceRoot})；
          // 不需要 Agent Session（E10 只约束模型工具 dsh-tool-lsp），也不经过 tools 服务。
          const startedAt = Date.now()
          const auditLsp = (outcome, error, workspaceRoot = null) => {
            try { audit('contract-delegate', lspAuditRecord({ action: validated.action, provider: 'mother', workspaceRoot, outcome, error, latencyMs: Date.now() - startedAt })) } catch { /* audit optional */ }
          }
          if (!lspProviderInfo.actions.includes(validated.action)) {
            const error = new Error(`lsp provider does not provide action '${validated.action}' (advertised: ${lspProviderInfo.actions.join(',') || 'none'})`)
            error.code = DELEGATE_ERROR.UNSUPPORTED
            error.detail = { tool: 'lsp', action: validated.action, provider: 'mother', reason: 'provider-capability-missing', advertised: lspProviderInfo.actions }
            auditLsp('rejected', DELEGATE_ERROR.UNSUPPORTED)
            throw error
          }
          const allowedRoots = resolveLspRootsForTask()
          const rootCheck = checkWorkspaceRoot({ workspaceRoot: params?.workspaceRoot, file: validated.file, allowedRoots })
          if (rootCheck.ok !== true) {
            const error = new Error(rootCheck.message)
            error.code = rootCheck.code
            error.detail = { tool: 'lsp', action: validated.action, provider: 'mother', reason: rootCheck.reason ?? 'workspace-root-denied', allowedRoots: allowedRoots.length }
            auditLsp('denied', rootCheck.code, String(params?.workspaceRoot ?? ''))
            throw error
          }
          const query = await queryMotherLsp({ lspService, invoke: validated, workspaceRoot: rootCheck.workspaceRoot, limits: { maxLocations: lspCfg.maxLocations, maxResultChars: lspCfg.maxResultChars } })
          if (query.ok !== true) {
            const error = new Error(query.message)
            error.code = query.code
            error.detail = { tool: 'lsp', action: validated.action, provider: 'mother', ...(query.detail ?? {}) }
            auditLsp('error', query.code, rootCheck.workspaceRoot)
            throw error
          }
          auditLsp('ok', null, rootCheck.workspaceRoot)
          return {
            tool: 'lsp',
            file: validated.file,
            line: validated.line,
            character: validated.character,
            workspaceRoot: rootCheck.workspaceRoot,
            ...query.result,
          }
        }
        if (lspHooksEnabled) {
          return {
            tool: 'lsp',
            action: validated.action,
            operation: validated.operation,
            file: validated.file,
            line: validated.line,
            character: validated.character,
            ok: true,
            provider: LSP_PROVIDER_TEST,
            kind: 'locations',
            locations: [],
          }
        }
        return delegateUnavailable('lsp tool provider is unavailable on mother (install dsh-lsp + dsh-lsp-stdio, or enable the fork-local provider)')
      },
      // B-7：chat.import。dryRun（默认）确定性预览；真实导入必须审批——委托层拒绝执行、零副作用。
      'fang.chat.import': async (params) => {
        const validated = validateChatImport(params)
        if (validated.ok !== true) {
          const error = new Error(validated.message)
          error.code = validated.error ?? DELEGATE_ERROR.INVALID
          throw error
        }
        const catalog = contractService('sessionCatalog', 'getSession', false)
        let found = false
        let reason = null
        if (catalog && typeof catalog.getSession === 'function') {
          const result = catalog.getSession(validated.sessionId)
          found = result?.ok === true
          reason = found ? null : (result?.code ?? result?.error ?? 'session-not-found')
        } else {
          reason = 'session-catalog-unavailable'
        }
        const preview = buildChatImportDryRun({ source: validated.source, sessionId: validated.sessionId, found, reason })
        if (validated.dryRun === true) return preview
        const error = new Error('chat import requires fang approval; no side effect performed')
        error.code = DELEGATE_ERROR.APPROVAL_REQUIRED
        error.detail = { source: validated.source, sessionId: validated.sessionId, approval: 'required', dryRun: preview }
        throw error
      },
      // e2e 专用测试缝（仅 FANG_CONTRACT_TEST_HOOKS=1 时注册；生产不出现；且必须 delegate=true）
      ...(process.env.FANG_CONTRACT_TEST_HOOKS === '1' ? {
        'fang.test.sleep': async (params, envelope) => {
          if (envelope?.meta?.delegate !== true) {
            const error = new Error('test hook requires delegated invocation')
            error.code = DELEGATE_ERROR.UNSUPPORTED
            throw error
          }
          const ms = Math.min(10000, Math.max(0, Number(params?.ms) || 100))
          await sleep(ms)
          return { sleptMs: ms }
        },
      } : {}),
      [CONTRACT_METHODS.DECISION_LIST]: async (params) => {
        const center = contractService('decisionCenter', 'snapshot', false)
        if (!center || typeof center.snapshot !== 'function') return delegateUnavailable('fang decision center is unavailable')
        const snapshot = center.snapshot()
        const items = Array.isArray(snapshot?.tickets) ? snapshot.tickets : (Array.isArray(snapshot?.items) ? snapshot.items : [])
        const limit = Math.min(50, Math.max(1, Number(params?.limit) || 20))
        return { items: items.slice(0, limit).map((t) => ({ id: t.id, level: t.level, status: t.status, title: t.title, priority: t.priority ?? null, risk: t.risk ?? null, at: t.createdAt ?? t.at ?? null })), total: items.length }
      },
      [CONTRACT_METHODS.APPROVALS_LIST]: async (params) => {
        const approver = contractService('approver', 'pending', false)
        if (!approver) return delegateUnavailable('fang approver is unavailable')
        const pending = typeof approver.pending === 'function' ? approver.pending() : []
        const limit = Math.min(50, Math.max(1, Number(params?.limit) || 20))
        return { items: (Array.isArray(pending) ? pending : []).slice(0, limit).map((a) => ({ id: a.id, kind: a.kind, risk: a.risk, state: a.state, title: a.title, at: a.createdAt ?? a.at ?? null })) }
      },
    },
  })
  try { ctx.effect(() => ctx.provide(SERVICE.contract, contractServer)) } catch { /* fake ctx */ }
  if (contractCfg.enabled !== false && String(contractCfg.fileDir ?? '').trim()) {
    try {
      const fileServer = startFileContractServer({ dir: String(contractCfg.fileDir), server: contractServer, logger: ctx.logger })
      ctx.effect(() => () => fileServer.stop())
    } catch (error) {
      try { ctx.logger?.warn?.(`[fang-contract] file fallback disabled: ${String(error?.message ?? error)}`) } catch { /* ignore */ }
    }
  }

  // 启动时把持久化的 supervise 开关应用到已经挂载的 forker（插件顺序可能晚于本插件）。
  ctx.inject([SERVICE.forker], (child) => {
    try {
      const f = child?.get?.(SERVICE.forker) ?? child?.[SERVICE.forker] ?? child?.forker ?? null
      const stored = readForkSupervisionSettings(layout.dataDir)
      if (f && typeof f.setSupervise === 'function' && stored.supervise === true) f.setSupervise(true)
    } catch { /* forker optional */ }
  })

  // ── v2.9.0 母体连接：只描述 + 只读探测，不持有连接状态 ──────────────────
  const linkProfileDir = () => {
    try {
      const dir = resolveProfileDir?.()
      return typeof dir === 'string' ? dir : ''
    } catch {
      return ''
    }
  }
  const linkService = {
    /** 母体连接描述：前缀/门户/接入说明/共享配置摘要（不包含任何 token）。 */
    describe: () => describeMotherLink({
      role: 'mother',
      version: FANG_VERSION,
      prefix: cfg.routes?.prefix ?? '/fang',
      sharedConfig: readSharedProfileSummary({ profileDir: linkProfileDir() }),
    }),
    /** 只读探测一个 http(s) 母体地址的 /api/status；失败以结构化错误返回。 */
    probe: (input = {}) => probeLink({
      target: input?.target,
      prefix: cfg.routes?.prefix ?? '/fang',
      timeoutMs: input?.timeoutMs,
    }),
  }
  ctx.effect(() => ctx.provide(SERVICE.link, linkService))

  // ── v2.11.0 母体镜像：备份 / 恢复 / 升级 / 自动备份（只管理文件夹 1）──────
  const mirrorRoot = cfg.mirrorRoot ? String(cfg.mirrorRoot) : path.join(layout.dataDir, 'mirror')
  // v3.0.3：客户端升级后的兼容性门禁（模块导入 + 路由契约；失败保持子插件关闭）
  const compatRoot = fileURLToPath(new URL('../../', import.meta.url))
  let compatWebServer = null
  const rawConfig = config && typeof config === 'object' ? config : {}
  const runCompatCheck = async () => {
    if (typeof rawConfig.compatGate === 'function') {
      // 测试/嵌入注入点：不改变生产默认（bundle 配置无法携带函数）。
      const injected = await rawConfig.compatGate()
      writeCompatStatus(layout.dataDir, injected)
      return injected
    }
    const status = await runCompatGate({
      rootDir: compatRoot,
      expectedRouteCount: DEFAULT_EXPECTED_ROUTE_COUNT,
      routePaths: compatWebServer !== null && typeof compatWebServer.paths === 'function'
        ? compatWebServer.paths()
        : null,
    })
    writeCompatStatus(layout.dataDir, status)
    return status
  }
  let upgradeCoordinator = null
  // 官方源：rawConfig.officialSource 优先（测试/嵌入可注入对象）；否则按 URL 构建 manifest adapter。
  let officialSource = rawConfig.officialSource ?? null
  if (officialSource === null && String(cfg.officialSourceUrl ?? '').trim()) {
    try {
      officialSource = createManifestOfficialSource({
        baseUrl: cfg.officialSourceUrl,
        token: cfg.officialSourceToken,
        headers: {},
      })
    } catch (error) {
      try { ctx.logger?.warn?.(`[mirror] official source disabled: ${String(error?.message ?? error)}`) } catch { /* ignore */ }
      officialSource = null
    }
  }
  const mirrorManager = new MirrorManager({
    mirrorRoot,
    // 测试/嵌入注入点：官方源与 compat gate 都可替换；生产 bundle 可配置 manifest URL。
    officialSource,
    logger: ctx.logger ?? {},
    usageProvider: () => ({
      activeEssenceCount: 0,
      activeSessionCount: Array.isArray(service.listForks?.())
        ? service.listForks().filter(fork => fork.status === 'running').length
        : 0,
    }),
    compatGate: () => runCompatCheck(),
    onCompatResult: (compat) => { writeCompatStatus(layout.dataDir, compat) },
    postUpgradeHook: () => {
      if (upgradeCoordinator === null) return
      // 升级成功 → 元主重算；失败必须让人看见（决策中心 ticket），不吞掉。
      Promise.resolve(upgradeCoordinator.onUpgradeSuccess()).catch((error) => {
        raiseDecisionTicket({
          level: 'yellow',
          title: '升级后元主重算失败',
          context: `镜像升级成功，但元主重算失败：${String(error?.message ?? error)}`,
          options: [{ value: 'retry', label: '重试重算' }, { value: 'ignore', label: '忽略' }],
          dedupeKey: 'mirror-upgrade:recompute-failed',
          sourceName: 'MirrorUpgrade',
        })
      })
    },
  })
  mirrorManager.ensureLayout()
  const preferencesStore = new PreferencesStore({ mirrorRoot, logger: ctx.logger ?? {} })
  preferencesStore.load()
  const essenceManager = new EssenceManager({
    essencesRoot: layout.essenceRoot,
    mirrorRoot,
    logger: ctx.logger ?? {},
  })
  // v3.0.4：首次启动 seed 官方推荐原身（锁定、预装默认插件）；失败不阻塞主插件
  let officialEssence = null
  try {
    officialEssence = essenceManager.ensureOfficialEssence()
  } catch (error) {
    ctx.logger?.warn?.('[essence] official essence seed failed', { error: String(error?.message ?? error) })
  }
  upgradeCoordinator = new MirrorUpgradeCoordinator({ essence: essenceManager, logger: ctx.logger ?? {} })
  // 元主运行态的 forkId 命名（稳定、可用于 forker 记录与端口池）
  const runtimeForkId = (essenceId) => 'rt-' + String(essenceId).replace(/^essence-/, '').replace(/[^A-Za-z0-9-]/g, '-')
  // v3.0.9 三区口径：运行态 home 统一在 runtimeRoot（FANG_HOME 下是 sessions/<essenceId>/home）。
  const runtimeHomeFor = (essenceId) => path.join(layout.runtimeRoot, String(essenceId), 'home')
  /**
   * 2026-11-22：元主/运行态 profile 声明了插件，但 node_modules 可能是旧快照，
   * 缺包时 DSH 会报 cannot resolve profile bundle。这里只补**缺失**的顶层包。
   */
  const syncProfileModulesFromMother = (profileDir, motherProfileDir) => {
    const copied = []
    const missing = []
    const pkg = readJson(path.join(String(profileDir ?? ''), 'package.json'), {}) ?? {}
    const names = new Set([
      ...(Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []),
      ...Object.keys(pkg?.dependencies ?? {}),
      ...Object.keys(pkg?.optionalDependencies ?? {}),
    ])
    const motherModules = path.join(String(motherProfileDir ?? ''), 'node_modules')
    for (const name of names) {
      if (typeof name !== 'string' || !name || name.startsWith('@local/')) continue
      const target = path.join(String(profileDir), 'node_modules', ...name.split('/'))
      if (exists(target)) continue
      const source = path.join(motherModules, ...name.split('/'))
      if (!exists(source)) { missing.push(name); continue }
      try {
        ensureDir(path.dirname(target))
        copyTree(source, target)
        copied.push(name)
      } catch { missing.push(name) }
    }
    return { copied, missing }
  }
  /**
   * 2026-11-22：元主 Web 里改的插件设置必须先捕获回元宝，分身下一次打开才会拿到。
   * 以前只在元主运行时停止/再次启动时捕获；运行中直接开分身会读到旧 merged 快照。
   */
  const captureEssenceRuntimeIfPresent = (essenceId) => {
    const id = String(essenceId ?? '').trim()
    if (!id) return null
    const runtimeProfileDir = path.join(runtimeHomeFor(id), 'profiles', 'essence-runtime')
    if (!exists(runtimeProfileDir)) return null
    try {
      const out = captureRuntimeProfileIntoEssence({
        essenceManager, essenceId: id, runtimeProfileDir, logger: ctx.logger,
      })
      if (out?.captured) audit('essence-runtime-captured-on-open', { essenceId: id, packageChanged: out.packageChanged === true, patchChanged: out.patchChanged ?? 0 })
      return out
    } catch (error) {
      audit('essence-runtime-capture-on-open-failed', { essenceId: id, error: String(error?.message ?? error) })
      return { ok: false, captured: false, error: String(error?.message ?? error) }
    }
  }
  // 路径守卫：任何拼接出来的目标必须落在给定根内（拒绝 .. / 绝对路径逃逸）。
  const assertInside = (root, target, label) => {
    const resolvedRoot = path.resolve(String(root))
    const resolved = path.resolve(String(target))
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`path-escape: ${label} (${resolved} not under ${resolvedRoot})`)
    }
    return resolved
  }
  // v3.0.9 会话配额：数该元主运行态隔离 home 里的会话目录（归档数不再计入——归档目录由实例自管）。
  const countEssenceSessions = (essenceId, meta) => {
    const home = path.join(runtimeHomeFor(essenceId), 'sessions')
    let used = 0
    try {
      for (const workspace of fs.readdirSync(home, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue
        const wsDir = path.join(home, workspace.name)
        for (const session of fs.readdirSync(wsDir, { withFileTypes: true })) {
          if (session.isDirectory()) used += 1
        }
      }
    } catch { used = 0 }
    const tier = String(meta?.tier ?? 'free')
    const limit = Number(VIP_QUOTAS[tier]?.maxActiveSessions) || VIP_QUOTAS.free.maxActiveSessions
    return { used, limit, over: used >= limit }
  }

  // 把母体的工作区索引按“被导入的会话”过滤后合并进隔离 home，界面上按工作区名分组而不是 key。
  const mergeWorkspaceIndexFor = (homeDir, importedSessions) => {
    try {
      const motherLayout = resolveSessionsLayout()
      const motherRaw = exists(motherLayout.workspaceFile) ? fs.readFileSync(motherLayout.workspaceFile, 'utf8') : ''
      const mother = parseWorkspaceIndex(motherRaw)
      const keys = new Set(importedSessions.map((session) => String(session.workspaceKey)))
      const ids = new Set(importedSessions.map((session) => String(session.sessionId)))
      const targetFile = path.join(homeDir, 'storages', 'workspace.json')
      const existing = exists(targetFile) ? parseWorkspaceIndex(fs.readFileSync(targetFile, 'utf8')) : { workspaces: [], global: { archivedSessionIds: [], pinnedSessionIds: [] } }
      const byPath = new Map(existing.workspaces.map((workspace) => [workspace.path, workspace]))
      for (const workspace of mother.workspaces) {
        if (!keys.has(encodeWorkspaceKey(workspace.path))) continue
        const previous = byPath.get(workspace.path)
        const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...workspace.sessionIds.filter((id) => ids.has(id))])]
        byPath.set(workspace.path, { ...workspace, sessionIds })
      }
      const workspaces = [...byPath.values()]
      const archivedSessionIds = [...new Set([
        ...(existing.global?.archivedSessionIds ?? []),
        ...mother.global.archivedSessionIds.filter((id) => ids.has(id)),
      ])]
      const pinnedSessionIds = [...new Set([
        ...(existing.global?.pinnedSessionIds ?? []),
        ...mother.global.pinnedSessionIds.filter((id) => ids.has(id)),
      ])]
      const tables = {}
      for (const workspace of workspaces) {
        tables[workspace.id] = {
          path: workspace.path, title: workspace.title, sessionIds: workspace.sessionIds,
          createdAt: workspace.createdAt, updatedAt: workspace.updatedAt,
        }
      }
      ensureDir(path.dirname(targetFile))
      writeJsonAtomic(targetFile, {
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          defaultWorkspaceId: workspaces[0]?.id ?? null,
          workspaceIds: workspaces.map((workspace) => workspace.id),
          archivedSessionIds,
          pinnedSessionIds,
        },
        tables: { workspaces: tables },
      })
      return { ok: true, workspaces: workspaces.length }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const importSessionsInto = (homeDir, sessionIds) => {
    const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id ?? '').trim()).filter(Boolean))]
    if (ids.length === 0) return []
    if (ids.length > 5) throw new Error('too-many-sessions (max 5)')
    const catalog = safeGet(SERVICE.sessionCatalog)
    if (!catalog || typeof catalog.listSessions !== 'function') throw new Error('session-catalog-unavailable')
    const listed = catalog.listSessions({ limit: 500, includeArchived: false })
    const rows = Array.isArray(listed?.sessions) ? listed.sessions : []
    const sessionsRoot = String(listed?.sessionsRoot ?? '')
    if (!sessionsRoot) throw new Error('sessions-root-missing')
    const byId = new Map(rows.map((row) => [String(row.sessionId), row]))
    const imported = []
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) throw new Error('unknown-session: ' + id)
      if (row.archived === true) throw new Error('archived-session-not-importable: ' + id)
      const workspaceKey = String(row.workspaceKey ?? '')
      if (!workspaceKey || workspaceKey.includes('..') || workspaceKey.includes('/') || workspaceKey.includes('\\')) {
        throw new Error('invalid-workspace-key: ' + workspaceKey)
      }
      const source = path.join(sessionsRoot, workspaceKey, id)
      if (!exists(source)) throw new Error('session-dir-missing: ' + id)
      const target = assertInside(homeDir, path.join(homeDir, 'sessions', workspaceKey, id), 'session-import')
      ensureDir(path.dirname(target))
      if (exists(target)) removeTree(target)
      copyTree(source, target)
      imported.push({ sessionId: id, title: row.title ?? null, workspaceKey })
    }
    // 工作区索引合并：让实例按工作区名分组，而不是显示 --E-GPT-- 这样的 key。
    const index = mergeWorkspaceIndexFor(homeDir, imported)
    if (index.ok === false) {
      try { audit('workspace-index-merge-failed', { homeDir, error: index.error }) } catch { /* ignore */ }
    }
    return imported
  }

  const mirrorService = {
    status: () => {
      const status = mirrorManager.getStatus()
      let preferences = null
      let sync = null
      try { preferences = preferencesStore.get() } catch { preferences = null }
      try { sync = readJson(path.join(mirrorRoot, 'sync-state.json'), null) } catch { sync = null }
      return { ...status, preferences, sync }
    },
    getPreferences: () => preferencesStore.get(),
    setPreferences: (patch = {}) => preferencesStore.update(patch),
    listEssences: () => {
      const defaultEssence = essenceManager.getDefault()
      // 元主是否落后于母体镜像：lastMergedFingerprint !== 当前镜像指纹。
      let mirrorFingerprint = ''
      try { mirrorFingerprint = String(essenceManager.loadMirror().fingerprint ?? '') } catch { /* mirror 不可读时全部标 stale=false */ }
      const essences = essenceManager.list().map((meta) => {
        const ui = buildEssenceActions({ locked: meta.locked === true, archived: meta.archived === true })
        const stale = mirrorFingerprint.length > 0 && meta.archived !== true
          && String(meta.lastMergedFingerprint ?? '') !== mirrorFingerprint
        const sessionQuota = countEssenceSessions(meta.id, meta)
        // 元宝卡片第二行：生成时间 + 最后一次与母体同步时间（merged/fingerprint.json）。
        let lastMergedAt = null
        try {
          const fingerprint = readJson(path.join(essenceManager.essenceRoot(meta.id), 'merged', 'fingerprint.json'), null)
          const value = Number(fingerprint?.mergedAt)
          if (Number.isFinite(value) && value > 0) lastMergedAt = value
        } catch { /* profile 尚未物化 */ }
        if (!lastMergedAt && Number(meta.updatedAt) > 0) lastMergedAt = Number(meta.updatedAt)
        return {
          ...meta,
          createdAt: Number(meta.createdAt) || null,
          lastMergedAt,
          lastSyncAt: lastMergedAt,
          locked: meta.locked === true,
          official: meta.official === true,
          archived: meta.archived === true,
          stale,
          sessions: sessionQuota,
          // 设计稿字段：quota.sessions = { used, limit, over }
          quota: { sessions: sessionQuota },
          // 运行态：面板据此把「打开」切换成「停止」。
          runtime: (() => {
            try {
              const live = forker()?.status?.(runtimeForkId(meta.id))
              return live ? { running: live.running === true, pid: live.pid ?? null, port: live.port ?? null } : { running: false, pid: null, port: null }
            } catch { return { running: false, pid: null, port: null } }
          })(),
          pluginCount: (() => { try { return essenceManager.pluginCount(meta.id) } catch { return 0 } })(),
          actions: ui.actions,
          blocks: ui.blocks,
        }
      })
      return {
        officialId: OFFICIAL_ESSENCE_ID,
        official: officialEssence,
        defaultId: defaultEssence.essenceId,
        defaultEssence,
        essences,
        mirrorFingerprint,
        staleCount: essences.filter(item => item.stale === true).length,
        capacity: { slots: 7, defaultLimit: 5, used: essences.filter(item => item.archived !== true).length },
      }
    },
    createEssence: (input = {}) => essenceManager.create({
      name: input?.name, tier: input?.tier, parentId: input?.parentId ?? null,
      defaultPatchEntries: Array.isArray(input?.defaultPatchEntries) ? input.defaultPatchEntries : undefined,
    }),
    defaultPreset: async () => {
      const entries = await listInstalledPlugins()
      const plan = planDefaultEssence(entries ?? [])
      const existingId = readDefaultEssenceId()
      const meta = existingId ? essenceManager.getMeta(existingId) : null
      return { ok: true, pluginManager: Array.isArray(entries), plan, defaultEssenceId: meta?.id ? existingId : '', exists: Boolean(meta?.id) }
    },
    ensureDefaultEssence: async ({ apply = false, force = false, mode = 'copy-local' } = {}) => {
      const existingId = readDefaultEssenceId()
      const existing = existingId ? essenceManager.getMeta(existingId) : null
      const isAutoDefault = (meta) => Boolean(meta) && meta.official !== true
        && String(meta.name ?? '').startsWith(DEFAULT_ESSENCE_NAME)
      // 用户自己选的默认元宝（非自动“默认元宝”快照）保持不动。
      if (existing?.id && !isAutoDefault(existing)) {
        return { ok: true, existed: true, created: false, official: existing.official === true, essenceId: existingId, mode }
      }
      // 2026-11-22：保底一个「开发者推荐（官方）」，不再无限新增“默认元宝”快照。
      const official = essenceManager.getMeta(OFFICIAL_ESSENCE_ID)
      if (official?.id && official.archived !== true) {
        if (apply !== true) {
          return { ok: true, dryRun: true, official: true, existed: true, created: false, essenceId: OFFICIAL_ESSENCE_ID, mode }
        }
        // 2026-11-22：官方推荐 = 固定推荐清单 + 全部已安装实验性插件默认开启；
        // 依赖/bundles 跟随当前母体（修复旧快照缺 2xray 等包的问题）。
        let repaired = null
        try {
          repaired = essenceManager.repairOfficialEssence({
            installed: (await listInstalledPlugins()) ?? [],
            motherProfileDir: templateDir(),
          })
        } catch (error) {
          repaired = { ok: false, error: String(error?.message ?? error) }
        }
        let modulesSync = { copied: [], missing: [] }
        try { modulesSync = syncProfileModulesFromMother(essenceManager.mergedProfileDir(OFFICIAL_ESSENCE_ID), templateDir()) } catch { /* best effort */ }
        essenceManager.setDefault(OFFICIAL_ESSENCE_ID)
        writeDefaultEssenceId(OFFICIAL_ESSENCE_ID)
        const archivedDuplicates = []
        for (const meta of essenceManager.list()) {
          if (!isAutoDefault(meta) || meta.archived === true) continue
          try { essenceManager.archive(meta.id, true); archivedDuplicates.push(meta.id) } catch { /* best effort */ }
        }
        audit('default-essence-official', { essenceId: OFFICIAL_ESSENCE_ID, archivedDuplicates, repaired, modulesSync })
        return { ok: true, existed: true, created: false, official: true, essenceId: OFFICIAL_ESSENCE_ID, mode, archivedDuplicates, repaired, modulesSync }
      }
      const entries = await listInstalledPlugins()
      const plan = planDefaultEssence(entries ?? [])
      const userEssences = essenceManager.list().filter((meta) => meta.official !== true)
      if (!force && userEssences.length > 0) return { ok: false, error: 'user-essence-exists', plan, mode }
      if (apply !== true) return { ok: true, dryRun: true, plan, mode }
      if (mode === 'preset') {
        const patchEntries = []
        const pending = []
        for (const group of plan.groups) {
          for (const plugin of group.plugins) {
            if (!plugin.installed) { pending.push({ spec: plugin.spec, group: group.key }); continue }
            patchEntries.push({ id: plugin.pluginId || plugin.spec, name: plugin.spec, disabled: group.enabled !== true })
          }
        }
        if (patchEntries.length === 0) return { ok: false, error: 'no-installed-default-plugins', plan, pending, mode }
        const created = essenceManager.create({ name: DEFAULT_ESSENCE_NAME, tier: 'free', defaultPatchEntries: patchEntries })
        writeDefaultEssenceId(created.id)
        try {
          writeJsonAtomic(path.join(essenceManager.essenceRoot(created.id), 'default-preset.json'), {
            at: nowMs(), mode, version: plan.version, groups: plan.groups, patchEntries, pending,
          })
        } catch { /* marker 失败不影响创建 */ }
        audit('default-essence-created', { essenceId: created.id, mode, installed: patchEntries.length, pending: pending.length })
        return { ok: true, created: true, mode, essenceId: created.id, plan, pending }
      }
      // copy-local（默认）：只复制本机插件的启用/禁用 + 设置；不复制任何会话/数据/代码/凭据。
      let captured
      try {
        captured = essenceManager.captureFromProfile(templateDir(), { name: DEFAULT_ESSENCE_NAME, tier: 'free' })
      } catch (error) {
        return { ok: false, error: 'capture-failed', detail: String(error?.message ?? error), plan, mode }
      }
      const created = captured.meta ?? captured
      writeDefaultEssenceId(created.id)
      try {
        writeJsonAtomic(path.join(essenceManager.essenceRoot(created.id), 'default-preset.json'), {
          at: nowMs(), mode, source: templateDir(),
          captured: captured.captured ?? null,
          conflicts: captured.conflicts ?? [],
          note: '只复制插件启用状态与设置；未复制会话/项目/凭据/Token',
        })
      } catch { /* marker 失败不影响创建 */ }
      audit('default-essence-created', { essenceId: created.id, mode, source: templateDir() })
      return { ok: true, created: true, mode, essenceId: created.id, plan, captured: captured.captured ?? null, conflicts: captured.conflicts ?? [] }
    },
    renameEssence: (essenceId, name) => essenceManager.rename(essenceId, name),
    archiveEssence: (essenceId, archived = true) => essenceManager.archive(essenceId, archived === true),
    deleteEssence: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const meta = essenceManager.getMeta(id)
      // 删除配置/插件目录，但**保留运行态会话**：旧布局把运行时 home 放在原身目录里，先搬出去。
      const legacyHome = path.join(essenceManager.essenceRoot(id), 'runtime', 'home')
      const preserved = runtimeHomeFor(id)
      try {
        if (exists(legacyHome) && !exists(preserved)) {
          ensureDir(path.dirname(preserved))
          copyTree(legacyHome, preserved)
        }
      } catch { /* 保留失败不阻塞删除，如实返回 */ }
      const removed = essenceManager.remove(id)
      addTombstone(id, meta?.name)
      return { ...removed, essenceId: id, tombstone: true, sessionsPreserved: exists(preserved) }
    },
    copyEssence: (essenceId, name) => {
      const result = essenceManager.copy(essenceId, { name })
      // v3.0.9：沙盒会话（运行态隔离 home 里的 sessions）随副本一起复制，副本可继续开发。
      const candidates = [
        path.join(runtimeHomeFor(String(essenceId)), 'sessions'),
        path.join(essenceManager.essenceRoot(String(essenceId)), 'runtime', 'home', 'sessions'),
        path.join(layout.dataDir, 'runtime', runtimeForkId(String(essenceId)), 'home', 'sessions'),
      ]
      const source = candidates.find((dir) => exists(dir))
      let sessionsCopied = 0
      if (source) {
        const target = path.join(runtimeHomeFor(result.id), 'sessions')
        try {
          copyTree(source, target)
          const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const file = path.join(dir, entry.name)
              if (entry.isDirectory()) walk(file)
              else if (entry.isFile()) sessionsCopied += 1
            }
          }
          walk(target)
        } catch { /* 会话复制失败不阻塞配置副本，如实返回 0 */ }
        // 工作区索引也随副本走，否则副本里会话会按 workspace key 显示。
        const sourceIndex = path.join(path.dirname(path.dirname(source)), 'storages', 'workspace.json')
        if (exists(sourceIndex)) {
          const targetIndex = path.join(runtimeHomeFor(result.id), 'storages', 'workspace.json')
          try { ensureDir(path.dirname(targetIndex)); fs.copyFileSync(sourceIndex, targetIndex) } catch { /* ignore */ }
        }
      }
      return { ...result, copy: { ...(result.copy ?? {}), sessionsCopied } }
    },
    // v3.0.9 母体 → 元主：克隆母体 profile 的可写层（patch/依赖/设置），不带凭据与会话。
    captureEssence: (input = {}) => {
      const result = essenceManager.captureFromProfile(templateDir(), {
        name: input?.name,
        tier: input?.tier,
        parentId: input?.parentId ?? null,
        includeDependencies: input?.includeDependencies !== false,
        includeSettings: input?.includeSettings !== false,
      })
      const defaultEssence = input?.setDefault === true ? essenceManager.setDefault(result.meta.id) : null
      return { ...result, default: defaultEssence }
    },
    setDefaultEssence: (essenceId) => essenceManager.setDefault(essenceId),
    downloadEssence: (essenceId, options = {}) => {
      const bundle = essenceManager.downloadBundle(essenceId, { full: options?.full === true })
      if (bundle.full !== true) return bundle
      // 整包迁移还要带走运行态沙盒：会话 + 工作区索引（运行态 home 在原身文件夹之外）。
      const id = String(essenceId)
      const home = runtimeHomeFor(id)
      const addFile = (relative, file) => {
        try {
          const bytes = fs.readFileSync(file)
          bundle.files.push({ path: relative, base64: bytes.toString('base64') })
          bundle.bytes += bytes.length
        } catch { /* 读失败跳过，不阻塞导出 */ }
      }
      const indexFile = path.join(home, 'storages', 'workspace.json')
      if (exists(indexFile)) addFile('runtime/home/storages/workspace.json', indexFile)
      const sessionsDir = path.join(home, 'sessions')
      if (exists(sessionsDir)) {
        const walk = (dir, rel) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name)
            const nextRel = rel ? rel + '/' + entry.name : entry.name
            if (entry.isDirectory()) walk(fullPath, nextRel)
            else if (entry.isFile()) addFile('runtime/home/sessions/' + nextRel, fullPath)
          }
        }
        walk(sessionsDir, '')
      }
      return bundle
    },
    backupEssence: (essenceId) => essenceManager.backup(essenceId),
    restoreEssence: (essenceId) => essenceManager.restoreBackup(essenceId),
    importEssence: (input = {}) => essenceManager.importBundle(input?.bundle ?? input, {
      name: input?.name, tier: input?.tier, parentId: input?.parentId ?? null,
    }),
    // v3.1.0 元主运行态：用元主 merged/profile 起一个**隔离 home** 的配置态实例。
    // 隔离边界：DSH_HOME = sessions/<essenceId>/home（自己的 sessions/storages），
    // node_modules 也属于元主自己（D: 盘），不再 junction 到母体 C: 盘模块树；
    // 分身才复用元主/母体的 node_modules junction。
    startEssenceRuntime: async (essenceId, input = {}) => {
      const id = String(essenceId ?? '').trim()
      const meta = essenceManager.getMeta(id)
      if (!meta || typeof meta.id !== 'string') throw new Error('unknown-essence')
      if (meta.archived === true) throw new Error('essence-archived')
      // 进行中会话配额（默认 10；归档不限；达到上限拒绝再开实例）。
      const sessionQuota = countEssenceSessions(id, meta)
      if (sessionQuota.over) throw new Error(`session-quota-exceeded: ${sessionQuota.used}/${sessionQuota.limit}`)
      const f = forker()
      if (!f || typeof f.provision !== 'function' || typeof f.spawn !== 'function') throw new Error('forker-unavailable')
      const forkId = runtimeForkId(id)
      const runtimeProfileDirEarly = path.join(runtimeHomeFor(id), 'profiles', 'essence-runtime')
      // v3.1.8：上次运行态里的插件安装/更新/卸载先捕获回元宝（overlay + merged + 模块树），
      // 否则 ensureFresh/provision 会用旧的元宝配置重放，把用户的工作静默丢掉。
      let capture = null
      try {
        const runtimeStatus = f.status?.(forkId) ?? null
        if (runtimeStatus?.running !== true && exists(runtimeProfileDirEarly)) {
          capture = captureRuntimeProfileIntoEssence({
            essenceManager, essenceId: id, runtimeProfileDir: runtimeProfileDirEarly, logger: ctx.logger,
          })
        }
      } catch (error) {
        capture = { ok: false, captured: false, error: 'capture-threw', detail: String(error?.message ?? error) }
      }
      await essenceManager.ensureFresh(id)
      const merged = essenceManager.mergedProfileDir(id)
      if (!exists(merged)) throw new Error('merged-profile-missing')
      assertInside(layout.essenceRoot, merged, 'essence-merged')
      const motherModules = path.join(templateDir(), 'node_modules')
      const essenceModules = path.join(merged, 'node_modules')
      // 元主自己的 node_modules：必须是 D: 盘真实目录，不能是到母体 C: 盘的 junction。
      // 旧布局/新建元主可能缺失；首次打开时从母体复制一份，之后各自独立升级。
      if (!exists(essenceModules)) {
        try {
          if (exists(motherModules)) copyTree(motherModules, essenceModules)
          else ensureDir(essenceModules)
        } catch (error) {
          throw new Error(`essence-node-modules-copy-failed: ${String(error?.message ?? error)}`)
        }
      }
      // 旧元主的模块树是旧快照：只补它 package.json 声明但 node_modules 缺失的包
      // （2026-11-22：@twinsearth/dsh-2xray 缺失导致元主 Web 报 cannot resolve bundle）。
      const modulesSync = syncProfileModulesFromMother(merged, templateDir())
      if (modulesSync.copied.length > 0) audit('essence-modules-synced', { essenceId: id, copied: modulesSync.copied })
      // 复制来的模块树记录了母体 store；元主/运行态的 pnpm 必须显式用同一个 store，
      // 否则项目在 D: 盘、模块来自 C: store 时会报 ERR_PNPM_UNEXPECTED_STORE。
      // v3.1.8：pnpm 11 只从 pnpm-workspace.yaml 读取非鉴权设置（.npmrc 只剩鉴权/网络键），
      // 且 modules manifest 里记录的 virtual store 仍是母体路径；两处都由
      // ensureEssenceRuntimePnpmConfig 在运行态 profile 上修正（见下方 spawn 前）。
      // v3.0.9 三区：运行态 home 在 runtimeRoot 下（FANG_HOME 时是 sessions/<essenceId>/home），
      // 原身文件夹只保留配置，项目/会话/任务文件不落原身目录。
      const homeDir = runtimeHomeFor(id)
      assertInside(layout.runtimeRoot, homeDir, 'runtime-home')
      // 运行态 profile 的 node_modules 必须重新指向该元主自己的模块树。
      // makeJunction 对已存在的链接不会替换，所以先安全移除旧 junction（不进入目标）。
      const runtimeProfileDir = runtimeProfileDirEarly
      const runtimeModules = path.join(runtimeProfileDir, 'node_modules')
      // 迁移/旧版本可能留下“指向不存在 merged/profile/node_modules”的 junction；
      // fs.existsSync 对 broken junction 返回 false，必须用 lstat 才能发现并清掉。
      try {
        const stat = fs.lstatSync(runtimeModules)
        if (stat.isSymbolicLink() || !exists(runtimeModules)) removeTree(runtimeModules)
      } catch { /* 不存在 */ }
      const legacyHomes = [
        path.join(layout.dataDir, 'runtime', forkId, 'home'),
        path.join(essenceManager.essenceRoot(id), 'runtime', 'home'),
      ]
      if (!exists(homeDir)) {
        const legacyHome = legacyHomes.find((dir) => exists(dir))
        if (legacyHome) {
          try { ensureDir(path.dirname(homeDir)); copyTree(legacyHome, homeDir) } catch { /* 迁移失败不阻塞 */ }
        }
      }
      const provisioned = await f.provision({
        forkId, taskTitle: `元主运行时 · ${String(meta.name ?? id)}`,
        homeDir, profile: 'essence-runtime', profileTemplate: merged,
        // 元主运行态必须继承元主的插件/设置；clean template 只用于空白分身，
        // 否则官方/用户元主打开后看不到本机插件列表（v3.0.10 实测）。
        cleanTemplate: false,
        nodeModulesSource: essenceModules,
        // P0 硬约束：加速核只服务分身 Web；元主运行态始终原厂 core。
        coreMode: 'stock',
      })
      if (!provisioned.ok) throw new Error(String(provisioned.error ?? 'runtime-provision-failed'))
      // 历史版本把生产盘锁写进了 essence-runtime；配置实例必须能管理插件，升级后清掉。
      try { clearForkConfigLock(runtimeProfileDir) } catch { /* best effort */ }
      // v3.1.7：运行态 profile 的 node_modules 必须是 per-entry mirror（不是整树 junction）。
      // 整树 junction 会让插件 importer 落在 DSH profile 作用域之外，运行态内 w2m 等插件
      // 无法解析 @deepseek-ai/*，退回离线 shim，工具 schema 非法 → 模型请求被供应商拒绝。
      try {
        const repaired = ensureModuleMirror(runtimeModules)
        if (repaired.ok === false) throw new Error(repaired.error ?? 'unknown')
      } catch (error) {
        throw new Error(`runtime-node-modules-mirror-failed: ${String(error?.message ?? error)}`)
      }
      // 补运行态 profile 里仍缺的包（mirror 只处理已登记条目）。
      const runtimeModulesSync = syncProfileModulesFromMother(runtimeProfileDir, templateDir())
      if (runtimeModulesSync.copied.length > 0) audit('essence-runtime-modules-synced', { essenceId: id, copied: runtimeModulesSync.copied })
      // v3.1.8：让运行态内的 pnpm 真正可用（元宝「插件」页更新/卸载插件走 DSH plugin manager）。
      // 失败不阻塞实例启动（实例仍可跑会话），但要把原因带回给调用方/面板。
      let pnpmConfig = null
      try {
        pnpmConfig = ensureEssenceRuntimePnpmConfig({
          profileDir: runtimeProfileDir,
          modulesDir: runtimeModules,
          sourceModulesDir: essenceModules,
          nodeLinker: readNodeLinker(templateDir()),
        })
      } catch (error) {
        pnpmConfig = { ok: false, error: 'pnpm-config-threw', detail: String(error?.message ?? error) }
      }
      // 先导入选中的进行中会话，再拉起实例（实例启动时就能看到它们）。
      const importedSessions = importSessionsInto(homeDir, input?.sessionIds)
      // 注意：forker.spawn 需要显式 homeDir/profile（它不从 provision 记录里猜）。
      const started = await f.spawn({
        forkId,
        homeDir,
        profile: 'essence-runtime',
        cliPath: cliPath(),
        // P0 硬约束：即使 forker 默认切到 accelerated，元主运行态也只跑原厂 core。
        coreMode: 'stock',
        // v3.1.16：原身运行态同样需要母体 dataDir，房主 Router 才能零配置推导
        // 契约 file 桥（contract-outbox）；普通分身在 846/1461/1534 行已有同名注入。
        env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: forkId, DSH_FANG_ESSENCE: '1', DSH_FANG_MOTHER: layout.dataDir },
      })
      if (!started.ok) {
        // v3.1.33：把真实 errno 与启动规格带进错误信息，避免只剩一个笼统的 spawn-error。
        const detail = started.message ? ` message=${started.message}` : ''
        const spec = started.spec ? ` spec=${started.spec.command} ${(started.spec.args ?? []).join(' ')}` : ''
        const logTail = Array.isArray(started.log) && started.log.length > 0
          ? ` log=${String(started.log.slice(-3).join(' | ')).slice(0, 400)}`
          : ''
        throw new Error(
          `runtime-spawn-failed: ${started.error ?? 'unknown'} (forkId=${forkId}, homeDir=${homeDir}, profile=essence-runtime)`
          + detail + spec + logTail,
        )
      }
      return {
        ok: true, essenceId: id, forkId,
        url: started.url, port: started.port, pid: started.pid,
        sandboxHome: homeDir,
        importedSessions,
        pnpmConfig,
        capture,
      }
    },
    stopEssenceRuntime: async (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const f = forker()
      if (!f || typeof f.stop !== 'function') return { ok: false, error: 'forker-unavailable' }
      const forkId = runtimeForkId(id)
      const out = f.stop(forkId)
      // v3.1.8：停止后把运行态最后一次保存的插件配置捕获回元宝；捕获失败不改变停止结果。
      let capture = null
      try {
        const runtimeProfileDir = path.join(runtimeHomeFor(id), 'profiles', 'essence-runtime')
        capture = captureRuntimeProfileIntoEssence({
          essenceManager, essenceId: id, runtimeProfileDir, logger: ctx.logger,
        })
      } catch (error) {
        capture = { ok: false, captured: false, error: 'capture-threw', detail: String(error?.message ?? error) }
      }
      return { ok: true, essenceId: id, forkId, stopped: out?.ok !== false, capture }
    },
    essenceRuntimeStatus: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const f = forker()
      if (!f || typeof f.status !== 'function') return { ok: false, error: 'forker-unavailable' }
      const forkId = runtimeForkId(id)
      let runtime = null
      try { runtime = f.status(forkId) ?? null } catch { runtime = null }
      return { ok: true, essenceId: id, forkId, runtime }
    },
    /** 打开前可选导入的「进行中」会话（最多 50 条给选择器，提交时服务端再限 5 条）。 */
    essenceOpenCandidates: () => {
      const catalog = safeGet(SERVICE.sessionCatalog)
      if (!catalog || typeof catalog.listSessions !== 'function') return { ok: false, error: 'session-catalog-unavailable' }
      const listed = catalog.listSessions({ limit: 200, includeArchived: false })
      const sessions = (Array.isArray(listed?.sessions) ? listed.sessions : [])
        .filter((row) => row?.archived !== true)
        .slice(0, 50)
        .map((row) => ({
          sessionId: row.sessionId,
          title: row.title ?? null,
          workspaceTitle: row.workspaceTitle ?? null,
          updatedAt: row.updatedAt ?? 0,
        }))
      return { ok: true, sessions, total: sessions.length }
    },
    /** 元主详情页数据：元数据 + overlay 插件条目 + 设置项 + 备份/运行态/日志（不含凭据）。 */
    essenceDetail: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const meta = essenceManager.getMeta(id)
      if (!meta || typeof meta.id !== 'string') throw new Error('unknown-essence')
      const root = essenceManager.essenceRoot(id)
      const overlay = essenceManager.loadOverlay(root)
      const patchEntries = (overlay.patchEntries || []).map((entry) => ({
        id: String(entry?.id ?? ''),
        name: String(entry?.name ?? ''),
        disabled: entry?.disabled === true,
      }))
      const f = forker()
      let runtime = null
      let logs = ''
      try { runtime = f?.status?.(runtimeForkId(id)) ?? null } catch { runtime = null }
      try { logs = String(f?.logs?.(runtimeForkId(id), 120) || '') } catch { logs = '' }
      return {
        ok: true,
        essenceId: id,
        meta,
        overlay: { patchEntries, settings: Object.keys(overlay.settings || {}) },
        sessions: countEssenceSessions(id, meta),
        backup: exists(path.join(root, 'Backup')),
        runtime,
        logs,
      }
    },
    /** 打开运行态：返回带临时 token 的 URL（仅内存，不落盘）。 */    openEssenceRuntime: (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const f = forker()
      if (!f || typeof f.openUrl !== 'function') return { ok: false, error: 'forker-unavailable' }
      const out = f.openUrl(runtimeForkId(id))
      if (!out || out.ok === false) return { ok: false, error: out?.error ?? 'not-running' }
      return { ok: true, essenceId: id, url: out.url, port: out.port ?? null }
    },
    // v3.0.9 升级链路 2.1：把本机母体 profile（PC 客户端那份）克隆成镜像基础层。
    cloneMotherProfile: (input = {}) => {
      const sourceDir = path.resolve(String(input?.sourceDir || templateDir()))
      const packageFile = path.join(sourceDir, 'package.json')
      if (!exists(packageFile)) throw new Error('mother profile has no package.json: ' + sourceDir)
      const activeProfile = path.join(mirrorRoot, 'active', 'profile')
      const relative = path.relative(path.resolve(mirrorRoot), sourceDir)
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        throw new Error('clone: source is already inside the mirror')
      }
      let backup = null
      try { backup = mirrorManager.backup({ label: '克隆母体前自动备份' }) } catch { /* 首次克隆没有可备份内容 */ }
      if (exists(activeProfile)) removeTree(activeProfile)
      ensureDir(activeProfile)
      const picked = []
      for (const rel of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
        const from = path.join(sourceDir, rel)
        if (!exists(from)) continue
        fs.copyFileSync(from, path.join(activeProfile, rel))
        picked.push(rel)
      }
      const settingsDir = path.join(sourceDir, 'settings')
      if (exists(settingsDir)) { copyTree(settingsDir, path.join(activeProfile, 'settings')); picked.push('settings/') }
      let version = ''
      try { version = String(readJson(packageFile, {})?.version ?? '') } catch { version = '' }
      const meta = mirrorManager.readMeta()
      mirrorManager.writeMeta({
        ...meta,
        version: version || meta.version || 'unknown',
        installedAt: nowMs(),
        lastBackupAt: backup?.createdAt ?? meta.lastBackupAt,
      })
      writeJsonAtomic(path.join(mirrorRoot, 'sync-state.json'), { lastSyncAt: nowMs(), sourceDir })
      return {
        ok: true,
        sourceDir,
        target: activeProfile,
        files: picked,
        version: version || meta.version || 'unknown',
        backup: backup ? { id: backup.id, bucket: backup.bucket, createdAt: backup.createdAt } : null,
      }
    },
    /** 空白母体（初始盘）：备份当前 → 清空 active/profile → 版本标记 blank。 */
    blankMother: () => {
      const activeProfile = path.join(mirrorRoot, 'active', 'profile')
      let backup = null
      try { backup = mirrorManager.backup({ label: '空白母体前自动备份' }) } catch { /* 首次为空 */ }
      if (exists(activeProfile)) removeTree(activeProfile)
      ensureDir(activeProfile)
      const meta = mirrorManager.readMeta()
      mirrorManager.writeMeta({
        ...meta,
        version: 'blank',
        installedAt: nowMs(),
        lastBackupAt: backup?.createdAt ?? meta.lastBackupAt,
      })
      return {
        ok: true,
        version: 'blank',
        target: activeProfile,
        backup: backup ? { id: backup.id, bucket: backup.bucket, createdAt: backup.createdAt } : null,
      }
    },
    // v3.0.9 升级链路 3：母体变化后，元主按 overlay 重放到新镜像（配置不动）。
    syncEssences: async (input = {}) => {
      const essenceId = String(input?.essenceId ?? '').trim()
      if (!essenceId) {
        const out = await essenceManager.recomputeAll({ concurrency: Number(input?.concurrency) || 2 })
        // recomputeAll 返回的是 id 数组（recomputed/skipped/conflicted/failed），不是计数。
        const conflictedCount = Array.isArray(out?.conflicted) ? out.conflicted.length : (Number(out?.conflicted) || 0)
        const failedCount = Array.isArray(out?.failed) ? out.failed.length : (Number(out?.failed) || 0)
        // EssenceManager：批量重算出现冲突/失败时，必须变成人类可见的 ticket。
        if (conflictedCount > 0 || failedCount > 0) {
          const conflicts = Array.from({ length: conflictedCount }, () => ({ kind: 'recompute-conflict', severity: 'warning' }))
          await businessProducers.essenceConflict({
            essenceId: 'all', conflicts,
            severity: failedCount > 0 ? 'fatal' : 'warning',
          })
        }
        return { ok: true, mode: 'all', ...out }
      }
      const meta = essenceManager.getMeta(essenceId)
      if (meta.locked === true) return { ok: false, error: 'locked', essenceId }
      if (meta.archived === true) return { ok: false, error: 'archived', essenceId }
      const fresh = await essenceManager.ensureFresh(essenceId)
      return {
        ok: true, mode: 'one', essenceId,
        recomputed: fresh.recomputed === true,
        status: fresh.meta?.status ?? 'unknown',
      }
    },
    backup: (input = {}) => mirrorManager.backup({
      label: input?.label, bucket: input?.bucket === 'restore' ? 'restore' : 'backup',
    }),
    restore: (backupId) => mirrorManager.restore(backupId),
    deleteBackup: (backupId) => mirrorManager.deleteBackup(backupId),
    setBackupInterval: (hours) => mirrorManager.setBackupInterval(hours),
    checkUpdate: () => mirrorManager.checkUpdate(),
    recomputeStatus: () => upgradeCoordinator.getRecomputeStatus(),
    compatStatus: () => readCompatStatus(layout.dataDir),
    runCompatCheck,
    upgrade: async (input = {}) => {
      const emitStage = (stage) => {
        try { bus.emit('fang/mirror-upgrade-stage', { stage, at: Date.now() }) } catch { /* ignore */ }
        try { audit('mirror-upgrade-stage', { stage }) } catch { /* ignore */ }
      }
      try {
        const out = await mirrorManager.upgrade({
          autoBackup: input?.autoBackup !== false,
          autoRollback: input?.autoRollback !== false,
          onProgress: emitStage,
        })
        if (out?.ok === false) {
          await businessProducers.mirrorUpgradeFailed({
            from: out.from, to: out.to,
            reason: String(out?.error ?? out?.reason ?? 'unknown'),
          })
        } else if (out?.reason === 'compat-gate-failed') {
          const findings = Array.isArray(out?.compat?.findings) ? out.compat.findings.length : 0
          raiseDecisionTicket({
            level: 'yellow',
            title: '镜像升级后兼容门禁未通过',
            context: `镜像已切到 ${String(out?.to ?? '新版本')}，但 compat 门禁未通过（findings=${findings}），子插件保持关闭。`,
            options: [{ value: 'retry', label: '重试升级' }, { value: 'ignore', label: '暂不处理' }],
            dedupeKey: 'mirror-upgrade:compat-gate-failed',
            sourceName: 'MirrorUpgrade',
          })
        } else if (out?.ok === true && out?.to && out.from !== out.to && !out.reason) {
          // 升级成功：新镜像要重启宿主才完全生效 → 红色 restart ticket（动作 confirm_restart）。
          await businessProducers.mirrorUpgradeRestartRequired({ from: out.from, to: out.to })
        }
        return out
      } catch (error) {
        await businessProducers.mirrorUpgradeFailed({
          from: 'unknown', reason: String(error?.message ?? error), level: 'red',
        })
        throw error
      }
    },
  }
  ctx.effect(() => ctx.provide(SERVICE.mirror, mirrorService))

  // 特殊动作执行钩子：confirm_restart 不再只落库，交给 restart-guard 的 request
  // （它自己的审批/三重门禁/外部 supervisor 仍然生效；决策中心只负责触发）。
  try {
    const decisionCenterService = safeGet(SERVICE.decisionCenter)
    if (decisionCenterService && typeof decisionCenterService.registerActionHandler === 'function') {
      const unregisterAction = decisionCenterService.registerActionHandler('confirm_restart', async ({ ticket, payload } = {}) => {
        const restart = safeGet(SERVICE.restart)
        if (!restart || typeof restart.request !== 'function') return { ok: false, reason: 'restart-unavailable' }
        const input = payload && typeof payload === 'object' ? payload : {}
        return restart.request({
          reason: input.reason ?? `decision:${ticket?.id ?? 'unknown'}`,
          risk: input.risk ?? 'yellow',
          scope: input.scope ?? 'mother',
          origin: 'decision-center',
          digests: Array.isArray(input.digests) ? input.digests : undefined,
          forcedApproval: input.forcedApproval === true,
        })
      })
      ctx.effect(() => () => { try { unregisterAction?.() } catch { /* ignore */ } })
    }
  } catch { /* decision center optional */ }
  // 启动后自检一次；兼容状态默认 subPluginsEnabled=false，直到门禁通过
  const compatBootTimer = setTimeout(() => { void runCompatCheck() }, 1500)
  compatBootTimer.unref?.()
  ctx.effect(() => () => clearTimeout(compatBootTimer))
  const mirrorAutoTimer = setInterval(() => {
    try {
      const status = mirrorService.status()
      if (status.meta?.nextBackupAt !== null && Date.now() >= status.meta.nextBackupAt) {
        mirrorManager.maybeAutoBackup()
      }
      // 母体自动同步：按偏好 6/12/24h 从本机 profile 克隆到镜像（关闭时不跑）。
      const prefs = preferencesStore.get()
      const syncHours = Number(prefs?.syncIntervalHours)
      if (Number.isFinite(syncHours) && syncHours > 0) {
        let last = 0
        try { last = Number(readJson(path.join(mirrorRoot, 'sync-state.json'), {})?.lastSyncAt) || 0 } catch { last = 0 }
        if (Date.now() - last >= syncHours * 3_600_000) {
          try {
            mirrorService.cloneMotherProfile({})
            ctx.logger?.info?.('[mirror] auto-sync completed', { hours: syncHours })
          } catch (error) {
            ctx.logger?.warn?.('[mirror] auto-sync failed', { error: String(error?.message ?? error) })
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('[mirror] auto backup tick failed', { error: String(error?.message ?? error) })
    }
  }, 60_000)
  mirrorAutoTimer.unref?.()
  ctx.effect(() => () => clearInterval(mirrorAutoTimer))

  // ── 启动自检 ───────────────────────────────────────────────────────────
  const bootState = { at: nowMs(), ok: null, findings: [] }
  const bootAuditTimer = setTimeout(() => {
    try {
      const auditor = safeGet(SERVICE.auditor)
      const check = auditor?.bootCheck?.() ?? auditor?.bootAudit?.()
      bootState.ok = check?.ok !== false
      bootState.findings = Array.isArray(check?.findings) ? check.findings : []
      audit(AUDIT.BOOT, { ok: bootState.ok, findings: bootState.findings })
    } catch (e) {
      bootState.ok = false
      bootState.findings = [{ id: 'boot-audit-threw', level: 'error', message: String(e?.message ?? e) }]
    }
  }, 1000)
  ctx.effect(() => () => clearTimeout(bootAuditTimer))

  // ── 启动时把注册表里已经死掉的任务标成 stopped（不假装还活着）───────────────
  const refreshStale = () => {
    let changed = false
    for (const t of tasks.values()) {
      const live = forker()?.status?.(t.taskId)
      if (live && !live.running && (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.READY)) {
        t.status = TASK_STATUS.FAILED
        changed = true
      }
    }
    if (changed) persist()
  }
  const bootTimer = setTimeout(() => { try { refreshStale() } catch { /* ignore */ } }, 2000)
  ctx.effect(() => () => clearTimeout(bootTimer))

  // ── 可选：空闲自动归档 ───────────────────────────────────────────────────
  if (cfg.autoReapIdleMinutes > 0) {
    const t = setInterval(() => {
      const idleMs = cfg.autoReapIdleMinutes * 60_000
      for (const task of [...tasks.values()]) {
        if (nowMs() - (task.lastActiveAt ?? task.createdAt) > idleMs) {
          service.reap(task.taskId).catch(() => { /* best effort */ })
        }
      }
    }, 60_000)
    ctx.effect(() => () => clearInterval(t))
  }

  // v3.0.9：连接信息要的宿主服务（只有 Web 运行时才有；分身/无 Web 环境允许缺失）。
  // 必须用 ctx.inject 取——直接 child.get 在插件上下文里拿不到这两个服务。
  let connectionService = null
  let webAppService = null
  ctx.inject(['connection'], (child) => {
    try { connectionService = child.get('connection') ?? child.connection ?? null } catch { connectionService = null }
  })
  ctx.inject(['webApp'], (child) => {
    try { webAppService = child.get('webApp') ?? child.webApp ?? null } catch { webAppService = null }
  })

  // ── HTTP 门户 ──────────────────────────────────────────────────────────
  if (cfg.routes?.enabled !== false) {
    ctx.inject(['webServer'], (child) => {
      const webServer = child.get('webServer') ?? child.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      compatWebServer = webServer
      // v3.0.8：把当前宿主 origin 写到 dataDir/endpoint.json，供 Electron 面板发现，
      // 避免桌面宿主端口每次变化后必须手工设置 FANG_UPSTREAM。
      try {
        const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
        if (origin) {
          fs.mkdirSync(layout.dataDir, { recursive: true })
          fs.writeFileSync(path.join(layout.dataDir, 'endpoint.json'), JSON.stringify({ url: origin, updatedAt: new Date().toISOString() }) + '\n')
        }
      } catch { /* endpoint discovery is best-effort */ }
      const prefix = String(cfg.routes?.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'

      const json = (res, code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      }
      // v3.3.3: queue journal route gate (json is in this scope).
      const queueJournalGate = (res) => {
        if (queueJournalEnabled()) return false
        json(res, 503, { ok: false, error: 'queue-journal-disabled', detail: 'enable the fang-queue-journal sub-plugin to use composer journal/queue recovery' })
        return true
      }
      const readBody = (req) => new Promise((resolve) => {
        let raw = ''
        req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy() })
        req.on('end', () => {
          try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
        })
        req.on('error', () => resolve({}))
      })
      const route = (method, pathname, handler, routeOptions) => webServer.register({
        kind: 'exact',
        path: pathname,
        method,
        handler: async (req, res) => {
          // v3.0.5/B1：loopback Host + Origin/CSRF + 安装 token（fail-closed）。
          // Auth must run before the method check: a token-less POST is 401, not 405.
          const decision = checkRequestAuth(req, {
            token: authToken,
            publicRoute: authToken.length === 0 || routeOptions?.public === true,
            bootstrap: routeOptions?.bootstrap === true,
          })
          if (!decision.ok) return json(res, decision.status, authErrorBody(decision))
          if (req.method !== method) {
            try { res.setHeader?.('allow', method) } catch { /* fake res */ }
            return json(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
          }
          try { return await handler(req, res) } catch (e) {
            return json(res, 500, { ok: false, error: 'handler-threw', code: 'handler-threw', detail: String(e?.message ?? e) })
          }
        },
      })

      // The DSH webServer keys exact routes by path only, so GET+POST on the same
      // path cannot be two `register()` calls (the second throws and later routes
      // silently never register). One handler dispatches by method instead.
      const routeMethods = (pathname, handlers, routeOptions) => webServer.register({
        kind: 'exact',
        path: pathname,
        method: Object.keys(handlers).join(','),
        handler: async (req, res) => {
          const decision = checkRequestAuth(req, {
            token: authToken,
            publicRoute: authToken.length === 0 || routeOptions?.public === true,
            bootstrap: routeOptions?.bootstrap === true,
          })
          if (!decision.ok) return json(res, decision.status, authErrorBody(decision))
          const allow = Object.keys(handlers)
          const fn = handlers[String(req.method ?? 'GET').toUpperCase()]
          if (typeof fn !== 'function') {
            try { res.setHeader?.('allow', allow.join(', ')) } catch { /* fake res */ }
            return json(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
          }
          try { return await fn(req, res) } catch (e) {
            return json(res, 500, { ok: false, error: 'handler-threw', code: 'handler-threw', detail: String(e?.message ?? e) })
          }
        },
      })

      // ── 分支路由共用：taskId 必须是注册表里的安全 id ─────────────────────
      // 既保证 404 语义一致（tasks/status 对未知任务返回 404），也阻断把
      // `../` 之类的 taskId 带进 BranchStore.file() 的路径逃逸。
      const safeTaskId = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value ?? ''))
      const requireTask = (value) => {
        const taskId = String(value ?? '').trim()
        if (!taskId) return { ok: false, status: 400, error: 'taskId-required' }
        if (!safeTaskId(taskId) || !tasks.has(taskId)) return { ok: false, status: 404, error: 'unknown-task' }
        return { ok: true, taskId }
      }
      const branchErrorStatus = (code) => {
        switch (String(code ?? '')) {
          case 'invalid-branch-id':
          case 'invalid-status':
          case 'invalid-task-id':
            return 400
          case 'branch-missing':
          case 'parent-missing':
            return 404
          case 'branch-exists':
          case 'branch-not-active':
          case 'cannot-seal-active':
            return 409
          default:
            return 500
        }
      }

      // 浏览器面板 bootstrap：同源读取 token（Host/Origin 已校验；v3.5.5 起 bootstrap 收紧：
      // 仅回环 peer + 同源 Origin（host:port 完全一致）+ Sec-Fetch-Site same-origin/none）。
      route('GET', `${prefix}/api/auth-token`, (req, res) => {
        try {
          res.setHeader?.('cache-control', 'no-store')
          res.setHeader?.('vary', 'Origin')
        } catch { /* fake res */ }
        return json(res, 200, { ok: true, token: authToken })
      }, { public: true, bootstrap: true })

      // 母体不可删除：即使有人直接打接口也返回 403，而不是“没有这个路由”。
      // 仅 POST（allow-list 只允许 GET/POST；DELETE 语义由该 403 表达）。
      route('POST', `${prefix}/api/mother/delete`, (req, res) => json(res, 403, { ok: false, error: 'mother-immutable' }))

      // 完整连接地址（带进程 token）：Web 端「连接信息」用它，不再依赖桌面壳。
      // 桌面壳缺失时也能给出可复制的真实登录地址；拿不到 token 时如实标 tokenized:false。
      route('GET', `${prefix}/api/connection`, (req, res) => {
        const advertised = (() => { try { return String(webAppService?.getAdvertisedUrl?.() ?? '') } catch { return '' } })()
        const origin = (() => { try { return String(webServer.getOrigin?.() ?? '') } catch { return '' } })()
        const base = advertised || origin
        let url = base
        let tokenized = false
        try {
          if (base && typeof connectionService?.authenticatedUrl === 'function') {
            const next = connectionService.authenticatedUrl(base)
            if (next) { url = String(next); tokenized = url !== base }
          }
        } catch { /* 无 connection 服务时退回裸地址，不假装成功 */ }
        return json(res, 200, {
          ok: true, url, origin, advertisedUrl: advertised, tokenized, available: Boolean(url),
        })
      })

      route('GET', `${prefix}/api/status`, (req, res) => json(res, 200, service.status()))
      // v3.1.15：fang-master 契约端点（HTTP fallback；token 未配置时禁用）。
      if (contractCfg.enabled !== false) {
        const contractPath = String(contractCfg.pathPrefix || `${prefix}/api/contract`).replace(/\/+$/, '')
        const contractAuthorized = (req) => {
          const token = String(contractCfg.token ?? '')
          if (!token) return false
          const match = /^Bearer\s+(\S+)$/i.exec(String(req?.headers?.authorization ?? '').trim())
          if (!match) return false
          const a = Buffer.from(match[1], 'utf8')
          const b = Buffer.from(token, 'utf8')
          return a.length === b.length && crypto.timingSafeEqual(a, b)
        }
        route('POST', `${contractPath}/hello`, async (req, res) => {
          if (!contractCfg.token) return json(res, 503, { ok: false, code: 'contract-token-required' })
          if (!contractAuthorized(req)) return json(res, 401, { ok: false, code: 'contract-unauthorized' })
          return json(res, 200, contractServer.hello())
        })
        route('POST', `${contractPath}/invoke`, async (req, res) => {
          if (!contractCfg.token) return json(res, 503, { ok: false, code: 'contract-token-required' })
          if (!contractAuthorized(req)) return json(res, 401, { ok: false, code: 'contract-unauthorized' })
          const body = await readBody(req)
          if (!body || typeof body !== 'object') return json(res, 400, { ok: false, code: 'invalid-envelope' })
          // B 委托：调用方以 meta.delegate=true 声明「委托调用」，白名单默认拒绝；
          // 未声明 delegate 的旧调用方保持既有语义（fork.spawn/decision.* 等不回归）。
          const delegated = body?.meta?.delegate === true
          const source = String(body?.meta?.source ?? body?.meta?.instanceId ?? '').slice(0, 120)
          if (delegated) {
            // B-8 激活链（专业版，默认关闭）：① 开关 → ② 逐项 allow → ③ 每次调用审批票 →
            // ④ 审计 + 资源限额。缺一环即显式拒绝（错误码 + detail.stage/reason），不静默降级。
            if (PRO_CAPABILITIES.includes(String(body?.method ?? ''))) {
              const proGateResult = checkProGate({ method: body?.method, config: proCfg, ticketId: body?.params?.approvalTicket, source, params: body?.params })
              if (proGateResult.ok !== true) {
                try { audit('contract-delegate', proAuditRecord({ method: body?.method, source, outcome: 'rejected', stage: proGateResult.stage, error: proGateResult.code, ticketId: body?.params?.approvalTicket, limits: proCfg })) } catch { /* audit optional */ }
                return json(res, 200, createResponse({ id: body?.id, error: { code: proGateResult.code, message: proGateResult.message, detail: { stage: proGateResult.stage, digest: proGateResult.digest ?? null } } }))
              }
              if (exceedPayloadLimit(body?.params, delegationCfg.maxPayloadBytes)) {
                try { audit('contract-delegate', proAuditRecord({ method: body?.method, source, outcome: 'rejected', stage: PRO_STAGE.LIMIT_EXCEEDED, error: DELEGATE_ERROR.INVALID, ticketId: body?.params?.approvalTicket, limits: proCfg })) } catch { /* audit optional */ }
                return json(res, 200, createResponse({ id: body?.id, error: { code: DELEGATE_ERROR.INVALID, message: 'delegated payload exceeds maxPayloadBytes', detail: { stage: PRO_STAGE.LIMIT_EXCEEDED } } }))
              }
              const consumed = proApprovals.consume({ id: body?.params?.approvalTicket, capability: body?.method, source, digest: proGateResult.digest })
              if (consumed.ok !== true) {
                try { audit('contract-delegate', proAuditRecord({ method: body?.method, source, outcome: 'rejected', stage: consumed.stage ?? PRO_STAGE.APPROVAL_INVALID, error: DELEGATE_ERROR.APPROVAL_REQUIRED, ticketId: body?.params?.approvalTicket, limits: proCfg })) } catch { /* audit optional */ }
                return json(res, 200, createResponse({ id: body?.id, error: { code: DELEGATE_ERROR.APPROVAL_REQUIRED, message: `approval ticket rejected: ${consumed.reason ?? 'invalid'}`, detail: { stage: PRO_STAGE.APPROVAL_INVALID, reason: consumed.reason ?? 'invalid' } } }))
              }
              const proRun = await runProCapability({
                execute: () => providerMissingResult(body?.method),
                timeoutMs: proCfg.timeoutMs,
                maxOutputBytes: proCfg.maxOutputBytes,
                gate: proGate,
              })
              const proOutcome = proRun.code === DELEGATE_ERROR.RATE_LIMITED ? 'rate-limited' : (proRun.ok === true ? 'ok' : 'error')
              try { audit('contract-delegate', proAuditRecord({ method: body?.method, source, outcome: proOutcome, stage: proRun.stage, error: proRun.ok === true ? null : proRun.code, ticketId: body?.params?.approvalTicket, latencyMs: proRun.latencyMs, limits: proCfg })) } catch { /* audit optional */ }
              return json(res, 200, createResponse({ id: body?.id, error: { code: proRun.code, message: proRun.message, detail: { stage: proRun.stage, activation: 'verified', limits: { timeoutMs: proCfg.timeoutMs, maxConcurrent: proCfg.maxConcurrent, maxOutputBytes: proCfg.maxOutputBytes } } } }))
            }
            const decision = checkDelegation({ method: body?.method, allow: delegationCfg.allow, config: delegationCfg })
            if (decision.ok !== true) {
              try { audit('contract-delegate', delegationAuditRecord({ method: body?.method, source, outcome: 'rejected', error: decision.error, latencyMs: 0 })) } catch { /* audit optional */ }
              return json(res, 200, createResponse({ id: body?.id, error: { code: decision.error, message: decision.message ?? decision.error } }))
            }
            if (exceedPayloadLimit(body?.params, delegationCfg.maxPayloadBytes)) {
              try { audit('contract-delegate', delegationAuditRecord({ method: body?.method, source, outcome: 'rejected', error: DELEGATE_ERROR.INVALID, latencyMs: 0 })) } catch { /* audit optional */ }
              return json(res, 200, createResponse({ id: body?.id, error: { code: DELEGATE_ERROR.INVALID, message: 'delegated payload exceeds maxPayloadBytes' } }))
            }
            const slot = delegationGate.tryAcquire()
            if (slot.ok !== true) {
              try { audit('contract-delegate', delegationAuditRecord({ method: body?.method, source, outcome: 'rate-limited', error: DELEGATE_ERROR.RATE_LIMITED, latencyMs: 0 })) } catch { /* audit optional */ }
              return json(res, 200, createResponse({ id: body?.id, error: { code: DELEGATE_ERROR.RATE_LIMITED, message: `delegation concurrency limit reached (max ${delegationCfg.maxConcurrent})` } }))
            }
            try {
              // LSP 委托需要拉起/索引语言服务器，用 writeTimeoutMs 预算；其余只读能力用 readTimeoutMs。
              const budgetMs = String(body?.method ?? '') === 'fang.tool.invoke' ? delegationCfg.writeTimeoutMs : delegationCfg.readTimeoutMs
              const run = await runDelegated(() => contractServer.invoke(body), { timeoutMs: budgetMs })
              const errorCode = run.ok ? null : (run.error ?? DELEGATE_ERROR.UNAVAILABLE)
              try { audit('contract-delegate', delegationAuditRecord({ method: body?.method, source, outcome: run.ok ? 'ok' : 'error', error: errorCode, latencyMs: run.latencyMs })) } catch { /* audit optional */ }
              if (run.ok !== true) {
                return json(res, 200, createResponse({ id: body?.id, error: { code: errorCode, message: run.message ?? errorCode } }))
              }
              // 委托模式统一错误码：服务不可用 → contract-unavailable（不泄露内部 code）。
              if (run.value?.ok === false && run.value?.error?.code === 'fang-service-unavailable') {
                return json(res, 200, createResponse({ id: body?.id, error: { code: DELEGATE_ERROR.UNAVAILABLE, message: 'capability service unavailable on mother' } }))
              }
              return json(res, 200, run.value)
            } finally {
              delegationGate.release()
            }
          }
          const out = await contractServer.invoke(body)
          return json(res, 200, out)
        })
        // B-8 专业版审批票签发（每次调用一张，一次性 + TTL；签发需要母体操作者 token）。
        route('POST', `${contractPath}/pro/approval`, async (req, res) => {
          if (!contractCfg.token) return json(res, 503, { ok: false, code: 'contract-token-required' })
          if (!contractAuthorized(req)) return json(res, 401, { ok: false, code: 'contract-unauthorized' })
          const body = await readBody(req)
          if (!body || typeof body !== 'object') return json(res, 400, { ok: false, code: 'invalid-envelope' })
          const capability = String(body.capability ?? '').trim()
          if (!PRO_CAPABILITIES.includes(capability)) return json(res, 200, { ok: false, code: DELEGATE_ERROR.UNSUPPORTED, stage: 'not-pro', message: `not a pro capability: ${capability || '(empty)'}` })
          if (proCfg.enabled !== true) return json(res, 200, { ok: false, code: DELEGATE_ERROR.UNSUPPORTED, stage: PRO_STAGE.DISABLED, message: 'pro capability disabled (default off): enable contract.delegate.pro.enabled first' })
          if (!proCfg.allow.includes(capability)) return json(res, 200, { ok: false, code: DELEGATE_ERROR.UNSUPPORTED, stage: PRO_STAGE.NOT_ALLOWED, message: `pro capability not activated: add '${capability}' to contract.delegate.pro.allow` })
          // v3.5.5（R23 安全）：审批票必须绑定“这一次调用的精确参数”。调用方必须显式提供 params
          // （可为 null）；未绑定参数的票在 consume 侧会被 params-unbound 拒绝，这里提前给出可读错误。
          if (!Object.prototype.hasOwnProperty.call(body, 'params')) {
            return json(res, 400, {
              ok: false,
              code: 'approval-params-required',
              stage: 'approval-params-required',
              message: 'approval ticket must bind the exact delegated params: send "params" (may be null) representing the payload to be approved',
            })
          }
          const digest = proParamsDigest(body.params)
          const issued = proApprovals.issue({ capability, source: String(body.source ?? '').slice(0, 120), digest, ttlMs: proCfg.approvalTtlMs })
          if (issued.ok !== true) return json(res, 200, { ok: false, code: DELEGATE_ERROR.INVALID, stage: 'invalid-request', message: String(issued.reason ?? 'cannot issue approval') })
          // 审计是审批链的硬一环：账本写不进去就不签发（避免“批了但无证据”）。
          try {
            auditStrict('contract-delegate', proAuditRecord({ method: capability, source: body.source, outcome: 'approval-issued', stage: 'approval-issued', ticketId: issued.ticket.id, limits: proCfg }))
          } catch (error) {
            return json(res, 503, {
              ok: false,
              code: 'audit-unavailable',
              stage: 'audit-unavailable',
              message: `refusing to issue approval without an auditable ledger: ${String(error?.message ?? error).slice(0, 200)}`,
            })
          }
          return json(res, 200, { ok: true, approval: { id: issued.ticket.id, capability: issued.ticket.capability, source: issued.ticket.source, expiresAt: issued.ticket.expiresAt, paramsDigest: issued.ticket.digest } })
        })
        route('GET', `${contractPath}/pro/status`, (req, res) => {
          if (!contractCfg.token) return json(res, 503, { ok: false, code: 'contract-token-required' })
          if (!contractAuthorized(req)) return json(res, 401, { ok: false, code: 'contract-unauthorized' })
          return json(res, 200, {
            ok: true,
            enabled: proCfg.enabled,
            allow: [...proCfg.allow],
            pendingTickets: proApprovals.pendingCount(),
            limits: { approvalTtlMs: proCfg.approvalTtlMs, maxConcurrent: proCfg.maxConcurrent, timeoutMs: proCfg.timeoutMs, maxOutputBytes: proCfg.maxOutputBytes },
          })
        })

        route('GET', `${contractPath}/health`, (req, res) => {
          // M5 回流端点：无 Bearer 的只读健康信息（{ ok, role, version, peer, accepted } 为房主约定字段）。
          let relayStatus = null
          try { relayStatus = relayStore.status() } catch { relayStatus = null }
          return json(res, 200, {
            ok: true,
            role: gate.role,
            version: CONTRACT_VERSION,
            contractVersion: CONTRACT_VERSION,
            peer: relayStatus?.peer ?? null,
            accepted: Number(relayStatus?.accepted ?? 0),
            methods: contractServer.hello().methods,
            // v3.1.35：回流计数（排障用；只读状态，不暴露可写 store）
            relay: relayStatus ? {
              peer: relayStatus.peer ?? null, cursor: relayStatus.cursor ?? 0, accepted: relayStatus.accepted ?? 0,
              duplicates: relayStatus.duplicates ?? 0, rejected: relayStatus.rejected ?? 0, batches: relayStatus.batches ?? 0, lastAt: relayStatus.lastAt ?? null,
            } : null,
          })
        })
      }
      // 分身核心开关（P1）：加速引擎只服务分身 Web；母体/元主始终原厂。
      // 持久化在 <dataDir>/fork-core.json，只影响新派生/重启的分身。
      const forkCoreView = () => {
        const f = safeGet(SERVICE.forker)
        const base = typeof f?.coreStatus === 'function'
          ? f.coreStatus()
          : { installable: true, accelerated: { installed: false, version: null, error: 'forker-unavailable' }, forks: {} }
        const settings = forkCoreSettings()
        const installed = base?.accelerated?.installed === true
        const state = resolveForkCoreState(settings, { installed })
        return {
          ok: true,
          mode: state.mode,
          sessionMode: state.sessionMode,
          effectiveMode: state.effectiveMode,
          blocked: state.blocked,
          accelerated: base?.accelerated ?? { installed: false, version: null },
          forks: base?.forks ?? {},
          essence: 'stock',
          updatedAt: settings.updatedAt,
          updatedBy: settings.updatedBy,
        }
      }
      // 同一路径不能 register 两次（webServer 以 path 为键，第二次会抛错并让后续路由静默丢失）。
      routeMethods(`${prefix}/api/fork-core`, {
        GET: (req, res) => json(res, 200, forkCoreView()),
        POST: async (req, res) => {
        const body = await readBody(req)
        if (body?.mode !== undefined && !['stock', 'accelerated'].includes(String(body.mode))) {
          return json(res, 400, { ok: false, error: 'invalid-fork-core-mode' })
        }
        if (body?.sessionMode !== undefined && !['new', 'copy', 'inherit'].includes(String(body.sessionMode))) {
          return json(res, 400, { ok: false, error: 'invalid-fork-session-mode' })
        }
        // 服务端同样 fail-closed：未安装加速核时拒绝切到加速档，且绝不写设置（不改档、不静默降级）。
        if (String(body?.mode ?? '') === 'accelerated') {
          const view = forkCoreView()
          if (view.accelerated?.installed !== true) {
            return json(res, 409, {
              ok: false,
              error: 'accelerated-cli-missing',
              unchanged: true,
              detail: '加速核未安装：设置未修改',
              accelerated: view.accelerated,
              searched: view.accelerated?.searched ?? [],
            })
          }
        }
        const written = writeForkCoreSettings(layout.dataDir, {
          ...(body?.mode !== undefined ? { mode: String(body.mode) } : {}),
          ...(body?.sessionMode !== undefined ? { sessionMode: String(body.sessionMode) } : {}),
        }, { by: String(body?.by ?? 'panel').slice(0, 120) })
        if (written.ok !== true) return json(res, 500, { ok: false, error: written.error ?? 'write-failed' })
        try { audit('fork-core-settings', { mode: written.settings.mode, sessionMode: written.settings.sessionMode }) } catch { /* audit optional */ }
        return json(res, 200, { ...forkCoreView(), changed: true })
        },
      })
      // 重启守卫 / supervisor 契约（只读）。不触发重启；写操作仍只走审批 + 外部 supervisor。
      route('GET', `${prefix}/api/restart`, (req, res) => {
        const view = restartView()
        return json(res, 200, { ok: view.available === true && !view.error, ...view })
      })
      route('GET', `${prefix}/api/restart/selfcheck`, (req, res) => {
        const guard = safeGet(SERVICE.restart)
        if (!guard || typeof guard.selfCheck !== 'function') return json(res, 503, { ok: false, error: 'restart-guard-unavailable' })
        return json(res, 200, guard.selfCheck())
      })
      // v3.3.6: red restart UI data. Read-only impact + execution state; no restart.
      route('GET', `${prefix}/api/restart/impact`, (req, res) => {
        const guard = safeGet(SERVICE.restart)
        if (!guard || typeof guard.impact !== 'function') return json(res, 503, { ok: false, error: 'restart-guard-unavailable' })
        try {
          const view = restartView()
          return json(res, 200, {
            ok: true,
            impact: guard.impact(),
            executionArmed: view.executionArmed === true,
            supervisorPresent: view.supervisorPresent === true,
            mode: view.mode ?? null,
            allowProcessRestart: view.allowProcessRestart === true,
            note: view.executionArmed === true
              ? '已武装：二次确认后守卫会把执行权交给 supervisor 并退出 75。'
              : '未武装：二次确认只会记录红色审批，不会自动退出/重启宿主。',
          })
        } catch (error) {
          return json(res, 500, { ok: false, error: 'restart-impact-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.3.6: two-step human restart. Confirmation is enforced here and again
      // by service.requestMotherRestart; missing fields are rejected with 428.
      route('POST', `${prefix}/api/restart/request`, async (req, res) => {
        const body = await readBody(req)
        const confirmation = body?.confirmation && typeof body.confirmation === 'object' ? body.confirmation : null
        if (!confirmation || confirmation.forkChecked !== true || confirmation.finalConfirm !== true) {
          return json(res, 428, {
            ok: false,
            error: 'restart-confirmation-required',
            required: { forkChecked: true, finalConfirm: true },
            detail: '请先在分身确认影响，再进行第二次确认；缺失确认时不会创建重启请求。',
          })
        }
        const out = await service.requestMotherRestart(String(body?.reason ?? 'manual'), { confirmation })
        return json(res, out.ok === false ? 409 : 200, out)
      })
      route('GET', `${prefix}/api/upgrade/status`, (req, res) => {
        let mirror = null
        let essences = []
        let compat = null
        try { mirror = mirrorService.status() } catch { /* empty */ }
        try { essences = mirrorService.listEssences()?.essences ?? [] } catch { /* empty */ }
        try { compat = readCompatStatus(layout.dataDir) } catch { /* empty */ }
        let failedTasks = 0
        try { failedTasks = [...tasks.values()].filter(task => task.status === TASK_STATUS.FAILED).length } catch { /* empty */ }
        return json(res, 200, buildUpgradeStatus({ version: FANG_VERSION, mirror, essences, compat, tasks: { failed: failedTasks } }))
      })
      route('GET', `${prefix}/api/tasks`, (req, res) => json(res, 200, { ok: true, tasks: service.listTasks() }))

      // Decision center (瓮城·决策中心): one inbox for human attention. The plugin
      // owns tickets; this route is only the authenticated read/write surface.
      route('GET', `${prefix}/api/decisions`, (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.list !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = center.list({
          includeArchived: query.get('includeArchived') === '1' || query.get('includeArchived') === 'true',
          since: Number(query.get('since')) || 0,
        })
        return json(res, 200, { ok: true, ...out })
      })
      route('GET', `${prefix}/api/decisions/quota`, (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.quotaStatus !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        return json(res, 200, center.quotaStatus())
      })
      route('GET', `${prefix}/api/decisions/item`, (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.get !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const ticket = center.get(String(query.get('id') ?? ''))
        return ticket ? json(res, 200, { ok: true, ticket }) : json(res, 404, { ok: false, error: 'not-found' })
      })
      route('GET', `${prefix}/api/decisions/forks`, (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.forkAggregation !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        return json(res, 200, center.forkAggregation())
      })
      route('GET', `${prefix}/api/decisions/producers`, (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.producerCatalog !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        return json(res, 200, center.producerCatalog())
      })
      // 外部生产者桥（PM/PJM/Worker/HarnessMM/PluginUpdater/SuperAgent）：
      // 只做带鉴权的 ingest；ticket 来源标记 external:<producer>，roleTrusted=false。
      route('POST', `${prefix}/api/decisions/ingest`, async (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.ingest !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        const body = await readBody(req)
        const out = center.ingest(body && typeof body === 'object' ? body : {})
        const status = out.ok ? 200
          : out.reason === 'title-required' || out.reason === 'options-required' || out.reason === 'gray-is-terminal' ? 400
            : 409
        return json(res, status, out)
      })
      // 决策中心实时推送：SSE。bus 事件 → 一条已鉴权流；无 SSE 时客户端仍可轮询。
      const decisionStreams = new Set()
      route('GET', `${prefix}/api/decisions/events`, (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.list !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        if (decisionStreams.size >= 20) return json(res, 429, { ok: false, error: 'too-many-event-streams' })
        const stream = openDecisionEventStream({ req, res, bus, center })
        decisionStreams.add(stream)
        const cleanup = () => {
          if (!decisionStreams.delete(stream)) return
          try { stream.close() } catch { /* ignore */ }
        }
        try { req.on?.('close', cleanup) } catch { /* ignore */ }
        try { res.on?.('close', cleanup) } catch { /* ignore */ }
        return undefined
      })
      try { child.effect?.(() => () => { for (const stream of decisionStreams) { try { stream.close() } catch { /* ignore */ } } decisionStreams.clear() }) } catch { /* fake webServer in tests */ }
      route('POST', `${prefix}/api/decisions/resolve`, async (req, res) => {
        const body = await readBody(req)
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.resolve !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        if (Array.isArray(body?.ids)) {
          if (typeof center.resolveMany !== 'function') return json(res, 503, { ok: false, error: 'decision-center-batch-unavailable' })
          const out = center.resolveMany(body.ids, { option: body?.option, by: body?.by ?? 'fang-api', note: body?.note })
          return json(res, 200, out)
        }
        const resolveOptions = { by: body?.by ?? 'fang-api', note: body?.note }
        // v3.1.13：只有显式传 custom 时才把字段交给服务层；undefined 字段不进
        // options（旧调用方/测试对 {by,note} 的形状有断言）。
        if (body?.custom !== undefined) resolveOptions.custom = body.custom
        const out = (body?.actionId !== undefined && typeof center.resolveAction === 'function')
          ? center.resolveAction(body?.id, body.actionId, body?.payload, resolveOptions)
          : center.resolve(body?.id, body?.option, resolveOptions)
        const status = out.ok ? 200
          : out.reason === 'not-found' ? 404
            : out.reason === 'option-required' || out.reason === 'unknown-option' ? 400
              : 409
        return json(res, status, out)
      })
      route('POST', `${prefix}/api/decisions/abandon`, async (req, res) => {
        const body = await readBody(req)
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.abandon !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        if (Array.isArray(body?.ids)) {
          if (typeof center.abandonMany !== 'function') return json(res, 503, { ok: false, error: 'decision-center-batch-unavailable' })
          const out = center.abandonMany(body.ids, { by: body?.by ?? 'fang-api', note: body?.note })
          return json(res, 200, out)
        }
        const out = center.abandon(body?.id, { by: body?.by ?? 'fang-api', note: body?.note })
        return json(res, out.ok ? 200 : (out.reason === 'not-found' ? 404 : 409), out)
      })

      route('GET', `${prefix}/api/decisions/ai`, (req, res) => {
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.aiStatus !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        return json(res, 200, { ok: true, ...center.aiStatus() })
      })
      route('POST', `${prefix}/api/decisions/ai/test`, async (req, res) => {
        const body = await readBody(req)
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.testAi !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        const out = await center.testAi(body ?? {})
        return json(res, out.ok ? 200 : (out.status === 429 ? 429 : 400), out)
      })
      route('POST', `${prefix}/api/decisions/ai/config`, async (req, res) => {
        const body = await readBody(req)
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.configureAi !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        const out = center.configureAi(body ?? {})
        return json(res, out.ok ? 200 : 400, out)
      })
      route('POST', `${prefix}/api/decisions/ai/advise/stream`, async (req, res) => {
        const body = await readBody(req)
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.advise !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        })
        try { res.flushHeaders?.() } catch { /* fake res */ }
        let closed = false
        let wrote = 0
        const send = (event, data) => {
          if (closed) return false
          try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); wrote += 1; return true } catch { return false }
        }
        try {
          send('start', { id: String(body?.id ?? '') })
          const out = typeof center.adviseStream === 'function'
            ? await center.adviseStream(body?.id, (delta, text) => { send('delta', { delta, text }) })
            : await center.advise(body?.id)
          send(out.ok ? 'done' : 'error', out.ok ? { advice: out.advice, ticket: out.ticket } : out)
        } catch (error) {
          send('error', { ok: false, error: String(error?.message ?? error) })
        } finally {
          closed = true
          try { res.end() } catch { /* ignore */ }
        }
      })
      route('POST', `${prefix}/api/decisions/ai/advise`, async (req, res) => {
        const body = await readBody(req)
        const center = safeGet(SERVICE.decisionCenter)
        if (!center || typeof center.advise !== 'function') return json(res, 503, { ok: false, error: 'decision-center-unavailable' })
        const out = await center.advise(body?.id)
        const limited = out?.reason === 'ai-rate-limited' || out?.reason === 'ai-circuit-open' || out?.reason === 'ai-daily-quota-exceeded'
        if (limited && Number.isFinite(out?.retryAfterMs) && out.retryAfterMs > 0) {
          try { res.setHeader?.('retry-after', String(Math.ceil(out.retryAfterMs / 1000))) } catch { /* fake res */ }
        }
        return json(res, out.ok ? 200 : (out.reason === 'not-found' ? 404 : limited ? 429 : 409), out)
      })

      // Mother-side approval aggregation: local approver + every live fork adapter.
      // A failed adapter is reported as degraded, never as an empty approval list.
      route('GET', `${prefix}/api/approvals`, async (req, res) => {
        const items = []
        const failed = []
        const approver = safeGet(SERVICE.approver)
        try {
          if (approver && typeof approver.pending === 'function') {
            for (const item of approver.pending() ?? []) {
              items.push({
                source: 'mother',
                taskId: null,
                approvalId: String(item?.id ?? ''),
                title: String(item?.title ?? ''),
                risk: String(item?.risk ?? 'unknown'),
                kind: String(item?.kind ?? 'unknown'),
                state: item?.state ?? 'pending',
                createdAt: item?.createdAt ?? null,
                deadlineAt: item?.deadlineAt ?? null,
                adapterOk: true,
              })
            }
            if (typeof approver.orphaned === 'function') {
              for (const item of approver.orphaned() ?? []) {
                items.push({
                  source: 'mother',
                  taskId: null,
                  approvalId: String(item?.id ?? ''),
                  title: String(item?.title ?? ''),
                  risk: String(item?.risk ?? 'unknown'),
                  kind: String(item?.kind ?? 'unknown'),
                  state: 'orphaned',
                  createdAt: item?.createdAt ?? null,
                  deadlineAt: item?.deadlineAt ?? null,
                  adapterOk: true,
                })
              }
            }
          } else {
            failed.push({ taskId: null, error: 'approver-unavailable' })
          }
        } catch (error) {
          failed.push({ taskId: null, error: String(error?.message ?? error) })
        }

        // v3.3.5: only live forks are aggregated. A dead/stopped fork is an
        // expected offline state, not an approval failure; keep it in `skipped`
        // so the panel can show it without marking the whole inbox degraded.
        const forkTasks = [...tasks.values()].filter((task) => task?.url)
        const liveForkTasks = forkTasks.filter((task) => isLiveForkForApprovals(task, taskView(task).status))
        const skipped = forkTasks
          .filter((task) => !liveForkTasks.includes(task))
          .map((task) => ({ taskId: task.taskId, status: taskView(task).status, reason: 'fork-offline' }))
        const forkResults = await Promise.all(liveForkTasks
          .map(async (task) => {
            if (task.adapter && task.adapter.ok === false) {
              return { task, ok: false, error: task.adapter.error ?? 'adapter-unavailable' }
            }
            const client = await remoteFor(task)
            if (!client) return { task, ok: false, error: 'remote-unavailable' }
            const result = await client.command(ADAPTER_OP.APPROVALS, {})
            const data = result?.data?.result ?? result?.data ?? {}
            if (!result?.ok || data?.ok === false) {
              return { task, ok: false, error: data?.error ?? result?.error ?? 'adapter-failed' }
            }
            const list = Array.isArray(data?.items) ? data.items
              : Array.isArray(data?.result?.items) ? data.result.items
                : []
            return { task, ok: true, items: list }
          }))
        for (const result of forkResults) {
          if (!result.ok) {
            failed.push({ taskId: result.task.taskId, error: result.error })
            continue
          }
          for (const item of result.items) {
            items.push({
              source: 'fork',
              taskId: result.task.taskId,
              approvalId: String(item?.id ?? item?.approvalId ?? ''),
              title: String(item?.title ?? ''),
              risk: String(item?.risk ?? 'unknown'),
              kind: String(item?.kind ?? 'unknown'),
              state: item?.state ?? 'pending',
              createdAt: item?.createdAt ?? null,
              deadlineAt: item?.deadlineAt ?? null,
              adapterOk: true,
            })
          }
        }
        items.sort((a, b) => (Number(a.deadlineAt) || Number.MAX_SAFE_INTEGER) - (Number(b.deadlineAt) || Number.MAX_SAFE_INTEGER))
        return json(res, 200, { ok: true, degraded: failed.length > 0, items, failed, skipped })
      })

      // v3.3.5: isolated approval drill. Runs the real approver request → decide →
      // snapshot → rollback path in a temp dataRoot; never touches production data.
      // This gives a live host a way to prove the approval chain executes.
      route('POST', `${prefix}/api/approvals/drill`, async (req, res) => {
        try {
          const out = await runApprovalDrill()
          const cleanup = cleanupApprovalDrill(out)
          return json(res, out.ok && cleanup ? 200 : 500, {
            ok: out.ok && cleanup,
            drill: {
              request: out.request ?? null,
              pendingBefore: out.pendingBefore ?? null,
              pendingAfter: out.pendingAfter ?? null,
              snapshot: out.snapshot ? { ok: out.snapshot.ok !== false, tag: out.snapshot.tag ?? null } : null,
              rollback: out.rollback ? { ok: out.rollback.ok === true, restored: out.restored === true } : null,
              cleanup,
            },
            error: out.error ?? null,
          })
        } catch (error) {
          return json(res, 500, { ok: false, error: 'approval-drill-failed', detail: String(error?.message ?? error) })
        }
      })

      // Decide one approval by source. The response is the real adapter/approver result;
      // stale or unknown approvals return 409 instead of pretending success.
      route('POST', `${prefix}/api/approvals/decide`, async (req, res) => {
        const body = await readBody(req)
        const source = String(body?.source ?? '')
        const taskId = body?.taskId === undefined || body?.taskId === null ? null : String(body.taskId)
        const approvalId = String(body?.approvalId ?? '').trim()
        const raw = body?.outcome ?? body?.decision
        const outcome = raw === 'approve' ? 'approved' : raw === 'deny' ? 'denied' : String(raw ?? '')
        const by = String(body?.by ?? 'fang-api')
        const note = body?.note === undefined || body?.note === null ? null : String(body.note)
        if (!approvalId) return json(res, 400, { ok: false, error: 'approval-id-required' })
        if (outcome !== 'approved' && outcome !== 'denied') return json(res, 400, { ok: false, error: 'bad-outcome', allowed: ['approved', 'denied'] })

        if (source === 'mother') {
          const approver = safeGet(SERVICE.approver)
          if (!approver || typeof approver.decide !== 'function') {
            return json(res, 503, { ok: false, source, error: 'approver-unavailable' })
          }
          try {
            const result = approver.decide(approvalId, outcome, { by, note })
            if (!result || result.ok === false) {
              const stale = result?.reason === 'not-found' || result?.reason === 'not-pending'
              return json(res, stale ? 409 : 400, { ok: false, source, approvalId, error: result?.reason ?? 'decide-failed' })
            }
            audit(AUDIT.APPROVAL_DECIDED, { source, taskId: null, approvalId, outcome, by, note })
            return json(res, 200, { ok: true, source, taskId: null, approvalId, outcome, by, result })
          } catch (error) {
            return json(res, 500, { ok: false, source, approvalId, error: String(error?.message ?? error) })
          }
        }

        if (source === 'fork') {
          if (!taskId) return json(res, 400, { ok: false, source, error: 'task-id-required' })
          const task = tasks.get(taskId)
          if (!task) return json(res, 404, { ok: false, source, taskId, error: 'unknown-task' })
          const client = await remoteFor(task)
          if (!client) return json(res, 503, { ok: false, source, taskId, error: 'remote-unavailable' })
          const result = await client.command(ADAPTER_OP.APPROVAL_DECIDE, { id: approvalId, outcome, by, note })
          const data = result?.data?.result ?? result?.data ?? {}
          if (!result?.ok || data?.ok === false) {
            const stale = data?.code === 'not-found' || data?.code === 'conflict'
            return json(res, stale ? 409 : 502, { ok: false, source, taskId, approvalId, error: data?.error ?? result?.error ?? 'adapter-failed' })
          }
          audit(AUDIT.APPROVAL_DECIDED, { source, taskId, approvalId, outcome, by, note })
          return json(res, 200, { ok: true, source, taskId, approvalId, outcome, by, result: data })
        }

        return json(res, 400, { ok: false, error: 'bad-source', allowed: ['mother', 'fork'] })
      })

      route('POST', `${prefix}/api/tasks/create`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = await service.createTask({ title: body?.title, template: body?.template, collaborators: body?.collaborators, essenceId: body?.essenceId, importSession: body?.importSession, seed: body?.seed })
          return json(res, out.ok ? 200 : 409, out)
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('GET', `${prefix}/api/tasks/status`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await service.getTaskStatus(query.get('taskId') ?? '')
        return json(res, out.ok === false ? 404 : 200, out)
      })
      // v3.0.5/B4：打开分身时才在内存中取带 token 的 URL（不落盘、不进列表）
      route('GET', `${prefix}/api/tasks/open-url`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const taskId = String(query.get('taskId') ?? '').trim()
        const out = taskId ? forker()?.openUrl?.(taskId) : null
        if (!out || out.ok !== true) return json(res, 404, { ok: false, error: out?.error ?? 'not-running' })
        return json(res, 200, out)
      })
      route('POST', `${prefix}/api/tasks/archive`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.archiveTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/restore`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.restoreTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      // 2026-11-22：一键修复（停残留 → 清别名桩 → 重置配置 → 重新拉起；不删 home/会话）
      route('POST', `${prefix}/api/tasks/repair`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.repairTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      // v3.0.9：强制单会话（运行中拒绝；停止/归档态把多余会话隔离到 quarantine-sessions/）
      route('POST', `${prefix}/api/tasks/sessions/enforce`, async (req, res) => {
        const body = await readBody(req)
        const out = service.enforceSingleSession(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/reset`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = await service.resetForkConfig(String(body?.taskId ?? ''))
          return json(res, out.ok ? 200 : 409, out)
        } catch (error) {
          return json(res, 500, { ok: false, error: 'reset-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/tasks/archive/delete`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.deleteArchivedTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/promote`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.promoteTask(String(body?.taskId ?? ''), String(body?.pluginId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })

      route('POST', `${prefix}/api/derive`, async (req, res) => {
        const body = await readBody(req)
        // v3.1.30：透传 sessionIds，让「一次只能导入一个会话」的校验在 API 层生效。
        const out = await service.derive({
          title: body?.title,
          sessionId: body?.sessionId,
          sessionIds: body?.sessionIds,
          collaborators: body?.collaborators,
        })
        return json(res, out.ok ? 200 : 409, out)
      })
      route('GET', `${prefix}/api/tasks/sessions`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await service.listForkSessions(query.get("taskId") ?? "", { limit: query.get("limit") })
        return json(res, out.ok === false ? 404 : 200, out)
      })
      // v1 兼容路由
      route('GET', `${prefix}/api/forks`, (req, res) => json(res, 200, { ok: true, forks: service.listForks() }))
      routeMethods(`${prefix}/api/forks/supervision`, {
        GET: (req, res) => json(res, 200, service.forkSupervision()),
        POST: async (req, res) => {
          const body = await readBody(req)
          const out = service.setForkSupervision(body ?? {})
          return json(res, out.ok ? 200 : 400, out)
        },
      })
      // watchdog 启动时的分身自动恢复；只拉起已登记但没在跑的非归档任务。
      route('POST', `${prefix}/api/forks/autostart`, async (req, res) => {
        const body = await readBody(req)
        const taskIds = Array.isArray(body?.taskIds) ? body.taskIds : null
        const out = await service.autostartForks({ taskIds })
        return json(res, out.ok ? 200 : 503, out)
      })
      route('POST', `${prefix}/api/forks/create`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.fork({ taskTitle: body?.taskTitle ?? body?.title })
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/reap`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.reap(String(body?.forkId ?? body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/promote`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.promote(String(body?.forkId ?? ''), String(body?.pluginId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      // v2.9.0 母体连接
      route('GET', `${prefix}/api/mother-link`, (req, res) => json(res, 200, linkService.describe()))
      route('POST', `${prefix}/api/mother-link/probe`, async (req, res) => {
        const body = await readBody(req)
        const out = await linkService.probe(body && typeof body === 'object' ? body : {})
        try {
          ctx.get(SERVICE.auditor)?.append?.(AUDIT.LINK_PROBE, {
            target: out.target ?? null, ok: out.ok === true,
            latencyMs: out.latencyMs ?? null, error: out.error ?? null,
          })
        } catch { /* 审计缺失不影响探测结果 */ }
        return json(res, 200, out)
      })
      // v2.11.0 母体镜像管理
      route('GET', `${prefix}/api/mirror/status`, async (req, res) => {
        // R13 修复：官方源版本是 async，先刷新缓存（RL 60s），getStatus 只读缓存，
        // 避免 "[object Promise]" 与未处理 rejection。
        try { await mirrorManager.refreshOfficialLatest?.({ maxAgeMs: 60_000 }) } catch { /* 官方源不可用不阻塞镜像状态 */ }
        const payload = mirrorService.status()
        const ifNoneMatch = req && req.headers ? req.headers['if-none-match'] : undefined
        const out = buildMirrorStatusResponse(payload, ifNoneMatch)
        res.writeHead(out.statusCode, out.headers)
        res.end(out.notModified ? '' : out.body)
      })
      route('POST', `${prefix}/api/mirror/backup`, async (req, res) => {
        const body = await readBody(req)
        try {
          const entry = mirrorService.backup({ label: body?.label, bucket: body?.bucket })
          return json(res, 200, { ok: true, entry })
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/mirror/restore`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = mirrorService.restore(body?.backupId)
          return json(res, out.ok ? 200 : 409, out)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/mirror/backup/delete`, async (req, res) => {
        const body = await readBody(req)
        try {
          const out = mirrorService.deleteBackup(body?.backupId)
          return json(res, out.ok ? 200 : 404, out)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/mirror/backup-interval`, async (req, res) => {
        const body = await readBody(req)
        const out = mirrorService.setBackupInterval(body?.hours)
        return json(res, out.ok ? 200 : 400, out)
      })
      // v3.0.9 升级链路 2.1：从本机母体 profile 克隆镜像基础层（先自动备份）。
      route('POST', `${prefix}/api/mirror/clone-profile`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.cloneMotherProfile(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'clone-failed', detail: String(error?.message ?? error) })
        }
      })
      // 空白母体（初始盘）：备份当前 → active/profile 清空 → 版本 blank
      route('POST', `${prefix}/api/mirror/blank`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.blankMother(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'blank-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.0.8 镜像偏好：对话框交互超时 15/30/60s（宿主侧持久化）
      route('GET', `${prefix}/api/mirror/preferences`, (req, res) => json(res, 200, mirrorService.getPreferences()))
      route('POST', `${prefix}/api/mirror/preferences/set`, async (req, res) => {
        const body = await readBody(req)
        try {
          const patch = {}
          if (body?.activeIdleTimeoutMs !== undefined) patch.activeIdleTimeoutMs = body.activeIdleTimeoutMs
          if (body?.syncIntervalHours !== undefined) patch.syncIntervalHours = body.syncIntervalHours
          const preferences = mirrorService.setPreferences(patch)
          return json(res, 200, preferences)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // v3.0.3 compat 门禁：客户端升级后子插件默认关闭，门禁通过才允许启用
      route('GET', `${prefix}/api/mirror/recompute-status`, (req, res) => json(res, 200, mirrorService.recomputeStatus()))
      route('GET', `${prefix}/api/essence/list`, (req, res) => json(res, 200, mirrorService.listEssences()))
      // v3.0.6 元主 CRUD / 默认元主 / 导出
      route('POST', `${prefix}/api/essence/create`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.createEssence(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // v3.3.8：手动触发默认元主版本自愈（启动时也会异步触发）。
      route('POST', `${prefix}/api/essence/auto-refresh`, async (req, res) => {
        try {
          const result = await service.refreshDefaultEssence()
          return json(res, result?.ok === false ? 500 : 200, { ok: result?.ok !== false, result })
        } catch (error) {
          return json(res, 500, { ok: false, error: 'essence-auto-refresh-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.0.9 母体 → 元主：从当前母体 profile 的可写层生成一个可配置元主。
      route('POST', `${prefix}/api/essence/capture`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.captureEssence(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'capture-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.0.9 升级链路 3：把元主 overlay 重放到当前镜像（单个或全部）。
      route('POST', `${prefix}/api/essence/sync`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...(await mirrorService.syncEssences(body)) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'sync-failed', detail: String(error?.message ?? error) })
        }
      })
      // v3.0.9 原身运行态：start / stop（隔离 home 的配置态实例）
      // 注意：DSH webServer 按 path 键路由，GET+POST 必须走 routeMethods 一次注册，
      // 否则第二次 register 抛出，后面的路由会静默丢失（实测踩过）。
      routeMethods(`${prefix}/api/essence/runtime`, {
        GET: (req, res) => {
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          return json(res, 200, mirrorService.essenceRuntimeStatus(query.get('essenceId')))
        },
        POST: async (req, res) => {
          const body = await readBody(req)
          const action = String(body?.action ?? 'start')
          try {
            if (action === 'stop') return json(res, 200, mirrorService.stopEssenceRuntime(body?.essenceId))
            return json(res, 200, await mirrorService.startEssenceRuntime(body?.essenceId, body))
          } catch (error) {
            return json(res, 400, { ok: false, error: 'runtime-failed', detail: String(error?.message ?? error) })
          }
        },
      })
      route('GET', `${prefix}/api/essence/detail`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        try { return json(res, 200, mirrorService.essenceDetail(query.get('essenceId'))) } catch (error) {
          return json(res, 400, { ok: false, error: 'detail-failed', detail: String(error?.message ?? error) })
        }
      })
      route('GET', `${prefix}/api/essence/open/candidates`, (req, res) => json(res, 200, mirrorService.essenceOpenCandidates()))
      route('GET', `${prefix}/api/essence/runtime/open`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        return json(res, 200, mirrorService.openEssenceRuntime(query.get('essenceId')))
      })
      route('POST', `${prefix}/api/essence/backup`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.backupEssence(String(body?.essenceId ?? '')) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'backup-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/restore`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.restoreEssence(String(body?.essenceId ?? '')) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'restore-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/import`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.importEssence(body) }) } catch (error) {
          return json(res, 400, { ok: false, error: 'import-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/rename`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.renameEssence(String(body?.essenceId ?? ''), body?.name) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/archive`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.archiveEssence(String(body?.essenceId ?? ''), body?.archived !== false) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/delete`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, ...mirrorService.deleteEssence(String(body?.essenceId ?? '')) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/copy`, async (req, res) => {
        const body = await readBody(req)
        try { return json(res, 200, { ok: true, essence: mirrorService.copyEssence(String(body?.essenceId ?? ''), body?.name) }) } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('GET', `${prefix}/api/essence/download`, (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        try {
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          const bundle = mirrorService.downloadEssence(String(query.get('essenceId') ?? ''), { full: query.get('full') === '1' })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="essence-${bundle.essenceId}.json"`,
            'cache-control': 'no-store',
          })
          return res.end(JSON.stringify(bundle))
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // v3.0.6 分身 rename/copy/download（copy=访问信息；download=元数据清单）
      route('POST', `${prefix}/api/tasks/rename`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.renameTask(String(body?.taskId ?? ''), body?.title)
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/copy`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.copyTaskInfo(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 404, out)
      })
      route('GET', `${prefix}/api/tasks/download`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await Promise.resolve(service.downloadTaskManifest(String(query.get('taskId') ?? '')))
        return json(res, out.ok ? 200 : 404, out)
      })
      route('GET', `${prefix}/api/compat`, (req, res) => json(res, 200, mirrorService.compatStatus()))
      route('POST', `${prefix}/api/compat/check`, async (req, res) => {
        const status = await mirrorService.runCompatCheck()
        return json(res, status.ok ? 200 : 409, status)
      })
      route('POST', `${prefix}/api/mirror/upgrade`, async (req, res) => {
        const body = await readBody(req)
        const out = await mirrorService.upgrade({
          autoBackup: body?.autoBackup !== false,
          autoRollback: body?.autoRollback !== false,
        })
        return json(res, out.ok ? 200 : 409, out)
      })
      // v3.0.8 分支 HTTP 面（注册在末尾，避免影响既有路由初始化顺序）
      routeMethods(`${prefix}/api/tasks/branches`, {
        GET: (req, res) => {
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          const checked = requireTask(query.get('taskId'))
          if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
          return json(res, 200, branchStore.list(checked.taskId))
        },
        POST: async (req, res) => {
          const body = await readBody(req)
          const checked = requireTask(body?.taskId)
          if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
          try {
            return json(res, 200, branchStore.create(checked.taskId, {
              branchId: String(body?.branchId ?? ''),
              parentBranchId: body?.parentBranchId ? String(body.parentBranchId) : undefined,
              baseTurn: Number(body?.baseTurn) || 0,
            }))
          } catch (error) {
            const code = String(error?.message ?? error)
            return json(res, branchErrorStatus(code), { ok: false, error: code, code })
          }
        },
      })
      route('POST', `${prefix}/api/tasks/branches/activate`, async (req, res) => {
        const body = await readBody(req)
        const checked = requireTask(body?.taskId)
        if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
        try {
          const out = branchStore.activate(checked.taskId, String(body?.branchId ?? ''))
          // 方案 B：激活即切换 active 分支会话（同一分身可有多个分支会话，但同时只有 1 个 active）。
          const task = tasks.get(checked.taskId)
          if (task) {
            task.activeBranchId = out.activeBranchId
            persist()
          }
          audit('fork-branch-activated', { taskId: checked.taskId, branchId: out.activeBranchId, childSessionId: out.branch?.sessionId ?? null })
          return json(res, 200, out)
        } catch (error) {
          const code = String(error?.message ?? error)
          return json(res, branchErrorStatus(code), { ok: false, error: code, code })
        }
      })
      route('POST', `${prefix}/api/tasks/branches/status`, async (req, res) => {
        const body = await readBody(req)
        const checked = requireTask(body?.taskId)
        if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
        try {
          return json(res, 200, branchStore.setStatus(checked.taskId, String(body?.branchId ?? ''), String(body?.status ?? '')))
        } catch (error) {
          const code = String(error?.message ?? error)
          return json(res, branchErrorStatus(code), { ok: false, error: code, code })
        }
      })
      // 方案 A：物理分支——在分身自己的宿主里 sessions.fork，子会话挂回同一分身。
      route('POST', `${prefix}/api/tasks/branches/fork`, async (req, res) => {
        const body = await readBody(req)
        const checked = requireTask(body?.taskId)
        if (!checked.ok) return json(res, checked.status, { ok: false, error: checked.error, code: checked.error })
        const task = tasks.get(checked.taskId)
        if (!task) return json(res, 404, { ok: false, error: 'unknown-task' })
        if (task.status === TASK_STATUS.ARCHIVED) return json(res, 409, { ok: false, error: 'task-archived' })
        const client = await remoteFor(task)
        if (!client || typeof client.command !== 'function') return json(res, 502, { ok: false, error: 'adapter-unavailable' })
        const current = branchStore.list(checked.taskId)
        const sourceSessionId = String(body?.sessionId ?? current.sessionId ?? '').trim()
        if (!sourceSessionId) return json(res, 409, { ok: false, error: 'no-session' })
        const branchId = String(body?.branchId ?? '').trim() || `b${Date.now().toString(36)}`
        const baseTurn = Number.isFinite(Number(body?.baseTurn)) ? Number(body.baseTurn) : 0
        try {
          const out = await client.command('fork-session', { sessionId: sourceSessionId, boundary: baseTurn || undefined })
          const result = out?.data?.result ?? out?.data ?? null
          if (!out?.ok || result?.ok === false) {
            const code = String(result?.code ?? result?.error ?? out?.error ?? 'fork-failed')
            return json(res, 502, { ok: false, error: code, detail: result })
          }
          const childSessionId = result?.childSessionId ?? result?.id ?? null
          const branch = branchStore.create(checked.taskId, { branchId, baseTurn, sessionId: childSessionId })
          audit('fork-branch-created', { taskId: checked.taskId, branchId, childSessionId })
          return json(res, 200, { ok: true, branch: branch.branch, childSessionId, sourceSessionId })
        } catch (error) {
          const code = String(error?.message ?? error)
          return json(res, branchErrorStatus(code), { ok: false, error: code, code })
        }
      })
      route('GET', `${prefix}/api/reflow/policy`, (req, res) => json(res, 200, {
        ok: true,
        states: ['sealed', 'verified', 'quarantine', 'adopted'],
        transitions: {
          sealed: ['verified'],
          verified: ['quarantine', 'adopted'],
          quarantine: ['verified'],
          adopted: [],
        },
        forbiddenFields: ['token', 'password', 'secret', 'credential', 'auth', 'cookie', 'sessionkey', 'apikey'],
        merge: false,
      }))

      // v3.0.9 composer journal: persist unsent drafts and a read-only queue mirror
      // so a restart/crash can offer recovery. Nothing is auto-sent.
      routeMethods(`${prefix}/api/composer/journal`, {
        GET: (req, res) => {
          if (queueJournalGate(res)) return
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          const key = query.get('key') || ''
          // list=1 is the recovery list: every saved session draft/queue, newest first.
          if (!key && query.get('list') === '1') {
            return json(res, 200, { ok: true, entries: composerJournal.list() })
          }
          if (!key) return json(res, 400, { ok: false, error: 'journal-key-required' })
          return json(res, 200, { ok: true, entry: composerJournal.get(key) })
        },
        POST: async (req, res) => {
          if (queueJournalGate(res)) return
          const body = await readBody(req)
          const key = String(body?.key ?? '')
          if (!key) return json(res, 400, { ok: false, error: 'journal-key-required' })
          try {
            return json(res, 200, { ok: true, entry: composerJournal.save(key, { ...body, sessionKey: body?.sessionKey || body?.sessionId || '' }) })
          } catch (error) {
            return json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })

      // v3.1.21：append-only 历史快照（主 journal 被覆盖时的兜底恢复源）。
      routeMethods(`${prefix}/api/composer/journal/history`, {
        GET: (req, res) => {
          if (queueJournalGate(res)) return
          const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
          const limit = Math.max(1, Math.min(200, Number(query.get('limit') || 20)))
          const sessionKey = String(query.get('sessionKey') || '')
          return json(res, 200, { ok: true, items: composerJournal.history({ limit, sessionKey }) })
        },
      })

      // Restore saved queue rows into the official Session inbox WITHOUT waking the
      // agent. The queue journal is a recovery surface; it must not send messages.
      route('POST', `${prefix}/api/composer/queue`, async (req, res) => {
        if (queueJournalGate(res)) return
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '').trim()
        const items = Array.isArray(body?.items) ? body.items : []
        if (!sessionId) return json(res, 400, { ok: false, error: 'session-id-required' })
        if (items.length === 0) return json(res, 200, { ok: true, queued: 0, failed: 0 })
        const agents = safeGet('agents')
        const agent = agents?.get?.(sessionId)
        if (!agent || typeof agent.send !== 'function') {
          return json(res, 409, { ok: false, error: 'session-not-live' })
        }
        let queued = 0
        let failed = 0
        for (const item of items.slice(0, 100)) {
          const text = String(item?.text ?? '').trim().slice(0, 4000)
          if (!text) { failed += 1; continue }
          try {
            agent.send({
              id: newId('msg'),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            }, 'next-turn', false)
            queued += 1
          } catch { failed += 1 }
        }
        return json(res, 200, { ok: true, queued, failed })
      })

      // v3.0.8 contract: an unknown /fang/api/* path must be a JSON 404 under the
      // same Host/Origin/token gate — not an unauthenticated empty 404 from the host.
      // Exact routes above win because the webServer matches exact before prefix.
      // 默认元宝（新用户免创建）：dry-run 计划 + 应用。
      route('GET', `${prefix}/api/essence/default-preset`, async (req, res) => {
        try { return json(res, 200, await mirrorService.defaultPreset()) } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/essence/default`, async (req, res) => {
        const body = await readBody(req)
        try {
          // 同一路径两用：显式 essenceId = 设为默认；否则走默认元宝 ensure（apply/force/mode）。
          if (body?.essenceId) {
            return json(res, 200, { ok: true, default: mirrorService.setDefaultEssence(String(body.essenceId)) })
          }
          const out = await mirrorService.ensureDefaultEssence({ apply: body?.apply === true, force: body?.force === true, mode: body?.mode === 'preset' ? 'preset' : 'copy-local' })
          return json(res, out.ok === false ? 409 : 200, out)
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })
      // 新用户延迟自动创建（不阻塞启动；无已装默认插件时不创建）。
      if (cfg.defaultEssenceAuto !== false) {
        const timer = setTimeout(() => { mirrorService.ensureDefaultEssence({ apply: true, mode: 'copy-local' }).catch(() => {}) }, 8000)
        if (typeof timer.unref === 'function') timer.unref()
      }

      webServer.register({
        kind: 'prefix',
        path: `${prefix}/api`,        handler: async (req, res) => {
          const decision = checkRequestAuth(req, {
            token: authToken,
            publicRoute: authToken.length === 0,
          })
          if (!decision.ok) return json(res, decision.status, authErrorBody(decision))
          return json(res, 404, { ok: false, error: 'not-found', code: 'not-found' })
        },
      })
    })
  }
}

/** Reject any plugin-provided relative path that escapes its base directory. */
export function resolveInside(base, rel) {
  const p = String(rel ?? '')
  if (!p || p.includes('\0')) return null
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\') || p.includes('..')) return null
  const resolved = path.resolve(base, p)
  const baseResolved = path.resolve(base)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) return null
  return resolved
}

/** Server-rendered portal (v2): task table + adapter state + four actions. */
export function renderPanelHtml(prefix = '/fang', authToken = '') {
  const p = HTML_ESCAPE(prefix)
  const token = HTML_ESCAPE(authToken)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="fang-auth" content="${token}">
<title>dsh-Fang v2 · 瓮城</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; max-width: 1180px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8a8a; margin-bottom: 20px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  input, button { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; }
  input { min-width: 280px; }
  button { cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #8884; vertical-align: middle; }
  th { font-weight: 600; color: #8a8a8a; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; }
  .ready { color: #16a34a; } .running { color: #2563eb; } .failed { color: #dc2626; }
  .archived { color: #8a8a8a; } .provisioning { color: #d97706; }
  .empty { color: #8a8a8a; padding: 24px 0; }
  #msg { min-height: 22px; color: #d97706; }
  a { color: inherit; }
</style></head>
<body>
  <h1>dsh-Fang v2 · 瓮城</h1>
  <div class="sub">母体只读；每个任务一个分身（用完即弃）。Adapter 就绪 = 分身器官已上线；归档 = flush + 回收。</div>
  <div class="row">
    <input id="title" placeholder="任务标题，例如：开发 dsh-foo 插件" />
    <button class="primary" id="create">派生新任务</button>
    <button id="refresh">刷新</button>
    <span id="mother"></span>
  </div>
  <div id="msg"></div>
  <table>
    <thead><tr><th>任务</th><th>状态</th><th>Adapter</th><th>端口</th><th>PID</th><th>操作</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody>
  </table>
<script>
const P = ${JSON.stringify(p)};
const $ = (id) => document.getElementById(id);
// v3.0.5/B1：面板同源读取安装 token，所有 /api 请求必须携带 header（否则 401 unauthorized）
const AUTH = (document.querySelector('meta[name="fang-auth"]')?.content || '');
// UI 分析日志：所有按钮/链接点击都记录（可被自动冒烟读取）
window.__fangUiLog = [];
document.addEventListener('click', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest('button, a[href]') : null;
  if (!el) return;
  window.__fangUiLog.push({
    at: Date.now(),
    text: String(el.textContent || '').trim().slice(0, 80),
    act: el.getAttribute('data-act') || null,
    href: el.href || null,
  });
}, true);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function msg(t, bad) { $('msg').textContent = t || ''; $('msg').style.color = bad ? '#dc2626' : '#16a34a'; }
async function api(path, opts) {
  const res = await fetch(P + path, Object.assign({
    headers: Object.assign({ 'content-type': 'application/json' }, AUTH ? { 'x-fang-auth': AUTH } : {}),
  }, opts));
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
async function refresh() {
  const { body } = await api('/api/status');
  const s = body || {};
  $('mother').innerHTML = s.version
    ? '<span class="badge">母体 · ' + esc(s.profileTag) + ' · ' + esc(s.tasks?.ready) + ' ready / ' + esc(s.tasks?.total) + ' tasks</span>'
    : '';
  const list = s.tasks?.list ?? [];
  if (!list.length) { $('rows').innerHTML = '<tr><td colspan="6" class="empty">还没有任务。输入标题并点「派生新任务」。</td></tr>'; return; }
  $('rows').innerHTML = list.map(t => '<tr>' +
    '<td>' + esc(t.title) + '<br><code>' + esc(t.taskId) + '</code></td>' +
    '<td><span class="badge ' + esc(t.status) + '">' + esc(t.status) + '</span></td>' +
    '<td><span class="badge ' + (t.adapter?.ok ? 'ready' : 'failed') + '">' + (t.adapter?.ok ? 'ready' : esc(t.adapter?.error || 'down')) + '</span></td>' +
    '<td>' + (t.port ? esc(t.port) : '—') + '</td>' +
    '<td>' + (t.pid ? esc(t.pid) : '—') + '</td>' +
    '<td>' +
      (t.url ? '<a class="badge" href="' + esc(t.url) + '" target="_blank" rel="noopener">打开</a> ' : '') +
      '<button data-act="archive" data-id="' + esc(t.taskId) + '">归档</button> ' +
      '<button data-act="promote" data-id="' + esc(t.taskId) + '">提升插件…</button>' +
    '</td></tr>').join('');
}
$('create').onclick = async () => {
  const title = $('title').value.trim();
  msg('派生中…（含 Adapter 握手，约 5–20 秒）');
  const { body } = await api('/api/tasks/create', { method: 'POST', body: JSON.stringify({ title }) });
  if (body?.ok) { msg('已派生：' + body.taskId + '（adapter ' + (body.adapter?.ok ? 'ready' : '未就绪') + '）'); if (body.url) window.open(body.url, '_blank', 'noopener'); $('title').value = ''; }
  else msg('派生失败：' + (body?.error || 'unknown') + (body?.detail ? ' — ' + body.detail : ''), true);
  refresh();
};
$('refresh').onclick = refresh;
$('rows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (btn.dataset.act === 'archive') {
    if (!confirm('归档该任务？会先 flush 分身缓冲并落审计，再删除 $DSH_HOME。')) return;
    const { body } = await api('/api/tasks/archive', { method: 'POST', body: JSON.stringify({ taskId: id }) });
    msg(body?.ok ? '已归档 ' + id : '归档失败：' + (body?.error || 'unknown'), !body?.ok);
  } else {
    const pluginId = prompt('要提升的插件目录名（位于该任务缓冲区内）：');
    if (!pluginId) return;
    const { body } = await api('/api/tasks/promote', { method: 'POST', body: JSON.stringify({ taskId: id, pluginId }) });
    msg(body?.ok ? '提升已批准：' + (body.note || body.target) : '提升被拒：' + (body?.error || 'unknown'), !body?.ok);
  }
  refresh();
});
refresh();
setInterval(refresh, 5000);
</script>
</body></html>`
}

export const _internals = { resolveCliPath, isShellLauncher, renderPanelHtml, loadRegistry, resolveInside, normalizeSeed }
