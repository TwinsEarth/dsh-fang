// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGACY_MEMORY_THRESHOLDS, resolveMemoryThresholds } from '../src/lib/memory-policy.mjs'

const windowsMemory = (physicalTotalMB, commitLimitMB = physicalTotalMB * 2) => ({
  ok: true, supported: true, physicalTotalMB, commitLimitMB,
})

test('adaptive thresholds scale across 8/16/32 GB hosts', () => {
  const small = resolveMemoryThresholds({}, windowsMemory(8192))
  assert.equal(small.adaptive, true)
  assert.equal(small.source, 'physical-total')
  assert.equal(small.browserMemoryLimitMB, 1638)
  assert.equal(small.browserHeapLimitMB, 819)
  assert.equal(small.memoryKillCommitMB, 1638)
  assert.equal(small.memoryGrowCommitMB, 614)

  const medium = resolveMemoryThresholds({}, windowsMemory(16384))
  assert.equal(medium.browserMemoryLimitMB, 3277)
  assert.equal(medium.browserHeapLimitMB, 1638)
  assert.equal(medium.memoryKillCommitMB, 3277)
  assert.equal(medium.memoryGrowCommitMB, 1024)
  assert.ok(medium.browserHeapLimitMB < medium.browserMemoryLimitMB)

  const large = resolveMemoryThresholds({}, windowsMemory(32768))
  assert.equal(large.browserMemoryLimitMB, 4096)
  assert.equal(large.browserHeapLimitMB, 3072)
  assert.equal(large.memoryKillCommitMB, 4096)
  assert.equal(large.memoryGrowCommitMB, 1024)
})

test('adaptive thresholds floor tiny hosts and cap huge hosts', () => {
  const tiny = resolveMemoryThresholds({}, windowsMemory(2048))
  assert.equal(tiny.browserMemoryLimitMB, 512)
  assert.equal(tiny.browserHeapLimitMB, 384)
  assert.equal(tiny.memoryKillCommitMB, 512)
  assert.equal(tiny.memoryGrowCommitMB, 192)

  const huge = resolveMemoryThresholds({}, windowsMemory(262144))
  assert.equal(huge.browserMemoryLimitMB, 4096)
  assert.equal(huge.browserHeapLimitMB, 3072)
  assert.equal(huge.memoryKillCommitMB, 4096)
})

test('CommitLimit is the fallback basis when physical RAM is unavailable', () => {
  const policy = resolveMemoryThresholds({}, { ok: true, supported: true, physicalTotalMB: 0, commitLimitMB: 16384 })
  assert.equal(policy.source, 'commit-limit')
  assert.equal(policy.basisMB, 16384)
  assert.equal(policy.browserMemoryLimitMB, 3277)
  assert.equal(policy.memoryKillCommitMB, 3277)
})

test('fixed mode and missing probes keep the configured legacy safeguards', () => {
  const config = {
    browserMemoryLimitMB: 3072,
    browserHeapLimitMB: 1024,
    memoryKillCommitMB: 4096,
    memoryGrowCommitMB: 512,
  }
  const fixed = resolveMemoryThresholds({ ...config, memoryAdaptiveThresholds: false }, windowsMemory(32768))
  assert.equal(fixed.adaptive, false)
  assert.equal(fixed.source, 'config')
  assert.equal(fixed.browserMemoryLimitMB, 3072)
  assert.equal(fixed.browserHeapLimitMB, 1024)
  assert.equal(fixed.memoryKillCommitMB, 4096)
  assert.equal(fixed.memoryGrowCommitMB, 512)

  const fallback = resolveMemoryThresholds(config, null)
  assert.equal(fallback.adaptive, false)
  assert.equal(fallback.source, 'fallback-no-memory')
  assert.equal(fallback.browserMemoryLimitMB, 3072)
  assert.equal(fallback.memoryKillCommitMB, 4096)

  const unsupported = resolveMemoryThresholds({}, { ok: true, supported: false, physicalTotalMB: 16384 })
  assert.equal(unsupported.source, 'fallback-no-memory')
  assert.equal(unsupported.browserMemoryLimitMB, LEGACY_MEMORY_THRESHOLDS.browserMemoryLimitMB)
  assert.equal(unsupported.browserHeapLimitMB, LEGACY_MEMORY_THRESHOLDS.browserHeapLimitMB)
})
