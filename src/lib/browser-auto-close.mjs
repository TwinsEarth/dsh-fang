// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure auto-close policy for the managed browser.
//
// The operator's explicit thresholds are hard ceilings: adaptive thresholds
// from memory-policy may tighten them on a small host, but never loosen them.
// Scope matters:
//   - browser's own tree/heap/DOM over limit -> close browser and stop fork
//   - host CommitFree low                   -> close browser only, keep fork home
// A browser-only close keeps the conversation home and can be reopened by the
// user; no path here deletes or rewrites the home directory.

export const BROWSER_AUTO_CLOSE_DEFAULTS = Object.freeze({
  treeCommitMB: 2048,
  jsHeapMB: 1536,
  domNodes: 200000,
  hostCommitFreeMB: 4096,
  idleMinutes: 10,
  gracefulCloseMs: 3000,
})

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/** Effective hard ceilings. Adaptive limits may only make the policy stricter. */
export function effectiveBrowserAutoCloseLimits(config = {}, policy = {}) {
  const adaptiveCommit = positive(policy.browserMemoryLimitMB)
  const configCommit = positive(config.browserMemoryLimitMB)
  const adaptiveHeap = positive(policy.browserHeapLimitMB)
  const configHeap = positive(config.browserHeapLimitMB)
  return {
    treeCommitMB: Math.min(
      adaptiveCommit || BROWSER_AUTO_CLOSE_DEFAULTS.treeCommitMB,
      configCommit || BROWSER_AUTO_CLOSE_DEFAULTS.treeCommitMB,
    ),
    jsHeapMB: Math.min(
      adaptiveHeap || BROWSER_AUTO_CLOSE_DEFAULTS.jsHeapMB,
      configHeap || BROWSER_AUTO_CLOSE_DEFAULTS.jsHeapMB,
    ),
    domNodes: positive(config.browserDomNodeLimit) || BROWSER_AUTO_CLOSE_DEFAULTS.domNodes,
    hostCommitFreeMB: positive(config.hostCriticalFreeMB) || BROWSER_AUTO_CLOSE_DEFAULTS.hostCommitFreeMB,
    idleMinutes: Number(config.autoCloseIdleMinutes) >= 0
      ? Number(config.autoCloseIdleMinutes)
      : BROWSER_AUTO_CLOSE_DEFAULTS.idleMinutes,
    gracefulCloseMs: Number(config.gracefulBrowserCloseMs) >= 0
      ? Number(config.gracefulBrowserCloseMs)
      : BROWSER_AUTO_CLOSE_DEFAULTS.gracefulCloseMs,
    adaptiveCommitMB: adaptiveCommit || null,
    adaptiveHeapMB: adaptiveHeap || null,
  }
}

/**
 * Evaluate one managed browser.
 *
 * `scope: 'task'` means close browser, stop the fork backend, release port and
 * revoke token. `scope: 'browser'` means close the browser only; the fork home
 * and session files stay in place.
 */
export function evaluateBrowserAutoClose({
  autoClose = true,
  commitMB = 0,
  heapMB = 0,
  nodeCount = 0,
  cdpOk = true,
  hostCommitFreeMB = null,
  config = {},
  policy = {},
} = {}) {
  const limits = effectiveBrowserAutoCloseLimits(config, policy)
  if (autoClose !== true) {
    return { close: false, reason: 'auto-close-disabled', scope: null, trigger: 'disabled', limits }
  }
  const free = hostCommitFreeMB === null || hostCommitFreeMB === undefined
    ? null
    : Number(hostCommitFreeMB)
  if (free !== null && Number.isFinite(free) && free >= 0 && free < limits.hostCommitFreeMB) {
    return {
      close: true,
      reason: 'host-commit-low-browser-memory-limit',
      scope: 'browser',
      trigger: 'host-commit-free',
      limits,
      metrics: { commitMB, heapMB, nodeCount, hostCommitFreeMB: free },
    }
  }
  if (Number(commitMB) >= limits.treeCommitMB) {
    return {
      close: true,
      reason: 'browser-memory-limit',
      scope: 'task',
      trigger: 'browser-tree-commit',
      limits,
      metrics: { commitMB, heapMB, nodeCount, hostCommitFreeMB: free },
    }
  }
  if (cdpOk && Number(heapMB) >= limits.jsHeapMB) {
    return {
      close: true,
      reason: 'browser-heap-limit',
      scope: 'task',
      trigger: 'browser-js-heap',
      limits,
      metrics: { commitMB, heapMB, nodeCount, hostCommitFreeMB: free },
    }
  }
  if (cdpOk && Number(nodeCount) >= limits.domNodes) {
    return {
      close: true,
      reason: 'browser-dom-limit',
      scope: 'task',
      trigger: 'browser-dom-nodes',
      limits,
      metrics: { commitMB, heapMB, nodeCount, hostCommitFreeMB: free },
    }
  }
  return {
    close: false,
    reason: 'below-limits',
    scope: null,
    trigger: null,
    limits,
    metrics: { commitMB, heapMB, nodeCount, hostCommitFreeMB: free },
  }
}
