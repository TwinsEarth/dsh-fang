// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
const sidecar = fs.readFileSync(new URL('../src/lib/watchdog-sidecar.mjs', import.meta.url), 'utf8')

test('watchdog.json targets carry creation time and command-line identity', () => {
  assert.match(orchestrator, /commandLineHash: browser\.pidIdentity\?\.commandLineHash/)
  assert.match(orchestrator, /createdAt: browser\.pidIdentity\?\.startedAt \?\? browser\.startedAt/)
  assert.match(orchestrator, /commandLineHash: task\.pidIdentity\?\.commandLineHash/)
  assert.match(orchestrator, /createdAt: task\.pidIdentity\?\.startedAt \?\? task\.pidStartedAt/)
  assert.match(orchestrator, /--remote-debugging-port=\$\{browser\.port\}/)
})

test('sidecar validates target identity and fail-closes when identity is missing', () => {
  assert.match(sidecar, /matchesProcessIdentity/)
  assert.match(sidecar, /target-identity-missing/)
  assert.match(sidecar, /pid-reuse:/)
  assert.match(sidecar, /readProcessIdentity\(value\)/)
  assert.match(sidecar, /skipped\.push/)
  assert.match(sidecar, /hostIsDead/)
  assert.match(sidecar, /hostStartedAt/)
})
