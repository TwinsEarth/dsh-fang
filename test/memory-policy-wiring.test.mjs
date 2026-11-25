// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const orchestrator = fs.readFileSync(path.join(root, 'src/plugins/orchestrator.mjs'), 'utf8')
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

test('orchestrator derives thresholds from host memory instead of fixed constants', () => {
  assert.match(orchestrator, /import \{ resolveMemoryThresholds \} from '\.\.\/lib\/memory-policy\.mjs'/)
  assert.match(orchestrator, /memoryAdaptiveThresholds: z\.boolean\(\)\.default\(true\)/)
  assert.match(orchestrator, /physicalTotalMB: Number\(memory\.physicalTotalMB\) \|\| 0/)
  assert.match(orchestrator, /const memoryPolicySnapshot = \(\) => \(\{[\s\S]{0,120}resolveMemoryThresholds\(cfg, memorySnapshot\?\.ok === true \? memorySnapshot : lastGoodMemory\)/)
  assert.match(orchestrator, /let lastGoodMemory = null/)
  assert.match(orchestrator, /memorySnapshot\.ok === true && \(memorySnapshot\.physicalTotalMB > 0 \|\| memorySnapshot\.commitLimitMB > 0\)/)
  assert.match(orchestrator, /const limits = memoryPolicySnapshot\(\)\n    const overKill = current >= Number\(limits\.memoryKillCommitMB\)/)
  assert.match(orchestrator, /const limits = memoryPolicySnapshot\(\)\n      const overMemory = Number\(tree\.commitMB\) >= Number\(limits\.browserMemoryLimitMB\)/)
  assert.match(orchestrator, /limitMB: limits\.memoryKillCommitMB/)
  assert.match(orchestrator, /memoryLimitMB: limits\.browserMemoryLimitMB/)
})

test('status and manual probe expose the effective policy', () => {
  assert.match(orchestrator, /memory: memorySnapshot,\n        memoryPolicy: memoryPolicySnapshot\(\)/)
  assert.match(orchestrator, /return \{ ok: memory\?\.ok !== false, memory: memorySnapshot, memoryPolicy: memoryPolicySnapshot\(\) \}/)
})

test('client shows the effective policy on probe and pagefile help', () => {
  assert.match(client, /out\.body\?\.memoryPolicy \|\| \{\}/)
  assert.match(client, /自动阈值 \$\{Math\.round\(Number\(policy\.browserMemoryLimitMB\) \|\| 0\)/)
  assert.match(client, /const policy = S\.status\?\.data\?\.memoryPolicy \|\| null/)
  assert.match(client, /内存看门狗：\$\{policy\.adaptive === true \? '自适应' : '固定'\}/)
})

