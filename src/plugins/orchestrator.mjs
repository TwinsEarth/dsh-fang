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
import v8 from 'node:v8'
import { spawn } from 'node:child_process'

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
import { installWatchGuard } from '../lib/watch-guard.mjs'
import { ensureInstallSnapshot } from '../lib/install-snapshot.mjs'
import { exportVault, importVault, readVault } from '../../vault/lib/vault.mjs'
import { installGlobalRedline } from '../lib/global-redline.mjs'
import { DEFAULT_FORBIDDEN_ROOTS, DEFAULT_FANG_DATA_ROOT, assertDataPath, isPathInside, workspaceForFork } from '../lib/data-isolation.mjs'
import { evaluateMemoryGuard, evaluatePagefileSingleFork, isPagefileMissing, killProcessTree, memoryGuardDefaults, readProcessTable, readProcessIdentity, readSystemMemory, selectProcessTree, sumProcessTree } from '../lib/memory-guard.mjs'
import { resolveMemoryThresholds } from '../lib/memory-policy.mjs'
import { hashCommandLine, matchesProcessIdentity } from '../lib/process-identity.mjs'
import { compactTaskSessions, compactLegacySessions } from '../lib/session-compaction.mjs'
import { scanSessionFootprint } from '../lib/session-footprint.mjs'
import { evaluateHostHeap, evaluateSessionFootprint, resolveHostHeapLimits } from '../lib/host-pressure.mjs'
import { cleanupBrowserCaches, scanDiskHygiene } from '../lib/disk-hygiene.mjs'
import { cleanupWatchdogFiles, pruneHostCrashHistory } from '../lib/host-housekeeping.mjs'
import { appendBrowserMetricHistory } from '../lib/browser-metrics.mjs'
import { enforceSinglePageTarget } from '../lib/browser-guard.mjs'
import { evaluateForkHealth, forkHealthPathForPrefix, inspectForkSessionHealth, probeForkHealth } from '../lib/fork-health.mjs'
import { readLatestMigrationReport } from '../lib/migration-report.mjs'
import { DEFAULT_LEGACY_WORKSPACE_ROOTS, mapWorkspacePathForFork, migrateForkWorkspace, prepareImportedSession } from '../lib/workspace-mapping.mjs'
import { appendJsonlRotated } from '../lib/log-rotation.mjs'
import { closeManagedBrowser, findBrowserPath, flushManagedBrowser, freePort, isPidAlive, launchManagedBrowser, lowerProcessPriority, sampleManagedBrowser, setManagedBrowserLifecycle } from '../lib/browser-guard.mjs'
import { FORK_COMMIT_SHARE_DEFAULT, HOST_COMMIT_RESERVE_MB_DEFAULT, evaluateForkCommitBudget, resolveForkCommitBudget } from '../lib/commit-budget.mjs'
import { resolveJobHostPath, JOB_HEARTBEAT_GRACE_MS, JOB_HEARTBEAT_TIMEOUT_MS } from '../lib/job-object.mjs'
import { normalizeFetchDescriptor } from '../lib/node-compat.mjs'
import { cleanupApprovalDrill, runApprovalDrill } from '../lib/approval-drill.mjs'
import { negotiateProtocol } from '../lib/adapter-protocol.mjs'
import { describeMotherLink, probeLink, readSharedProfileSummary } from '../lib/mother-link.mjs'
import { MirrorManager } from '../lib/mirror.mjs'
import { buildMirrorStatusResponse } from '../lib/mirror-etag.mjs'
import { PreferencesStore } from '../lib/preferences.mjs'
import { EssenceManager, OFFICIAL_ESSENCE_ID, OFFICIAL_EXPERIMENTAL_BUNDLES, NODE_COMPAT_BUNDLE, VIP_QUOTAS, ESSENCE_HARD_MAX, ESSENCE_QUOTA_DEFAULT, parsePatchEntries } from '../lib/essence.mjs'
import { applyForkConfigLock, setProfileConfigReadonly } from '../lib/fork-config-lock.mjs'
import { enforceCoreUiEntries } from '../lib/core-ui-plugins.mjs'
import { ensureForkEmptySession, enforceForkSessionCap, summarizeForkSessions, FORK_SESSION_MAX, FORK_SESSION_MIN } from '../lib/fork-sessions.mjs'
import { decideIdleClose } from '../lib/fork-activity.mjs'
import { classifyCloseReason } from '../lib/browser-close-reason.mjs'
import { effectiveBrowserAutoCloseLimits, evaluateBrowserAutoClose } from '../lib/browser-auto-close.mjs'
import { resolveFlushEndpoint, flushResultFromResponse, flushRequestHeaders, unsavedCloseWarning } from '../lib/fork-flush.mjs'
import { DEFAULT_ESSENCE_NAME, planDefaultEssence } from '../lib/default-essence.mjs'
import { MirrorUpgradeCoordinator } from '../lib/upgrade-coordinator.mjs'
import { createBusinessProducers } from '../lib/business-producers.mjs'
import { createManifestOfficialSource } from '../lib/mirror-official-source.mjs'
import { clearForkConfigLock } from '../lib/fork-config-lock.mjs'
import { readForkSupervisionSettings, writeForkSupervisionSettings } from '../lib/fork-supervision-settings.mjs'
import { evaluateCrashLoop, readForkMeta, writeForkMeta } from '../lib/fork-supervisor.mjs'
import { DEFAULT_EXPECTED_ROUTE_COUNT, readCompatStatus, runCompatGate, writeCompatStatus } from '../lib/compat.mjs'
import { buildUpgradeStatus } from '../lib/upgrade-status.mjs'
import { openDecisionEventStream } from '../lib/decision-events.mjs'
import { authErrorBody, checkRequestAuth, loadAuthToken } from '../lib/http-auth.mjs'
import { verifyPeerOwner } from '../lib/peer-owner.mjs'
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

// Package root is used only to resolve the bundled Windows Job helper.
const FANG_ROOT = (() => {
  try { return fileURLToPath(new URL('../../', import.meta.url)).replace(/[/\\]$/, '') } catch { return '' }
})()

// Legacy workspace mapping must cover the full known set of shared roots,
// even when forbiddenDataRoots only names the DS-level paths. Otherwise a fork
// pointing at E:\DSH (no DS segment) would keep escaping its home.
function workspaceMigrationRoots(cfg) {
  const configured = Array.isArray(cfg?.forbiddenDataRoots) ? cfg.forbiddenDataRoots : []
  return [...new Set([...configured, ...DEFAULT_LEGACY_WORKSPACE_ROOTS])]
}

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


const FORK_BUNDLE_NAMES = Object.freeze(['@twinsearth/fang-dsh-plugin', '@twinsearth/dsh-fang', '@twinsearth/fang-dsh-plugin'])
// build.mjs rewrites @twinsearth/fang-dsh-plugin to the published package name.
const CURRENT_FANG_BUNDLE = '@twinsearth/fang-dsh-plugin'

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
    return !(declared.has('@twinsearth/dsh-fang') || declared.has('@twinsearth/fang-dsh-plugin-legacy'))
  }
  // v3.3.8: same package name but an older exact version is stale too. This is
  // the normal upgrade case (3.3.7 essence after installing 3.3.8).
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const declaredVersion = String(
    dependencies['@twinsearth/fang-dsh-plugin'] ||
    dependencies['@twinsearth/fang-dsh-plugin'] ||
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

/**
 * Safe Mode reset gate. This is deliberately pure so a simulated Windows memory
 * sample can be regression-tested without PowerShell. The caller must pass a
 * fresh `readSystemMemory({ force: true })` result; the reset path never trusts
 * a UI checkbox or a cached sample.
 *
 * v3.8.13: a missing pagefile is advisory, not a hard prerequisite. The real
 * gate is usable free memory: CommitFree must keep the host-critical reserve.
 */
export const SAFE_MODE_AUTO_CLEAR_COMMIT_MB = 2345
export const FORK_COMMIT_HARD_MIN_MB = 999

export function evaluateSafeModeReset(memory, { hostCriticalFreeMB = SAFE_MODE_AUTO_CLEAR_COMMIT_MB, force = false } = {}) {
  if (!memory || memory.ok !== true) {
    return { ok: false, error: 'memory-probe-unavailable', detail: '无法读取系统内存状态，拒绝解除 Safe Mode。' }
  }
  if (memory.supported === false) {
    return { ok: true, skipped: 'unsupported-platform', pageFileMB: 0, commitFreeMB: Number(memory.commitFreeMB) || 0, minFreeMB: 0 }
  }
  const pageFileMB = Number(memory.pageFileMB) || 0
  const commitFreeMB = Number(memory.commitFreeMB) || 0
  const minFreeMB = Math.max(0, Number(hostCriticalFreeMB) || 0)
  const pagefileMissing = isPagefileMissing(memory)
  if (commitFreeMB < minFreeMB && force !== true) {
    return {
      ok: false,
      error: 'commit-low',
      pageFileMB,
      commitFreeMB,
      minFreeMB,
      pagefileMissing,
      canForce: true,
      detail: `Commit 余量 ${commitFreeMB} MB 低于宿主紧急阈值 ${minFreeMB} MB；可先释放内存，或由操作员强制解除闩锁（新建分身仍会被内存守卫拒绝）。`,
    }
  }
  return {
    ok: true,
    forced: force === true && commitFreeMB < minFreeMB,
    pageFileMB,
    commitFreeMB,
    minFreeMB,
    pagefileMissing,
    advisory: pagefileMissing ? 'pagefile-missing' : null,
    detail: pagefileMissing ? '页面文件缺失只作为提示：建议设置页面文件，但当前可用内存仍可解除 Safe Mode。' : null,
  }
}

/** v3.9.5：崩溃样本是否携带真实资源压力；只有这种崩溃循环才允许全局封门。 */
export function hasHostCrashPressure(metrics = {}, { criticalFreeMB = 2345 } = {}) {
  const commitFree = Number(metrics?.commitFreeMB)
  const critical = Math.max(0, Number(criticalFreeMB) || 0)
  return (Number.isFinite(commitFree) && commitFree > 0 && commitFree < critical)
    || metrics?.heapLevel === 'critical' || metrics?.heapLevel === 'emergency'
    || metrics?.sessionPressure === 'emergency'
}

/** v3.9.4：Commit 余量达到 2345 MB 时，Safe Mode 闩锁自动解除，无需用户手动操作。 */
export function shouldAutoClearSafeMode(memory, { autoClearCommitMB = SAFE_MODE_AUTO_CLEAR_COMMIT_MB, reason = '' } = {}) {
  if (!memory || memory.ok !== true || memory.supported === false) return false
  const why = String(reason ?? '')
  // 手动 Panic 是用户明确的“停住”指令，不因当前 Commit 恢复而自动放行。
  // 崩溃循环（crash-loop-*）不是：它通常由一次 OOM 或异常重启留下，
  // Commit 已恢复到 2345 MB 以上说明宿主风险已解除，必须自动恢复可用性。
  if (/manual-panic/.test(why)) return false
  return (Number(memory.commitFreeMB) || 0) >= Math.max(0, Number(autoClearCommitMB) || 0)
}

/** Boot-time pagefile precheck is now advisory only; never force Safe Mode. */
export function pagefileRequiresSafeMode(memory, { allowSingleFork = false } = {}) {
  return false
}

/**
 * Decide how a missing pagefile affects boot. v3.8.13 no longer treats it as a
 * Safe Mode condition. It only reports whether free memory is below the advisory
 * 3000 MB floor; the actual memory guard still uses `memoryMinFreeMB`.
 */
export function decidePagefileBootPolicy(memory, { hostCriticalFreeMB = SAFE_MODE_AUTO_CLEAR_COMMIT_MB, minFreeMB = FORK_COMMIT_HARD_MIN_MB } = {}) {
  const missing = isPagefileMissing(memory)
  if (!missing) return { safeMode: false, singleForkOnly: false, reason: null, advisory: null }
  const commitFree = Number(memory?.commitFreeMB)
  const physicalFree = Number(memory?.physicalFreeMB)
  const freeMB = Number.isFinite(physicalFree) && physicalFree > 0 ? physicalFree : (Number.isFinite(commitFree) ? commitFree : null)
  const lowFree = Number.isFinite(freeMB) && freeMB < Number(minFreeMB)
  return {
    safeMode: false,
    // v3.9.4：页面文件缺失只提醒，绝不因此限制分身数量。
    singleForkOnly: false,
    reason: lowFree ? 'pagefile-missing-low-free' : 'pagefile-missing-advisory',
    advisory: 'pagefile-missing',
    lowFree,
    freeMB,
    commitFreeMB: Number.isFinite(commitFree) ? commitFree : null,
    minFreeMB: Number(minFreeMB),
    detail: '页面文件缺失：建议在 Windows 系统属性中设置页面文件；仅提醒，不限制分身数量，实际准入只按 Commit 余量判断。',
  }
}

// v3.9.4：分身默认容量 8，硬上限 62。maxForks 是准入配置，实际创建仍由内存/Commit 守卫裁决。
export const DEFAULT_MAX_FORKS = 8
export const HARD_MAX_FORKS = 62
// C1: host-state.json lastMetrics lag follows this timer; 15s reduces the
// heartbeat file write + host-state rewrite rate without losing crash evidence.
export const HOST_STATE_WRITE_INTERVAL_MS = 15000
// v3.9.2: the host memory/heap/session watchdog used to run every 5s. That
// meant a PowerShell/CIM probe, a session-directory stat pass and a heap sample
// every five seconds even when no fork existed. 15s keeps the same signals and
// lets readSystemMemory() cache one sample per tick.
export const HOST_WATCHDOG_INTERVAL_MS = 15000
// C4: explicit confirm token; confirmation is audited but never lifts the hard limit.
export const MULTI_FORK_CONFIRM_TOKEN = 'MULTI-FORK'

export const Config = z.object({
  role: z.union([z.const('mother'), z.const('fork')]).default('mother')
    .description('配置层角色；环境 DSH_FANG_ROLE 优先（forker 派生的分身自动为 fork）'),
  officialSourceUrl: z.string().default('')
    .description('官方源 manifest 基础 URL（https；留空 = 无官方源，升级显式 official-source-unavailable）'),
  officialSourceToken: z.string().default('')
    .description('官方源 Bearer token（可选；不会写进日志/状态）'),
  // v3.9.2: restore the operator-facing 8-fork capacity. Memory/commit gates
  // still refuse new forks when the host is under pressure; this only removes
  // the unconditional single-fork clamp that made the quota useless.
  maxForks: z.number().min(1).max(HARD_MAX_FORKS).default(DEFAULT_MAX_FORKS)
    .description('允许同时存活的分身上限；默认 8，硬上限 62；实际创建仍受 Commit 余量守卫'),
  allowMultiFork: z.boolean().default(true)
    .description('是否允许 maxForks>1；默认 true；内存不足时由 memoryGuard 拒绝，而不是把配额改成 1'),
  memoryGuard: z.boolean().default(true)
    .description('创建/打开/还原分身前检查 CommitFree、Host JS heap 与 session 文件体量'),
  memoryMinFreeMB: z.number().min(0).max(1048576).default(FORK_COMMIT_HARD_MIN_MB)
    .description('创建/打开/还原分身前检查 Windows CommitFree 余量；v3.9.4 默认 999 MB，低于该值禁止派生和启动'),
  hostWarnFreeMB: z.number().min(0).max(1048576).default(8192)
    .description('宿主内存警告阈值（MB，仅提示）'),
  hostCriticalFreeMB: z.number().min(0).max(1048576).default(SAFE_MODE_AUTO_CLEAR_COMMIT_MB)
    .description('宿主 Commit 紧急阈值（MB）：v3.9.4 默认 2345；达到该值 Safe Mode 自动解除'),
  hostEmergencyFreeMB: z.number().min(0).max(1048576).default(2048)
    .description('宿主最低保留（MB）；低于此值进入 Safe Mode 并隔离'),
  hostJsHeapWarnMB: z.number().min(32).max(1048576).default(1024)
    .description('Host JS heap 警告阈值（MB）；超过只审计/提示，不阻止已有任务'),
  hostJsHeapCriticalMB: z.number().min(33).max(1048576).default(1536)
    .description('Host JS heap 严重阈值（MB）；超过后拒绝新分身/新浏览器，避免继续加载大 session'),
  hostJsHeapEmergencyMB: z.number().min(34).max(1048576).default(2048)
    .description('Host JS heap 紧急阈值（MB）；连续 N 个 host tick 超过后按宿主紧急处置'),
  hostJsHeapEmergencyStreak: z.number().min(1).max(30).default(3)
    .description('Host JS heap 连续超过紧急阈值的采样次数；默认 3 次（15s tick 下约 45s）'),
  sessionFootprintEnabled: z.boolean().default(true)
    .description('是否周期盘点 Host/分身 sessions 下的 session.v4.jsonl.zstd 体量（只读 stat）'),
  sessionFootprintIntervalMs: z.number().min(5000).max(86400000).default(60000)
    .description('session 体量盘点间隔（毫秒）；默认 60s，避免每次 host tick 都扫目录'),
  sessionFootprintWarnMB: z.number().min(0).max(1048576).default(512)
    .description('全部 session 文件合计警告阈值（MB）'),
  sessionFootprintCriticalMB: z.number().min(0).max(1048576).default(1024)
    .description('全部 session 文件合计严重阈值（MB）'),
  sessionFootprintEmergencyMB: z.number().min(0).max(1048576).default(2048)
    .description('全部 session 文件合计紧急阈值（MB）；超过后只审计/横幅提示，单文件紧急线才拒绝新分身/新浏览器'),
  sessionFileWarnMB: z.number().min(0).max(1048576).default(16)
    .description('单个 session.v4 文件警告阈值（MB）'),
  sessionFileCriticalMB: z.number().min(0).max(1048576).default(32)
    .description('单个 session.v4 文件严重阈值（MB）'),
  sessionFileEmergencyMB: z.number().min(0).max(1048576).default(64)
    .description('单个 session.v4 文件紧急阈值（MB）；超过后拒绝新分身/新浏览器'),
  memoryWatchdog: z.boolean().default(true)
    .description('定时采样每个分身的 PID 树/Commit，异常增长时只杀该分身'),
  memoryAdaptiveThresholds: z.boolean().default(true)
    .description('按宿主物理内存自动缩放浏览器 Commit/JS heap 与分身杀阈值；关闭后使用下方固定值'),
  memoryWatchIntervalMs: z.number().min(5000).max(600000).default(15000)
    .description('内存看门狗采样间隔（毫秒）'),
  forkHealthGate: z.boolean().default(true)
    .description('打开托管浏览器前请求分身 /api/health，并检查 session 大小/事件数与 adapter 状态'),
  forkHealthPath: z.string().default('')
    .description('分身健康检查路径；留空=按 routes.prefix 推导 /<prefix>/api/health'),
  forkHealthTimeoutMs: z.number().min(100).max(30000).default(2000)
    .description('分身健康检查超时（毫秒）'),
  forkHealthMaxSessionMB: z.number().min(1).max(4096).default(500)
    .description('单文件硬上限（MB）；超过即拒绝打开'),
  forkHealthWarnSessionMB: z.number().min(1).max(4096).default(200)
    .description('单文件警戒线（MB）；超过显示警告但允许打开'),
  forkHealthConfirmSessionMB: z.number().min(1).max(4096).default(300)
    .description('单文件二次确认线（MB）；超过需用户确认'),
  forkHealthWarnTotalMB: z.number().min(1).max(4096).default(3000)
    .description('分身内会话合计警戒线（MB）；超过显示警告'),
  forkHealthConfirmTotalMB: z.number().min(1).max(4096).default(3600)
    .description('分身内会话合计二次确认线（MB）；超过需用户确认'),
  forkHealthHardTotalMB: z.number().min(1).max(4096).default(3900)
    .description('分身内会话合计硬上限（MB）；超过即拒绝打开'),
  forkHealthMaxEvents: z.number().min(1).max(10000000).default(1000000)
    .description('打开前允许的最大单会话事件数；超过或扫描截断即拒绝打开并要求归档/压缩'),
  forkFlushTimeoutMs: z.number().min(100).max(30000).default(3000)
    .description('关闭浏览器前等待 fork flush 的总预算（毫秒；超时按 unsupported/未确认处理，不假装保存）'),
  browserCrashWindowMs: z.number().min(60_000).max(60 * 60 * 1000).default(10 * 60_000)
    .description('同一任务浏览器崩溃退避窗口（毫秒）'),
  browserCrashThreshold: z.number().min(1).max(10).default(2)
    .description('同一任务在窗口内浏览器崩溃次数达到该值时隔离（browser-crash-loop）'),
  memoryProcessScanIntervalMs: z.number().min(10000).max(600000).default(30000)
    .description('全进程表最小采样间隔（毫秒）；中间的 tick 复用缓存表并只做 liveness/CDP 按需检查'),
  browserCdpSampleIntervalMs: z.number().min(15000).max(600000).default(15000)
    .description('托管浏览器 CDP heap/DOM/visibility 采样间隔（毫秒）；v3.8.5 默认 15s，中间复用上次 CDP 指标'),
  processPriority: z.union([z.const('below-normal'), z.const('idle')]).default('below-normal')
    .description('托管浏览器/分身的进程优先级档位；idle 更低但可能拖慢页面，默认 below-normal'),
  memoryKillCommitMB: z.number().min(128).max(1048576).default(2048)
    .description('固定兜底：单个分身 PID 树 commit 超过该值（MB）才进入杀进程候选；自适应开启时仅无内存探针时使用'),
  memoryGrowCommitMB: z.number().min(64).max(1048576).default(768)
    .description('固定兜底：相对该分身低点增长超过该值（MB）才杀；自适应开启时按有效杀阈值等比缩放'),
  diagnosticLogMaxMB: z.number().min(1).max(1024).default(16)
    .description('browser-samples/memory-samples 单个活动日志上限（MB），超过即轮转'),
  diagnosticLogRetentionDays: z.number().min(1).max(365).default(7)
    .description('轮转后的诊断日志保留天数，过期归档自动清理'),
  // v3.9.2: multi-fork is a first-class quota again. Keeping this true silently
  // paused every sibling fork on start/open, which made `maxForks` irrelevant.
  singleActiveFork: z.boolean().default(false)
    .description('false（默认）：允许多个分身并存；true 时启动新分身会暂停其他运行中的分身'),
  managedBrowser: z.boolean().default(true)
    .description('由 Fang 启动独立 Chromium 窗口并纳入 PID/CDP 监控'),
  autoClose: z.boolean().default(true)
    .description('内存/空闲触发时自动关闭托管浏览器，默认 true，不再二次确认；只清进程，home 与会话文件保留'),
  browserPath: z.string().default('')
    .description('托管浏览器 exe；留空自动找 Edge/Chrome'),
  maxOpenForkBrowsers: z.number().min(1).max(16).default(1)
    .description('同时存活的托管浏览器窗口上限'),
  browserMemoryLimitMB: z.number().min(256).max(1048576).default(2048)
    .description('托管浏览器 PID 树 Commit 硬上限（MB）；默认 2048，自适应阈值只能更严不能放宽'),
  browserHeapLimitMB: z.number().min(128).max(1048576).default(1536)
    .description('托管浏览器 JS heap 硬上限（MB）；默认 1536，自适应阈值只能更严不能放宽'),
  browserJobObject: z.boolean().default(true)
    .description('Windows 下用 Job Object 托管浏览器进程树，宿主被杀/冻结时内核回收'),
  browserJobProcessMemoryMB: z.number().min(256).max(1048576).default(2048)
    .description('浏览器 Job 单进程 Commit 上限（MB）'),
  browserJobTotalMemoryMB: z.number().min(256).max(1048576).default(2048)
    .description('浏览器 Job 总 Commit 上限（MB）'),
  gracefulBrowserCloseMs: z.number().min(0).max(30000).default(3000)
    .description('CDP Browser.close 后等待优雅退出的时间；超时才 taskkill'),
  idleCloseOnlyWhenIdle: z.boolean().default(true)
    .description('只关闭确认空闲的 fork 页面；无法确认活跃状态时不自动关'),
  pauseHiddenTab: z.boolean().default(false)
    .description('实验开关：页面隐藏时用 CDP Page.setWebLifecycleState=frozen 暂停渲染；默认关闭，真机验证恢复可见可 active 后再考虑默认开启'),
  browserSingleAppWindow: z.boolean().default(true)
    .description('一个 fork profile 只保留一个 app page；启动后和看门狗周期用 CDP 关闭多余标签'),
  orphanSweepMinutes: z.number().min(0).max(1440).default(5)
    .description('孤儿 fork 进程清理间隔（分钟；0=仅启动时）'),
  watchdogHostStuckMs: z.number().min(15000).max(600000).default(60000)
    .description('独立看门狗判定宿主卡死的 heartbeat 静默阈值（毫秒）；默认 60s'),
  forkFlushPath: z.string().default('')
    .description('关闭浏览器前调用的 fork 会话落盘路径（显式覆盖）；留空=只用 fork health 广告的 flush 或实际注册的 /<prefix>/adapter/flush-session，不猜 /api/session/* 端点'),
  forkCommitShareLimit: z.number().min(0.05).max(1).default(FORK_COMMIT_SHARE_DEFAULT)
    .description('fork+browser 聚合 Commit 占系统上限的比例；超过即紧急处置'),
  forkCommitHostReserveMB: z.number().min(0).max(1048576).default(HOST_COMMIT_RESERVE_MB_DEFAULT)
    .description('v3.8.13：无论 fork 占比多少，都必须为宿主保留的 CommitLimit 余量（MB）'),
  forkCommitWarnShare: z.number().min(0.05).max(1).default(0.3)
    .description('聚合 Commit 警告阈值'),
  forkCommitSevereShare: z.number().min(0.05).max(1).default(0.35)
    .description('聚合 Commit 严重阈值'),
  browserDomNodeLimit: z.number().min(1000).max(10000000).default(200000)
    .description('托管浏览器 DOM 节点硬上限，默认 200000，达到即关闭'),
  autoCloseIdleMinutes: z.number().min(0).max(1440).default(10)
    .description('页面隐藏且无运行任务超过该分钟数自动关闭浏览器（0=不关；home 保留）'),
  quarantineOnGuard: z.boolean().default(true)
    .description('内存护栏触发后隔离任务，禁止自动重连'),
  safeModeAfterCrash: z.boolean().default(true)
    .description('上次宿主非正常退出时启动 Safe Mode，禁止自动恢复分身'),
  hostCrashMaxEntries: z.number().min(10).max(1000).default(50)
    .description('host-crashes.json 保留的最大崩溃条数（超出丢弃最旧条目）'),
  hostCrashWindowMinutes: z.number().min(1).max(1440).default(10)
    .description('host-crashes.json 的崩溃循环窗口（分钟）；safe-mode 原因与 UI 文案同源，默认 10'),
  hostCrashRetentionDays: z.number().min(1).max(365).default(30)
    .description('host-crashes.json 崩溃条目最长保留天数'),
  watchdogRetentionDays: z.number().min(1).max(365).default(7)
    .description('旧 watchdog-<pid>.json 最长保留天数；死亡 PID 文件超期移入回收目录'),
  watchdogMaxFiles: z.number().min(0).max(200).default(20)
    .description('旧 watchdog-<pid>.json 最多保留份数；当前宿主文件始终保留'),
  autoRestoreForks: z.boolean().default(false)
    .description('宿主启动时自动恢复上次运行的分身（默认关闭）'),
  motherProfile: z.string().default('')
    .description('母体 profile 名；留空 = 当前 profile（分身模板来源）'),
  profileTemplate: z.string().default('')
    .description('分身 profile 模板目录；留空 = 当前 profile 目录（Forker 的 cleanTemplate 会覆盖）'),
  fangHome: z.string().default('')
    .description('三区数据根（相当于 FANG_HOME）；留空 = D:\\ToFuture\\FangData（旧数据需显式迁移）'),
  enforceDataIsolation: z.boolean().default(true)
    .description('拒绝把 Fang 数据/分身 home 写进宿主或工程目录（如 E:\\DSH\\DS）'),
  forbiddenDataRoots: z.array(z.string()).default(DEFAULT_FORBIDDEN_ROOTS)
    .description('禁止作为 Fang 数据根的目录前缀'),
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
  sessionCompactEnabled: z.boolean().default(true)
    .description('归档后自动对超过阈值的大 session.v4 日志做无损重压缩（保留硬链接回滚备份）'),
  sessionCompactBytes: z.number().min(0).max(1073741824).default(16777216)
    .description('触发会话日志压缩的最小压缩字节数（默认 16 MiB；0 = 所有多帧日志）'),
  sessionCompactMaxBytes: z.number().min(1048576).max(1073741824).default(134217728)
    .description('单文件压缩上限（默认 128 MiB；超过则跳过，避免一次读入过多内存）'),
  sessionCompactLevel: z.number().min(1).max(19).default(9)
    .description('zstd 重压缩等级（默认 9；19 更省空间但 CPU/耗时显著更高）'),
  sessionCompactIntervalMs: z.number().min(0).max(86400000).default(600000)
    .description('归档任务会话压缩巡检间隔（毫秒；0 = 只在新归档时触发）'),
  sessionCompactLegacyEnabled: z.boolean().default(true)
    .description('是否压缩 <dataDir>/sessions/**/legacy 下的迁移历史日志（不压缩活动会话；仍保留硬链接备份）'),
  diskHygieneEnabled: z.boolean().default(true)
    .description('是否定期盘点托管浏览器缓存与 Windows 搜索索引大小（只读，不删除）'),
  diskHygieneIntervalMs: z.number().min(60000).max(86400000).default(1800000)
    .description('磁盘卫生盘点间隔（毫秒，默认 30 分钟；只读扫描，不产生清理动作）'),
  browserCacheCleanupEnabled: z.boolean().default(false)
    .description('归档时是否自动把可重建的浏览器缓存移入回收目录（默认关闭；只移动 Cache/Code Cache 等，不碰登录态）'),
  browserCacheCleanupMinBytes: z.number().min(0).max(1073741824).default(67108864)
    .description('触发浏览器缓存清理的最小缓存字节数（默认 64 MiB）'),
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
  // 必须在 roleGate 之前：fork 角色也要执行（experimental-inspector 在 fork/元主都可能加载）。
  try { normalizeFetchDescriptor(globalThis) } catch { /* best effort */ }
  // EB-03 全局红线：所有 fork 进程只能写自己的 DSH_HOME；母体/客户端/其他分身写入即 EPERM。
  if (String(process.env.DSH_FANG_ROLE ?? '').toLowerCase() === 'fork') {
    try {
      installGlobalRedline({
        ownHome: process.env.DSH_HOME,
        motherData: process.env.DSH_FANG_MOTHER,
        logger: ctx.logger,
      })
    } catch { /* guard must never prevent fork boot; failures are audited by caller */ }
  }
  const cfg = { ...Config({}), ...(config ?? {}) }
  // C4: remember whether the operator asked for multi-fork before the hard red line
  // clamps it back to 1. The status/confirm endpoints can then explain the refusal.
  const requestedMultiFork = Number(config?.maxForks) > HARD_MAX_FORKS || config?.allowMultiFork === true
  // C5: normalize the only two safe tiers once; never pass arbitrary strings to PowerShell.
  const processPriorityClass = cfg.processPriority === 'idle' ? 'Idle' : 'BelowNormal'
  const hostCrashWindowMinutes = Math.max(1, Math.min(1440, Math.round(Number(cfg.hostCrashWindowMinutes) || 10)))
  const hostCrashWindowMs = hostCrashWindowMinutes * 60_000
  // v3.8.13: maxForks is a hard single-fork red line. `allowMultiFork` is kept
  // as a compatibility field but can no longer open a second fork. Legacy tests
  // that exercise multi-task bookkeeping may opt in through an env-gated hook;
  // production processes never see NODE_TEST_CONTEXT.
  // v3.9.2: no unconditional production clamp. `maxForks` is an operator quota;
  // `memoryGate`/`main-city` are the actual safety gates.
  const testOnlyMultiFork = Boolean(process.env.NODE_TEST_CONTEXT) && config?.__testOnlyAllowMultiFork === true
  const effectiveMaxForks = () => {
    return Math.max(1, Math.min(HARD_MAX_FORKS, Math.floor(Number(cfg.maxForks) || DEFAULT_MAX_FORKS)))
  }
  const forkHealthPath = String(cfg.forkHealthPath || '').trim() || forkHealthPathForPrefix(cfg.routes?.prefix)
  const forkPrefix = String(cfg.routes?.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'
  const forkFlushDefaultPath = `${forkPrefix}/adapter/flush-session`
  const gate = roleGate('orchestrator', { cfgRole: cfg.role, logger: ctx.logger })
  if (!gate.active) return
  // 部署工具用这个标识区分“仍是本实例”与“同一端口被别的服务占用”。
  const instanceId = `fang-${gate.role}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  // 2026-11-22：宿主 watcher EPERM 不应杀死整个 DSH host。在加载业务插件前安装
  // fs.watch error 降级层（止损；上游仍应修复 watcher error 处理）。
  try {
    if (process.env.DSH_FANG_WATCH_GUARD === '1') {
      const watchGuard = installWatchGuard({ logger: ctx.logger })
      if (watchGuard.ok === true && watchGuard.already !== true) ctx.logger?.info?.('[fang] fs.watch error guard installed')
    }
  } catch { /* guard 失败不阻塞插件加载 */ }
  const role = gate.role

  const layout = resolveFangLayout({ dataRoot: cfg.dataRoot, forksRoot: cfg.forksRoot, fangHome: cfg.fangHome })
  // P2 #10: migration is performed while the host is stopped; read the latest
  // report once at boot so the panel can show what was copied/conflicted.
  const migrationReport = readLatestMigrationReport(layout.fangHome || layout.canonicalFangHome)
  const isolationChecks = [
    ['dataDir', layout.dataDir],
    ['essenceRoot', layout.essenceRoot],
    ['forksRoot', layout.forkHomesDir],
    ['sessionsRoot', layout.sessionsRoot],
    ['runtimeRoot', layout.runtimeRoot],
  ].map(([name, target]) => ({ name, ...assertDataPath(target, { fangHome: layout.fangHome, forbiddenRoots: cfg.forbiddenDataRoots }) })).filter((item) => item.ok !== true)
  const isolationBlocked = cfg.enforceDataIsolation === true
    && !process.env.NODE_TEST_CONTEXT
    && !/e2e/i.test(String(process.argv[1] ?? ''))
    && isolationChecks.length > 0
  if (isolationBlocked) {
    try { ctx.logger?.error?.(`[fang] data isolation blocked: ${isolationChecks.map((item) => `${item.name}=${item.error}`).join(', ')}`) } catch { /* logger optional */ }
  }
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
    if (task?.essenceId) {
      captureEssenceRuntimeIfPresent(task.essenceId)
      if (task.essenceId === OFFICIAL_ESSENCE_ID) await repairOfficialEssenceNow()
    }
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
  // 元主 Web（essence runtime）不是 task，但它的托管浏览器也必须进入
  // watchdog/慌张清单；否则最后两个 window.open 只能继续回退外部浏览器。
  const runtimeBrowsers = new Map()

  // v3.8.0: host crash latch. A previous host that did not write cleanShutdown
  // means the last run died; enter Safe Mode unless explicitly disabled.
  const safeModeFile = path.join(layout.dataDir, 'safe-mode.json')
  const hostStateFile = path.join(layout.dataDir, 'host-state.json')
  const hostCrashFile = path.join(layout.dataDir, 'host-crashes.json')
  const readJsonFile = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
  const previousHost = readJsonFile(hostStateFile)
  const previousSafeMode = readJsonFile(safeModeFile)
  const unclean = Boolean(previousHost && previousHost.clean !== true && Number(previousHost.pid) !== process.pid)
  let safeMode = Boolean(previousSafeMode?.safeMode)
  let safeModeReason = String(previousSafeMode?.reason ?? '')
  // Emergency admission latch is independent from the persisted Safe Mode:
  // it closes new fork/browser creation immediately, while status/panic routes
  // stay reachable for the operator.
  let hostAdmissionClosed = Boolean(safeMode)
  const hostStartedAt = new Date().toISOString()
  let lastHostMetrics = null
  let lastProcessCount = 0
  let lastHostHeapDecision = null
  let lastSessionFootprint = null
  let lastSessionFootprintDecision = null
  let lastSessionFootprintAt = 0
  let hostHeapPressureGate = false
  let sessionFootprintGate = false
  let hostHeapEmergencyCount = 0
  let lastHostHeapWarnAt = 0
  let lastHostHeapCriticalAt = 0
  let lastHostHeapEmergencyAt = 0
  let lastSessionWarnAt = 0
  let lastSessionCriticalAt = 0
  const mb = (bytes) => Math.round((Number(bytes) || 0) / 1048576 * 10) / 10
  const sampleHostHeap = () => {
    const self = process.memoryUsage()
    let stats = null
    try { stats = v8.getHeapStatistics() } catch { /* metrics only */ }
    return {
      at: nowMs(),
      heapUsedMB: mb(self.heapUsed),
      heapTotalMB: mb(self.heapTotal),
      heapLimitMB: stats ? mb(stats.heap_size_limit) : 0,
      externalMB: mb(self.external),
      arrayBuffersMB: mb(self.arrayBuffers),
    }
  }
  const hostHeapLimits = (heapLimitMB = 0) => resolveHostHeapLimits(cfg, heapLimitMB)
  const sessionFootprintLimits = () => ({
    sessionFootprintWarnMB: Number(cfg.sessionFootprintWarnMB),
    sessionFootprintCriticalMB: Number(cfg.sessionFootprintCriticalMB),
    sessionFootprintEmergencyMB: Number(cfg.sessionFootprintEmergencyMB),
    sessionFileWarnMB: Number(cfg.sessionFileWarnMB),
    sessionFileCriticalMB: Number(cfg.sessionFileCriticalMB),
    sessionFileEmergencyMB: Number(cfg.sessionFileEmergencyMB),
  })
  const currentPressureGate = () => {
    if (hostHeapPressureGate) {
      return {
        ok: false,
        error: 'host-js-heap-pressure',
        detail: `Host JS heap ${lastHostHeapDecision?.heapUsedMB ?? '?'} MB 已达到严重阈值 ${lastHostHeapDecision?.criticalMB ?? cfg.hostJsHeapCriticalMB} MB；先释放/重启宿主，再打开新任务。`,
        heap: lastHostHeapDecision,
      }
    }
    if (sessionFootprintGate) {
      return {
        ok: false,
        error: 'session-footprint-pressure',
        detail: `session 文件体量 ${lastSessionFootprintDecision?.totalMB ?? '?'} MB / 单文件 ${lastSessionFootprintDecision?.largestMB ?? '?'} MB 已达到紧急阈值；先归档或压缩会话，再打开新任务。`,
        session: lastSessionFootprintDecision,
      }
    }
    return { ok: true }
  }
  const currentPressurePolicy = () => ({
    heap: hostHeapLimits(Number(lastHostMetrics?.heapLimitMB) || 0),
    session: sessionFootprintLimits(),
    stack: {
      heapGate: hostHeapPressureGate,
      sessionGate: sessionFootprintGate,
    },
  })
  let hostCleanExit = false
  const now = nowMs()
  const crashDoc = readJsonFile(hostCrashFile)
  const priorCrashes = Array.isArray(crashDoc?.crashes) ? crashDoc.crashes : []
  const crashHistory = priorCrashes.slice()
  const previousMetrics = previousHost?.lastMetrics && typeof previousHost.lastMetrics === 'object'
    ? previousHost.lastMetrics
    : null
  if (unclean) {
    crashHistory.push({
      at: now,
      previousPid: previousHost?.pid ?? null,
      reason: 'unclean-shutdown',
      metrics: previousMetrics,
      processCount: Number(previousMetrics?.processCount) || null,
    })
  }
  const crashPrune = pruneHostCrashHistory(crashHistory, {
    now,
    maxEntries: cfg.hostCrashMaxEntries,
    retentionDays: cfg.hostCrashRetentionDays,
  })
  // The JSON counter keeps only the configured crash-loop window. Full history
  // (with metrics) goes to host-crashes.jsonl so a crash loop cannot grow it.
  const recent = crashPrune.crashes.filter((item) => now - Number(item.at) <= hostCrashWindowMs)
  if (unclean || crashDoc) {
    const pruned = crashPrune.changed
      ? { at: now, expired: crashPrune.expired, dropped: crashPrune.dropped }
      : (crashDoc?.pruned ?? null)
    try {
      fs.writeFileSync(hostCrashFile, JSON.stringify({
        crashes: recent,
        cap: crashPrune.maxEntries,
        retentionDays: crashPrune.retentionDays,
        windowMinutes: hostCrashWindowMinutes,
        pruned,
      }, null, 2))
    } catch { /* best effort */ }
  }
  // Red line: one crash is context; two crashes within the configured window means a loop.
  // v3.9.5：只有崩溃样本携带真实资源压力（低 Commit / heap 临界 / session 紧急）才全局封门。
  // 普通关闭/重启在 Windows 上常被记为 unclean-shutdown；若 Commit 仍有 25 GB，
  // 仅凭“两次 unclean”封住所有分身会直接把瓮城锁死，违背守卫的初衷。
  const recentHasResourcePressure = recent.some((item) => hasHostCrashPressure(item?.metrics, { criticalFreeMB: cfg.hostCriticalFreeMB }))
  if (unclean && cfg.safeModeAfterCrash === true && !safeMode && recent.length >= 2 && recentHasResourcePressure) {
    safeMode = true
    safeModeReason = 'crash-loop-10m'
    if (hostCrashWindowMinutes !== 10) safeModeReason = `crash-loop-${hostCrashWindowMinutes}m`
    hostAdmissionClosed = true
  }
  // A fresh host process is an explicit recovery boundary: clear per-task
  // quarantine latches, but keep tokens revoked so the old page cannot reconnect.
  let quarantineReset = 0
  if (previousHost?.pid !== process.pid) {
    for (const task of tasks.values()) {
      if (!task.quarantined) continue
      task.quarantineCleared = { at: nowMs(), reason: 'host-restart' }
      task.quarantined = null
      task.token = ''
      task.url = ''
      // C3: an archived task swept by an allTasks panic stays archived after restart.
      if (task.status !== TASK_STATUS.ARCHIVED) task.status = TASK_STATUS.FAILED
      task.pid = null
      task.port = null
      quarantineReset += 1
    }
    if (quarantineReset) {
      try { saveRegistry(layout.tasksFile, [...tasks.values()].map(task => ({
        ...task, token: '', url: stripUrlToken(task.url),
        browser: task.browser ? { ...task.browser, metricsHistory: undefined } : task.browser,
      }))) } catch { /* best effort */ }
    }
  }
  const persistSafeMode = () => {
    try { fs.writeFileSync(safeModeFile, JSON.stringify({ safeMode, reason: safeModeReason, at: new Date().toISOString() }, null, 2)) } catch { /* best effort */ }
  }
  persistSafeMode()
  try { fs.writeFileSync(hostStateFile, JSON.stringify({ pid: process.pid, startedAt: hostStartedAt, clean: false, lastMetrics: lastHostMetrics }, null, 2)) } catch { /* best effort */ }
  try {
    ctx.effect(() => () => {
      hostCleanExit = true
      try { fs.writeFileSync(hostStateFile, JSON.stringify({ pid: process.pid, startedAt: hostStartedAt, exitedAt: new Date().toISOString(), clean: true, lastMetrics: lastHostMetrics }, null, 2)) } catch { /* best effort */ }
      try {
        const prior = JSON.parse(fs.readFileSync(watchdogFile, 'utf8'))
        fs.writeFileSync(watchdogFile, JSON.stringify({ ...prior, hostPid: process.pid, clean: true, at: new Date().toISOString() }, null, 2))
      } catch { /* best effort */ }
    })
  } catch { /* fake ctx */ }

  // v3.8.0 independent watchdog: a detached Node/Electron process cleans up
  // managed browsers/fork trees if this host is force-killed. It never reads
  // user data and acts only on PIDs written here.
  const watchdogFile = path.join(layout.dataDir, `watchdog-${process.pid}.json`)
  // Job helper heartbeat: separate from watchdog.json (which only changes on
  // state transitions) and refreshed on a fixed timer. A frozen host stops
  // refreshing it; the per-fork helper then terminates the kernel job.
  const hostHeartbeatFile = path.join(layout.dataDir, `watchdog-${process.pid}.heartbeat`)
  const writeHostHeartbeat = () => {
    if (hostCleanExit) return
    try {
      fs.writeFileSync(hostHeartbeatFile, JSON.stringify({ hostPid: process.pid, at: new Date().toISOString() }), 'utf8')
    } catch { /* best effort: helper also watches the host process */ }
    try {
      const snapshot = lastHostMetrics ?? { at: Date.now(), processCount: lastProcessCount || null }
      fs.writeFileSync(hostStateFile, JSON.stringify({
        pid: process.pid, startedAt: hostStartedAt, clean: false, lastMetrics: snapshot,
      }, null, 2))
    } catch { /* best effort */ }
  }
  writeHostHeartbeat()
  // C1: 15s keeps host-state.json close enough to a hard kill while cutting
  // the file-write rate to one third of the old 5s heartbeat.
  const hostHeartbeatTimer = setInterval(writeHostHeartbeat, HOST_STATE_WRITE_INTERVAL_MS)
  hostHeartbeatTimer.unref?.()
  try {
    ctx.effect?.(() => () => { clearInterval(hostHeartbeatTimer) })
  } catch { /* fake ctx in tests */ }
  const writeWatchdog = () => {
    const targets = []
    for (const task of tasks.values()) {
      if (task.browser?.pid) {
        const browser = task.browser
        targets.push({
          pid: Number(browser.pid),
          kind: 'browser',
          taskId: task.taskId,
          createdAt: browser.pidIdentity?.startedAt ?? browser.startedAt ?? null,
          commandLineHash: browser.pidIdentity?.commandLineHash ?? null,
          tokens: browser.profileDir && Number(browser.port) > 0
            ? [`--user-data-dir=${browser.profileDir}`, `--remote-debugging-port=${browser.port}`]
            : [],
          port: browser.port,
        })
      }
      if (task.pid && task.status !== TASK_STATUS.ARCHIVED) {
        targets.push({
          pid: Number(task.pid),
          kind: 'fork',
          taskId: task.taskId,
          createdAt: task.pidIdentity?.startedAt ?? task.pidStartedAt ?? null,
          commandLineHash: task.pidIdentity?.commandLineHash ?? null,
          tokens: task.profile && Number(task.port) > 0
            ? [String(task.profile), '--port', String(task.port)]
            : [],
          profile: task.profile,
          port: task.port,
        })
      }
    }
    for (const runtime of runtimeBrowsers.values()) {
      const browser = runtime.browser
      if (!browser?.pid) continue
      targets.push({
        pid: Number(browser.pid),
        kind: 'browser',
        taskId: runtime.taskId,
        runtime: true,
        createdAt: browser.pidIdentity?.startedAt ?? browser.startedAt ?? null,
        commandLineHash: browser.pidIdentity?.commandLineHash ?? null,
        tokens: browser.profileDir && Number(browser.port) > 0
          ? [`--user-data-dir=${browser.profileDir}`, `--remote-debugging-port=${browser.port}`]
          : [],
        port: browser.port,
      })
    }
    try { fs.writeFileSync(watchdogFile, JSON.stringify({ hostPid: process.pid, hostStartedAt: Date.now() - Math.round(process.uptime() * 1000), clean: false, at: new Date().toISOString(), heartbeatFile: hostHeartbeatFile, hostStuckMs: Number(cfg.watchdogHostStuckMs), targets }, null, 2)) } catch { /* best effort */ }
  }
  writeWatchdog()
  const testLike = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.DSH_FANG_E2E === '1' || /(?:test|e2e)/i.test(String(process.argv[1] ?? ''))
  const sidecarAlready = globalThis.__fangWatchdogSidecar === true
  if (process.platform === 'win32' && process.env.DSH_FANG_DISABLE_SIDECAR !== '1' && !testLike && !sidecarAlready) {
    globalThis.__fangWatchdogSidecar = true
    try {
      // IMPORTANT: never spawn process.execPath here. In a packaged DSH host that
      // is DeepSeek Harness.exe, and ELECTRON_RUN_AS_NODE may be fused off; it
      // would boot a second host, corrupt the profile, and trigger the exact
      // "Failed to load plugins" / handler-threw failure seen in v3.8.0.
      const nodeCandidates = [
        process.env.DSH_FANG_NODE_EXE,
        path.join(path.dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
        'D:\\DSH\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe',
      ].filter(Boolean)
      const nodeExe = nodeCandidates.find((candidate) => exists(candidate))
      if (!nodeExe) {
        audit('watchdog-sidecar-unavailable', { reason: 'bundled-node-not-found' })
      } else {
        const sidecar = fileURLToPath(new URL('../lib/watchdog-sidecar.mjs', import.meta.url))
        const child = spawn(nodeExe, [sidecar, watchdogFile], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        child.on('error', () => {})
        child.unref()
      }
    } catch { /* sidecar is best effort; host watchdog remains */ }
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
  // P0: existing fork homes may still point at the shared E:\DSH\DS tree.
  // Migrate them once at startup (metadata + Fang-owned session dirs only) so
  // an old workspace is not reused by the next fork merely because it was
  // created before this fix. Idempotent; failures are audited, never fatal.
  const startupWorkspaceMigrations = []
  {
    const homes = new Set()
    for (const task of tasks.values()) {
      const home = String(task?.homeDir ?? '').trim()
      if (home) homes.add(home)
    }
    try {
      for (const entry of fs.readdirSync(layout.forkHomesDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) homes.add(path.join(layout.forkHomesDir, entry.name))
      }
    } catch { /* first boot has no fork homes */ }
    for (const home of homes) {
      if (!exists(path.join(home, 'storages', 'workspace.json'))) continue
      let result
      try {
        result = migrateForkWorkspace(home, { roots: workspaceMigrationRoots(cfg) })
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error), changed: false, mappings: [], moved: [], conflicts: [] }
      }
      if (result.changed || (result.conflicts?.length ?? 0) > 0 || result.ok === false) {
        startupWorkspaceMigrations.push({ home, ...result })
        try {
          audit('fork-workspace-migrated-startup', {
            home,
            changed: result.changed === true,
            mappings: result.mappings?.length ?? 0,
            moved: result.moved?.length ?? 0,
            conflicts: result.conflicts?.slice(0, 5) ?? [],
            error: result.error ?? null,
          })
        } catch { /* audit optional */ }
      }
    }
  }

  // P2#4: every host boot creates watchdog-<pid>.json. Dead PID files are
  // bounded here (retention + count) and moved to the same-volume recycle
  // directory instead of being silently deleted.
  try {
    const watchdogCleanup = cleanupWatchdogFiles({
      dataDir: layout.dataDir,
      currentPid: process.pid,
      maxFiles: cfg.watchdogMaxFiles,
      retentionDays: cfg.watchdogRetentionDays,
      recycleDir: path.join(layout.dataDir, 'recycle', 'watchdog'),
      isPidAlive,
    })
    if (watchdogCleanup.moved > 0 || watchdogCleanup.errors.length > 0) {
      audit('watchdog-files-pruned', {
        moved: watchdogCleanup.moved,
        kept: watchdogCleanup.kept,
        recycleDir: watchdogCleanup.recycleDir,
        errors: watchdogCleanup.errors.slice(0, 10),
      })
    }
  } catch (error) {
    audit('watchdog-files-pruned', { moved: 0, error: String(error?.message ?? error).slice(0, 300) })
  }
  const persist = () => {
    try {
      // v3.0.5/B4：tasks.json 不落 token，URL 也不带 ?token=（打开时走 open-url 临时下发）
      saveRegistry(layout.tasksFile, [...tasks.values()].map(task => ({
        ...task, token: '', url: stripUrlToken(task.url),
        browser: task.browser ? { ...task.browser, metricsHistory: undefined } : task.browser,
      })))
    } catch { /* best effort */ }
  }
  const forker = () => safeGet(SERVICE.forker)

  /** 2026-11-24: commit-memory guard before any new renderer/spawn. */
  let pagefileWarned = false
  let memorySnapshot = null
  // Last successful capacity keeps adaptive limits stable when a later probe
  // fails; falling back to the fixed 2 GB would loosen an 8 GB host's limits.
  let lastGoodMemory = null
  const rememberMemory = (memory) => {
    if (!memory || typeof memory !== 'object') return memory
    memorySnapshot = {
      ok: memory.ok === true,
      supported: memory.supported !== false,
      source: memory.source ?? null,
      commitLimitMB: Number(memory.commitLimitMB) || 0,
      commitFreeMB: Number(memory.commitFreeMB) || 0,
      physicalTotalMB: Number(memory.physicalTotalMB) || 0,
      physicalFreeMB: Number(memory.physicalFreeMB) || 0,
      pageFileMB: Number(memory.pageFileMB) || 0,
      hasPageFile: memory.hasPageFile === true || Number(memory.pageFileMB) > 0,
      pagingFiles: String(memory.pagingFiles ?? ''),
      pagingFilesEmpty: memory.pagingFilesEmpty === true,
      automaticManagedPagefile: memory.automaticManagedPagefile === true,
      commitLimitNearRam: memory.commitLimitNearRam === true,
      pagefileMissing: isPagefileMissing(memory),
      checkedAt: nowMs(),
      cached: memory.cached === true,
      error: memory.error ?? null,
    }
    if (memorySnapshot.ok === true && (memorySnapshot.physicalTotalMB > 0 || memorySnapshot.commitLimitMB > 0)) {
      lastGoodMemory = memorySnapshot
    }
    return memory
  }
  const notePagefile = (memory, action) => {
    if (memory?.ok === true && isPagefileMissing(memory) && !pagefileWarned) {
      pagefileWarned = true
      audit('pagefile-missing', {
        action,
        pageFileMB: Number(memory.pageFileMB) || 0,
        pagingFilesEmpty: memory.pagingFilesEmpty === true,
        commitLimitNearRam: memory.commitLimitNearRam === true,
        commitLimitMB: memory.commitLimitMB,
        commitFreeMB: memory.commitFreeMB,
      })
    }
  }
  /** Effective limits for this host; fixed values remain the no-probe fallback. */
  const memoryPolicySnapshot = () => ({
    ...resolveMemoryThresholds(cfg, memorySnapshot?.ok === true ? memorySnapshot : lastGoodMemory),
    hostCriticalFreeMB: Number(cfg.hostCriticalFreeMB),
    memoryMinFreeMB: Number(cfg.memoryMinFreeMB),
    safeModeAutoClearCommitMB: SAFE_MODE_AUTO_CLEAR_COMMIT_MB,
    forkCommitHardMinMB: FORK_COMMIT_HARD_MIN_MB,
  })
  // Boot probe: the banner must be visible before the first gate/host tick even
  // when every fork is idle. A failed probe leaves memorySnapshot=null and the
  // UI stays silent instead of inventing a warning.
  //
  // Boot pagefile precheck: a missing/disabled page file is a system-level
  // precondition that Fang cannot repair from inside the plugin. Force Safe Mode
  // before any autostart can spawn a DSH fork; otherwise the next boot can hit
  // the same Windows commit/read failure before the Fang watchdog is loaded.
  let bootPagefileGate = Promise.resolve({ ok: true, skipped: 'non-windows' })
  if (process.platform === 'win32') {
    bootPagefileGate = (async () => {
      let memory
      try {
        memory = rememberMemory(await readSystemMemory({ force: true }))
      } catch (error) {
        audit('safe-mode-pagefile-probe-failed', { action: 'boot', detail: String(error?.message ?? error).slice(0, 300) })
        return { ok: false, error: 'memory-probe-threw' }
      }
      notePagefile(memory, 'boot')
      const bootPolicy = decidePagefileBootPolicy(memory, { hostCriticalFreeMB: cfg.hostCriticalFreeMB, minFreeMB: cfg.memoryMinFreeMB })
      if (bootPolicy.advisory === 'pagefile-missing') {
        audit('pagefile-missing-advisory', {
          action: 'boot',
          pageFileMB: Number(memory.pageFileMB) || 0,
          commitLimitMB: memory.commitLimitMB,
          commitFreeMB: memory.commitFreeMB,
          physicalFreeMB: memory.physicalFreeMB,
          hasPageFile: memory.hasPageFile,
          pagingFilesEmpty: memory.pagingFilesEmpty === true,
          commitLimitNearRam: memory.commitLimitNearRam === true,
          lowFree: bootPolicy.lowFree === true,
        })
      }
      // v3.9.4：页面文件缺失不再改变准入。只保留一次提示性审计，绝不写
      // single-fork 限制，也不因它回写 Safe Mode 状态。
      if (bootPolicy.advisory === 'pagefile-missing') {
        audit('pagefile-missing-advisory-only', {
          action: 'boot', pageFileMB: Number(memory.pageFileMB) || 0, commitFreeMB: bootPolicy.commitFreeMB,
          lowFree: bootPolicy.lowFree === true, enforcedSingleFork: false,
        })
      }
      return { ok: true, safeMode: false, pageFileMB: Number(memory.pageFileMB) || 0, advisory: bootPolicy.advisory }
    })()
  }
  const memoryGate = async (action) => {
    const pressure = currentPressureGate()
    if (pressure.ok !== true) {
      audit('host-pressure-admission-refused', { action, error: pressure.error, detail: pressure.detail, heap: pressure.heap ?? null, session: pressure.session ?? null })
      return pressure
    }
    if (cfg.memoryGuard !== true) return { ok: true, skipped: 'disabled' }
    const memory = rememberMemory(await readSystemMemory({ force: true }))
    notePagefile(memory, action)
    const activeForks = [...tasks.values()].filter((task) => {
      try {
        const live = forker()?.status?.(task.taskId)
        if (live && typeof live.running === 'boolean') return live.running === true
        return task.status === TASK_STATUS.READY || task.status === TASK_STATUS.RUNNING
      } catch {
        return task.status === TASK_STATUS.READY || task.status === TASK_STATUS.RUNNING
      }
    }).length
    const pagefileNotice = evaluatePagefileSingleFork(memory, { activeForks })
    // v3.9.4：页面文件缺失只是建议，不能作为拒绝派生/启动的依据。
    if (pagefileNotice.limited === true) audit('fork-pagefile-advisory', { action, activeForks, pageFileMB: Number(memory.pageFileMB) || 0 })
    const decision = evaluateMemoryGuard(memory, { minFreeMB: cfg.memoryMinFreeMB })
    if (decision.ok !== true) {
      const commitFreeMB = Number(decision.commitFreeMB) || 0
      const critical = commitFreeMB < FORK_COMMIT_HARD_MIN_MB
      audit(critical ? 'fork-commit-critical' : 'fork-memory-low', { action, commitFreeMB, minFreeMB: decision.minFreeMB, hardMinMB: FORK_COMMIT_HARD_MIN_MB })
      return {
        ...decision,
        error: critical ? 'commit-critical' : 'memory-low',
        hardMinMB: FORK_COMMIT_HARD_MIN_MB,
        detail: critical
          ? `Commit 余量 ${commitFreeMB} MB 低于 ${FORK_COMMIT_HARD_MIN_MB} MB 硬底线：已禁止派生新分身和启动已有分身。`
          : decision.detail || `Commit 余量 ${commitFreeMB} MB 低于准入阈值 ${decision.minFreeMB} MB。`,
      }
    }
    return { ...decision, pagefileLimited: false, pagefileAdvisory: pagefileNotice.advisory ?? null, activeForks }
  }

  let sessionCompactBusy = false
  let sessionCompactSnapshot = null
  // 准入前先给 Safe Mode 一次“按当前 Commit 自动解除”的机会。safeModeStatus
  // 在 apply 后段才定义，但这里的方法只会在 apply 返回后被调用，闭包可安全引用。
  const ensureHostAdmission = async () => {
    if (!hostAdmissionClosed && !safeMode) return { ok: true }
    try { await safeModeStatus() } catch { /* keep latched on probe failure */ }
    if (!hostAdmissionClosed && !safeMode) return { ok: true }
    return { ok: false, error: 'host-admission-closed', detail: safeModeReason || 'host-emergency' }
  }
  const compactArchivedTaskSessions = (task) => {
    if (cfg.sessionCompactEnabled !== true) return { ok: true, skipped: 'disabled' }
    if (!task || task.status !== TASK_STATUS.ARCHIVED || !task.homeDir || sessionCompactBusy) {
      return { ok: true, skipped: sessionCompactBusy ? 'busy' : 'not-archived' }
    }
    sessionCompactBusy = true
    try {
      const result = compactTaskSessions(task.homeDir, {
        minBytes: cfg.sessionCompactBytes,
        maxBytes: cfg.sessionCompactMaxBytes,
        level: cfg.sessionCompactLevel,
      })
      sessionCompactSnapshot = {
        at: nowMs(), taskId: task.taskId,
        candidates: result.candidates, compacted: result.compacted,
        skipped: result.skipped, failed: result.failed, savedBytes: result.savedBytes,
      }
      if (result.compacted > 0) {
        audit('session-compacted', sessionCompactSnapshot)
      }
      if (result.failed > 0) {
        audit('session-compact-failed', {
          ...sessionCompactSnapshot,
          errors: result.results.filter((row) => row.ok !== true).slice(0, 5).map((row) => row.error),
        })
      }
      return result
    } catch (error) {
      audit('session-compact-failed', { taskId: task.taskId, error: String(error?.message ?? error) })
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      sessionCompactBusy = false
    }
  }
  const sessionCompactTick = async () => {
    if (cfg.sessionCompactEnabled !== true || Number(cfg.sessionCompactIntervalMs) <= 0 || sessionCompactBusy) return
    for (const task of tasks.values()) {
      if (task.status !== TASK_STATUS.ARCHIVED) continue
      const result = compactArchivedTaskSessions(task)
      if (result.compacted > 0 || result.failed > 0) {
        // Keep the loop responsive after a potentially slow zstd recompression.
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    if (cfg.sessionCompactLegacyEnabled === true && !sessionCompactBusy) {
      sessionCompactBusy = true
      try {
        const result = compactLegacySessions(layout.dataDir, {
          minBytes: cfg.sessionCompactBytes,
          maxBytes: cfg.sessionCompactMaxBytes,
          level: cfg.sessionCompactLevel,
        })
        sessionCompactSnapshot = {
          at: nowMs(), scope: 'legacy',
          candidates: result.candidates, compacted: result.compacted,
          skipped: result.skipped, failed: result.failed, savedBytes: result.savedBytes,
        }
        if (result.compacted > 0) audit('session-compacted-legacy', sessionCompactSnapshot)
        if (result.failed > 0) audit('session-compact-failed', { ...sessionCompactSnapshot, scope: 'legacy' })
      } catch (error) {
        audit('session-compact-failed', { scope: 'legacy', error: String(error?.message ?? error) })
      } finally {
        sessionCompactBusy = false
      }
    }
  }

  let diskHygieneBusy = false
  let diskHygieneSnapshot = null
  let diskHygieneAt = 0
  const refreshDiskHygiene = (force = false) => {
    if (cfg.diskHygieneEnabled !== true) return diskHygieneSnapshot
    if (diskHygieneBusy) return diskHygieneSnapshot
    if (!force && diskHygieneSnapshot && nowMs() - diskHygieneAt < Number(cfg.diskHygieneIntervalMs)) return diskHygieneSnapshot
    diskHygieneBusy = true
    try {
      const homes = [...tasks.values()]
        .filter((task) => task?.homeDir)
        .map((task) => ({ taskId: task.taskId, homeDir: task.homeDir, status: task.status }))
      const report = scanDiskHygiene({ taskHomes: homes })
      diskHygieneSnapshot = {
        ...report,
        summary: {
          browserProfiles: report.browserProfiles.length,
          browserBytes: report.browserProfiles.reduce((sum, row) => sum + Number(row.bytes || 0), 0),
          browserCacheBytes: report.browserCacheBytes,
          searchIndexReadable: report.searchIndex.some((row) => row.readable === true),
        },
      }
      diskHygieneAt = nowMs()
      return diskHygieneSnapshot
    } finally {
      diskHygieneBusy = false
    }
  }
  const browserCacheCleanup = (task) => {
    if (!task || task.status !== TASK_STATUS.ARCHIVED || !task.homeDir) return { ok: false, error: 'not-archived' }
    const result = cleanupBrowserCaches(task.homeDir, {
      taskId: task.taskId,
      // Same-volume recycle: the browser profile may live on D: while dataDir
      // lives on E:. A cross-volume rename would fail, so keep the rollback
      // copy inside the task home (never in sessions/, never silently deleted).
      recycleDir: path.join(task.homeDir, '.fang-recycle', 'browser-cache'),
      confirm: true,
      minBytes: cfg.browserCacheCleanupMinBytes,
    })
    audit('browser-cache-cleanup', {
      taskId: task.taskId,
      ok: result.ok === true,
      moved: result.moved ?? 0,
      bytes: result.bytes ?? 0,
      recycleDir: result.recycleDir ?? null,
      errors: Array.isArray(result.results) ? result.results.filter((row) => row.ok !== true).length : 0,
    })
    if (result.ok) refreshDiskHygiene(true)
    return result
  }

  /** Single-active-fork policy: stop other running forks before starting/opening one. */
  const pauseOtherForks = async (currentId, reason = 'single-active-fork') => {
    if (cfg.singleActiveFork !== true) return { ok: true, paused: [] }
    const f = forker()
    const paused = []
    for (const [id, task] of tasks) {
      if (id === currentId) continue
      if (task.status !== TASK_STATUS.READY && task.status !== TASK_STATUS.RUNNING) continue
      const live = f?.status?.(id)
      if (!live?.running) continue
      let browserClose = null
      try { browserClose = await closeTaskBrowser(task, reason) } catch (error) {
        audit('fork-auto-pause-browser-close-failed', { taskId: id, reason, by: currentId, error: String(error?.message ?? error) })
      }
      let stopped = null
      try { stopped = await f.stop?.(id) } catch (error) {
        audit('fork-auto-pause-stop-failed', { taskId: id, reason, by: currentId, error: String(error?.message ?? error) })
      }
      task.status = TASK_STATUS.FAILED
      task.pid = null
      task.port = null
      task.url = null
      task.token = ''
      task.adapter = { ok: false, error: 'auto-paused-memory' }
      task.memoryPaused = { reason, at: nowMs() }
      const metaSynced = syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: 'auto-paused-memory' })
      paused.push(id)
      audit('fork-auto-paused', {
        taskId: id, reason, by: currentId,
        browserCloseOk: browserClose?.ok === true,
        stopOk: stopped?.ok !== false,
        metaSynced: metaSynced === true,
      })
    }
    if (paused.length) persist()
    return { ok: true, paused }
  }

  const memorySamples = new Map()

  /**
   * Browser crash evidence. The exit event can arrive while closeTaskBrowser is
   * still flushing the page, so this only records facts and clears the live
   * handle; the normal close result remains authoritative for "saved/unsaved".
   */
  const recordBrowserExit = (task, browser, info = {}) => {
    if (!task || !browser || browser.exitRecorded === true) return null
    browser.exitRecorded = true
    const at = Number(info.at) || nowMs()
    const exit = {
      code: info.code ?? null,
      unsignedCode: info.unsignedCode ?? null,
      hex: info.hex ?? null,
      signal: info.signal ?? null,
      kind: info.kind ?? 'unknown',
      oom: info.oom === true,
      source: info.source ?? 'process-exit',
      intentional: browser.intentionalClose ? String(browser.intentionalClose) : null,
      at,
    }
    const last = browser.last && typeof browser.last === 'object' ? { ...browser.last } : null
    const pidTree = last ? {
      pids: Array.isArray(last.pids) ? last.pids : [],
      count: Number(last.count) || 0,
      workingSetMB: Number(last.workingSetMB) || 0,
      commitMB: Number(last.commitMB) || 0,
    } : null
    const record = {
      taskId: task.taskId,
      at,
      kind: 'browser-exit',
      source: 'managed-browser',
      pid: Number(browser.pid) || null,
      port: Number(browser.port) || null,
      exit,
      lastCdp: last ? {
        at: last.at ?? null,
        nodes: last.nodes ?? null,
        heapMB: last.heapMB ?? null,
        documents: last.documents ?? null,
        listeners: last.listeners ?? null,
        layoutCount: last.layoutCount ?? null,
        visibility: last.visibility ?? null,
      } : null,
      pidTree,
      logFile: browser.logFile ?? null,
      crashDir: browser.crashDir ?? null,
    }
    task.browserExit = record
    if (task.browser === browser) task.browser = null
    try { appendJsonlRotated(path.join(layout.dataDir, 'browser-events.jsonl'), { ...record, event: 'exit' }, diagnosticLogOptions()) } catch { /* diagnostics only */ }
    const unexpected = (!exit.intentional || exit.oom === true) && exit.kind !== 'normal'
    if (unexpected) {
      const crash = {
        taskId: task.taskId,
        at,
        pid: record.pid,
        code: exit.code,
        rawCode: exit.code,
        unsignedCode: exit.unsignedCode,
        hex: exit.hex,
        signal: exit.signal,
        oom: exit.oom === true,
        kind: exit.kind,
        source: exit.source,
        lastMetrics: last,
        pids: pidTree?.pids ?? [],
        cdp: record.lastCdp,
      }
      const crashes = Array.isArray(task.browserCrashes) ? task.browserCrashes.slice(-20) : []
      crashes.push(crash)
      task.browserCrashes = crashes
      task.browserCrash = crash
      try { appendJsonlRotated(path.join(layout.dataDir, 'browser-crashes.jsonl'), crash, diagnosticLogOptions()) } catch { /* diagnostics only */ }
      const loop = evaluateCrashLoop(crashes.map((item) => item.at), at, {
        windowMs: cfg.browserCrashWindowMs,
        threshold: cfg.browserCrashThreshold,
      })
      if (loop.tripped === true) {
        task.quarantined = { reason: 'browser-crash-loop', count: loop.count, windowMs: loop.windowMs, at, tokenRevoked: true }
        audit('browser-crash-loop', { taskId: task.taskId, count: loop.count, windowMs: loop.windowMs, oom: exit.oom === true })
        void quarantineTask(task, 'browser-crash-loop').catch(() => { /* best effort */ })
      }
    }
    // memory-samples.jsonl is crash evidence; a deliberate flush+close should not
    // train the root-cause reader on normal shutdowns.
    if (!exit.intentional || exit.oom) {
      try { appendJsonlRotated(path.join(layout.dataDir, 'memory-samples.jsonl'), record, diagnosticLogOptions()) } catch { /* diagnostics only */ }
    }
    audit(exit.oom ? 'fork-browser-exit-oom' : (exit.intentional ? 'fork-browser-exit-intentional' : 'fork-browser-exit'), {
      taskId: task.taskId, pid: record.pid, exitCode: exit.code, exitHex: exit.hex, exitKind: exit.kind,
      oom: exit.oom, nodes: record.lastCdp?.nodes ?? null, heapMB: record.lastCdp?.heapMB ?? null,
      pids: pidTree?.pids ?? [],
    })
    try { persist() } catch { /* record already written */ }
    return record
  }

  const flushForkSession = async (task) => {
    const configured = String(cfg.forkFlushPath || '').trim()
    const capability = task?.flushCapability && typeof task.flushCapability === 'object' ? task.flushCapability : null
    // Formal flush only uses a confirmed endpoint:
    //   1) explicit operator override, 2) endpoint advertised by fork health,
    //   3) the adapter route that this plugin actually registers.
    // Never guess `/api/session/*` names; an unconfirmed endpoint stays unsaved.
    const candidateSpecs = [
      { path: configured, source: 'configured' },
      { path: capability?.method === 'POST' ? String(capability.path ?? '').trim() : '', source: 'health-capability' },
      { path: forkFlushDefaultPath, source: 'adapter-route' },
    ].filter((item) => item.path)
    const candidates = candidateSpecs.map((item) => item.path).filter((value, index, list) => list.indexOf(value) === index)
    const specByPath = new Map(candidateSpecs.map((item) => [item.path, item.source]))
    if (candidates.length === 0) {
      return { ok: false, error: 'flush-unsupported', code: 'flush-unsupported', saved: false, attempted: [] }
    }
    const opened = forker()?.openUrl?.(task.taskId)
    if (!opened?.url) return { ok: false, error: 'fork-url-unavailable', saved: false, attempted: [] }
    const budgetMs = Math.max(100, Number(cfg.forkFlushTimeoutMs) || 3000)
    const deadline = Date.now() + budgetMs
    const token = String(forker()?.getToken?.(task.taskId) ?? '')
    const attempted = []
    let last = null
    for (const flushPath of candidates) {
      const source = specByPath.get(flushPath) ?? 'unknown'
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        attempted.push({ path: flushPath, source, ok: false, saved: false, error: 'flush-budget-exhausted' })
        break
      }
      let endpoint
      try { endpoint = resolveFlushEndpoint(opened.url, flushPath) } catch (error) {
        attempted.push({ path: flushPath, source, ok: false, saved: false, error: String(error?.message ?? error) })
        continue
      }
      const startedAt = Date.now()
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: flushRequestHeaders(token),
          signal: AbortSignal.timeout(remaining),
        })
        let body = null
        try {
          const text = await response.text()
          body = text.trim() ? JSON.parse(text) : null
        } catch { /* non-JSON or empty body: saved stays unconfirmed */ }
        const result = flushResultFromResponse(response, body)
        const view = {
          path: flushPath,
          source,
          ok: result.ok,
          status: result.status,
          saved: result.saved,
          latencyMs: Math.max(0, Date.now() - startedAt),
          code: body?.code ?? null,
          error: body?.error ?? null,
        }
        attempted.push(view)
        last = { ...result, path: flushPath, source, attempted, code: view.code, detail: view.error }
        if (result.saved === true) return { ...last, verified: true, unsupported: false }
        // 401/403/5xx means the endpoint exists but cannot save; trying aliases would
        // only repeat the same failure. 404/405 means this candidate is not registered.
        if (Number(result.status) !== 404 && Number(result.status) !== 405) return { ...last, verified: true, unsupported: false }
      } catch (error) {
        const detail = String(error?.message ?? error)
        attempted.push({ path: flushPath, source, ok: false, saved: false, error: detail, latencyMs: Math.max(0, Date.now() - startedAt) })
        last = { ok: false, status: null, saved: false, path: flushPath, source, attempted, error: detail }
        if (/timeout|timed out|aborted/i.test(detail)) break
      }
    }
    return {
      ok: false,
      status: last?.status ?? null,
      saved: false,
      path: last?.path ?? candidates[candidates.length - 1],
      source: last?.source ?? specByPath.get(candidates[candidates.length - 1]) ?? 'unknown',
      attempted,
      error: 'flush-unsupported',
      code: 'flush-unsupported',
      unsupported: true,
      verified: true,
    }
  }

  const closeTaskBrowser = async (task, reason = 'guard') => {
    if (!task?.browser?.pid) return { ok: true, skipped: 'no-browser' }
    const browser = task.browser
    browser.intentionalClose = String(reason)
    const closeKind = classifyCloseReason(reason)
    task.closeReason = { raw: String(reason), kind: closeKind, at: nowMs() }
    const forkFlush = await flushForkSession(task)
    const sessionSaved = forkFlush.ok === true && forkFlush.saved === true
    const flushView = {
      ok: forkFlush.ok === true,
      status: forkFlush.status ?? null,
      path: forkFlush.path ?? null,
      source: forkFlush.source ?? null,
      saved: forkFlush.saved === true,
      error: forkFlush.error ?? null,
      code: forkFlush.response?.code ?? forkFlush.code ?? null,
      detail: forkFlush.response?.error ?? null,
      unsupported: forkFlush.unsupported === true,
      verified: forkFlush.verified === true,
      attempted: Array.isArray(forkFlush.attempted) ? forkFlush.attempted.slice(0, 10) : [],
      flushed: Array.isArray(forkFlush.response?.flushed) ? forkFlush.response.flushed.slice(0, 20) : [],
      failed: Array.isArray(forkFlush.response?.failed) ? forkFlush.response.failed.slice(0, 20) : [],
    }
    // The warning is written before the force-close so the operator can see why the
    // browser session is being killed without a confirmed durable checkpoint.
    const closeWarning = unsavedCloseWarning({ saved: sessionSaved, forkFlush: flushView, at: nowMs() })
    task.closeWarning = closeWarning
    if (closeWarning) {
      try { bus.emit('fang/browser-unsaved-close', { taskId: task.taskId, reason, warning: closeWarning.message, forkFlush: flushView }) } catch { /* bus optional */ }
      audit('fork-browser-unsaved-close', { taskId: task.taskId, reason, warning: closeWarning.message, forkFlush: flushView })
    }
    let pageFlush = null
    try { pageFlush = await flushManagedBrowser(browser.port) } catch (error) { pageFlush = { ok: false, error: String(error?.message ?? error) } }
    const result = await closeManagedBrowser({ pid: browser.pid, port: browser.port, graceMs: cfg.gracefulBrowserCloseMs })
    task.browser = null
    task.browserClosed = {
      at: nowMs(), reason, reasonKind: closeKind, pid: browser.pid, ok: result.ok, graceful: result.graceful === true,
      pageFlush: pageFlush ?? null,
      forkFlush: flushView, saved: sessionSaved, warning: closeWarning?.message ?? null,
    }
    task.memoryGuard = {
      reason,
      reasonKind: closeKind,
      at: nowMs(),
      pid: browser.pid,
      metrics: browser.last ?? null,
      graceful: result.graceful === true,
      browserSaved: result.graceful === true,
      pageFlush: pageFlush ?? null,
      sessionSaved,
      forkFlush: flushView,
      saved: result.graceful === true && sessionSaved,
      unsavedForceClose: !sessionSaved,
      warning: closeWarning?.message ?? null,
    }
    writeWatchdog()
    try {
      fs.appendFileSync(path.join(layout.dataDir, 'browser-events.jsonl'), JSON.stringify({ taskId: task.taskId, at: nowMs(), event: 'closed', reason, reasonKind: closeKind, pid: browser.pid, ok: result.ok, graceful: result.graceful === true, pageFlush, forkFlush: flushView, saved: sessionSaved, warning: closeWarning?.message ?? null, metrics: browser.last ?? null }) + '\n')
    } catch { /* diagnostics only */ }
    audit('fork-browser-closed', { taskId: task.taskId, reason, reasonKind: closeKind, pid: browser.pid, ok: result.ok, graceful: result.graceful === true, pageFlush, forkFlush: flushView, saved: sessionSaved, warning: closeWarning?.message ?? null })
    persist()
    return { ...result, pageFlush, forkFlush: flushView, saved: sessionSaved, warning: closeWarning?.message ?? null }
  }

  const quarantineTask = async (task, reason, { closeBrowser = true, stopFork = true, preserveArchived = false } = {}) => {
    if (!task) return { ok: false, error: 'unknown-task' }
    const archived = task.status === TASK_STATUS.ARCHIVED
    if (closeBrowser) await closeTaskBrowser(task, reason)
    if (stopFork) {
      try { forker()?.stop?.(task.taskId) } catch { /* best effort */ }
    }
    // C3: allTasks must sweep ARCHIVED records too, but must not demote their
    // archive state to FAILED merely because a host-wide panic ran.
    task.status = archived && preserveArchived ? TASK_STATUS.ARCHIVED : TASK_STATUS.FAILED
    task.pid = null
    task.port = null
    task.url = null
    task.token = ''
    task.adapter = { ok: false, error: 'fork-quarantined' }
    task.quarantined = { reason, at: nowMs(), tokenRevoked: true }
    syncTaskMeta(task, { status: task.status, pid: null, port: null, url: null, lastError: archived && preserveArchived ? 'host-panic-quarantined' : 'fork-quarantined' })
    audit('fork-quarantined', { taskId: task.taskId, reason, archived })
    persist()
    return { ok: true, quarantined: true, taskId: task.taskId, reason }
  }

  const inspectTaskOpenHealth = async (task, options = {}) => {
    if (cfg.forkHealthGate !== true) return { ok: true, skipped: 'disabled' }
    // 元主 runtime browser 不是任务，没有 task.adapter/port；它的存活由 forker
    // 的 live 状态保证，不能套用分身的 task health gate。
    if (task.runtime === true) return { ok: true, skipped: 'runtime-browser' }
    const adapter = task.adapter && typeof task.adapter === 'object'
      ? { ok: task.adapter.ok === true, error: task.adapter.error ?? null, busy: task.adapter.busy === true }
      : { ok: false, error: 'adapter-missing' }
    let session = null
    try {
      session = await inspectForkSessionHealth(task.homeDir, {
        maxSessionMB: cfg.forkHealthMaxSessionMB,
        warnSessionMB: cfg.forkHealthWarnSessionMB,
        confirmSessionMB: cfg.forkHealthConfirmSessionMB,
        warnTotalMB: cfg.forkHealthWarnTotalMB,
        confirmTotalMB: cfg.forkHealthConfirmTotalMB,
        hardTotalMB: cfg.forkHealthHardTotalMB,
        maxEvents: cfg.forkHealthMaxEvents,
      })
    } catch (error) {
      session = { ok: false, error: String(error?.message ?? error), sessions: 0, totalBytes: 0, events: null }
    }
    let http = null
    if (Number(task.port) > 0) {
      try {
        http = await probeForkHealth(task.port, {
          path: forkHealthPath,
          fallbackPaths: ['/api/health'],
          timeoutMs: cfg.forkHealthTimeoutMs,
        })
      } catch (error) {
        http = { ok: false, error: String(error?.message ?? error), status: null, path: forkHealthPath }
      }
    } else {
      http = { ok: false, error: 'fork-port-missing', status: null, path: forkHealthPath }
    }
    const decision = evaluateForkHealth({
      session,
      adapter,
      http,
      limits: {
        maxSessionMB: cfg.forkHealthMaxSessionMB,
        warnSessionMB: cfg.forkHealthWarnSessionMB,
        confirmSessionMB: cfg.forkHealthConfirmSessionMB,
        warnTotalMB: cfg.forkHealthWarnTotalMB,
        confirmTotalMB: cfg.forkHealthConfirmTotalMB,
        hardTotalMB: cfg.forkHealthHardTotalMB,
        maxEvents: cfg.forkHealthMaxEvents,
        confirmed: options.confirmLargeSession === true,
      },
    })
    // A successful fork health response may advertise the real flush endpoint.
    // Never invent one: if it is absent, close will record flush=unsupported.
    if (http?.data?.flush) task.flushCapability = http.data.flush
    const healthRecord = {
      taskId: task.taskId,
      at: nowMs(),
      ok: decision.ok === true,
      error: decision.error ?? null,
      failures: decision.failures,
      session: session ? {
        ok: session.ok === true,
        sessions: session.sessions,
        totalBytes: session.totalBytes,
        largestBytes: session.largestBytes,
        largestSessionId: session.largestSessionId ?? null,
        events: session.events,
        truncated: session.truncated === true,
        scanSkipped: session.scanSkipped === true,
        policy: session.policy ?? null,
      } : null,
      http: http ? {
        ok: http.ok === true,
        status: http.status ?? null,
        path: http.path ?? null,
        latencyMs: http.latencyMs ?? null,
        error: http.error ?? null,
        flush: http.data?.flush ?? null,
      } : null,
      adapter,
    }
    try { appendJsonlRotated(path.join(layout.dataDir, 'browser-health.jsonl'), healthRecord, diagnosticLogOptions()) } catch { /* diagnostics only */ }
    if (decision.requiresConfirmation && decision.confirmed !== true) {
      audit('fork-open-session-confirmation-required', {
        taskId: task.taskId,
        detail: decision.detail,
        sessionPolicy: decision.sessionPolicy,
      })
    }
    if (decision.ok !== true) {
      audit('fork-open-health-refused', {
        taskId: task.taskId,
        error: decision.error,
        failures: decision.failures,
        session: healthRecord.session,
        http: healthRecord.http,
        adapter,
      })
    }
    return { ...decision, healthRecord }
  }

  const launchTaskBrowser = async (task, url, options = {}) => {
    const admission = await ensureHostAdmission()
    if (admission.ok !== true) return admission
    const pressure = currentPressureGate()
    if (pressure.ok !== true) {
      audit('host-pressure-admission-refused', { action: 'open-browser', taskId: task?.taskId ?? null, error: pressure.error, detail: pressure.detail })
      return pressure
    }
    if (cfg.managedBrowser !== true) return { ok: false, error: 'managed-browser-disabled', managed: false, url }
    if (!task || !url) return { ok: false, error: 'browser-url-required' }
    // Reusing an already-open managed page is not a new open; the watchdog still
    // owns its memory/health enforcement. Only a new launch pays the health gate.
    if (task.browser?.pid && isPidAlive(task.browser.pid)) {
      task.closeWarning = null
      task.memoryGuard = null
      return { ok: true, managed: true, pid: task.browser.pid, port: task.browser.port, reused: true }
    }
    const health = await inspectTaskOpenHealth(task, options)
    if (health.ok !== true) {
      return {
        ok: false,
        error: health.error ?? 'fork-health-refused',
        step: 'fork-health',
        detail: health.detail ?? null,
        requiresConfirmation: health.requiresConfirmation === true,
        sessionPolicy: health.sessionPolicy ?? null,
        warnings: health.warnings ?? [],
        sessionWarning: health.warning ?? null,
        health: {
          ok: false,
          failures: health.failures,
          session: health.session,
          adapter: health.adapter,
          http: health.http,
        },
      }
    }
    const liveBrowsers = [...tasks.values(), ...runtimeBrowsers.values()].filter((item) => item.browser?.pid && isPidAlive(item.browser.pid))
    // v3.9.4：页面文件不再是并发限制条件；maxOpenForkBrowsers 是唯一配置口径。
    const max = Math.max(1, Number(cfg.maxOpenForkBrowsers) || 1)
    let liveCount = liveBrowsers.length
    for (const other of liveBrowsers) {
      if (other.taskId === task.taskId) continue
      if (liveCount < max) break
      await closeTaskBrowser(other, 'max-open-fork-browsers')
      liveCount -= 1
    }
    const exe = findBrowserPath(cfg.browserPath)
    if (!exe) return { ok: false, error: 'browser-unavailable' }
    const port = await freePort()
    if (!port) return { ok: false, error: 'browser-port-unavailable' }
    const profileDir = path.join(task.homeDir, 'browser-profile')
    const logDir = path.join(task.homeDir, 'browser-logs')
    const jobEnabled = process.platform === 'win32' && cfg.browserJobObject !== false
    const jobHelperPath = jobEnabled ? resolveJobHostPath({ packageRoot: FANG_ROOT }) : ''
    let browserHandle = null
    const launched = await launchManagedBrowser({
      exe, url, profileDir, logDir, port,
      priorityClass: processPriorityClass,
      jobObject: jobEnabled ? {
        enabled: true,
        helperPath: jobHelperPath,
        homeDir: task.homeDir,
        forkId: `browser-${task.taskId}`,
        hostPid: process.pid,
        heartbeatFile: hostHeartbeatFile,
        timeoutMs: JOB_HEARTBEAT_TIMEOUT_MS,
        graceMs: JOB_HEARTBEAT_GRACE_MS,
        processMemoryMB: Number(cfg.browserJobProcessMemoryMB) || 2048,
        totalMemoryMB: Number(cfg.browserJobTotalMemoryMB) || 2048,
      } : null,
      onExit: (info) => {
        const handle = browserHandle ?? {
          pid: info.pid ?? null, port, logFile: info.logFile ?? null,
          crashDir: info.crashDir ?? null, last: null,
        }
        recordBrowserExit(task, handle, { ...info, source: 'process-exit' })
      },
    })
    if (launched.ok !== true) {
      audit('fork-browser-launch-failed', { taskId: task.taskId, error: launched.error, pid: launched.pid ?? null })
      return launched
    }
    const priority = launched.priority && typeof launched.priority === 'object' ? {
      ok: launched.priority.ok === true,
      partial: launched.priority.partial === true,
      tree: launched.priority.tree === true,
      rootOnly: launched.priority.rootOnly === true,
      count: Number(launched.priority.count) || 0,
      lowered: Number(launched.priority.lowered) || 0,
      changed: Number(launched.priority.changed) || 0,
      alreadyLow: Number(launched.priority.alreadyLow) || 0,
      missing: Number(launched.priority.missing) || 0,
      failed: Number(launched.priority.failed) || 0,
      notLowered: Number(launched.priority.notLowered) || 0,
      error: launched.priority.error ?? null,
    } : null
    browserHandle = task.browser = {
      pid: launched.pid, helperPid: launched.helperPid ?? null, jobObject: launched.jobObject ?? null,
      port: launched.port, profileDir, logFile: launched.logFile,
      crashDir: launched.crashDir, exe, startedAt: nowMs(), hiddenSince: null, last: null, priority, lifecycleState: 'active', lifecycleAt: null, lifecycleError: null, lifecycleFailedAt: null,
    }
    // A fresh browser session invalidates the previous close's unsaved warning.
    task.closeWarning = null
    task.memoryGuard = null
    writeWatchdog()
    persist()
    scheduleBrowserProcessIdentity(task)
    audit('fork-browser-opened', { taskId: task.taskId, pid: launched.pid, port: launched.port })
    if (cfg.browserSingleAppWindow !== false || pagefileMissing === true) {
      try {
        const single = await enforceSinglePageTarget(launched.port, { maxPages: 1 })
        browserHandle.singlePage = { at: nowMs(), ...single }
        if (single.closed?.length) audit('fork-browser-extra-pages-closed', { taskId: task.taskId, port: launched.port, closed: single.closed })
      } catch (error) {
        browserHandle.singlePageError = String(error?.message ?? error)
        audit('fork-browser-extra-pages-close-failed', { taskId: task.taskId, port: launched.port, error: browserHandle.singlePageError })
      }
    }
    if (priority) {
      const event = !priority.ok ? 'fork-browser-priority-failed' : priority.partial ? 'fork-browser-priority-partial' : 'fork-browser-priority'
      audit(event, { taskId: task.taskId, ...priority })
    }
    return {
      ok: true,
      managed: true,
      pid: launched.pid,
      port: launched.port,
      sessionWarning: health.warning ?? null,
      sessionPolicy: health.sessionPolicy ?? null,
    }
  }

  /** Managed browser for the essence runtime (元主 Web), which is not a task. */
  const closeRuntimeManagedBrowser = async (essenceId, reason = 'essence-runtime-browser-close') => {
    const forkId = runtimeForkId(essenceId)
    const runtime = runtimeBrowsers.get(forkId)
    if (!runtime) return { ok: true, skipped: 'no-runtime-browser' }
    const out = await closeTaskBrowser(runtime, reason)
    runtimeBrowsers.delete(forkId)
    try { persist(); writeWatchdog() } catch { /* best effort */ }
    audit('essence-runtime-browser-closed', { essenceId: String(essenceId), forkId, reason, ok: out.ok === true })
    return out
  }

  const openRuntimeManagedBrowser = async (essenceId, url) => {
    const id = String(essenceId ?? '').trim()
    const forkId = runtimeForkId(id)
    const live = forker()?.status?.(forkId) ?? null
    if (!live?.running || !live.homeDir) return { ok: false, error: 'not-running' }
    // A runtime URL carries a fresh token; reuse of the previous page would keep
    // the old token. Close the old managed page first, then launch the new URL.
    if (runtimeBrowsers.get(forkId)?.browser?.pid) {
      await closeRuntimeManagedBrowser(id, 'runtime-url-refresh')
    }
    const runtime = runtimeBrowsers.get(forkId) ?? { taskId: forkId, homeDir: String(live.homeDir), runtime: true, essenceId: id }
    runtimeBrowsers.set(forkId, runtime)
    const out = await launchTaskBrowser(runtime, url)
    if (out.ok === true) {
      audit('essence-runtime-browser-opened', { essenceId: id, forkId, pid: out.pid ?? null, port: out.port ?? null, reused: out.reused === true })
      try { writeWatchdog() } catch { /* best effort */ }
    } else {
      runtimeBrowsers.delete(forkId)
      audit('essence-runtime-browser-refused', { essenceId: id, forkId, error: out.error ?? 'browser-open-failed' })
    }
    return out
  }

  let hostPanic = false
  const hostEmergency = async (reason, { safe = false, allTasks = false } = {}) => {
    if (hostPanic) return { ok: true, skipped: 'in-progress' }
    hostPanic = true
    // Close admission before the first close: no new fork/browser can enter
    // while the emergency drains the existing trees. Status/panic routes stay up.
    hostAdmissionClosed = true
    try {
      // Order is deliberate: browser (largest commit) first, then fork backends.
      for (const task of tasks.values()) {
        if (task.browser?.pid) await closeTaskBrowser(task, `host-panic:${reason}`)
      }
      for (const runtime of [...runtimeBrowsers.values()]) {
        if (runtime.browser?.pid) await closeTaskBrowser(runtime, `host-panic:${reason}`)
      }
      runtimeBrowsers.clear()
      let archivedSwept = 0
      for (const task of tasks.values()) {
        const archived = task.status === TASK_STATUS.ARCHIVED
        if (!allTasks && (archived || (task.status !== TASK_STATUS.READY && task.status !== TASK_STATUS.RUNNING))) continue
        await quarantineTask(task, `host-panic:${reason}`, { closeBrowser: false, preserveArchived: archived })
        if (archived) archivedSwept += 1
      }
      if (safe) {
        safeMode = true
        safeModeReason = `host-emergency:${reason}`
        persistSafeMode()
      }
      const self = process.memoryUsage()
      audit('host-emergency-guard', {
        reason, safe, allTasks, tasks: tasks.size, archivedSwept, admissionClosed: hostAdmissionClosed,
        selfRssMB: Number(lastHostMetrics?.selfRssMB) || Math.round(self.rss / 1048576),
        selfPrivateMB: Number(lastHostMetrics?.selfPrivateMB) || Math.round((self.heapUsed + self.external) / 1048576),
        metrics: lastHostMetrics,
      })
      return { ok: true, reason, safe }
    } finally {
      hostPanic = false
    }
  }

  const diagnosticLogOptions = () => ({
    maxBytes: Number(cfg.diagnosticLogMaxMB) * 1024 * 1024,
    retentionDays: Number(cfg.diagnosticLogRetentionDays),
  })

  if (unclean) {
    const record = crashHistory[crashHistory.length - 1] ?? { at: now, reason: 'unclean-shutdown' }
    try {
      appendJsonlRotated(path.join(layout.dataDir, 'host-crashes.jsonl'), {
        event: 'host-crash', ...record,
        commitFreeMB: record.metrics?.commitFreeMB ?? null,
        selfRssMB: record.metrics?.selfRssMB ?? null,
        selfPrivateMB: record.metrics?.selfPrivateMB ?? null,
        hostJsHeapUsedMB: record.metrics?.heapUsedMB ?? null,
        hostJsHeapLimitMB: record.metrics?.heapLimitMB ?? null,
        hostJsHeapPressure: record.metrics?.heapPressure ?? null,
        sessionFootprintMB: record.metrics?.sessionFootprintMB ?? null,
        largestSessionMB: record.metrics?.largestSessionMB ?? null,
        largestSessionFile: record.metrics?.largestSessionFile ?? null,
        forkCommitMB: record.metrics?.forkCommitMB ?? null,
        browserCommitMB: record.metrics?.browserCommitMB ?? null,
        totalCommitMB: record.metrics?.totalCommitMB ?? null,
        processCount: record.processCount ?? record.metrics?.processCount ?? null,
      }, diagnosticLogOptions())
    } catch { /* diagnostics only */ }
  }

  const recordForkMemory = async (task, rootPid, table) => {
    const tree = sumProcessTree(selectProcessTree(table.rows, rootPid))
    if (!tree.count) return null
    const list = memorySamples.get(task.taskId) ?? []
    list.push({ at: nowMs(), ...tree })
    if (list.length > 40) list.splice(0, list.length - 40)
    memorySamples.set(task.taskId, list)
    try {
      appendJsonlRotated(path.join(layout.dataDir, 'memory-samples.jsonl'), { taskId: task.taskId, at: nowMs(), ...tree }, diagnosticLogOptions())
    } catch { /* diagnostics only */ }
    const low = Math.min(...list.map((sample) => Number(sample.commitMB) || 0))
    const current = Number(tree.commitMB) || 0
    const limits = memoryPolicySnapshot()
    const overKill = current >= Number(limits.memoryKillCommitMB)
    const overGrowth = current - low >= Number(limits.memoryGrowCommitMB)
    if (overKill && overGrowth) {
      try { forker()?.stop?.(task.taskId) } catch { /* best effort */ }
      try { await killProcessTree(rootPid) } catch { /* PID may already be gone */ }
      task.status = TASK_STATUS.FAILED
      task.pid = null
      task.port = null
      task.url = null
      task.adapter = { ok: false, error: 'memory-watchdog-killed' }
      task.memoryKill = { at: nowMs(), commitMB: current, lowMB: low, limitMB: limits.memoryKillCommitMB, growMB: limits.memoryGrowCommitMB, source: limits.source, pids: tree.pids }
      audit('fork-memory-killed', { taskId: task.taskId, commitMB: current, lowMB: low, limitMB: limits.memoryKillCommitMB, growMB: limits.memoryGrowCommitMB, source: limits.source, pids: tree.pids })
      persist()
      return { ...tree, killed: true }
    }
    return tree
  }

  const forkActivityCache = new Map()
  async function fetchTaskActivity(task) {
    const cached = forkActivityCache.get(task.taskId)
    if (cached && nowMs() - Number(cached.fetchedAt) < 5000) return cached
    try {
      const client = await remoteFor(task)
      if (!client || typeof client.activity !== 'function') {
        const value = { ok: false, error: 'activity-endpoint-unavailable', fetchedAt: nowMs() }
        forkActivityCache.set(task.taskId, value)
        return value
      }
      let res = null
      try { res = await client.activity() } catch (e) { res = { ok: false, error: String(e?.message ?? e) } }
      const data = res?.ok === true ? (res.data?.activity ?? res.data ?? null) : null
      const value = data && typeof data === 'object'
        ? { ...data, fetchedAt: nowMs(), remoteOk: res.ok === true }
        : { ok: false, error: res?.status === 404 ? 'activity-endpoint-unavailable' : (res?.error ?? res?.kind ?? 'activity-unavailable'), fetchedAt: nowMs() }
      forkActivityCache.set(task.taskId, value)
      return value
    } catch (e) {
      const value = { ok: false, error: 'activity-fetch-failed', detail: String(e?.message ?? e), fetchedAt: nowMs() }
      forkActivityCache.set(task.taskId, value)
      return value
    }
  }

  async function taskIdleForClose(task, { hiddenSince = 0, now = nowMs() } = {}) {
    const live = forker()?.status?.(task.taskId)
    if (!live?.running) return { close: true, reason: 'fork-not-running', warn: false }
    if (task.adapter?.busy === true) return { close: false, reason: 'adapter-busy', warn: false }
    const activity = await fetchTaskActivity(task)
    return decideIdleClose(activity, {
      hiddenSince,
      now,
      idleMinutes: cfg.autoCloseIdleMinutes,
      onlyWhenIdle: cfg.idleCloseOnlyWhenIdle,
      busy: task.adapter?.busy === true,
    })
  }

  const browserWatchdogTick = async (table, { freshTable = true } = {}) => {
    if (cfg.managedBrowser !== true || process.platform !== 'win32') return
    const now = nowMs()
    const cdpIntervalMs = Math.max(15000, Number(cfg.browserCdpSampleIntervalMs) || 15000)
    for (const task of tasks.values()) {
      const browser = task.browser
      if (!browser?.pid) continue
      if (!isPidAlive(browser.pid)) {
        recordBrowserExit(task, browser, { source: 'watchdog-pid-dead' })
        task.browser = null
        task.browserClosed = { at: nowMs(), reason: 'browser-process-exited', reasonKind: task.browserExit?.exit?.oom ? 'browser-oom' : 'user', pid: browser.pid, exit: task.browserExit?.exit ?? null }
        audit('fork-browser-exited', { taskId: task.taskId, pid: browser.pid, exitCode: task.browserExit?.exit?.code ?? null, exitHex: task.browserExit?.exit?.hex ?? null })
        persist()
        continue
      }
      let cdpAt = Number(browser.cdpAt) || 0
      const cdpDue = !cdpAt || now - cdpAt >= cdpIntervalMs
      // On cached-table ticks, only browsers whose CDP window elapsed need work.
      if (!freshTable && !cdpDue) continue
      const tree = freshTable
        ? sumProcessTree(selectProcessTree(table.rows, browser.pid))
        : {
            pids: Array.isArray(browser.last?.pids) ? browser.last.pids : [],
            count: Number(browser.last?.count) || 0,
            workingSetMB: Number(browser.last?.workingSetMB) || 0,
            commitMB: Number(browser.last?.commitMB) || 0,
          }
      let nodes = Number(browser.last?.nodes) || 0
      let heapMB = Number(browser.last?.heapMB) || 0
      let visibility = browser.last?.visibility ?? 'unknown'
      let documents = Number(browser.last?.documents) || 0
      let listeners = Number(browser.last?.listeners) || 0
      let layoutCount = Number(browser.last?.layoutCount) || 0
      let cdpOk = Boolean(browser.last && cdpAt)
      if (cdpDue) {
        const sample = await sampleManagedBrowser(browser.port)
        if (sample?.ok === true) {
          cdpOk = true
          browser.cdpAt = now
          cdpAt = now
          browser.cdpError = null
          nodes = Number(sample.nodes) || 0
          heapMB = Math.round((Number(sample.heapBytes) || 0) / 1048576)
          visibility = sample.visibility ?? 'unknown'
          documents = Number(sample.documents) || 0
          listeners = Number(sample.listeners) || 0
          layoutCount = Number(sample.layoutCount) || 0
        } else {
          cdpOk = false
          browser.cdpError = String(sample?.error ?? 'browser-cdp-sample-failed')
        }
      }
      const hostCommitFreeMB = memorySnapshot?.ok === true && Number(memorySnapshot.commitFreeMB) > 0
        ? Number(memorySnapshot.commitFreeMB)
        : null
      browser.last = {
        at: now,
        ...tree,
        nodes,
        heapMB,
        visibility,
        documents,
        listeners,
        layoutCount,
        hostCommitFreeMB,
        cdpAt: cdpAt || null,
        cdpAgeMs: cdpAt ? now - cdpAt : null,
        cdpSampled: cdpDue && cdpOk,
      }
      if (cdpDue && cdpOk) {
        browser.metricsHistory = appendBrowserMetricHistory(browser.metricsHistory, {
          at: cdpAt,
          documents,
          listeners,
          layoutCount,
        })
      }
      try {
        appendJsonlRotated(path.join(layout.dataDir, 'browser-samples.jsonl'), { taskId: task.taskId, ...browser.last }, diagnosticLogOptions())
      } catch { /* diagnostics only */ }
      if (cfg.browserSingleAppWindow !== false || memorySnapshot?.pagefileMissing === true || memorySnapshot?.hasPageFile === false) {
        try {
          const single = await enforceSinglePageTarget(browser.port, { maxPages: 1 })
          browser.singlePage = { at: now, ...single }
          if (single.closed?.length) {
            audit('fork-browser-extra-pages-closed', { taskId: task.taskId, port: browser.port, closed: single.closed })
          }
        } catch (error) {
          browser.singlePageError = String(error?.message ?? error)
        }
      }
      const limits = memoryPolicySnapshot()
      // v3.8.9: hard 2 GB commit / 1.5 GB heap / 200k DOM / 4 GB host-free
      // ceilings. Host-free closes the browser only; own browser overrun also
      // stops the fork and revokes the port/token.
      const autoCloseDecision = evaluateBrowserAutoClose({
        autoClose: cfg.autoClose === true,
        commitMB: tree.commitMB,
        heapMB,
        nodeCount: nodes,
        cdpOk,
        hostCommitFreeMB,
        config: cfg,
        policy: limits,
      })
      browser.last.autoClose = autoCloseDecision
      if (autoCloseDecision.close) {
        audit('fork-browser-auto-close', {
          taskId: task.taskId,
          reason: autoCloseDecision.reason,
          scope: autoCloseDecision.scope,
          trigger: autoCloseDecision.trigger,
          commitMB: tree.commitMB,
          nodes,
          heapMB,
          hostCommitFreeMB,
          memoryLimitMB: autoCloseDecision.limits.treeCommitMB,
          heapLimitMB: autoCloseDecision.limits.jsHeapMB,
          domNodeLimit: autoCloseDecision.limits.domNodes,
          hostFreeLimitMB: autoCloseDecision.limits.hostCommitFreeMB,
          limits: autoCloseDecision.limits,
        })
        // Browser first, then fork; quarantineTask clears port/token and keeps home.
        if (autoCloseDecision.scope === 'task' && cfg.quarantineOnGuard !== false) {
          await quarantineTask(task, autoCloseDecision.reason)
        } else {
          await closeTaskBrowser(task, autoCloseDecision.reason)
        }
        continue
      }
      // Experimental pause: freeze a hidden renderer at the CDP lifecycle layer.
      // Default off; only enable after a real fork page has been verified to
      // resume (visibility -> active -> accepts input) on the target host.
      if (cfg.pauseHiddenTab === true && cdpOk) {
        const desired = visibility === 'hidden' ? 'frozen' : 'active'
        if (browser.lifecycleState !== desired) {
          const lastFail = Number(browser.lifecycleFailedAt) || 0
          if (desired === 'active' || now - lastFail >= 60_000) {
            const lifecycle = await setManagedBrowserLifecycle(browser.port, desired)
            if (lifecycle.ok) {
              browser.lifecycleState = desired
              browser.lifecycleAt = now
              browser.lifecycleError = null
              audit(desired === 'frozen' ? 'fork-browser-hidden-paused' : 'fork-browser-visible-resumed', { taskId: task.taskId, port: browser.port })
            } else {
              browser.lifecycleError = lifecycle.error || 'cdp-lifecycle-failed'
              browser.lifecycleFailedAt = now
              audit('fork-browser-lifecycle-failed', { taskId: task.taskId, port: browser.port, state: desired, error: browser.lifecycleError })
            }
          }
        }
      }
      if (cfg.autoClose === true && cfg.autoCloseIdleMinutes > 0) {
        if (cdpOk && visibility === 'hidden') {
          if (!browser.hiddenSince) browser.hiddenSince = now
          const idleMs = now - Number(browser.hiddenSince)
          if (idleMs >= Number(cfg.autoCloseIdleMinutes) * 60_000) {
            const decision = await taskIdleForClose(task, { hiddenSince: browser.hiddenSince, now })
            if (decision.close) {
              browser.idleClose = { at: now, action: 'closed', reason: decision.reason }
              await closeTaskBrowser(task, 'idle-hidden')
              continue
            }
            browser.idleClose = {
              at: now, action: 'skipped', reason: decision.reason,
              lastActivityAt: decision.activity?.lastActivityAt ?? null,
              turnRunning: decision.activity?.turnRunning ?? null,
              sessionId: decision.activity?.sessionId ?? null,
            }
            const warnAt = Number(browser.idleCloseWarnAt) || 0
            if (decision.warn && now - warnAt >= 60_000) {
              browser.idleCloseWarnAt = now
              audit('fork-idle-close-skipped', {
                taskId: task.taskId,
                reason: decision.reason,
                hiddenForMs: idleMs,
                lastActivityAt: decision.activity?.lastActivityAt ?? null,
                turnRunning: decision.activity?.turnRunning ?? null,
                signal: decision.activity?.signal ?? 'none',
                sessionId: decision.activity?.sessionId ?? null,
              })
            }
          }
        } else if (cdpOk) {
          browser.hiddenSince = null
          browser.idleClose = null
        }
      }
    }
  }

  /**
   * v3.8.13 P0: aggregate commit for fork + managed browser PID trees.
   * `rows` is the shared process table snapshot used by the 15s host gate and
   * the pre-spawn gate, so accounting cannot diverge between them.
   */
  const currentForkCommitMB = (rows) => {
    if (!Array.isArray(rows)) return { forkCommitMB: 0, browserCommitMB: 0, totalMB: 0 }
    let forkCommitMB = 0
    let browserCommitMB = 0
    for (const task of tasks.values()) {
      if (task.status === TASK_STATUS.ARCHIVED || task.status === TASK_STATUS.FAILED) continue
      if (Number(task.pid) > 0) {
        forkCommitMB += sumProcessTree(selectProcessTree(rows, Number(forker()?.status?.(task.taskId)?.pid ?? task.pid))).commitMB
      }
      if (task.browser?.pid) browserCommitMB += sumProcessTree(selectProcessTree(rows, Number(task.browser.pid))).commitMB
    }
    for (const runtime of runtimeBrowsers.values()) {
      if (runtime.browser?.pid) browserCommitMB += sumProcessTree(selectProcessTree(rows, Number(runtime.browser.pid))).commitMB
    }
    return { forkCommitMB, browserCommitMB, totalMB: forkCommitMB + browserCommitMB }
  }

  let commitBudgetBusy = false
  /** Evaluate the 40% share + 4 GB host reserve ceiling. */
  const enforceForkCommitBudget = async ({ source = 'commit-budget', table = null, memory = null, failClosed = false } = {}) => {
    if (process.platform !== 'win32' || cfg.memoryWatchdog !== true) return { ok: true, skipped: 'disabled' }
    if (commitBudgetBusy) return { ok: true, skipped: 'busy' }
    commitBudgetBusy = true
    try {
      const hasActive = [...tasks.values(), ...runtimeBrowsers.values()].some((task) => task.browser?.pid
        || (Number(task.pid) > 0 && (task.status === TASK_STATUS.READY || task.status === TASK_STATUS.RUNNING)))
      if (!hasActive && source !== 'create-fork' && source !== 'restore-fork') return { ok: true, skipped: 'no-active-fork' }
      const mem = memory ?? rememberMemory(await readSystemMemory())
      const limitMB = Number(mem?.commitLimitMB) || 0
      if (mem?.ok !== true || limitMB <= 0) {
        audit('fork-commit-budget-unavailable', { source, failClosed, reason: 'commit-limit-unavailable' })
        return { ok: !failClosed, error: 'commit-limit-unavailable', source }
      }
      const tableNow = table ?? await readProcessTable({ detailed: false, cacheMs: 5000 })
      if (tableNow.ok !== true) {
        audit('fork-commit-budget-unavailable', { source, failClosed, reason: 'process-table-unavailable', detail: tableNow.error ?? null })
        return { ok: !failClosed, error: 'process-table-unavailable', source }
      }
      const totals = currentForkCommitMB(tableNow.rows)
      const decision = evaluateForkCommitBudget({
        commitLimitMB: limitMB,
        forkTotalMB: totals.totalMB,
        share: cfg.forkCommitShareLimit,
        reserveMB: cfg.forkCommitHostReserveMB,
      })
      if (!decision.ok || decision.over) {
        audit('fork-commit-share-exceeded', { source, ...decision, forkCommitMB: Math.round(totals.forkCommitMB), browserCommitMB: Math.round(totals.browserCommitMB) })
        await hostEmergency('fork-commit-share', { safe: true, allTasks: true })
        return { ok: false, error: 'fork-commit-share-exceeded', source, ...decision }
      }
      return { ok: true, source, ...decision, forkCommitMB: Math.round(totals.forkCommitMB), browserCommitMB: Math.round(totals.browserCommitMB) }
    } finally {
      commitBudgetBusy = false
    }
  }

  const memoryWatchdogTick = async () => {
    if (cfg.memoryWatchdog !== true || process.platform !== 'win32') return
    const running = [...tasks.values()].filter((task) => task.status === TASK_STATUS.READY || task.status === TASK_STATUS.RUNNING)
    const hasBrowser = [...tasks.values(), ...runtimeBrowsers.values()].some((task) => task.browser?.pid)
    if (!running.length && !hasBrowser) return
    const table = await readProcessTable({
      detailed: false,
      cacheMs: Math.max(10000, Number(cfg.memoryProcessScanIntervalMs) || 30000),
    })
    if (!table.ok) return
    const freshTable = table.cached !== true
    if (freshTable) {
      for (const task of running) {
        const rootPid = Number(forker()?.status?.(task.taskId)?.pid ?? task.pid)
        if (rootPid > 0) await recordForkMemory(task, rootPid, table)
      }
    }
    await browserWatchdogTick(table, { freshTable })
    // On a cached tick only liveness and due CDP samples run; memory thresholds
    // are evaluated on the next fresh full-table snapshot.
    if (!freshTable) return
    // Red line: aggregate fork+browser commit must stay below the configured share.
    const memory = rememberMemory(await readSystemMemory())
    notePagefile(memory, 'memory-watchdog')
    if (memory.ok && Number(memory.commitLimitMB) > 0) {
      const totals = currentForkCommitMB(table.rows)
      const forkCommitMB = totals.forkCommitMB
      const browserCommitMB = totals.browserCommitMB
      const total = totals.totalMB
      const limitMB = Number(memory.commitLimitMB) || 0
      const share = limitMB > 0 ? total / limitMB : 0
      const budget = evaluateForkCommitBudget({
        commitLimitMB: limitMB,
        forkTotalMB: total,
        share: cfg.forkCommitShareLimit,
        reserveMB: cfg.forkCommitHostReserveMB,
      })
      const effectiveShare = limitMB > 0 ? budget.limitMB / limitMB : 0
      const self = process.memoryUsage()
      const selfMetrics = {
        at: nowMs(),
        commitFreeMB: Number(memory.commitFreeMB) || null,
        commitLimitMB: limitMB || null,
        selfRssMB: Number(memory.selfRssMB) || Math.round(self.rss / 1048576),
        selfPrivateMB: Number(memory.selfPrivateMB) || Math.round((self.heapUsed + self.external) / 1048576),
        forkCommitMB: Math.round(forkCommitMB),
        browserCommitMB: Math.round(browserCommitMB),
        totalCommitMB: Math.round(total),
        processCount: table.rows.length,
        forkShare: Math.round(share * 1000) / 1000,
        forkCommitLimitMB: budget.limitMB,
        forkCommitHostReserveMB: budget.reserveMB,
        forkCommitReserveLimitMB: budget.reserveLimitMB,
        forkCommitShareLimitMB: budget.shareLimitMB,
      }
      lastHostMetrics = selfMetrics
      lastProcessCount = table.rows.length
      const emergency = effectiveShare
      const severe = Math.min(Number(cfg.forkCommitSevereShare), effectiveShare)
      const warn = Math.min(Number(cfg.forkCommitWarnShare), effectiveShare)
      if (!budget.ok || share > emergency) {
        audit('fork-commit-share-exceeded', {
          ...selfMetrics,
          limitMB: budget.limitMB,
          shareLimit: Math.round(effectiveShare * 1000) / 1000,
          reserveMB: budget.reserveMB,
          reason: budget.reason,
        })
        await hostEmergency('fork-commit-share', { safe: true, allTasks: true })
        return
      }
      if (share > severe && nowMs() - lastCommitSevereAt > 60_000) {
        lastCommitSevereAt = nowMs()
        audit('fork-commit-share-severe', { ...selfMetrics, limitMB: Math.round(limitMB * severe), shareLimit: severe })
      } else if (share > warn && nowMs() - lastCommitWarnAt > 60_000) {
        lastCommitWarnAt = nowMs()
        audit('fork-commit-share-warning', { ...selfMetrics, limitMB: Math.round(limitMB * warn), shareLimit: warn })
      }
    }
    writeWatchdog()
  }

  let lastHostWarnAt = 0
  let lastHostSevereAt = 0
  let lastCommitWarnAt = 0
  let lastCommitSevereAt = 0
  const scanHostSessionFootprint = () => {
    if (cfg.sessionFootprintEnabled !== true) return null
    const at = nowMs()
    if (lastSessionFootprint && at - lastSessionFootprintAt < Number(cfg.sessionFootprintIntervalMs)) return lastSessionFootprint
    lastSessionFootprintAt = at
    const roots = [{ label: 'host', homeDir: layout.dshHome }]
    for (const task of tasks.values()) {
      if (task?.homeDir) roots.push({ label: `task:${task.taskId}`, taskId: task.taskId, homeDir: task.homeDir })
    }
    let footprint
    try {
      footprint = scanSessionFootprint(roots, { top: 8 })
    } catch (error) {
      audit('session-footprint-scan-failed', { error: String(error?.message ?? error) })
      return lastSessionFootprint
    }
    const decision = evaluateSessionFootprint(footprint, sessionFootprintLimits())
    lastSessionFootprint = footprint
    lastSessionFootprintDecision = decision
    sessionFootprintGate = decision.gate
    const evidence = {
      level: decision.level,
      totalMB: decision.totalMB,
      files: decision.files,
      largestMB: decision.largestMB,
      largestFile: decision.largestFile,
      largestSessionId: decision.largestSessionId,
      reasons: decision.reasons,
      top: Array.isArray(footprint.top) ? footprint.top.slice(0, 5) : [],
    }
    if (decision.level === 'critical' && nowMs() - lastSessionCriticalAt > 60_000) {
      lastSessionCriticalAt = nowMs()
      audit('session-footprint-critical', evidence)
    } else if (decision.level === 'warn' && nowMs() - lastSessionWarnAt > 60_000) {
      lastSessionWarnAt = nowMs()
      audit('session-footprint-warning', evidence)
    }
    if (decision.gate === true) audit('session-footprint-emergency', evidence)
    return footprint
  }
  const hostWatchdogTick = async () => {
    if (process.platform !== 'win32' || hostPanic) return
    // v3.8.14: Host JS heap and session body are sampled even when the
    // PowerShell/CIM memory probe fails. CommitFree alone missed the V8 heap
    // spike that preceded the observed host OOM.
    const heapSample = sampleHostHeap()
    const heapLimits = hostHeapLimits(heapSample.heapLimitMB)
    const heapDecision = evaluateHostHeap(heapSample, heapLimits)
    lastHostHeapDecision = heapDecision
    hostHeapPressureGate = heapDecision.level === 'critical' || heapDecision.level === 'emergency'
    if (heapDecision.level === 'emergency') {
      hostHeapEmergencyCount += 1
      if (hostHeapEmergencyCount >= heapLimits.emergencyStreak) {
        audit('host-js-heap-emergency', { ...heapDecision, streak: hostHeapEmergencyCount })
        await hostEmergency('host-js-heap-emergency', { safe: true, allTasks: true })
        return
      }
      if (nowMs() - lastHostHeapEmergencyAt > 60_000) {
        lastHostHeapEmergencyAt = nowMs()
        audit('host-js-heap-emergency-pending', { ...heapDecision, streak: hostHeapEmergencyCount, required: heapLimits.emergencyStreak })
      }
    } else {
      hostHeapEmergencyCount = 0
    }
    if (heapDecision.level === 'critical' && nowMs() - lastHostHeapCriticalAt > 60_000) {
      lastHostHeapCriticalAt = nowMs()
      audit('host-js-heap-critical', heapDecision)
    } else if (heapDecision.level === 'warn' && nowMs() - lastHostHeapWarnAt > 60_000) {
      lastHostHeapWarnAt = nowMs()
      audit('host-js-heap-warning', heapDecision)
    }
    const footprint = scanHostSessionFootprint()
    lastHostMetrics = {
      ...(lastHostMetrics ?? {}),
      at: nowMs(),
      ...heapSample,
      heapLevel: heapDecision.level,
      heapPressure: heapDecision.pressure,
      heapLimitMB: heapDecision.heapLimitMB,
      heapCriticalMB: heapDecision.criticalMB,
      heapEmergencyMB: heapDecision.emergencyMB,
      sessionFootprintMB: footprint ? Math.round(footprint.bytes / 1048576) : null,
      sessionFiles: footprint ? footprint.files : null,
      largestSessionMB: footprint?.largestBytes ? Math.round(footprint.largestBytes / 1048576) : null,
      largestSessionFile: footprint?.largestFile ?? null,
      sessionPressure: lastSessionFootprintDecision?.level ?? null,
      pressureGate: hostHeapPressureGate ? 'host-js-heap' : (sessionFootprintGate ? 'session-footprint' : null),
    }
    // Red line: the mother samples self RSS/Private + CommitFree every 15 s even
    // when no fork/browser exists. A DSH host can OOM without any child.
    const memory = rememberMemory(await readSystemMemory())
    notePagefile(memory, 'memory-watchdog')
    if (!memory.ok) {
      writeWatchdog()
      return
    }
    const free = Number(memory.commitFreeMB) || 0
    const limitMB = Number(memory.commitLimitMB) || 0
    const selfNow = process.memoryUsage()
    lastHostMetrics = {
      ...(lastHostMetrics ?? {}),
      at: nowMs(),
      commitFreeMB: free,
      commitLimitMB: limitMB || null,
      selfRssMB: Number(memory.selfRssMB) || Math.round(selfNow.rss / 1048576),
      selfPrivateMB: Number(memory.selfPrivateMB) || Math.round((selfNow.heapUsed + selfNow.external) / 1048576),
      processCount: lastProcessCount || lastHostMetrics?.processCount || null,
    }
    // v3.8.13: the 15 s host tick also enforces the aggregate fork budget, so a
    // runaway child cannot wait for the slower memory watchdog sample.
    const activeForBudget = [...tasks.values(), ...runtimeBrowsers.values()].some((task) => task.browser?.pid
      || (Number(task.pid) > 0 && (task.status === TASK_STATUS.READY || task.status === TASK_STATUS.RUNNING)))
    if (activeForBudget) {
      const commitGate = await enforceForkCommitBudget({ source: 'host-watchdog-15s', memory })
      if (commitGate.ok !== true) return
    }
    if (free < Number(cfg.hostWarnFreeMB) && nowMs() - lastHostWarnAt > 60_000) {
      lastHostWarnAt = nowMs()
      audit('host-memory-warning', {
        commitFreeMB: free, warnMB: cfg.hostWarnFreeMB,
        selfRssMB: lastHostMetrics.selfRssMB, selfPrivateMB: lastHostMetrics.selfPrivateMB,
        forkCommitMB: lastHostMetrics.forkCommitMB ?? null, browserCommitMB: lastHostMetrics.browserCommitMB ?? null,
        totalCommitMB: lastHostMetrics.totalCommitMB ?? null, forkShare: lastHostMetrics.forkShare ?? null,
        processCount: lastHostMetrics.processCount,
      })
    }
    if (free < Number(cfg.hostCriticalFreeMB) && nowMs() - lastHostSevereAt > 60_000) {
      lastHostSevereAt = nowMs()
      audit('host-memory-severe', {
        commitFreeMB: free, criticalMB: cfg.hostCriticalFreeMB,
        selfRssMB: lastHostMetrics.selfRssMB, selfPrivateMB: lastHostMetrics.selfPrivateMB,
        totalCommitMB: lastHostMetrics.totalCommitMB ?? null, forkShare: lastHostMetrics.forkShare ?? null,
        processCount: lastHostMetrics.processCount,
      })
    }
    if (free < Number(cfg.hostEmergencyFreeMB)) {
      await hostEmergency('commit-free-emergency', { safe: true, allTasks: true })
    }
  }

  /**
   * Record the spawned process's CreationDate + CommandLine hash. Orphan cleanup uses
   * this to distinguish the original fork from a recycled PID. Never blocks a spawn
   * forever: a failed/unsupported capture leaves pidIdentity=null and the cleanup
   * falls back to the stricter profile+port argv check.
   */
  const captureTaskProcessIdentity = async (task) => {
    task.pidIdentity = null
    task.pidIdentityError = null
    // v3.8.13: keep the spawn-time provisional timestamp if CIM is late or
    // unavailable. Orphan cleanup can then reject recycled PIDs immediately
    // instead of waiting for a second identity sample.
    const provisionalStartedAt = Number(task?.pidStartedAt)
    const provisionalSource = String(task?.pidStartedAtSource ?? '')
    if (!Number.isFinite(provisionalStartedAt) || provisionalStartedAt <= 0) {
      task.pidStartedAt = null
      task.pidStartedAtSource = null
    }
    const pid = Number(task?.pid)
    if (!Number.isInteger(pid) || pid <= 0) {
      task.pidIdentityError = 'bad-pid'
      return { ok: false, error: 'bad-pid' }
    }
    if (process.platform !== 'win32') {
      task.pidIdentityError = 'unsupported-platform'
      return { ok: false, error: 'unsupported-platform' }
    }
    const identity = await readProcessIdentity(pid).catch((error) => ({ ok: false, error: String(error?.message ?? error), row: null }))
    if (!identity.ok || !identity.row || Number(identity.row.pid) !== pid) {
      task.pidIdentityError = identity?.error ?? (identity?.row ? 'pid-mismatch' : 'not-found')
      audit('fork-pid-identity-unavailable', { taskId: task.taskId, pid, error: task.pidIdentityError, pidStartedAtSource: task.pidStartedAtSource ?? null })
      return { ok: false, error: task.pidIdentityError }
    }
    const tokenCheck = matchesProcessIdentity(identity.row, { pid, taskId: task.taskId, profile: task.profile, port: task.port })
    if (!tokenCheck.ok) {
      task.pidIdentityError = `identity-token-mismatch:${tokenCheck.reason}`
      audit('fork-pid-identity-unavailable', { taskId: task.taskId, pid, error: task.pidIdentityError, pidStartedAtSource: task.pidStartedAtSource ?? null })
      return { ok: false, error: task.pidIdentityError }
    }
    const createdAt = Number(identity.row.createdAt)
    task.pidIdentity = {
      pid,
      startedAt: Number.isFinite(createdAt) ? createdAt : (Number.isFinite(provisionalStartedAt) ? provisionalStartedAt : null),
      commandLineHash: hashCommandLine(identity.row.commandLine),
      profile: task.profile,
      port: task.port,
      capturedAt: nowMs(),
      source: Number.isFinite(createdAt) ? 'cim' : 'spawn-provisional',
    }
    if (Number.isFinite(createdAt)) {
      task.pidStartedAt = createdAt
      task.pidStartedAtSource = 'cim'
    } else {
      task.pidStartedAt = Number.isFinite(provisionalStartedAt) ? provisionalStartedAt : null
      task.pidStartedAtSource = task.pidStartedAt ? 'spawn-provisional' : null
      task.pidIdentityError = 'creation-time-missing'
      audit('fork-pid-identity-unavailable', { taskId: task.taskId, pid, error: task.pidIdentityError, pidStartedAtSource: task.pidStartedAtSource })
      return { ok: false, error: task.pidIdentityError }
    }
    if (provisionalSource && task.pidStartedAtSource === 'cim') {
      task.pidIdentity.provisionalStartedAt = Number.isFinite(provisionalStartedAt) ? provisionalStartedAt : null
      task.pidIdentity.provisionalSource = provisionalSource
    }
    return { ok: true }
  }

  /** Capture identity off the critical spawn path; persist once it settles. */
  const scheduleTaskProcessIdentity = (task) => {
    void captureTaskProcessIdentity(task)
      .then(() => { try { writeWatchdog(); persist() } catch { /* best effort */ } })
      .catch(() => { /* captureTaskProcessIdentity already records the error */ })
  }

  /** Browser targets need the same PID-reuse guard as forks. */
  const scheduleBrowserProcessIdentity = (task) => {
    const browser = task?.browser
    if (!browser?.pid) return
    const pid = Number(browser.pid)
    const tokens = browser.profileDir && Number(browser.port) > 0
      ? [`--user-data-dir=${browser.profileDir}`, `--remote-debugging-port=${browser.port}`]
      : []
    void readProcessIdentity(pid)
      .then((identity) => {
        if (!identity.ok || !identity.row || Number(identity.row.pid) !== pid) return
        const tokenCheck = matchesProcessIdentity(identity.row, { pid, tokens })
        if (!tokenCheck.ok) {
          audit('watchdog-target-identity-unavailable', { taskId: task.taskId, kind: 'browser', pid, error: tokenCheck.reason })
          return
        }
        if (task.browser !== browser) return
        browser.pidIdentity = {
          pid,
          startedAt: identity.row.createdAt ?? null,
          commandLineHash: hashCommandLine(identity.row.commandLine),
          tokens,
          capturedAt: nowMs(),
          source: 'cim',
        }
        writeWatchdog()
        persist()
      })
      .catch(() => { /* sidecar falls back to startedAt + tokens */ })
  }


  const cleanupOrphanForks = async () => {
    if (process.platform !== 'win32') return { ok: true, killed: [] }
    const table = await readProcessTable()
    if (!table.ok) return { ok: false, killed: [], error: table.error }
    const killed = []
    for (const task of tasks.values()) {
      if (task.status !== TASK_STATUS.ARCHIVED && task.status !== TASK_STATUS.FAILED) continue
      const rootPid = Number(task.pid)
      if (!(rootPid > 0)) continue
      const tree = selectProcessTree(table.rows, rootPid)
      if (!tree.length) continue
      const root = tree.find((row) => row.pid === rootPid)
      if (!root) continue
      if (task.pidIdentity && (task.pidIdentity.startedAt === null || task.pidIdentity.startedAt === undefined || !Number.isFinite(Number(task.pidIdentity.startedAt)))) {
        const previous = Number(task.orphanSkipWarnAt) || 0
        if (nowMs() - previous >= 10 * 60_000) {
          task.orphanSkipWarnAt = nowMs()
          audit('fork-orphan-kill-skipped', { taskId: task.taskId, pid: rootPid, phase: 'preflight', reason: 'identity-start-time-missing' })
        }
        continue
      }
      const identity = {
        pid: rootPid,
        taskId: task.taskId,
        profile: task.profile,
        port: task.port,
        startedAt: task.pidIdentity?.startedAt ?? null,
        commandLineHash: task.pidIdentity?.commandLineHash ?? null,
      }
      const matched = matchesProcessIdentity(root, identity)
      if (!matched.ok) {
        const previous = Number(task.orphanSkipWarnAt) || 0
        if (nowMs() - previous >= 10 * 60_000) {
          task.orphanSkipWarnAt = nowMs()
          audit('fork-orphan-kill-skipped', { taskId: task.taskId, pid: rootPid, phase: 'preflight', reason: matched.reason, detail: matched.detail ?? null })
        }
        continue
      }
      // Re-read immediately before taskkill: PID may have been recycled between the
      // sweep snapshot and this kill, so start time + command-line hash must still match.
      const recheck = await readProcessTable()
      if (!recheck.ok) {
        audit('fork-orphan-kill-skipped', { taskId: task.taskId, pid: rootPid, phase: 'recheck-failed', reason: recheck.error })
        continue
      }
      if (task.status !== TASK_STATUS.ARCHIVED && task.status !== TASK_STATUS.FAILED) continue
      const currentRoot = recheck.rows.find((row) => row.pid === rootPid) ?? null
      const rechecked = matchesProcessIdentity(currentRoot, identity)
      if (!rechecked.ok) {
        audit('fork-orphan-kill-skipped', { taskId: task.taskId, pid: rootPid, phase: 'pre-taskkill', reason: rechecked.reason, detail: rechecked.detail ?? null })
        continue
      }
      const result = await killProcessTree(rootPid)
      if (result.ok) {
        killed.push(task.taskId)
        audit('fork-orphan-killed', { taskId: task.taskId, pid: rootPid, createdAt: currentRoot?.createdAt ?? null })
      } else {
        audit('fork-orphan-kill-failed', { taskId: task.taskId, pid: rootPid, error: result.error ?? 'taskkill-failed' })
      }
    }
    return { ok: true, killed }
  }

  const cliPath = () => (cfg.cliPath ? cfg.cliPath : resolveCliPath('', process.env))
  const forkTempEnv = (taskId) => {
    const tmp = path.join(layout.forkHomesDir, String(taskId), 'tmp')
    try { ensureDir(tmp) } catch { /* best effort */ }
    return { TEMP: tmp, TMP: tmp }
  }
  // P2：每个版本一份不可变安装快照；stock 分身使用自己的快照 CLI，母体安装升级/替换
  // 不会改变运行中分身解析到的 app.asar/runtime。快照创建失败时显式回退共享安装。
  let installSnapshotMemo = null
  const forkCliPath = () => {
    // P2-A 安装快照默认关闭：首次创建需对约 1.1GB/7,884 文件的安装树做 hardlink，
    // 在部分卷/目录结构上会退化为复制并超过 fork spawn 的 60s 预算，导致“启动失败”。
    // 验证通过后可显式 DSH_FANG_INSTALL_SNAPSHOT=1 启用（启动前预热快照）。
    if (process.env.DSH_FANG_INSTALL_SNAPSHOT !== '1') return cliPath()
    if (installSnapshotMemo) return installSnapshotMemo.cliPath
    const result = ensureInstallSnapshot({ cliPath: cliPath(), version: FANG_VERSION })
    installSnapshotMemo = result
    if (result.ok !== true) audit('fork-install-snapshot-failed', { error: result.error ?? 'unknown' })
    else audit('fork-install-snapshot-ready', { root: result.root, created: result.created })
    return result.ok === true ? result.cliPath : cliPath()
  }
  // The booted profile's own directory is authoritative (launcher sets DSH_PROFILE_DIR);
  // resolving "$DSH_HOME/profiles/<tag>" from argv can point at a template that never existed.
  // 分身模板必须来自一个**真的装了本 bundle** 的 profile；否则分身的 node_modules junction
  // 指到一个没有 @twinsearth/fang-dsh-plugin 的 profile，fork 里所有 /fang 路由都会 404（实测事故）。
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
      pidIdentity: f.pidIdentity ?? null,
      pidStartedAt: f.pidStartedAt ?? null,
      pidIdentityError: f.pidIdentityError ?? null,
      orphanSkipWarnAt: f.orphanSkipWarnAt ?? null,
      adapter: f.adapter ?? { ok: false, error: 'not-handshaked' },
      browserClosed: f.browserClosed ?? null,
      closeWarning: f.closeWarning ?? null,
      memoryGuard: f.memoryGuard ?? null,
      collaborators: Array.isArray(f.collaborators) ? f.collaborators : [],
      template: f.template ?? '',
      essenceId: f.essenceId ?? null,
      sourceEssence: f.sourceEssence ?? null,
      syncSourceId: f.syncSourceId ?? f.essenceId ?? OFFICIAL_ESSENCE_ID,
      configSourceFingerprint: f.configSourceFingerprint ?? null,
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

    const syncTaskMeta = (task, overrides = {}) => {
      if (!task?.homeDir) return false
      try {
        const previous = readForkMeta(task.homeDir) ?? {}
        const written = writeForkMeta(task.homeDir, {
          ...previous,
          forkId: task.taskId,
          status: overrides.status ?? task.status,
          pid: overrides.pid !== undefined ? overrides.pid : (task.pid ?? null),
          port: overrides.port !== undefined ? overrides.port : (task.port ?? null),
          url: overrides.url !== undefined ? overrides.url : stripUrlToken(task.url),
          profile: task.profile ?? previous.profile ?? null,
          taskStatus: overrides.status ?? task.status,
          lastError: overrides.lastError ?? task.adapter?.error ?? previous.lastError ?? null,
        })
        if (written !== true) audit('fork-meta-write-failed', { taskId: task.taskId, homeDir: task.homeDir })
        return written
      } catch {
        return false
      }
    }


    /**
     * Repair a fork's own fang-meta.json when no live process exists. The task
     * registry is authoritative after pause/stop; a meta that still says
     * running/pid/port is exactly the state that makes Open/Restore reuse a
     * port now owned by the essence runtime.
     */
    const repairTaskMetaIfStale = (task, reason = 'task-view') => {
      if (!task?.homeDir || task.status === TASK_STATUS.ARCHIVED) return false
      let live = null
      try { live = forker()?.status?.(task.taskId) ?? null } catch { live = null }
      if (live?.running === true) return false
      if (task.pid && isPidAlive(Number(task.pid))) return false
      const meta = readForkMeta(task.homeDir)
      const metaStatus = String(meta?.status ?? meta?.taskStatus ?? '')
      const taskStatus = String(task.status ?? '')
      const metaSuspect = Boolean(meta?.pid || meta?.port || meta?.url)
        || metaStatus === TASK_STATUS.RUNNING
        || metaStatus === TASK_STATUS.READY
        || metaStatus === TASK_STATUS.PROVISIONING
      const taskSuspect = Boolean(task.pid || task.port || task.url)
        || taskStatus === TASK_STATUS.RUNNING
        || taskStatus === TASK_STATUS.READY
        || taskStatus === TASK_STATUS.PROVISIONING
      if (!metaSuspect && !taskSuspect) return false
      const before = {
        task: { status: task.status, pid: task.pid ?? null, port: task.port ?? null, url: task.url ?? null, adapter: task.adapter?.ok ?? null },
        meta: meta ? { status: meta.status ?? meta.taskStatus ?? null, pid: meta.pid ?? null, port: meta.port ?? null, url: meta.url ?? null } : null,
      }
      const lastError = task.adapter?.error || (metaSuspect ? 'stale-meta-reconciled' : 'stale-process')
      let changed = false
      if (task.status !== TASK_STATUS.FAILED) { task.status = TASK_STATUS.FAILED; changed = true }
      if (task.pid != null) { task.pid = null; changed = true }
      if (task.port != null) { task.port = null; changed = true }
      if (task.url != null) { task.url = null; changed = true }
      if (task.token) { task.token = ''; changed = true }
      if (task.adapter?.ok === true) { task.adapter = { ok: false, error: lastError }; changed = true }
      if (changed) persist()
      const synced = meta ? syncTaskMeta(task, {
        status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError,
      }) : false
      audit('fork-meta-reconciled', { taskId: task.taskId, reason, before, synced })
      return synced || changed
    }

  function taskView(t) {
    try { repairTaskMetaIfStale(t, 'task-view') } catch { /* best effort */ }
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
      pid: running ? (live?.pid ?? t.pid ?? null) : null,
      pidStartedAt: t.pidStartedAt ?? t.pidIdentity?.startedAt ?? null,
      pidIdentityError: t.pidIdentityError ?? null,
      port: running ? (t.port ?? null) : null,
      url: running ? stripUrlToken(t.url) : null,
      homeDir: t.homeDir,
      profile: t.profile,
      createdAt: t.createdAt,
      restarts: t.restarts ?? 0,
      quarantined: t.quarantined ?? live?.quarantined ?? null,
      crashLoop: live?.quarantined?.reason === 'crash-loop' ? {
        count: live.quarantined.count ?? null,
        threshold: live.quarantined.threshold ?? null,
        windowMs: live.quarantined.windowMs ?? null,
        at: live.quarantined.at ?? null,
      } : null,
      browserExit: t.browserExit ?? null,
      browserCrash: t.browserCrash ?? null,
      browserCrashes: Array.isArray(t.browserCrashes) ? t.browserCrashes.slice(-5) : [],
      closeReason: t.closeReason ?? null,
      browserClosed: t.browserClosed ?? null,
      flushCapability: t.flushCapability ?? null,
      adapter: { ok: !!t.adapter?.ok, version: t.adapter?.version ?? '', protocol: t.adapter?.protocol ?? 0, error: t.adapter?.error ?? '' },
      activity: (() => {
        const cached = forkActivityCache.get(t.taskId)
        if (!cached) return null
        return {
          ok: cached.ok !== false,
          lastActivityAt: cached.lastActivityAt ?? null,
          lastActivityISO: cached.lastActivityISO ?? null,
          turnRunning: cached.turnRunning ?? null,
          signal: cached.signal ?? 'none',
          sessionId: cached.sessionId ?? null,
          messages: cached.messages ?? null,
          degraded: cached.degraded ?? [],
          source: cached.source ?? 'session-log',
          fetchedAt: cached.fetchedAt ?? null,
          error: cached.error ?? null,
        }
      })(),
      browser: t.browser ? {
        pid: t.browser.pid ?? null,
        helperPid: t.browser.helperPid ?? null,
        jobObject: t.browser.jobObject ?? null,
        port: t.browser.port ?? null,
        visibility: t.browser.last?.visibility ?? 'unknown',
        hiddenSince: t.browser.hiddenSince ?? null,
        idleClose: t.browser.idleClose ?? null,
        metrics: t.browser.last ? {
          at: t.browser.last.cdpAt ?? t.browser.last.at ?? null,
          documents: Number(t.browser.last.documents) || 0,
          listeners: Number(t.browser.last.listeners) || 0,
          layoutCount: Number(t.browser.last.layoutCount) || 0,
          nodes: Number(t.browser.last.nodes) || 0,
          heapMB: Number(t.browser.last.heapMB) || 0,
          cdpAgeMs: t.browser.last.cdpAgeMs ?? null,
          cdpSampled: t.browser.last.cdpSampled === true,
        } : null,
        history: Array.isArray(t.browser.metricsHistory)
          ? t.browser.metricsHistory.slice(-60).map((point) => ({
            at: Number(point.at) || null,
            documents: Number(point.documents) || 0,
            listeners: Number(point.listeners) || 0,
            layoutCount: Number(point.layoutCount) || 0,
          }))
          : [],
      } : null,
      browserClosed: t.browserClosed ?? null,
      closeWarning: t.closeWarning ?? null,
      memoryGuard: t.memoryGuard ?? null,
      collaborators: t.collaborators ?? [],
      seed: t.seed ?? null,
      importedSession: t.importedSession ?? null,
      workspaceMap: t.workspaceMapping ?? null,
      jobObject: live?.jobObject ?? null,
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
    const requestedWorkspace = String(meta?.workspacePath ?? '').trim() || 'imported-session'
    // P0: E:\DSH\DS and other shared host/project roots are redirected into
    // this fork's own home before the copied session is registered. The header
    // is rewritten too, so DSH does not resume with the old cwd.
    const workspaceMap = mapWorkspacePathForFork(homeDir, requestedWorkspace, {
      roots: cfg.forbiddenDataRoots,
      forkId: String(meta?.taskId ?? meta?.forkId ?? ''),
    })
    if (workspaceMap.ok !== true) return { ok: false, reason: 'workspace-map-failed', detail: workspaceMap }
    const workspacePath = workspaceMap.path || 'imported-session'
    const workspaceKey = encodeWorkspaceKey(workspacePath)
    const workspaceTitle = workspaceMap.mapped
      ? (String(meta?.workspaceTitle ?? '').trim() ? `${meta.workspaceTitle}（已隔离）` : '旧工作区（已隔离）')
      : (String(meta?.workspaceTitle ?? '').trim() || '导入的会话')
    const destDir = path.join(homeDir, 'sessions', workspaceKey, sessionId)
    ensureDir(destDir)
    fs.copyFileSync(sourceFile, path.join(destDir, 'session.v4.jsonl.zstd'))
    const headerRewrite = workspaceMap.mapped
      ? prepareImportedSession(homeDir, { sessionId, workspacePath: requestedWorkspace, roots: workspaceMigrationRoots(cfg), forkId: String(meta?.taskId ?? meta?.forkId ?? '') })
      : null

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
    return {
      ok: true, bytes, sessionId, workspacePath, workspaceKey, workspaceTitle, indexFile,
      workspaceMap: workspaceMap.mapped ? {
        mapped: true, originalPath: workspaceMap.original, mappedPath: workspaceMap.path,
        headerRewrite: headerRewrite?.header ?? null,
      } : { mapped: false },
    }
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
    const requested = String(cwd ?? '').trim()
    const safeRequested = requested && assertDataPath(requested, { forbiddenRoots: cfg.forbiddenDataRoots }).ok === true ? requested : ''
    // v3.8.2: never default a fork workspace to the mother/client project tree.
    // Each fork gets its own workspace inside its own home; imported E:\DSH\DS
    // workspace is intentionally ignored unless explicitly outside forbidden roots.
    const workspacePath = safeRequested || String(task?.importedSession?.workspacePath ?? '').trim()
      || workspaceForFork(homeDir)
    const finalWorkspace = assertDataPath(workspacePath, { forbiddenRoots: cfg.forbiddenDataRoots }).ok === true ? workspacePath : workspaceForFork(homeDir)
    const created = ensureForkEmptySession(homeDir, {
      workspacePath: finalWorkspace,
      workspaceTitle: path.basename(finalWorkspace) || '新会话',
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

    /**
     * fang-meta fallback for task-state transitions where the forker record is
     * missing. Merge the prior doc so crash counters survive; never write the
     * tokenized URL.
     */
    /** Loopback bind probe; falls back to the browser-guard scanner when an older forker lacks portFree. */
    const portIsFree = async (port) => {
      const n = Math.floor(Number(port))
      if (!Number.isInteger(n) || n < 1 || n > 65535) return true
      const f = forker()
      if (f && typeof f.portFree === 'function') {
        try { return (await f.portFree(n)) === true } catch { return false }
      }
      try { return (await freePort(n, n)) === n } catch { return false }
    }

    /**
     * Open-fork preflight: reconcile the three state stores before restore/open.
     * A task or fang-meta can still say running/pid/port after the process died,
     * while the same port is owned by the essence runtime (18000). Reusing that
     * URL opens the mother page and hides the real task failure behind a generic
     * handler-threw. This function only clears stale state; it never kills a
     * process that the forker still reports as genuinely alive.
     */
    const reconcileOpenState = async (task, reason = 'open-fork') => {
      if (!task || task.status === TASK_STATUS.ARCHIVED) return { ok: true, changed: false }
      const id = task.taskId
      const f = forker()
      let live = null
      try { live = f?.status?.(id) ?? null } catch { live = null }
      let liveAlive = false
      try { if (f && typeof f.alive === 'function') liveAlive = f.alive(id) === true } catch { liveAlive = false }
      if (!liveAlive && live?.running === true && Number(live.pid) > 0) liveAlive = isPidAlive(Number(live.pid))
      if (liveAlive) {
        // Keep the task row aligned with the process that actually owns the URL.
        const nextPid = Number(live?.pid) || task.pid || null
        const nextPort = Number(live?.port) || task.port || null
        const nextUrl = typeof live?.url === 'string' && live.url ? live.url : task.url
        let changed = false
        if (nextPid !== task.pid) { task.pid = nextPid; changed = true }
        if (nextPort !== task.port) { task.port = nextPort; changed = true }
        if (nextUrl && nextUrl !== task.url) { task.url = nextUrl; changed = true }
        if (task.status !== TASK_STATUS.RUNNING && task.status !== TASK_STATUS.READY) {
          task.status = TASK_STATUS.RUNNING
          changed = true
        }
        if (changed) {
          persist()
          syncTaskMeta(task)
          audit('fork-open-state-adopted-live', { taskId: id, reason, pid: task.pid, port: task.port })
        }
        return { ok: true, changed, live: true, pid: task.pid, port: task.port }
      }
      const liveStatus = String(task.status ?? '')
      const meta = readForkMeta(task.homeDir)
      const metaStatus = String(meta?.status ?? meta?.taskStatus ?? '')
      const metaSuspect = Boolean(meta?.pid || meta?.port || meta?.url)
        || metaStatus === TASK_STATUS.RUNNING
        || metaStatus === TASK_STATUS.READY
        || metaStatus === TASK_STATUS.PROVISIONING
      const suspect = Boolean(task.pid || task.port || task.url) || metaSuspect
        || liveStatus === TASK_STATUS.RUNNING
        || liveStatus === TASK_STATUS.READY
        || liveStatus === TASK_STATUS.PROVISIONING
      if (!suspect) return { ok: true, changed: false, live: false }
      const before = { status: task.status, pid: task.pid ?? null, port: task.port ?? null, url: task.url ?? null, meta: meta ? { status: meta.status ?? meta.taskStatus ?? null, pid: meta.pid ?? null, port: meta.port ?? null, url: meta.url ?? null } : null }
      const stalePort = Number(task.port) || Number(meta?.port) || null
      let portFree = true
      if (stalePort) portFree = await portIsFree(stalePort)
      // Stop a stale forker record; stopRecord is safe when nothing is running and
      // rewrites fang-meta with pid/port/url=null.
      try { await f?.stop?.(id) } catch { /* meta repair is best effort */ }
      // Never flush through the stale URL: it may now point at the essence runtime.
      try {
        if (task.browser?.pid) {
          const closed = await closeManagedBrowser({ pid: task.browser.pid, port: task.browser.port, graceMs: cfg.gracefulBrowserCloseMs })
          task.browser = null
          audit('fork-open-stale-browser-closed', { taskId: id, reason, ok: closed?.ok === true })
        }
      } catch (error) {
        audit('fork-open-stale-browser-close-failed', { taskId: id, reason, error: String(error?.message ?? error) })
      }
      const portConflict = Boolean(stalePort) && !portFree
      task.status = TASK_STATUS.FAILED
      task.pid = null
      task.port = null
      task.url = null
      task.token = ''
      task.adapter = { ok: false, error: portConflict ? 'stale-port-conflict' : 'stale-process' }
      persist()
      syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: task.adapter.error })
      audit('fork-open-state-reconciled', { taskId: id, reason, before, portFree, live: Boolean(live) })
      return { ok: true, changed: true, live: false, portFree, before }
    }

  const service = {
    role,
    version: FANG_VERSION,
    dataDir: layout.dataDir,

    /** v2 主入口：派生一个任务（= 一个分身）。 */
    async createTask(input = {}) {
      await bootPagefileGate
      const admission = await ensureHostAdmission()
      if (admission.ok !== true) return admission
      if (safeMode) return { ok: false, error: 'safe-mode', detail: safeModeReason || 'host-safe-mode' }
      if (isolationBlocked) return { ok: false, error: 'data-root-forbidden', detail: isolationChecks }
      const title = String(input.title ?? input.taskTitle ?? '').trim() || `任务 ${tasks.size + 1}`
      const running = [...tasks.values()].filter(t => {
        const s = taskView(t).status
        return s === TASK_STATUS.RUNNING || s === TASK_STATUS.READY
      }).length
      const maxForks = effectiveMaxForks()
      if (running >= maxForks) {
        return { ok: false, error: 'quota-exceeded', detail: `已达上限 ${maxForks}，请先归档旧任务` }
      }
      const commitGate = await enforceForkCommitBudget({ source: 'create-fork', failClosed: true })
      if (commitGate.ok !== true) {
        return { ok: false, error: commitGate.error || 'fork-commit-share-exceeded', detail: `fork 总 Commit 超过宿主余量红线（保留 ${cfg.forkCommitHostReserveMB} MB）` }
      }
      const f = forker()
      if (!f || typeof f.spawn !== 'function') {
        return { ok: false, error: 'forker-unavailable', detail: 'fang-forker 未加载' }
      }

      const taskId = newId('task')
      const profile = `fang-${taskId.replace(/^task_/, '').slice(0, 12)}`
      const homeDir = path.join(layout.forkHomesDir, taskId)
      const memory = await memoryGate('create-fork')
      if (memory.ok !== true) return { ok: false, taskId, ...memory }
      const paused = await pauseOtherForks(taskId, 'create-fork')
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
        if (essenceId === OFFICIAL_ESSENCE_ID) await repairOfficialEssenceNow()
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
        // 2026-11-22：所有分身（含模板/空白）都以官方推荐为默认同步源；每次打开都会
        // 对比源 fingerprint，源变化则重启并重新 provision，而不是等用户手动修复。
        syncSourceId: sourceEssence?.id ?? OFFICIAL_ESSENCE_ID,
        configSourceFingerprint: null,
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
      task.configSourceFingerprint = essenceManager.getMeta(sourceEssence?.id ?? OFFICIAL_ESSENCE_ID)?.lastMergedFingerprint ?? null

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
          // 此时回退母体模块树，保证分身仍能解析 @twinsearth/fang-dsh-plugin（否则是僵尸分身）。
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
        const experimentalSurface = applyOfficialExperimentalSurface(path.join(homeDir, 'profiles', profile), { coreMode })
        if (experimentalSurface.ok === false) audit('fork-experimental-surface-failed', { taskId, error: experimentalSurface.error })
        // D2：记录加速分身的插件面同步结果（哪些映射成功、哪些不支持、哪些插件被复制）。
        if (provisioned?.accelerated?.sync) {
          task.acceleratedSync = provisioned.accelerated.sync
          persist()
        }
        audit(AUDIT.FORK_CREATED, { taskId, forkId: taskId, title, homeDir, profile, templateFallback })

        // 防御：分身的 profile 必须能解析本 bundle；否则派生出来的是一个"没有 /fang 路由"的
        // 僵尸分身（adapter 握手会得到 http-404）。发现即回收并如实报错。
        // npm 安装名是 @twinsearth/fang-dsh-plugin；旧包名 @twinsearth/dsh-fang 与开发 link @twinsearth/fang-dsh-plugin 继续兼容。
        const forkProfileDir = path.join(homeDir, 'profiles', profile)
        if (process.env.DSH_FANG_E2E_DEBUG === '1') { try { copyTree(forkProfileDir, path.join(layout.dataDir, 'debug-fork-profile')) } catch { /* debug best effort */ } }
        const forkBundle = forkBundlePath(forkProfileDir)
        if (!forkBundle) {
          task.status = TASK_STATUS.FAILED
          tasks.delete(taskId)
          forkActivityCache.delete(taskId)
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

        // P0: existing imported/copied sessions may still carry E:\DSH\DS in
        // workspace.json or the session header. Redirect them before the fork
        // host starts; this is metadata-only (old workspace files stay untouched).
        try {
          const workspaceMap = migrateForkWorkspace(homeDir, { roots: workspaceMigrationRoots(cfg), forkId: taskId })
          task.workspaceMapping = workspaceMap
          if (workspaceMap.changed || workspaceMap.conflicts.length > 0) {
            audit('fork-workspace-migrated', {
              taskId, changed: workspaceMap.changed, mappings: workspaceMap.mappings.length,
              moved: workspaceMap.moved.length, conflicts: workspaceMap.conflicts.slice(0, 5),
              manifestFile: workspaceMap.manifestFile ?? null,
            })
          }
        } catch (error) {
          task.workspaceMapping = { ok: false, error: String(error?.message ?? error) }
          audit('fork-workspace-migration-failed', { taskId, error: task.workspaceMapping.error })
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

        let spawnPidPoll = null
        let started = null
        try {
          // The forker exposes the OS PID as soon as spawn returns, before the
          // URL-ready promise resolves. Mirror it into the task/watchdog file
          // synchronously so the sidecar never has to wait for a 30s tick.
          spawnPidPoll = setInterval(() => {
            try {
              const live = f.status?.(taskId)
              const livePid = Number(live?.pid)
              if (!(livePid > 0) || Number(task.pid) === livePid) return
              task.pid = livePid
              if (Number(live?.port) > 0) task.port = Number(live.port)
              syncTaskMeta(task, { pid: task.pid, port: task.port ?? null })
              persist()
              writeWatchdog()
              void lowerProcessPriority(task.pid, { priorityClass: processPriorityClass })
            } catch { /* sidecar sync is best effort */ }
          }, 200)
          spawnPidPoll.unref?.()
          started = await f.spawn({
            forkId: taskId,
            homeDir,
            profile,
            // 加速档只解析加速核入口；stock 母体 CLI 绝不能传入（v3.5.2 起会误判/失败）。
            ...(coreMode === 'accelerated' ? {} : { cliPath: forkCliPath() }),
            coreMode,
            env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: taskId, DSH_FANG_MOTHER: layout.dataDir, ...forkTempEnv(taskId) },
          })
        } finally {
          if (spawnPidPoll) clearInterval(spawnPidPoll)
        }
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
        task.pidStartedAt = Number(started.pid) > 0 ? nowMs() : null
        task.pidStartedAtSource = Number(started.pid) > 0 ? 'spawn-provisional' : null
        task.port = started.port ?? null
        task.url = started.url ?? null
        task.token = started.token ?? extractTokenSafe(task.url)
        scheduleTaskProcessIdentity(task)
        persist()
        writeWatchdog()
        void lowerProcessPriority(task.pid, { priorityClass: processPriorityClass })
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

    /** 2026-11-22：一键导出分身完整 home（不含可再生的 node_modules/tmp）。 */
    async exportTask(taskId, destDir, options = {}) {
      const task = tasks.get(String(taskId ?? '').trim())
      if (!task) return { ok: false, error: 'unknown-task' }
      if (!destDir || !path.isAbsolute(String(destDir))) return { ok: false, error: 'dest-dir-required' }
      let workspacePath = ''
      try {
        const ws = readJson(path.join(task.homeDir, 'storages', 'workspace.json'), {})
        workspacePath = Object.values(ws?.tables?.workspaces ?? {}).map((item) => String(item?.path ?? '')).find(Boolean) ?? ''
      } catch { /* optional */ }
      const out = exportVault({ homeDir: task.homeDir, destDir: String(destDir), task: { ...task, workspacePath }, options })
      if (out.ok) audit('fork-exported', { taskId: task.taskId, dir: out.dir, files: out.files, bytes: out.bytes })
      return out
    },

    /** 2026-11-22：一键导入分身导出包，复制 home/profile 后重新拉起并握手。 */
    async importTask(sourceDir, title) {
      const parsed = readVault(sourceDir)
      if (!parsed.ok) return parsed
      const id = newId('task')
      const profile = `fang-${id.slice(-12)}`
      const homeDir = path.join(layout.forkHomesDir, id)
      if (exists(homeDir)) return { ok: false, error: 'task-exists', taskId: id }
      ensureDir(path.dirname(homeDir))
      const imported = importVault({ sourceDir, homeDir, profile })
      if (imported.ok !== true) return imported
      const targetProfileDir = path.join(homeDir, 'profiles', profile)
      // 导出包不含 node_modules：从母体/官方 merged 重新移植依赖树，再拉起。
      const importedModules = path.join(targetProfileDir, 'node_modules')
      if (!exists(importedModules)) {
        const motherModules = path.join(linkProfileDir() || essenceManager.mergedProfileDir(OFFICIAL_ESSENCE_ID), 'node_modules')
        if (exists(motherModules)) {
          try { fs.symlinkSync(motherModules, importedModules, 'junction') } catch { /* mirror repair will retry */ }
        }
      }
      try { syncProfileModulesFromMother(targetProfileDir, linkProfileDir() || essenceManager.mergedProfileDir(OFFICIAL_ESSENCE_ID)) } catch { /* best effort */ }
      const task = normalizeTask({
        taskId: id,
        title: String(title ?? '').trim() || String(parsed.manifest?.title ?? '').trim() || `导入的分身 ${id.slice(-6)}`,
        profile,
        homeDir,
        status: TASK_STATUS.FAILED,
        coreMode: parsed.manifest?.coreMode === 'accelerated' ? 'accelerated' : 'stock',
        essenceId: null,
        syncSourceId: OFFICIAL_ESSENCE_ID,
        configSourceFingerprint: essenceManager.getMeta(OFFICIAL_ESSENCE_ID)?.lastMergedFingerprint ?? null,
        importedSnapshot: true,
      })
      tasks.set(id, task)
      persist()
      audit('fork-imported', { taskId: id, sourceDir: parsed.dir, files: parsed.manifest?.files ?? 0, profile })
      const restored = await service.restoreTask(id, { preserveProfile: true })
      return { ok: restored.ok === true, taskId: id, title: task.title, restored, dir: parsed.dir }
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

    /** C4: operator quota status; safe gates are Commit/heap, not a hidden 1-fork clamp. */
    multiForkStatus() {
      const limit = effectiveMaxForks()
      return {
        ok: true,
        requested: requestedMultiFork,
        enabled: limit > 1,
        hardLimit: limit,
        confirmRequired: true,
        confirmToken: MULTI_FORK_CONFIRM_TOKEN,
        detail: `当前配额 ${limit}；创建新分身仍受 Commit/heap 守卫限制，内存不足会明确拒绝。`,
      }
    },

    /** C4: UI/HTTP confirm endpoint; records the operator's quota confirmation. */
    confirmMultiFork(input = {}) {
      if (input?.confirm !== true || String(input?.token ?? '') !== MULTI_FORK_CONFIRM_TOKEN) {
        return {
          ok: false,
          error: 'confirmation-required',
          requested: requestedMultiFork,
          hardLimit: effectiveMaxForks(),
          confirmToken: MULTI_FORK_CONFIRM_TOKEN,
        }
      }
      const limit = effectiveMaxForks()
      try { audit('multi-fork-confirmed', { requested: requestedMultiFork, hardLimit: limit }) } catch { /* audit optional */ }
      return {
        ok: true,
        confirmed: true,
        requested: requestedMultiFork,
        enabled: limit > 1,
        hardLimit: limit,
        detail: `已确认 ${limit} 个分身配额；实际创建仍由 Commit/heap 守卫逐次检查。`,
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
      if (adapterStatus && adapterStatus.activity && typeof adapterStatus.activity === 'object') {
        forkActivityCache.set(task.taskId, { ...adapterStatus.activity, fetchedAt: nowMs(), remoteOk: true })
      }
      const activity = forkActivityCache.get(task.taskId) ?? null
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
        activity,
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
        activity: status.activity ?? null,
        adapterStatus: status.adapterStatus ?? null,
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
      await closeTaskBrowser(task, 'archive')
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
      syncTaskMeta(task, { status: TASK_STATUS.ARCHIVED, pid: null, port: null, url: null, lastError: 'archived' })
      remoteCache.delete(id)
      audit(AUDIT.TASK_ARCHIVED, { taskId: id, title: task.title, remote, stopped: true, homeKept: true })
      bus.emit('fang/task-archived', { taskId: id, title: task.title })
      // EB-01: compaction is only for an already-archived task, keeps a hard-link
      // backup, and never moves the session. Run after the archive response so a
      // large 60 MB log does not delay the UI.
      setTimeout(() => {
        try { compactArchivedTaskSessions(task) } catch { /* audited inside */ }
        if (cfg.browserCacheCleanupEnabled === true) {
          try { browserCacheCleanup(task) } catch { audit('browser-cache-cleanup-failed', { taskId: id }) }
        }
      }, 0)
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
    async compactSessions(taskId = '') {
      const id = String(taskId ?? '')
      if (id) {
        const task = tasks.get(id)
        if (!task) return { ok: false, error: 'unknown-task' }
        if (task.status !== TASK_STATUS.ARCHIVED) return { ok: false, error: 'not-archived' }
        return compactArchivedTaskSessions(task)
      }
      await sessionCompactTick()
      return { ok: true, snapshot: sessionCompactSnapshot }
    },
    diskHygiene() {
      return refreshDiskHygiene(false) || { ok: false, error: 'disabled' }
    },
    refreshDiskHygiene() {
      return refreshDiskHygiene(true) || { ok: false, error: 'disabled' }
    },
    cleanupBrowserCache(taskId, options = {}) {
      if (options?.confirm !== true) return { ok: false, error: 'confirmation-required' }
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.status !== TASK_STATUS.ARCHIVED) return { ok: false, error: 'not-archived' }
      return browserCacheCleanup(task)
    },

    /** 还原存档：用原 home/profile 重新 spawn（新端口 + 新 token），再握手。 */
    /** 分身配置重置：把来源原身的 merged/profile 重新覆盖到分身 profile（保留 node_modules 与会话）。 */
    async resetForkConfig(taskId) {
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      const sourceId = String(task.essenceId || task.syncSourceId || OFFICIAL_ESSENCE_ID)
      if (!task.essenceId && !task.syncSourceId) return { ok: false, error: 'no-source-essence' }
      const meta = essenceManager.getMeta(sourceId)
      if (!meta || typeof meta.id !== 'string') return { ok: false, error: 'source-essence-missing' }
      if (meta.archived === true) return { ok: false, error: 'source-essence-archived' }
      await essenceManager.ensureFresh(sourceId)
      const source = essenceManager.mergedProfileDir(sourceId)
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
      task.configSyncedFrom = sourceId
      task.syncSourceId = sourceId
      task.configSourceFingerprint = essenceManager.getMeta(sourceId)?.lastMergedFingerprint ?? null
      persist()
      audit('fork-config-reset', { taskId: id, essenceId: sourceId, files: picked, configLock, profileReadonly })
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

    async restoreTask(taskId, options = {}) {
      await bootPagefileGate
      const preserveProfile = options?.preserveProfile === true
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      const admission = await ensureHostAdmission()
      if (admission.ok !== true) return { ...admission, taskId: id }
      if (safeMode) return { ok: false, taskId: id, error: 'safe-mode', detail: safeModeReason || 'host-safe-mode' }
      const wasQuarantined = Boolean(task.quarantined)
      const f = forker()
      if (!f || typeof f.spawn !== 'function') return { ok: false, error: 'forker-unavailable', taskId: id }
      const liveQuarantine = typeof f.status === 'function' ? f.status(id)?.quarantined : null
      const clearingQuarantine = wasQuarantined || Boolean(liveQuarantine)
      const failRestoreStep = (step, error, extra = {}) => {
        const detail = String(error?.message ?? error)
        try { f.stop?.(id) } catch { /* best effort */ }
        task.status = TASK_STATUS.FAILED
        task.pid = null
        task.port = null
        task.url = null
        task.token = ''
        task.adapter = { ok: false, error: `${step}-threw` }
        persist()
        syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: task.adapter.error })
        audit('fork-restore-step-failed', { taskId: id, step, detail, ...extra })
        return { ok: false, taskId: id, step, error: `${step}-threw`, detail, ...extra }
      }
      // Never restore through a stale task/pid/port row. This also releases a
      // port that the essence runtime (18000) owns before spawn allocates a new one.
      try { await reconcileOpenState(task, 'restore-fork') } catch (error) {
        return failRestoreStep('reconcile-state', error)
      }
      const memory = await (async () => {
        try { return await memoryGate('restore-fork') } catch (error) { return { ok: false, error: 'memory-gate-threw', detail: String(error?.message ?? error) } }
      })()
      if (memory.ok !== true) return { ok: false, taskId: id, step: 'memory-gate', error: memory.error, detail: memory.detail ?? null }
      let paused
      try { paused = await pauseOtherForks(id, 'restore-fork') } catch (error) {
        return failRestoreStep('pause-other-forks', error)
      }
      // 2026-11-22：任务可能停在 ready/running，但子进程已经死了（宿主重启、手动 kill、
      // 端口丢失）。客户端「启动」仍会调用 restore；旧逻辑返回 not-archived，导致
      // 真机界面一直显示“启动失败”。这里允许恢复 stale 的 ready/running。
      if (task.status !== TASK_STATUS.ARCHIVED && task.status !== TASK_STATUS.FAILED) {
        let live = null
        try { live = f.status?.(id) ?? null } catch (error) { return failRestoreStep('inspect-live-fork', error) }
        if (live?.running === true && task.adapter?.ok === true) {
          return { ok: true, alreadyRunning: true, taskId: id, url: task.url, port: task.port, adapter: task.adapter }
        }
        try { f.stop?.(id) } catch { /* stale process already gone */ }
        task.status = TASK_STATUS.FAILED
        task.pid = null
        task.port = null
        task.url = null
        persist()
        syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: 'stale-process' })
      }
      if (!task.homeDir || !exists(task.homeDir)) {
        return { ok: false, error: 'archive-home-missing', taskId: id, homeDir: task.homeDir ?? '' }
      }
      try { assertInside(layout.forkHomesDir, task.homeDir, 'fork-home') } catch (error) {
        return { ok: false, error: 'path-escape', taskId: id, detail: String(error?.message ?? error) }
      }
      // P0: restore is the last checkpoint before the fork host opens its
      // sessions. Redirect legacy E:\DSH\DS metadata here even for tasks that
      // were created before this release.
      try {
        const workspaceMap = migrateForkWorkspace(task.homeDir, { roots: workspaceMigrationRoots(cfg), forkId: id })
        task.workspaceMapping = workspaceMap
        if (workspaceMap.changed || workspaceMap.conflicts.length > 0) {
          audit('fork-workspace-migrated', {
            taskId: id, changed: workspaceMap.changed, mappings: workspaceMap.mappings.length,
            moved: workspaceMap.moved.length, conflicts: workspaceMap.conflicts.slice(0, 5),
            manifestFile: workspaceMap.manifestFile ?? null,
          })
        }
      } catch (error) {
        task.workspaceMapping = { ok: false, error: String(error?.message ?? error) }
        audit('fork-workspace-migration-failed', { taskId: id, error: task.workspaceMapping.error })
      }
      const forkProfileDir = path.join(task.homeDir, 'profiles', task.profile)
      const forkBundle = forkBundlePath(forkProfileDir)
      if (!forkBundle) {
        return { ok: false, error: 'fork-bundle-unavailable', taskId: id, detail: forkProfileDir }
      }
      // 从原身派生的分身：还原前先把配置重置回来源原身（分身只生产，不保留配置改动）。
      // 先捕获元主 Web 的最新插件改动，避免 reset 用旧快照覆盖。所有分身（含模板）
      // 默认同步源为官方推荐。
      const syncSourceId = String(task.essenceId || task.syncSourceId || OFFICIAL_ESSENCE_ID)
      let configReset = null
      if (!preserveProfile) {
        try {
          captureEssenceRuntimeIfPresent(syncSourceId)
          if (syncSourceId === OFFICIAL_ESSENCE_ID) await repairOfficialEssenceNow()
        } catch (error) {
          return failRestoreStep('capture-source-profile', error)
        }
        try { configReset = await service.resetForkConfig(id) } catch (error) {
          configReset = { ok: false, error: String(error?.message ?? error) }
        }
      } else {
        configReset = { ok: true, skipped: 'preserve-imported-profile' }
      }
      // EB-01 防线：restore 绝不再搬移用户会话。超额只保留 violation 警告；
      // 只有用户显式 enforce/归档动作才允许移动（见 docs/ERROR-BOOK.md EB-01）。
      const sessionGuard = { ok: true, skipped: 'restore-never-moves-sessions', violation: Boolean(task.sessions?.violation) }
      // 开关不是热更新：重新打开分身时按当前开关换核（重新 provision profile；会话目录不动）。
      // resetForkConfig 刚把 profile 重置回 stock 形状；即使 coreMode 未变也必须强制 reprovision，
      // 否则加速分身会以 stock 配置 + accelerated CLI 启动而永远不 ready（2026-11-22 实测 timeout）。
      let coreSync
      try {
        coreSync = preserveProfile
          ? { ok: true, switched: false, coreMode: task.coreMode === 'accelerated' ? 'accelerated' : 'stock' }
          : await syncForkCoreMode(task, { force: true })
      } catch (error) {
        return failRestoreStep('sync-fork-core-mode', error)
      }
      if (coreSync.ok !== true) {
        task.status = TASK_STATUS.FAILED
        task.pid = null
        task.port = null
        task.url = null
        task.token = ''
        task.adapter = { ok: false, error: coreSync.error ?? 'sync-fork-core-mode-failed' }
        persist()
        syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: task.adapter.error })
        audit(AUDIT.TASK_RESTORED, { taskId: id, ok: false, error: coreSync.error })
        return { ok: false, taskId: id, step: 'sync-fork-core-mode', error: coreSync.error, detail: coreSync.detail ?? null }
      }
      // 老/空白分身重新打开时补齐官方实验性插件表面；先整体对齐来源元主的完整插件面。
      // 完整来源插件面对齐：默认开启；e2e 已证 125/125（node-compat 复制关闭后）。
      let sourceSurface
      try {
        sourceSurface = preserveProfile
          ? { ok: true, skipped: 'preserve-imported-profile' }
          : process.env.DSH_FANG_SOURCE_SURFACE === '0'
            ? { ok: true, skipped: 'disabled' }
            : applySourcePluginSurface(task, forkProfileDir)
      } catch (error) {
        return failRestoreStep('apply-source-plugin-surface', error)
      }
      if (process.env.DSH_FANG_E2E_DEBUG === '1') { try { copyTree(forkProfileDir, path.join(layout.dataDir, 'debug-restore-profile')) } catch { /* debug */ } }
      if (sourceSurface.ok === false) audit('fork-source-surface-failed', { taskId: id, error: sourceSurface.error })
      else if (Number(sourceSurface.coreUiForced) > 0) audit('fork-core-ui-enabled', { taskId: id, coreUiForced: Number(sourceSurface.coreUiForced) })
      let experimentalSurface
      try {
        experimentalSurface = preserveProfile
          ? { ok: true, skipped: 'preserve-imported-profile' }
          : applyOfficialExperimentalSurface(forkProfileDir, { coreMode: coreSync.coreMode })
      } catch (error) {
        return failRestoreStep('apply-experimental-surface', error)
      }
      if (experimentalSurface.ok === false) audit('fork-experimental-surface-failed', { taskId: id, error: experimentalSurface.error })
      let started
      try {
        started = await f.spawn({
        forkId: id,
        homeDir: task.homeDir,
        profile: task.profile,
        ...(coreSync.coreMode === 'accelerated' ? {} : { cliPath: forkCliPath() }),
        coreMode: coreSync.coreMode,
          resetCrashLoop: clearingQuarantine,
          env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: id, DSH_FANG_MOTHER: layout.dataDir, ...forkTempEnv(id) },
        })
      } catch (error) {
        return failRestoreStep('spawn', error)
      }
      if (!started || started.ok === false) {
        const error = started?.error === 'accelerated-cli-missing' ? 'accelerated-cli-missing' : 'spawn-failed'
        task.status = TASK_STATUS.FAILED
        task.pid = null
        task.port = null
        task.url = null
        task.token = ''
        task.adapter = { ok: false, error }
        persist()
        syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: error })
        try { f.stop?.(id) } catch { /* best effort */ }
        audit(AUDIT.TASK_RESTORED, { taskId: id, ok: false, error, step: 'spawn' })
        return {
          ok: false,
          taskId: id,
          step: 'spawn',
          error,
          detail: started?.error ?? 'unknown',
          ...(Array.isArray(started?.searched) ? { searched: started.searched } : {}),
        }
      }
      task.status = TASK_STATUS.RUNNING
      task.archivedAt = null
      task.archiveRemote = null
      task.pid = started.pid ?? null
      task.pidStartedAt = Number(started.pid) > 0 ? nowMs() : null
      task.pidStartedAtSource = Number(started.pid) > 0 ? 'spawn-provisional' : null
      task.port = started.port ?? null
      task.url = started.url ?? null
      task.token = started.token ?? extractTokenSafe(task.url)
      task.adapter = { ok: false, error: 'handshaking' }
      scheduleTaskProcessIdentity(task)
      persist()
      writeWatchdog()
      void lowerProcessPriority(task.pid, { priorityClass: processPriorityClass })
      audit(AUDIT.FORK_STARTED, { taskId: id, pid: task.pid, port: task.port, profile: task.profile, restored: true })
      let adapter
      try {
        adapter = await handshake(task)
      } catch (error) {
        const detail = String(error?.message ?? error)
        task.status = TASK_STATUS.RUNNING
        task.adapter = { ok: false, error: 'handshake-threw' }
        persist()
        audit('fork-restore-step-failed', { taskId: id, step: 'handshake', detail })
        return { ok: false, taskId: id, step: 'handshake', error: 'handshake-threw', detail, url: stripUrlToken(task.url), port: task.port, pid: task.pid }
      }
      task.status = adapter.ok ? TASK_STATUS.READY : TASK_STATUS.RUNNING
      persist()
      audit(AUDIT.TASK_RESTORED, { taskId: id, ok: true, adapter })
      bus.emit('fang/task-restored', { taskId: id, url: task.url, port: task.port })
      if (task.quarantined) {
        task.quarantined = null
        audit('fork-quarantine-cleared', { taskId: id, by: 'restore', tokenRotated: true })
      }
      return { ok: true, restored: true, taskId: id, title: task.title, url: task.url, port: task.port, adapter, configReset, sessionGuard, paused, tokenRotated: true, quarantineCleared: wasQuarantined }
    },

    /**
     * 2026-11-22：每次打开分身都主动同步来源元主的插件状态。
     * 读取运行中元主的 settings/patch/bundles/modules → 更新元宝 fingerprint；
     * fingerprint 变化时停止旧分身并按新 merged profile 重新 provision + spawn。
     */
    async syncTaskOnOpen(taskId) {
      await bootPagefileGate
      const id = String(taskId ?? '')
      const task = tasks.get(id)
      if (!task) return { ok: false, error: 'unknown-task' }
      const admission = await ensureHostAdmission()
      if (admission.ok !== true) return { ...admission, taskId: id }
      if (safeMode) return { ok: false, taskId: id, error: 'safe-mode', detail: safeModeReason || 'host-safe-mode' }
      // Forker 的 10 分钟 2 次崩溃闩锁是进程层事实；把它投影到任务层，
      // 否则用户点“打开”会绕过隔离直接 restore 出一个新进程。
      try {
        const live = forker()?.status?.(id)
        if (live?.quarantined && !task.quarantined) {
          task.quarantined = live.quarantined
          task.status = TASK_STATUS.FAILED
          task.pid = null
          task.port = null
          task.url = null
          task.token = ''
          task.adapter = { ok: false, error: 'fork-quarantined' }
          persist()
          syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: 'crash-loop-quarantined' })
          audit('fork-crash-loop-quarantine-projected', { taskId: id, quarantined: live.quarantined })
        }
      } catch { /* status read is best effort */ }
      if (task.quarantined) return { ok: false, taskId: id, error: 'fork-quarantined', detail: task.quarantined.reason ?? 'guard' }

      const failOpenStep = (step, error, extra = {}) => {
        const detail = String(error?.message ?? error)
        const f = forker()
        let live = null
        try { live = f?.status?.(id) ?? null } catch { live = null }
        const stillRunning = live?.running === true
        if (!stillRunning) {
          task.status = TASK_STATUS.FAILED
          task.pid = null
          task.port = null
          task.url = null
          task.token = ''
          try { f?.stop?.(id) } catch { /* best effort */ }
        }
        task.adapter = { ok: false, error: `${step}-threw` }
        persist()
        syncTaskMeta(task, { status: task.status, pid: task.pid ?? null, port: task.port ?? null, url: stripUrlToken(task.url), lastError: task.adapter.error })
        audit('fork-open-step-failed', { taskId: id, step, detail, ...extra })
        return {
          ok: false, taskId: id, step, error: `${step}-threw`, detail,
          ...(stillRunning ? { url: stripUrlToken(task.url), port: task.port, pid: task.pid } : {}),
          ...extra,
        }
      }

      let step = 'reconcile-state'
      try {
        await reconcileOpenState(task, 'open-fork')
        step = 'memory-gate'
        const memory = await memoryGate('open-fork')
        if (memory.ok !== true) return { ok: false, taskId: id, step, error: memory.error, detail: memory.detail ?? null }
        step = 'pause-other-forks'
        const paused = await pauseOtherForks(id, 'open-fork')
        const sourceId = String(task.essenceId || task.syncSourceId || OFFICIAL_ESSENCE_ID)
        step = 'capture-source-profile'
        captureEssenceRuntimeIfPresent(sourceId)
        step = 'repair-official-essence'
        if (sourceId === OFFICIAL_ESSENCE_ID) await repairOfficialEssenceNow()
        step = 'ensure-fresh'
        await essenceManager.ensureFresh(sourceId)
        step = 'fingerprint'
        const fingerprint = essenceManager.getMeta(sourceId)?.lastMergedFingerprint ?? null
        const changed = Boolean(fingerprint && task.configSourceFingerprint !== fingerprint)
        if (changed) {
          step = 'stop-stale'
          // Stop unconditionally: a stopped record still carries stale meta fields.
          try { await forker()?.stop?.(id) } catch { /* best effort */ }
          task.status = TASK_STATUS.FAILED
          task.pid = null
          task.port = null
          task.url = null
          task.token = ''
          task.adapter = { ok: false, error: 'source-fingerprint-changed' }
          persist()
          syncTaskMeta(task, { status: TASK_STATUS.FAILED, pid: null, port: null, url: null, lastError: task.adapter.error })
          step = 'restore'
          const restored = await service.restoreTask(id)
          return { ...restored, synced: true, restarted: true, sourceFingerprint: fingerprint, paused }
        }
        if (task.status === TASK_STATUS.FAILED) {
          step = 'restore'
          const restored = await service.restoreTask(id)
          return { ...restored, synced: true, restarted: true, sourceFingerprint: fingerprint, paused }
        }
        step = 'open-url'
        const out = forker()?.openUrl?.(id) ?? null
        if (!out || out.ok !== true) return { ok: false, taskId: id, step, error: out?.error ?? 'not-running' }
        return { ...out, synced: true, restarted: false, sourceFingerprint: fingerprint, paused }
      } catch (error) {
        return failOpenStep(step, error)
      }
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
      // Boot pagefile gate is authoritative: a missing/disabled page file enters
      // Safe Mode and no fork/browser may be spawned automatically.
      await bootPagefileGate
      if (safeMode) {
        const skipped = [...tasks.values()].map(task => ({ taskId: task.taskId, reason: 'safe-mode' }))
        audit('autostart-refused', { reason: safeModeReason || 'host-safe-mode', skipped: skipped.length })
        return { ok: false, error: 'safe-mode', detail: safeModeReason || 'host-safe-mode', started: [], failed: [], skipped }
      }
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
            ...(coreSync.coreMode === 'accelerated' ? {} : { cliPath: forkCliPath() }),
            coreMode: coreSync.coreMode,
            env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: id, DSH_FANG_MOTHER: layout.dataDir, ...forkTempEnv(id) },
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
        task.pidStartedAt = Number(started.pid) > 0 ? nowMs() : null
        task.pidStartedAtSource = Number(started.pid) > 0 ? 'spawn-provisional' : null
        task.port = started.port ?? null
        task.url = started.url ?? null
        task.token = started.token ?? extractTokenSafe(task.url)
        task.adapter = { ok: false, error: 'handshaking' }
        scheduleTaskProcessIdentity(task)
        persist()
        writeWatchdog()
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
      forkActivityCache.delete(id)
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
      forkActivityCache.delete(task.taskId)
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
          canonicalFangHome: layout.canonicalFangHome || DEFAULT_FANG_DATA_ROOT,
          legacyDataDetected: layout.legacyDataDetected === true,
          legacyDataDir: layout.legacyDataDir || '',
          migrationReport,
          dataIsolationBlocked: isolationBlocked,
          dataIsolationErrors: isolationChecks,
          dataDir: layout.dataDir,
          essenceRoot: layout.essenceRoot,
          forkHomesDir: layout.forkHomesDir,
          runtimeRoot: layout.runtimeRoot,
          sessionsRoot: layout.sessionsRoot || '',
        },
        mother: { profile: motherProfile, cliPath: cliPath(), template: templateDir() },
        essenceAutoRefresh: lastAutoRefresh,
        tasks: { total: list.length, ready, running, max: effectiveMaxForks(), list },
        // v1 兼容视图：Client 徽标与旧调用方仍读 forks.*
        forks: { total: list.length, running: ready + running, max: effectiveMaxForks(), list },
        // v3.9.4：分身容量（默认 8 / 硬上限 62）；UI 读取这里而不是自己硬编码 7。
        capacity: {
          slots: effectiveMaxForks(),
          hardMax: HARD_MAX_FORKS,
          defaultLimit: DEFAULT_MAX_FORKS,
          limit: effectiveMaxForks(),
          used: list.filter((row) => row.status !== 'archived').length,
        },
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
        // 2026-11-25: pagefile / Commit 快照。由 memoryGate、host/memory watchdog
        // 和启动探针刷新；status 本身不做 PowerShell 查询，避免拉高采样成本。
        memory: memorySnapshot,
        pageFileMB: Number(memorySnapshot?.pageFileMB) || 0,
        hasPageFile: memorySnapshot?.hasPageFile === true,
        memoryPolicy: memoryPolicySnapshot(),
        // v3.8.8: mother RSS/private + fork/browser aggregate commit snapshot.
        hostMetrics: lastHostMetrics,
        processPriority: {
          mode: cfg.processPriority,
          class: processPriorityClass,
        },
        multiFork: service.multiForkStatus(),
        hostCrash: {
          windowMinutes: hostCrashWindowMinutes,
        },
        // v3.8.14: Host JS heap + session body. These are independent of the
        // OS Commit probe so a PowerShell failure cannot hide a V8 heap spike.
        hostPressure: {
          heap: lastHostHeapDecision,
          session: lastSessionFootprintDecision,
          footprint: lastSessionFootprint,
          policy: currentPressurePolicy(),
          gate: (() => {
            const pressure = currentPressureGate()
            return pressure.ok === true ? null : pressure.error
          })(),
        },
        forkCommitPolicy: {
          warnShare: Number(cfg.forkCommitWarnShare),
          severeShare: Number(cfg.forkCommitSevereShare),
          emergencyShare: Number(cfg.forkCommitShareLimit),
          warnMB: Number(cfg.hostWarnFreeMB),
          severeMB: Number(cfg.hostCriticalFreeMB),
          emergencyMB: Number(cfg.hostEmergencyFreeMB),
        },
        browserAutoClose: {
          enabled: cfg.autoClose === true,
          requiresConfirm: false,
          preservesHome: true,
          ...effectiveBrowserAutoCloseLimits(cfg, memoryPolicySnapshot()),
        },
        pagefilePolicy: {
          missing: memorySnapshot?.pagefileMissing === true,
          hasPageFile: memorySnapshot?.hasPageFile === true,
          pageFileMB: Number(memorySnapshot?.pageFileMB) || 0,
          evidence: memorySnapshot?.pagingFilesEmpty === true ? 'PagingFiles={}'
            : memorySnapshot?.commitLimitNearRam === true ? 'CommitLimit≈RAM'
              : memorySnapshot?.pagefileMissing === true ? 'Win32_PageFileUsage 无分配' : null,
          singleForkOnly: false,
          maxConcurrentForks: effectiveMaxForks(),
          advisoryOnly: (memorySnapshot?.pagefileMissing === true || memorySnapshot?.hasPageFile === false) === true,
          safeMode: safeMode === true,
          admissionClosed: hostAdmissionClosed === true,
        },
        sessionCompact: sessionCompactSnapshot,
        diskHygiene: diskHygieneSnapshot,
      }
    },

    healthSnapshot: async () => {
      const home = role === 'fork' ? String(process.env.DSH_HOME ?? '') : ''
      let session = null
      if (home) {
        try {
          session = await inspectForkSessionHealth(home, {
            maxSessionMB: cfg.forkHealthMaxSessionMB,
            warnSessionMB: cfg.forkHealthWarnSessionMB,
            confirmSessionMB: cfg.forkHealthConfirmSessionMB,
            warnTotalMB: cfg.forkHealthWarnTotalMB,
            confirmTotalMB: cfg.forkHealthConfirmTotalMB,
            hardTotalMB: cfg.forkHealthHardTotalMB,
            maxEvents: cfg.forkHealthMaxEvents,
          })
        } catch (error) {
          session = { ok: false, error: String(error?.message ?? error), sessions: 0, totalBytes: 0, events: null }
        }
      }
      let adapter = null
      let flush = null
      try {
        const adapterService = safeGet(SERVICE.adapter)
        if (adapterService && typeof adapterService.health === 'function') adapter = adapterService.health()
        if (role === 'fork') {
          flush = {
            available: typeof adapterService?.flushSessions === 'function',
            method: 'POST',
            path: forkFlushDefaultPath,
            source: 'fang-adapter',
            timeoutMs: cfg.forkFlushTimeoutMs,
          }
        }
      } catch (error) {
        adapter = { ok: false, error: String(error?.message ?? error) }
      }
      const ok = session?.ok !== false && session?.truncated !== true && adapter?.ok !== false
      return {
        ok,
        role,
        version: FANG_VERSION,
        pid: process.pid ?? null,
        at: iso(),
        uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
        session,
        adapter,
        flush,
      }
    },

    openManagedBrowser: async (taskId, url, options = {}) => {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      if (task.quarantined) return { ok: false, error: 'fork-quarantined', detail: task.quarantined.reason ?? 'guard' }
      return launchTaskBrowser(task, String(url ?? task.url ?? ''), options)
    },
    closeManagedBrowser: async (taskId, reason = 'user') => {
      const task = tasks.get(String(taskId ?? ''))
      if (!task) return { ok: false, error: 'unknown-task' }
      return closeTaskBrowser(task, reason)
    },
    probeMemory: async () => {
      const memory = rememberMemory(await readSystemMemory({ force: true }))
      notePagefile(memory, 'manual-probe')
      return { ok: memory?.ok !== false, memory: memorySnapshot, memoryPolicy: memoryPolicySnapshot() }
    },
    safeModeStatus: async () => {
      // A latched Safe Mode must reflect the *current* host, not the boot-time
      // snapshot: otherwise closing browsers cannot unlock the UI.
      let memory = memorySnapshot
      try {
        memory = rememberMemory(await readSystemMemory())
      } catch { /* keep the last known sample */ }
      const guard = evaluateSafeModeReset(memory, { hostCriticalFreeMB: cfg.hostCriticalFreeMB })
      // v3.9.4：Commit 余量 ≥2345 MB 时，Safe Mode 自动解除，不依赖用户点按钮；
      // 用户仍可通过 resetSafeMode({force:true}) 强制解除。清理后不自动拉起分身，
      // 新建/打开仍要经过 memoryGate（<999 MB 时直接拒绝）。
      if (safeMode && shouldAutoClearSafeMode(memory, { autoClearCommitMB: SAFE_MODE_AUTO_CLEAR_COMMIT_MB, reason: safeModeReason })) {
        const clearedReason = safeModeReason
        safeMode = false
        safeModeReason = ''
        hostAdmissionClosed = false
        // crash-loop 计数是历史闩锁；自动解除后必须把窗口内计数清零，
        // 否则下一次正常重启会拿旧记录再次封门，形成“永远 Safe Mode”。
        if (/^crash-loop/.test(clearedReason)) {
          try {
            const crashDoc = readJson(hostCrashFile, null) || {}
            fs.writeFileSync(hostCrashFile, JSON.stringify({
              crashes: [], cap: cfg.hostCrashMaxEntries, retentionDays: cfg.hostCrashRetentionDays,
              windowMinutes: hostCrashWindowMinutes, clearedAt: new Date().toISOString(), clearedReason,
            }, null, 2))
          } catch { /* best effort: JSONL 仍保留完整审计 */ }
        }
        persistSafeMode()
        audit('host-safe-mode-auto-clear', {
          reason: 'commit-recovered',
          clearedReason,
          commitFreeMB: Number(memory?.commitFreeMB) || 0,
          autoClearCommitMB: SAFE_MODE_AUTO_CLEAR_COMMIT_MB,
        })
      }
      // 非 SafeMode 的旧 admission 闩锁（例如某次 hostEmergency 的 safe:false）
      // 在内存已恢复时也应自动重开；任务级 quarantine 仍会独立拦截。
      if (!safeMode && hostAdmissionClosed && guard.ok === true) {
        hostAdmissionClosed = false
        audit('host-admission-auto-reopen', { commitFreeMB: Number(memory?.commitFreeMB) || 0 })
      }
      const pagefileMissing = memory ? isPagefileMissing(memory) : false
      return {
        ok: true, safeMode, admissionClosed: hostAdmissionClosed, reason: safeModeReason,
        windowMinutes: hostCrashWindowMinutes,
        reset: {
          canReset: guard.ok === true,
          canForce: guard.ok !== true && guard.error === 'commit-low' && memory?.ok === true,
          error: guard.ok === true ? null : guard.error,
          detail: guard.ok === true ? null : guard.detail,
          memoryKnown: memory?.ok === true,
          pagefileMissing,
          pageFileMB: Number(memory?.pageFileMB) || 0,
          commitFreeMB: Number(memory?.commitFreeMB) || 0,
          minFreeMB: Number(guard.minFreeMB ?? cfg.hostCriticalFreeMB) || 0,
          checkedAt: memory?.checkedAt ?? null,
        },
      }
    },
    panic: async () => hostEmergency('manual-panic', { safe: true, allTasks: true }),
    resetSafeMode: async (input = {}) => {
      const force = input?.force === true
      const restore = input?.restore === true
      let memory = null
      try {
        memory = rememberMemory(await readSystemMemory({ force: true }))
        notePagefile(memory, 'safe-mode-reset')
      } catch (error) {
        const detail = String(error?.message ?? error)
        audit('safe-mode-reset-refused', { reason: 'memory-probe-threw', detail })
        return { ok: false, error: 'memory-probe-threw', detail }
      }
      const decision = evaluateSafeModeReset(memory, { hostCriticalFreeMB: cfg.hostCriticalFreeMB, force })
      if (decision.ok !== true) {
        audit('safe-mode-reset-refused', {
          reason: decision.error,
          pageFileMB: decision.pageFileMB,
          commitFreeMB: decision.commitFreeMB,
          minFreeMB: decision.minFreeMB,
        })
        return {
          ok: false,
          error: decision.error,
          detail: decision.detail,
          memory: memorySnapshot,
        }
      }
      // Second probe immediately before the latch is released: a pagefile can
      // disappear between the first probe and this point. Fail closed, not open.
      let confirmMemory = null
      try {
        confirmMemory = rememberMemory(await readSystemMemory({ force: true }))
        notePagefile(confirmMemory, 'safe-mode-reset-postcheck')
      } catch (error) {
        const detail = String(error?.message ?? error)
        audit('safe-mode-reset-refused', { reason: 'postcheck-probe-threw', detail })
        return { ok: false, error: 'memory-probe-threw', detail, stage: 'postcheck', memory: memorySnapshot }
      }
      const confirmDecision = evaluateSafeModeReset(confirmMemory, { hostCriticalFreeMB: cfg.hostCriticalFreeMB, force })
      if (confirmDecision.ok !== true) {
        audit('safe-mode-reset-refused', {
          reason: confirmDecision.error,
          stage: 'postcheck',
          pageFileMB: confirmDecision.pageFileMB,
          commitFreeMB: confirmDecision.commitFreeMB,
          minFreeMB: confirmDecision.minFreeMB,
        })
        return {
          ok: false,
          error: confirmDecision.error,
          detail: confirmDecision.detail,
          stage: 'postcheck',
          memory: memorySnapshot,
        }
      }
      safeMode = false
      safeModeReason = ''
      hostAdmissionClosed = false
      persistSafeMode()
      audit('host-safe-mode-reset', {
        pageFileMB: confirmDecision.pageFileMB,
        commitFreeMB: confirmDecision.commitFreeMB,
        minFreeMB: confirmDecision.minFreeMB,
        postcheck: 'pagefile-present',
        forced: force,
        restore,
      })
      let restored = null
      if (restore) {
        // Do not hold the reset HTTP response for up to N × 60 s spawn waits.
        // The restore runs in the background and reports into the audit log.
        restored = { queued: true }
        Promise.resolve()
          .then(() => service.autostartForks({}))
          .then((result) => {
            audit('host-safe-mode-restore', {
              ok: result?.ok === true,
              started: Array.isArray(result?.started) ? result.started.length : 0,
              failed: Array.isArray(result?.failed) ? result.failed.length : 0,
              error: result?.error ?? null,
            })
          })
          .catch((error) => {
            audit('host-safe-mode-restore', { ok: false, error: 'restore-threw', detail: String(error?.message ?? error) })
          })
      }
      return { ok: true, safeMode: false, forced: decision.forced === true || confirmDecision.forced === true, restored }
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
  // 2026-11-24: sample fork PID trees/commit; kill only the offending fork.
  if (cfg.memoryWatchdog === true && process.platform === 'win32') {
    const timer = setInterval(() => { void memoryWatchdogTick() }, cfg.memoryWatchIntervalMs)
    timer.unref?.()
    try { ctx.effect(() => () => clearInterval(timer)) } catch { /* fake ctx */ }
  }
  // v3.8.0: host self-preservation. This must run even when no fork is running.
  if (process.platform === 'win32') {
    const timer = setInterval(() => { void hostWatchdogTick() }, HOST_WATCHDOG_INTERVAL_MS)
    timer.unref?.()
    try { ctx.effect(() => () => clearInterval(timer)) } catch { /* fake ctx */ }
  }
  // Startup: reclaim archived/failed fork processes whose recorded PID still lives.
  void cleanupOrphanForks()
  if (cfg.orphanSweepMinutes > 0) {
    const timer = setInterval(() => { void cleanupOrphanForks() }, Number(cfg.orphanSweepMinutes) * 60_000)
    timer.unref?.()
    try { ctx.effect(() => () => clearInterval(timer)) } catch { /* fake ctx */ }
  }
  // P2 #2: only archived tasks; first sweep is delayed so boot and a just-archived
  // task do not both decode the same 60 MB log.
  if (cfg.sessionCompactEnabled === true && Number(cfg.sessionCompactIntervalMs) > 0) {
    const first = setTimeout(() => { void sessionCompactTick() }, 60_000)
    first.unref?.()
    const timer = setInterval(() => { void sessionCompactTick() }, Number(cfg.sessionCompactIntervalMs))
    timer.unref?.()
    try { ctx.effect(() => () => { clearTimeout(first); clearInterval(timer) }) } catch { /* fake ctx */ }
  }
  // P2 #3: read-only disk snapshot first (no cache movement unless the user
  // explicitly turns browserCacheCleanupEnabled on).
  if (cfg.diskHygieneEnabled === true) {
    const first = setTimeout(() => { try { refreshDiskHygiene(true) } catch { /* read-only best effort */ } }, 90_000)
    first.unref?.()
    const timer = setInterval(() => { try { refreshDiskHygiene(true) } catch { /* read-only best effort */ } }, Number(cfg.diskHygieneIntervalMs))
    timer.unref?.()
    try { ctx.effect(() => () => { clearTimeout(first); clearInterval(timer) }) } catch { /* fake ctx */ }
  }
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
   * 2026-11-22：官方推荐是默认底座，任何打开/派生都必须先把它修到当前母体版本，
   * 否则 profileUsesCurrentFangBundle 判 stale，分身会静默回退到 clean template，
   * 实验性插件就全丢（真机截图复现）。
   */
  const repairOfficialEssenceNow = async () => {
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
    if (repaired?.ok !== true) audit('official-essence-repair-failed', { repaired })
    else if (Number(repaired.coreUiForced) > 0) audit('official-core-ui-enabled', { coreUiForced: Number(repaired.coreUiForced) })
    return { repaired, modulesSync }
  }
  const applyOfficialExperimentalSurface = (profileDir, options = {}) => {
    if (process.env.DSH_FANG_EXPERIMENTAL_SURFACE === '0') return { ok: true, skipped: 'disabled' }
    if (options.coreMode === 'accelerated') return { ok: true, skipped: 'accelerated-core' }
    const dir = String(profileDir ?? '')
    const pkgFile = path.join(dir, 'package.json')
    const patchFile = path.join(dir, 'cordis.patch.yml')
    if (!exists(pkgFile)) return { ok: false, error: 'profile-package-missing' }
    const officialMerged = essenceManager.mergedProfileDir(OFFICIAL_ESSENCE_ID)
    const officialPkg = readJson(path.join(officialMerged, 'package.json'), null)
    if (!officialPkg) return { ok: false, error: 'official-profile-missing' }
    const officialPatch = parsePatchEntries(
      exists(path.join(officialMerged, 'cordis.patch.yml')) ? fs.readFileSync(path.join(officialMerged, 'cordis.patch.yml'), 'utf8') : '',
    ).entries
    const experimentalNames = new Set([
      ...OFFICIAL_EXPERIMENTAL_BUNDLES,
      ...(Array.isArray(officialPkg?.dsh?.profile?.bundles) ? officialPkg.dsh.profile.bundles : []),
      ...officialPatch.map((entry) => String(entry?.name ?? '')),
    ].filter((name) => /^@deepseek-ai\/(dsh-experimental-|dsh-personalized|dsh-cua-|dsh-deepseek-chat-import)/.test(name)))
    if (experimentalNames.size === 0) return { ok: true, skipped: 'official-has-no-experimental' }
    const pkg = readJson(pkgFile, null)
    if (!pkg) return { ok: false, error: 'profile-package-invalid' }
    pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
    pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {}
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? [...pkg.dsh.profile.bundles] : []
    let bundlesAdded = 0
    for (const name of experimentalNames) {
      if (bundles.includes(name)) continue
      bundles.push(name)
      bundlesAdded += 1
    }
    pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
    pkg.dependencies[NODE_COMPAT_BUNDLE] = '^0.1.0'
    if (!bundles.includes(NODE_COMPAT_BUNDLE)) bundles.unshift(NODE_COMPAT_BUNDLE)
    pkg.dsh.profile.bundles = bundles
    writeJsonAtomic(pkgFile, pkg)
    const parsed = parsePatchEntries(exists(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '')
    const entries = parsed.entries.filter((entry) => !experimentalNames.has(String(entry?.name ?? '')))
    let rowsAdded = 0
    for (const name of experimentalNames) {
      const officialEntry = officialPatch.find((entry) => entry?.name === name)
      entries.push({ id: officialEntry?.id ?? `fork-exp-${sha256(name).slice(0, 8)}`, name, disabled: false })
      rowsAdded += 1
    }
    fs.writeFileSync(patchFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    return { ok: true, bundles: [...experimentalNames], bundlesAdded, rowsAdded }
  }
  /**
   * v3.7.4：把来源元主的完整插件面（bundles + dependencies + patch rows）覆盖到 fork profile。
   * 修复 BUG-4：只补实验性 bundle 会留下“已同步”假阳性；reset 后必须整体对齐来源。
   * fork 私有配置锁行（tool-plugin-manager / ui-settings-plugin-inventory）保留。
   */
  const applySourcePluginSurface = (task, profileDir) => {
    try {
      if (task?.coreMode === 'accelerated') return { ok: true, skipped: 'accelerated-core' }
      const sourceId = String(task?.essenceId || task?.syncSourceId || OFFICIAL_ESSENCE_ID)
      const sourceDir = essenceManager.mergedProfileDir(sourceId)
      const sourcePkg = readJson(path.join(sourceDir, 'package.json'), null)
      if (!sourcePkg) return { ok: false, error: 'source-profile-missing', sourceId }
      const sourcePatchRaw = parsePatchEntries(
        exists(path.join(sourceDir, 'cordis.patch.yml')) ? fs.readFileSync(path.join(sourceDir, 'cordis.patch.yml'), 'utf8') : '',
      ).entries
      // A source essence may still carry an old `ui-theme disabled: true` row.
      // Copying it into a fork reproduces the exact "waiting for service: theme"
      // boot failure; force required UI rows on this merge path too.
      const sourcePatch = enforceCoreUiEntries(sourcePatchRaw).entries
      const pkgFile = path.join(String(profileDir), 'package.json')
      const patchFile = path.join(String(profileDir), 'cordis.patch.yml')
      const forkPkg = readJson(pkgFile, null)
      if (!forkPkg) return { ok: false, error: 'fork-profile-missing' }
      forkPkg.dsh = forkPkg.dsh && typeof forkPkg.dsh === 'object' ? forkPkg.dsh : {}
      forkPkg.dsh.profile = forkPkg.dsh.profile && typeof forkPkg.dsh.profile === 'object' ? forkPkg.dsh.profile : {}
      const sourceBundles = Array.isArray(sourcePkg?.dsh?.profile?.bundles) ? sourcePkg.dsh.profile.bundles : []
      const forkBundlesBefore = Array.isArray(forkPkg?.dsh?.profile?.bundles) ? forkPkg.dsh.profile.bundles : []
      const forkFangBundle = FORK_BUNDLE_NAMES.find((candidate) => exists(path.join(String(profileDir), 'node_modules', ...candidate.split('/'))))
        || forkBundlesBefore.find((candidate) => /(^|\/)dsh-fang$/.test(String(candidate)))
        || '@twinsearth/fang-dsh-plugin'
      const bundles = sourceBundles
        .filter((name) => name !== NODE_COMPAT_BUNDLE)
        .map((name) => /(^|\/)(dsh-fang|fang-dsh-plugin)$/.test(String(name)) ? forkFangBundle : name)
      bundles.unshift(NODE_COMPAT_BUNDLE)
      forkPkg.dsh.profile.bundles = [...new Set(bundles)]
      forkPkg.dependencies = {
        ...(forkPkg.dependencies && typeof forkPkg.dependencies === 'object' ? forkPkg.dependencies : {}),
        ...(sourcePkg.dependencies && typeof sourcePkg.dependencies === 'object' ? sourcePkg.dependencies : {}),
        [NODE_COMPAT_BUNDLE]: '^0.1.0',
      }
      writeJsonAtomic(pkgFile, forkPkg)
      const forkPatch = parsePatchEntries(exists(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '').entries
      const lockIds = new Set(['tool-plugin-manager', 'ui-settings-plugin-inventory'])
      const locks = forkPatch.filter((entry) => lockIds.has(String(entry?.id ?? '')))
      const mergedRaw = [...sourcePatch]
      for (const row of locks) if (!mergedRaw.some((entry) => entry?.id === row.id)) mergedRaw.push(row)
      const merged = enforceCoreUiEntries(mergedRaw)
      fs.writeFileSync(patchFile, `${JSON.stringify(merged.entries, null, 2)}\n`, 'utf8')
      return {
        ok: true, sourceId, bundles: forkPkg.dsh.profile.bundles.length,
        rows: merged.entries.length, coreUiForced: merged.forced,
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
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
      // v3.9.4：pnpm 曾把“不同包管理器安装”的依赖移动到 .ignored；若顶栏缺失，
      // 先把 .ignored 里的副本还原，否则 profile bundle（如 dsh-2xray）无法解析。
      const ignored = path.join(String(profileDir), 'node_modules', '.ignored', ...name.split('/'))
      if (!exists(target) && exists(ignored)) {
        try {
          ensureDir(path.dirname(target))
          copyTree(ignored, target)
          copied.push(name + ':ignored')
          continue
        } catch { /* fall through to mother copy */ }
      }
      const source = path.join(motherModules, ...name.split('/'))
      if (!exists(source)) { if (!exists(target)) missing.push(name); continue }
      // 同名包已存在时不能只看“有没有”：旧 official/fork 可能停留在旧 fang/子包版本，
      // 必须按 package.json version 比较后替换，否则 stale bundle 永远修不好。
      let sameVersion = false
      if (exists(target)) {
        const targetPkg = readJson(path.join(target, 'package.json'), {}) ?? {}
        const sourcePkg = readJson(path.join(source, 'package.json'), {}) ?? {}
        sameVersion = Boolean(sourcePkg.version) && sourcePkg.version === targetPkg.version
        if (sameVersion) continue
      }
      try {
        if (exists(target)) removeTree(target)
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
    // Index merge copies the mother's E:\DSH\DS path by design; redirect it
    // now, before the fork host can open the session with the shared cwd.
    const workspaceMap = migrateForkWorkspace(homeDir, { roots: workspaceMigrationRoots(cfg) })
    if (workspaceMap.changed || workspaceMap.conflicts.length > 0) {
      try { audit('fork-workspace-migrated', { homeDir, ...workspaceMap }) } catch { /* ignore */ }
    }
    return imported.map((row) => {
      const mapping = workspaceMap.mappings.find((item) => item.oldKey === row.workspaceKey)
      return mapping ? { ...row, workspaceKey: mapping.newKey, workspaceMap: mapping } : row
    })
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
        capacity: { slots: ESSENCE_HARD_MAX, hardMax: ESSENCE_HARD_MAX, defaultLimit: ESSENCE_QUOTA_DEFAULT, used: essences.filter(item => item.archived !== true).length },
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
      // 2026-11-22：官方推荐是唯一保底默认元宝；即使它已经是 default，也要每次启动重算
      // （否则旧 official overlay 会停在旧 fang 版本，分身派生时被判 stale 回退到 clean template，
      //  实验性插件就全部丢失）。
      const repairOfficialDefault = async () => {
        if (apply !== true) {
          return { ok: true, dryRun: true, official: true, existed: true, created: false, essenceId: OFFICIAL_ESSENCE_ID, mode }
        }
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
      if (existing?.official === true) return repairOfficialDefault()
      // 用户自己选的默认元宝（非官方、非自动快照）保持不动。
      if (existing?.id && !isAutoDefault(existing)) {
        return { ok: true, existed: true, created: false, official: false, essenceId: existingId, mode }
      }
      // 2026-11-22：保底一个「开发者推荐（官方）」，不再无限新增“默认元宝”快照。
      const official = essenceManager.getMeta(OFFICIAL_ESSENCE_ID)
      if (official?.id && official.archived !== true) return repairOfficialDefault()
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
      if (isolationBlocked) throw new Error('data-root-forbidden')
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
      if (id === OFFICIAL_ESSENCE_ID) await repairOfficialEssenceNow()
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
      // Direct self-heal for an existing runtime profile: provision only clones
      // package.json/cordis*.yml, and a stale runtime copy may still say
      // ui-theme disabled: true. Fix the file before the CLI boots, otherwise
      // layout/sidebar/chat pend and the page fails with required-entries.
      try {
        const patchFile = path.join(runtimeProfileDir, 'cordis.patch.yml')
        const enforced = enforceCoreUiEntries(parsePatchEntries(exists(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '').entries)
        if (enforced.forced > 0) {
          fs.writeFileSync(patchFile, `${JSON.stringify(enforced.entries, null, 2)}\n`, 'utf8')
          audit('runtime-core-ui-enabled', { essenceId: id, coreUiForced: enforced.forced })
        }
      } catch (error) {
        audit('runtime-core-ui-repair-failed', { essenceId: id, error: String(error?.message ?? error) })
      }
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
          // v3.9.4：运行态 profile 若没有 .modules.yaml，从母体复制一份并对齐 store，
          // 否则 pnpm 把包移到 .ignored，@twinsearth/dsh-2xray 等 profile bundle
          // 在启动时无法解析（cannot resolve profile bundle）。
          manifestSourceDir: path.join(templateDir(), 'node_modules'),
          nodeLinker: readNodeLinker(templateDir()),
        })
      } catch (error) {
        pnpmConfig = { ok: false, error: 'pnpm-config-threw', detail: String(error?.message ?? error) }
      }
      // 先导入选中的进行中会话，再拉起实例（实例启动时就能看到它们）。
      const importedSessions = importSessionsInto(homeDir, input?.sessionIds)
      const memory = await memoryGate('start-essence-runtime')
      if (memory.ok !== true) return { ok: false, error: memory.error, taskId: forkId, ...memory }
      const paused = await pauseOtherForks(forkId, 'start-essence-runtime')
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
        env: { DSH_FANG_ROLE: 'fork', DSH_FANG_TASK_ID: forkId, DSH_FANG_ESSENCE: '1', DSH_FANG_MOTHER: layout.dataDir, ...forkTempEnv(forkId) },
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
    /** 打开运行态：URL 只进托管浏览器，成功后才算 open；绝不回退外部浏览器。 */
    openEssenceRuntime: async (essenceId) => {
      const id = String(essenceId ?? '').trim()
      const f = forker()
      if (!f || typeof f.openUrl !== 'function') return { ok: false, error: 'forker-unavailable' }
      const out = f.openUrl(runtimeForkId(id))
      if (!out || out.ok === false) return { ok: false, error: out?.error ?? 'not-running' }
      const browser = await openRuntimeManagedBrowser(id, out.url)
      if (browser.ok !== true) {
        return { ok: false, error: browser.error ?? 'browser-open-failed', browserError: browser.error ?? 'browser-open-failed', managed: false, essenceId: id }
      }
      return { ok: true, essenceId: id, url: out.url, port: out.port ?? null, managed: true, browserPid: browser.pid ?? null }
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
          fs.writeFileSync(path.join(layout.dataDir, 'endpoint.json'), JSON.stringify({
            url: origin,
            pid: process.pid,
            instanceId,
            version: FANG_VERSION,
            role,
            dataDir: layout.dataDir,
            updatedAt: new Date().toISOString(),
          }) + '\n')
        }
      } catch { /* endpoint discovery is best-effort */ }
      const prefix = String(cfg.routes?.prefix ?? '/fang').replace(/\/+$/, '') || '/fang'

      const json = (res, code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      }
      const handlerFailure = (res, error, method, pathname) => {
        const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        const detail = String(error?.message ?? error)
        audit('http-handler-threw', {
          requestId, method, path: pathname, detail,
          stack: String(error?.stack ?? '').slice(0, 3000),
        })
        return json(res, 500, {
          ok: false, error: 'handler-threw', code: 'handler-threw',
          detail, route: pathname, method, requestId,
        })
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
          try { res.setHeader?.('x-fang-instance', instanceId) } catch { /* fake res */ }
          // v3.0.5/B1：loopback Host + Origin/CSRF + 安装 token（fail-closed）。
          // Auth must run before the method check: a token-less POST is 401, not 405.
          const decision = checkRequestAuth(req, {
            token: authToken,
            publicRoute: authToken.length === 0 || routeOptions?.public === true,
            bootstrap: routeOptions?.bootstrap === true,
          })
          if (!decision.ok) return json(res, decision.status, authErrorBody(decision))
          if (routeOptions?.peerOwner === true) {
            const verifier = typeof cfg.peerOwnerVerifier === 'function' ? cfg.peerOwnerVerifier : verifyPeerOwner
            let peer = null
            try { peer = await verifier(req, { hostPid: process.pid }) } catch (error) {
              peer = { ok: false, error: `peer-owner-check-failed:${String(error?.message ?? error)}` }
            }
            if (peer?.ok !== true) {
              audit('auth-token-host-owner-refused', { error: String(peer?.error ?? 'not-host-owner') })
              return json(res, 403, { ok: false, error: String(peer?.error ?? 'not-host-owner'), code: 'not-host-owner' })
            }
          }
          if (req.method !== method) {
            try { res.setHeader?.('allow', method) } catch { /* fake res */ }
            return json(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
          }
          try { return await handler(req, res) } catch (e) {
            return handlerFailure(res, e, method, pathname)
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
          try { res.setHeader?.('x-fang-instance', instanceId) } catch { /* fake res */ }
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
            return handlerFailure(res, e, String(req.method ?? 'GET').toUpperCase(), pathname)
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
      }, { public: true, bootstrap: true, peerOwner: true })

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

      // 分身打开前健康检查：session 大小/事件数 + adapter 状态。
      // Public only in the sense of no install token; Host/Origin loopback checks still run.
      const handleHealth = async (req, res) => json(res, 200, await service.healthSnapshot())
      route('GET', `${prefix}/api/health`, handleHealth, { public: true })
      if (prefix !== '') {
        try { route('GET', '/api/health', handleHealth, { public: true }) } catch (error) {
          audit('fork-health-root-alias-skipped', { detail: String(error?.message ?? error) })
        }
      }
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

      route('POST', `${prefix}/api/deploy`, async (_req, res) => json(res, 409, {
        ok: false,
        error: 'host-running',
        detail: '宿主存活时禁止部署/热替换母体 profile；请先退出 DSH Desktop，使用 tools/release/deploy-profile.mjs。',
      }))
      route('GET', `${prefix}/api/deploy/guard`, async (_req, res) => json(res, 409, {
        ok: false,
        error: 'host-running',
        detail: '当前进程就是 DSH host；任何部署请求都必须由外部工具在 host 停止后执行。',
        pid: process.pid,
      }))
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
      // v3.7.4：GET 只读（不产生 stop/spawn 副作用），POST 才执行 sync-on-open。
      route('GET', `${prefix}/api/tasks/open-url`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const taskId = String(query.get('taskId') ?? '').trim()
        if (!taskId) return json(res, 400, { ok: false, error: 'taskId-required' })
        if (!tasks.has(taskId)) return json(res, 404, { ok: false, error: 'unknown-task', taskId })
        const admission = await ensureHostAdmission()
        if (admission.ok !== true) return json(res, 423, admission)
        if (safeMode) return json(res, 423, { ok: false, error: 'safe-mode', detail: safeModeReason })
        const guardTask = tasks.get(taskId)
        if (guardTask?.quarantined) return json(res, 423, { ok: false, error: 'fork-quarantined', detail: guardTask.quarantined.reason ?? 'guard' })
        try {
          const out = forker()?.openUrl?.(taskId) ?? null
          if (!out || out.ok !== true) return json(res, 404, { ok: false, error: out?.error ?? 'not-running', taskId })
          return json(res, 200, out)
        } catch (error) {
          const detail = String(error?.message ?? error)
          audit('fork-open-url-failed', { taskId, detail })
          return json(res, 500, { ok: false, error: 'open-url-threw', step: 'open-url', taskId, detail })
        }
      })
      route('POST', `${prefix}/api/tasks/open`, async (req, res) => {
        const body = await readBody(req)
        const taskId = String(body?.taskId ?? '').trim()
        if (!taskId) return json(res, 400, { ok: false, error: 'taskId-required' })
        if (!tasks.has(taskId)) return json(res, 404, { ok: false, error: 'unknown-task', taskId })
        let out = null
        try {
          out = await service.syncTaskOnOpen(taskId)
        } catch (error) {
          const detail = String(error?.message ?? error)
          audit('fork-open-handler-failed', { taskId, step: 'sync-task-on-open', detail })
          return json(res, 500, { ok: false, error: 'open-fork-threw', step: 'sync-task-on-open', taskId, detail })
        }
        if (!out || out.ok !== true) {
          const status = out?.error === 'unknown-task' ? 404 : out?.error === 'not-running' ? 404 : out?.error === 'safe-mode' || out?.error === 'host-admission-closed' || out?.error === 'fork-quarantined' ? 423 : 409
          return json(res, status, { ok: false, error: out?.error ?? 'not-running', ...out })
        }
        if (!out.url) return json(res, 409, { ...out, ok: false, error: 'fork-url-missing' })
        // P0: no silent external-browser fallback. A fork URL is only deliverable
        // through the managed, measurable browser. If it cannot start, fail the
        // open explicitly and keep the URL server-side for a later retry.
        try {
          const browser = await service.openManagedBrowser(taskId, out.url, {
            confirmLargeSession: body?.confirmLargeSession === true,
          })
          if (browser?.ok === true) return json(res, 200, { ...out, ...browser, managed: true })
          const error = browser?.error ?? 'browser-unavailable'
          if (error === 'fork-session-confirmation-required') {
            return json(res, 409, { ...out, ...browser, ok: false, error, requiresConfirmation: true })
          }
          if (error === 'fork-health-session-hard-limit') {
            return json(res, 409, { ...out, ...browser, ok: false, error })
          }
          audit('fork-browser-open-refused', { taskId, error })
          return json(res, 503, { ...out, ok: false, error, browserError: error, managed: false })
        } catch (error) {
          const detail = String(error?.message ?? error)
          audit('fork-browser-open-handler-failed', { taskId, error: detail })
          return json(res, 503, { ...out, ok: false, error: 'browser-open-failed', browserError: detail, managed: false })
        }
      })
      route('GET', `${prefix}/api/safe-mode`, async (req, res) => json(res, 200, await service.safeModeStatus()))
      route('POST', `${prefix}/api/memory/probe`, async (req, res) => {
        await readBody(req)
        return json(res, 200, await service.probeMemory())
      })
      route('POST', `${prefix}/api/sessions/compact`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.compactSessions(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('GET', `${prefix}/api/disk-hygiene`, async (req, res) => json(res, 200, service.diskHygiene()))
      route('POST', `${prefix}/api/disk-hygiene/refresh`, async (req, res) => {
        await readBody(req)
        return json(res, 200, service.refreshDiskHygiene())
      })
      route('POST', `${prefix}/api/disk-hygiene/cleanup`, async (req, res) => {
        const body = await readBody(req)
        const out = service.cleanupBrowserCache(String(body?.taskId ?? ''), { confirm: body?.confirm === true })
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/safe-mode/reset`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.resetSafeMode(body)
        return json(res, out.ok ? 200 : 409, out)
      })
      // Global Panic: browser -> fork -> quarantine all -> Safe Mode. UI has the
      // button; this route is the missing HTTP entry point.
      route('POST', `${prefix}/api/panic`, async (req, res) => {
        await readBody(req)
        const out = await service.panic()
        return json(res, out?.ok === false ? 409 : 200, { ok: out?.ok !== false, mode: 'panic', ...out })
      })
      route('POST', `${prefix}/api/tasks/archive`, async (req, res) => {
        const body = await readBody(req)
        const out = await service.archiveTask(String(body?.taskId ?? ''))
        return json(res, out.ok ? 200 : 409, out)
      })
      route('POST', `${prefix}/api/tasks/restore`, async (req, res) => {
        const body = await readBody(req)
        let out
        try {
          out = await service.restoreTask(String(body?.taskId ?? ''))
        } catch (error) {
          const detail = String(error?.message ?? error)
          audit('fork-restore-handler-failed', { taskId: body?.taskId ?? '', detail })
          return json(res, 500, { ok: false, error: 'restore-fork-threw', step: 'restore', taskId: body?.taskId ?? '', detail })
        }
        const status = out.ok ? 200 : out?.error === 'safe-mode' || out?.error === 'fork-quarantined' || out?.error === 'host-admission-closed' ? 423 : 409
        return json(res, status, out)
      })
      // 2026-11-22：一键修复（停残留 → 清别名桩 → 重置配置 → 重新拉起；不删 home/会话）
      route('POST', `${prefix}/api/vault/export`, async (req, res) => {
        const body = await readBody(req)
        const taskId = String(body?.taskId ?? '').trim()
        if (!taskId) return json(res, 400, { ok: false, error: 'taskId-required' })
        if (!tasks.has(taskId)) return json(res, 404, { ok: false, error: 'unknown-task', taskId })
        const destDir = String(body?.destDir ?? '').trim()
        if (!destDir) return json(res, 400, { ok: false, error: 'dest-dir-required' })
        try {
          const out = await service.exportTask(taskId, destDir, body?.options ?? {})
          return json(res, out.ok ? 200 : 500, out)
        } catch (error) {
          return json(res, 500, { ok: false, error: 'export-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/vault/import`, async (req, res) => {
        const body = await readBody(req)
        const sourceDir = String(body?.sourceDir ?? '').trim()
        if (!sourceDir) return json(res, 400, { ok: false, error: 'source-dir-required' })
        try {
          const out = await service.importTask(sourceDir, body?.title)
          return json(res, out.ok ? 200 : 409, out)
        } catch (error) {
          return json(res, 409, { ok: false, error: 'import-failed', detail: String(error?.message ?? error) })
        }
      })
      route('POST', `${prefix}/api/tasks/repair`, async (req, res) => {
        const body = await readBody(req)
        const taskId = String(body?.taskId ?? '').trim()
        if (!taskId) return json(res, 400, { ok: false, error: 'taskId-required' })
        if (!tasks.has(taskId)) return json(res, 404, { ok: false, error: 'unknown-task', taskId })
        let out
        try {
          out = await service.repairTask(taskId)
        } catch (error) {
          const detail = String(error?.message ?? error)
          audit('fork-repair-handler-failed', { taskId, detail })
          return json(res, 500, { ok: false, error: 'repair-fork-threw', step: 'repair', taskId, detail })
        }
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
      // C4: explicit second confirmation. It is recorded/audited but the hard
      // limit remains 1; no request can turn this into a multi-fork bypass.
      routeMethods(`${prefix}/api/forks/multi-fork`, {
        GET: (req, res) => json(res, 200, service.multiForkStatus()),
        POST: async (req, res) => {
          const body = await readBody(req)
          const out = service.confirmMultiFork(body ?? {})
          return json(res, out.ok ? 200 : 409, out)
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
      route('GET', `${prefix}/api/essence/runtime/open`, async (req, res) => {
        const query = new URL(String(req.url ?? '/'), 'http://x').searchParams
        const out = await mirrorService.openEssenceRuntime(query.get('essenceId'))
        return json(res, out?.ok === true ? 200 : 503, out)
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
          try { res.setHeader?.('x-fang-instance', instanceId) } catch { /* fake res */ }
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
// v3.9.2：这个页面同样给日志加上限，避免长期打开时点击事件无限堆积。
window.__fangUiLog = [];
window.__fangUiLog.__fangUiLogBytes = 0;
function pushUiLog(entry) {
  const log = window.__fangUiLog;
  log.push(entry);
  let bytes = Number(log.__fangUiLogBytes) || 0;
  try { bytes += JSON.stringify(entry).length + 1; } catch { bytes += 64; }
  while (log.length > 500 || bytes > 262144) {
    const removed = log.shift();
    if (removed === undefined) break;
    try { bytes -= JSON.stringify(removed).length + 1; } catch { bytes -= 64; }
  }
  log.__fangUiLogBytes = Math.max(0, bytes);
}
document.addEventListener('click', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest('button, a[href]') : null;
  if (!el) return;
  pushUiLog({
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
setInterval(refresh, 15000);
</script>
</body></html>`
}

export const _internals = { resolveCliPath, isShellLauncher, renderPanelHtml, loadRegistry, resolveInside, normalizeSeed }
