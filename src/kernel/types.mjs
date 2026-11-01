// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// dsh-Fang kernel — the shared vocabulary of the 1 orchestrator + 9 sub-plugins.
// Kept as plain constants so plugin code, tests and the client half agree on names.

/** Host service keys. Every sub-plugin provides exactly one; subplugins read peers through `ctx.get`. */
export const SERVICE = {
  orchestrator: 'fang',
  forker: 'fangForker',
  scorer: 'fangScorer',
  healer: 'fangHealer',
  approver: 'fangApprover',
  hotReloader: 'fangHotReloader',
  restart: 'fangRestart',
  buffer: 'fangBuffer',
  auditor: 'fangAudit',
  router: 'fangRouter',
  adapter: 'fangAdapter',
  commercial: 'fangCommercial',
  sessionCatalog: 'fangSessionCatalog',
}

/** Loader row ids used by cordis.patch.yml. */
export const ROW = {
  orchestrator: 'fang-orchestrator',
  forker: 'fang-forker',
  scorer: 'fang-scorer',
  healer: 'fang-healer',
  approver: 'fang-approver',
  hotReloader: 'fang-hot-reloader',
  restart: 'fang-restart-guard',
  buffer: 'fang-buffer-keeper',
  auditor: 'fang-auditor',
  router: 'fang-router',
  sessionCatalog: 'fang-session-catalog',
}

export const FORK_STATUS = {
  PROVISIONING: 'provisioning',
  RUNNING: 'running',
  CRASHED: 'crashed',
  STOPPED: 'stopped',
  REAPED: 'reaped',
}

/** Risk vocabulary shared by scorer / approver / restart-guard. */
export const RISK = { BLUE: 'blue', YELLOW: 'yellow', RED: 'red' }

/** Static plugin grades (A safest .. E veto). */
export const GRADE = ['A', 'B', 'C', 'D', 'E']

export const GRADE_COLOR = { A: 'green', B: 'blue', C: 'yellow', D: 'red', E: 'red' }

/** Router outcomes. */
export const ROUTE = { SANDBOX: 'sandbox', CONTAINER: 'container', DENY: 'deny' }

/** Restart-guard state machine (mother level only). */
export const GUARD_STATE = {
  IDLE: 'idle',
  COLLECTING: 'collecting',
  AWAITING: 'awaiting',
  EXECUTING: 'executing',
}

/** Buffer watcher three-state judgement. */
export const BUFFER_STATE = { SETTLED: 'settled', WRITING: 'writing', PENDING_HIGH_RISK: 'pending-high-risk' }

/** Audit record kinds written by the auditor. */
export const AUDIT = {
  BOOT: 'boot',
  BOOT_VERIFY: 'boot-verify',
  FORK_CREATED: 'fork-created',
  FORK_STARTED: 'fork-started',
  FORK_CRASHED: 'fork-crashed',
  FORK_REAPED: 'fork-reaped',
  FORK_HEALTH: 'fork-health',
  PROMOTE_REQUESTED: 'promote-requested',
  PROMOTE_COMMITTED: 'promote-committed',
  PROMOTE_FAILED: 'promote-failed',
  RESTART_REQUESTED: 'restart-requested',
  RESTART_RESOLVED: 'restart-resolved',
  RESTART_DENIED: 'restart-denied',
  SHUTDOWN_GRACEFUL: 'shutdown-graceful',
  APPROVAL_REQUESTED: 'approval-requested',
  APPROVAL_DECIDED: 'approval-decided',
  SNapshot_CREATED: 'snapshot-created',
  ROLLBACK: 'rollback',
  ROUND_OPEN: 'round-open',
  ROUND_RESET: 'round-reset',
  SCORE: 'score',
  ROUTE: 'route',
  BUFFER_FLUSH: 'buffer-flush',
  TASK_READY: 'task-ready',
  TASK_ARCHIVED: 'task-archived',
  ADAPTER_HANDSHAKE: 'adapter-handshake',
  ROUTE_CONFIRMED: 'route-confirmed',
  RUNTIME_ERROR: 'runtime-error',
}

export const FANG_VERSION = '2.3.0'

/**
 * @typedef {object} ForkInfo
 * @property {string} forkId
 * @property {string} taskTitle
 * @property {'provisioning'|'running'|'crashed'|'stopped'|'reaped'} status
 * @property {number|null} pid
 * @property {number|null} port
 * @property {string} homeDir
 * @property {string} profile
 * @property {string|null} url
 * @property {number} createdAt
 * @property {number} restarts
 * @property {object|null} health
 */

/**
 * @typedef {object} Assessment
 * @property {'A'|'B'|'C'|'D'|'E'} grade
 * @property {number} score
 * @property {'green'|'blue'|'yellow'|'red'} color
 * @property {boolean} veto
 * @property {string[]} reasons
 * @property {{id:string, weight:number}[]} signals
 */

/**
 * @typedef {object} ImpactReport
 * @property {string[]} activeForks
 * @property {string[]} pendingPromotes
 * @property {string[]} dirtyBuffers
 * @property {number} activeSessions
 */


/** Task lifecycle (v2): a task is the product-facing unit, a fork is its process. */
export const TASK_STATUS = {
  PROVISIONING: 'provisioning',
  READY: 'ready',
  RUNNING: 'running',
  ARCHIVED: 'archived',
  FAILED: 'failed',
}

/** Adapter command vocabulary (mother → fork control channel). */
export const ADAPTER_OP = {
  PING: 'ping',
  STATUS: 'status',
  FLUSH_BUFFER: 'flush-buffer',
  SCORE_PLUGIN: 'score-plugin',
  READ_PLUGIN: 'read-plugin',
  ROUTE_CONFIRM: 'route-confirm',
  APPROVALS: 'approvals',
  APPROVAL_DECIDE: 'approval-decide',
  ARCHIVE: 'archive',
}

/** Adapter HTTP route suffixes (fork side). */
export const ADAPTER_ROUTE = {
  HELLO: '/adapter/hello',
  STATUS: '/adapter/status',
  APPROVALS: '/adapter/approvals',
  AUDIT: '/adapter/audit',
  COMMAND: '/adapter/command',
}

/** Container (AppContainer) executor states. */
export const CONTAINER = { DISABLED: 'disabled', UNAVAILABLE: 'unavailable', READY: 'ready' }
