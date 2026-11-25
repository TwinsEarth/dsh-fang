// SPDX-License-Identifier: AGPL-3.0-or-later
// Adaptive memory thresholds for dsh-Fang.
//
// The old fixed browser/fork limits (2 GB commit / 1.5 GB JS heap / 2 GB
// fork kill) were tuned on one host and are wrong at both ends: too loose on a
// 8 GB laptop, too tight on a 32 GB workstation. This module derives the
// effective limits from the host's physical RAM, falling back to commit limit,
// and keeps the configured values only as an explicit fixed mode / no-probe
// fallback. It is pure so the policy can be tested without PowerShell.
export const LEGACY_MEMORY_THRESHOLDS = Object.freeze({
  browserMemoryLimitMB: 2048,
  browserHeapLimitMB: 1536,
  memoryKillCommitMB: 2048,
  memoryGrowCommitMB: 768,
})

const MIN_BROWSER_MB = 512
const MAX_BROWSER_MB = 4096
const MIN_HEAP_MB = 384
const MAX_HEAP_MB = 3072
const MIN_KILL_MB = 512
const MAX_KILL_MB = 4096
const MIN_GROW_MB = 192
const MAX_GROW_MB = 1024

const BROWSER_SHARE = 0.20
const HEAP_SHARE = 0.10
const KILL_SHARE = 0.20
const GROW_RATIO = 0.375

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function positiveMB(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function fixedThresholds(config) {
  return {
    browserMemoryLimitMB: positiveMB(config?.browserMemoryLimitMB) || LEGACY_MEMORY_THRESHOLDS.browserMemoryLimitMB,
    browserHeapLimitMB: positiveMB(config?.browserHeapLimitMB) || LEGACY_MEMORY_THRESHOLDS.browserHeapLimitMB,
    memoryKillCommitMB: positiveMB(config?.memoryKillCommitMB) || LEGACY_MEMORY_THRESHOLDS.memoryKillCommitMB,
    memoryGrowCommitMB: positiveMB(config?.memoryGrowCommitMB) || LEGACY_MEMORY_THRESHOLDS.memoryGrowCommitMB,
  }
}

/**
 * Resolve effective watchdog limits.
 *
 * `memory` is the readSystemMemory() shape; physicalTotalMB is preferred,
 * commitLimitMB is the fallback. Without a usable probe the old fixed values
 * remain in force, so a failed PowerShell query never silently loosens a limit.
 */
export function resolveMemoryThresholds(config = {}, memory = null) {
  const fixed = fixedThresholds(config)
  if (config?.memoryAdaptiveThresholds === false) {
    return { ...fixed, adaptive: false, mode: 'fixed', source: 'config' }
  }

  const supported = memory?.ok === true && memory?.supported !== false
  const physicalTotalMB = positiveMB(memory?.physicalTotalMB)
  const commitLimitMB = positiveMB(memory?.commitLimitMB)
  const basisMB = physicalTotalMB || commitLimitMB
  // Non-Windows has no meaningful CommitLimit; os.freemem() is not a limit.
  const usable = supported && basisMB > 0
  if (!usable) {
    return {
      ...fixed,
      adaptive: false,
      mode: 'fixed',
      source: 'fallback-no-memory',
      physicalTotalMB,
      commitLimitMB,
    }
  }

  const browserMemoryLimitMB = clamp(basisMB * BROWSER_SHARE, MIN_BROWSER_MB, MAX_BROWSER_MB)
  const browserHeapLimitMB = Math.min(
    browserMemoryLimitMB,
    clamp(basisMB * HEAP_SHARE, MIN_HEAP_MB, MAX_HEAP_MB),
  )
  const memoryKillCommitMB = clamp(basisMB * KILL_SHARE, MIN_KILL_MB, MAX_KILL_MB)
  const memoryGrowCommitMB = clamp(memoryKillCommitMB * GROW_RATIO, MIN_GROW_MB, MAX_GROW_MB)
  return {
    browserMemoryLimitMB,
    browserHeapLimitMB,
    memoryKillCommitMB,
    memoryGrowCommitMB,
    adaptive: true,
    mode: 'adaptive',
    source: physicalTotalMB > 0 ? 'physical-total' : 'commit-limit',
    basisMB,
    physicalTotalMB,
    commitLimitMB,
  }
}
