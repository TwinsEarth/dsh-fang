// SPDX-License-Identifier: AGPL-3.0-or-later
// Host pressure policy for dsh-Fang.
//
// v3.8.14: the old host guard only looked at Windows CommitFree and the
// mother's Private/RSS. That misses the two signals that actually preceded
// the observed OOM: the DSH host's V8 JS heap and the on-disk body of
// session.v4.jsonl.zstd files. This module is pure so both thresholds and
// their clamping can be tested without PowerShell or a live DSH host.
const MB = 1024 * 1024

export const HOST_HEAP_DEFAULTS = Object.freeze({
  warnMB: 1024,
  criticalMB: 1536,
  emergencyMB: 2048,
  emergencyStreak: 3,
})

export const SESSION_FOOTPRINT_DEFAULTS = Object.freeze({
  // v3.9.7: align host-pressure session thresholds with the confirmed
  // fork-health policy (200/300/500 MB per file; 3000/3600/3900 MB total).
  warnMB: 3000,
  criticalMB: 3600,
  emergencyMB: 3900,
  fileWarnMB: 200,
  fileCriticalMB: 300,
  fileEmergencyMB: 500,
})

function positiveMB(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

function nonNegativeMB(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback
}

function round1(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : 0
}

/**
 * Resolve host JS-heap thresholds. Absolute config values are the operator's
 * ceiling, but a small V8 heap limit is always more authoritative: a 1 GB
 * Node heap cannot wait until a fixed 2 GB "emergency" number.
 */
export function resolveHostHeapLimits(config = {}, heapLimitMB = 0) {
  const warnCfg = positiveMB(config?.hostJsHeapWarnMB, HOST_HEAP_DEFAULTS.warnMB)
  const criticalCfg = positiveMB(config?.hostJsHeapCriticalMB, HOST_HEAP_DEFAULTS.criticalMB)
  const emergencyCfg = positiveMB(config?.hostJsHeapEmergencyMB, HOST_HEAP_DEFAULTS.emergencyMB)
  const streakCfg = positiveMB(config?.hostJsHeapEmergencyStreak, HOST_HEAP_DEFAULTS.emergencyStreak)
  let warnMB = warnCfg
  let criticalMB = Math.max(warnCfg + 1, criticalCfg)
  let emergencyMB = Math.max(criticalMB + 1, emergencyCfg)

  const limit = Number(heapLimitMB) || 0
  if (limit >= 4) {
    // Leave 10% head-room for V8/GC and the emergency close path itself.
    const warnCap = Math.max(1, Math.min(Math.round(limit * 0.65), limit - 2))
    const criticalCap = Math.max(warnCap + 1, Math.min(Math.round(limit * 0.8), limit - 1))
    const emergencyCap = Math.max(criticalCap + 1, limit - 1)
    warnMB = Math.min(warnMB, warnCap)
    criticalMB = Math.min(criticalMB, criticalCap)
    emergencyMB = Math.min(emergencyMB, emergencyCap)
    if (warnMB >= criticalMB) criticalMB = warnMB + 1
    if (criticalMB >= emergencyMB) emergencyMB = criticalMB + 1
    if (emergencyMB > limit - 1) {
      emergencyMB = Math.max(criticalMB + 1, limit - 1)
    }
  }

  return {
    warnMB,
    criticalMB,
    emergencyMB,
    emergencyStreak: Math.max(1, streakCfg),
  }
}

/**
 * Evaluate one Host JS-heap sample.
 * `heapUsedMB` is process.memoryUsage().heapUsed, `heapLimitMB` is
 * v8.getHeapStatistics().heap_size_limit. A missing metric is explicitly
 * skipped, never treated as healthy.
 */
export function evaluateHostHeap(metrics = {}, limits = null) {
  const used = Number(metrics.heapUsedMB)
  if (!Number.isFinite(used) || used <= 0) {
    return { ok: false, skipped: 'no-heap-metric', level: 'unknown', heapUsedMB: 0 }
  }
  const limitMB = Number(metrics.heapLimitMB) || 0
  const thresholds = limits || resolveHostHeapLimits({}, limitMB)
  const level = used >= thresholds.emergencyMB
    ? 'emergency'
    : used >= thresholds.criticalMB
      ? 'critical'
      : used >= thresholds.warnMB
        ? 'warn'
        : 'ok'
  return {
    ok: true,
    level,
    heapUsedMB: round1(used),
    heapTotalMB: round1(metrics.heapTotalMB),
    heapLimitMB: limitMB || null,
    externalMB: round1(metrics.externalMB),
    arrayBuffersMB: round1(metrics.arrayBuffersMB),
    pressure: limitMB > 0 ? round1((used / limitMB) * 1000) / 1000 : null,
    ...thresholds,
  }
}

function levelForMB(value, thresholds) {
  // Exact threshold values stay in the lower band, matching fork-health's
  // `>` semantics: 200/300/500 MB and 3000/3600/3900 MB are not crossed yet.
  if (value > thresholds.emergencyMB) return 'emergency'
  if (value > thresholds.criticalMB) return 'critical'
  if (value > thresholds.warnMB) return 'warn'
  return 'ok'
}

const LEVEL_RANK = Object.freeze({ ok: 0, warn: 1, critical: 2, emergency: 3, unknown: 4 })

function worseLevel(a, b) {
  return (LEVEL_RANK[a] ?? 0) >= (LEVEL_RANK[b] ?? 0) ? a : b
}

/**
 * Evaluate the total session body and the largest single session log.
 * Total bytes are a disk/compaction problem; the largest single file is the
 * one DSH will decompress into the host JS heap when it opens that session.
 */
export function evaluateSessionFootprint(footprint = {}, limits = {}) {
  const bytes = Math.max(0, Number(footprint.bytes) || 0)
  const largestBytes = Math.max(0, Number(footprint.largestBytes) || 0)
  const thresholds = {
    warnMB: nonNegativeMB(limits.sessionFootprintWarnMB, SESSION_FOOTPRINT_DEFAULTS.warnMB),
    criticalMB: nonNegativeMB(limits.sessionFootprintCriticalMB, SESSION_FOOTPRINT_DEFAULTS.criticalMB),
    emergencyMB: nonNegativeMB(limits.sessionFootprintEmergencyMB, SESSION_FOOTPRINT_DEFAULTS.emergencyMB),
    fileWarnMB: nonNegativeMB(limits.sessionFileWarnMB, SESSION_FOOTPRINT_DEFAULTS.fileWarnMB),
    fileCriticalMB: nonNegativeMB(limits.sessionFileCriticalMB, SESSION_FOOTPRINT_DEFAULTS.fileCriticalMB),
    fileEmergencyMB: nonNegativeMB(limits.sessionFileEmergencyMB, SESSION_FOOTPRINT_DEFAULTS.fileEmergencyMB),
  }
  if (thresholds.criticalMB <= thresholds.warnMB) thresholds.criticalMB = thresholds.warnMB + 1
  if (thresholds.emergencyMB <= thresholds.criticalMB) thresholds.emergencyMB = thresholds.criticalMB + 1
  if (thresholds.fileCriticalMB <= thresholds.fileWarnMB) thresholds.fileCriticalMB = thresholds.fileWarnMB + 1
  if (thresholds.fileEmergencyMB <= thresholds.fileCriticalMB) thresholds.fileEmergencyMB = thresholds.fileCriticalMB + 1

  const totalMB = round1(bytes / MB)
  const largestMB = round1(largestBytes / MB)
  const totalLevel = levelForMB(totalMB, thresholds)
  const fileLevel = levelForMB(largestMB, {
    warnMB: thresholds.fileWarnMB,
    criticalMB: thresholds.fileCriticalMB,
    emergencyMB: thresholds.fileEmergencyMB,
  })
  const level = worseLevel(totalLevel, fileLevel)
  const reasons = []
  if (totalLevel !== 'ok') reasons.push(`session-total-${totalLevel}`)
  if (fileLevel !== 'ok') reasons.push(`session-file-${fileLevel}`)
  return {
    ok: true,
    level,
    totalLevel,
    fileLevel,
    bytes,
    totalMB,
    files: Math.max(0, Number(footprint.files) || 0),
    largestBytes,
    largestMB,
    largestFile: footprint.largestFile || null,
    largestSessionId: footprint.largestSessionId || null,
    reasons,
    // A hard gate is driven by the largest single file, not by total bytes.
    // Many small archived sessions can make the total large without making the
    // next Host open dangerous; one 500 MB+ log is the actual heap risk.
    gate: fileLevel === 'emergency',
    totalGate: totalLevel === 'emergency',
    thresholds,
  }
}
