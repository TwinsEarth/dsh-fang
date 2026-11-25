// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const upload = fs.readFileSync(path.join(root, 'tools/release/upload-release-assets.mjs'), 'utf8')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
const retry = fs.readFileSync(path.join(root, 'tools/release/net-retry.mjs'), 'utf8')

test('GitHub release upload retries transient failures and recovers ambiguous 422s', () => {
  assert.match(upload, /retryOperation/)
  assert.match(upload, /retryAfterMsFrom/)
  assert.match(upload, /assetMatches\(asset, data, localSha\)/)
  assert.match(upload, /recovered uploaded asset after 422/)
  assert.match(upload, /asset already current/)
  assert.match(upload, /release exists after create race/)
  assert.match(upload, /retries=\$\{RETRIES\}/)
})

test('retry helper treats network resets and 5xx as transient', () => {
  assert.match(retry, /ECONNRESET/)
  assert.match(retry, /ENOTFOUND/)
  assert.match(retry, /TRANSIENT_STATUS/)
  assert.match(retry, /502/)
  assert.match(retry, /Retry-After|retry-after/)
})

test('codeload source fetch is retried instead of one-shot failing the release job', () => {
  assert.match(workflow, /\$attempts = 5/)
  assert.match(workflow, /fetch attempt \{0\}\/\{1\}/)
  assert.match(workflow, /Start-Sleep -Seconds \$delay/)
  assert.match(workflow, /源码下载失败/)
})
