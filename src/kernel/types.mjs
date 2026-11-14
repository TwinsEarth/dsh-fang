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
  umbrella: 'fangUmbrella',
  adapter: 'fangAdapter',
  commercial: 'fangCommercial',
  sessionCatalog: 'fangSessionCatalog',
  sessionBridge: 'fangSessionBridge',
  sessionSync: 'fangSessionSync',
  sessionRouter: 'fangSessionRouter',
  link: 'fangLink',
  mirror: 'fangMirror',
  decisionCenter: 'fangDecisionCenter',
  contract: 'fangContract',
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
  umbrella: 'fang-umbrella',
  sessionCatalog: 'fang-session-catalog',
  sessionBridge: 'fang-session-bridge',
  sessionSync: 'fang-session-sync',
  sessionRouter: 'fang-session-router',
  decisionCenter: 'fang-decision-center',
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

/**
 * Action light vocabulary (v2.7.6, `fang-umbrella`).
 *
 * `RISK` above is the *approval* enum of restart-guard (three levels, no "nothing to
 * approve"). The umbrella light is four levels because it also has to say "no side
 * effect at all" — green. Mapping: green → auto-allow, blue → auto-allow + mark,
 * yellow → ask, red → ask(critical)/deny/delegate.
 */
export const LIGHT = { GREEN: 'green', BLUE: 'blue', YELLOW: 'yellow', RED: 'red' }

/** Light severity order; higher rank == more dangerous. */
export const LIGHT_RANK = { green: 1, blue: 2, yellow: 3, red: 4 }


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
  FORK_SUPERVISION: 'fork-supervision',
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
  UMBRELLA_DECISION: 'umbrella-decision',
  UMBRELLA_STRICT_MODE: 'umbrella-strict-mode',
  ROUTE: 'route',
  BUFFER_FLUSH: 'buffer-flush',
  TASK_READY: 'task-ready',
  TASK_ARCHIVED: 'task-archived',
  TASK_RESTORED: 'task-restored',
  ADAPTER_HANDSHAKE: 'adapter-handshake',
  ROUTE_CONFIRMED: 'route-confirmed',
  LINK_PROBE: 'link-probe',
  RUNTIME_ERROR: 'runtime-error',
}

export const FANG_VERSION = '3.3.0'

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
  FORK_SESSION: 'fork-session',
  DECISION_INGEST: 'decision-ingest',
}

/** Adapter HTTP route suffixes (fork side). */
export const ADAPTER_ROUTE = {
  HELLO: '/adapter/hello',
  IDENTITY: '/adapter/identity',
  CLIENT_REPORT: '/adapter/client-report',
  STATUS: '/adapter/status',
  APPROVALS: '/adapter/approvals',
  AUDIT: '/adapter/audit',
  COMMAND: '/adapter/command',
  // ── v3（docs/PROTOCOL-V3.md §4）：与 v2 五条并存，向后兼容 ──
  VERSION: '/adapter/version',
  HEALTH: '/adapter/health',
  STATE: '/adapter/state',
  EVENTS: '/adapter/events',
  COMMANDS: '/adapter/commands',
}

/**
 * Adapter 协议版本（v2.6.1 起）。两侧编译期常量：母体用它做版本协商，分身
 * 在 /adapter/version 与 /adapter/state 里回报。
 */
export const ADAPTER_PROTOCOL_VERSION = 3
/** 母体可接受的最低协议版本（v1 = 无版本号的 v2.0 握手，按 legacy 处理）。 */
export const ADAPTER_PROTOCOL_MIN = 1

/** Adapter 事件种类（SSE 下行，docs/PROTOCOL-V3.md §6）。 */
export const ADAPTER_EVENT = {
  STATE_CHANGED: 'state-changed',
  PLUGIN_STATE: 'plugin-state',
  APPROVAL_REQUESTED: 'approval-requested',
  APPROVAL_RESOLVED: 'approval-resolved',
  AUDIT: 'audit',
  COMMAND: 'command',
  COMMAND_PROGRESS: 'command-progress',
  COMMAND_DONE: 'command-done',
  ERROR: 'error',
}

/**
 * Adapter 错误码 → HTTP 状态码（docs/PROTOCOL-V3.md §8）。
 * 未登记的 code 一律 500：宁可让母体看到一个明确的失败，也不要假装成功。
 */
export const ADAPTER_ERROR_STATUS = {
  'bad-request': 400,
  'invalid-json': 400,
  'invalid-payload': 400,
  'missing-op': 400,
  'unknown-op': 400,
  'path-escape': 400,
  'file-too-large': 400,
  'total-too-large': 400,
  'binary-file': 400,
  'body-too-large': 413,
  'cursor-invalid': 400,
  'command-id-invalid': 400,
  unauthorized: 401,
  'not-found': 404,
  'plugin-not-found': 404,
  'session-changed': 409,
  'state-conflict': 409,
  'not-pending': 409,
  'service-unavailable': 409,
  'not-configured': 409,
  conflict: 409,
  timeout: 409,
  'cursor-expired': 410,
  'handler-threw': 500,
  'internal-error': 500,
  'not-ready': 503,
}

/** Container (AppContainer) executor states. */
export const CONTAINER = { DISABLED: 'disabled', UNAVAILABLE: 'unavailable', READY: 'ready' }
