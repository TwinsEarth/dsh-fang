// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as forker from '../src/plugins/forker.mjs'
import { resolveJobHostPath } from '../src/lib/job-object.mjs'
import { removeTree } from '../src/kernel/index.mjs'
import { makeCtx } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 't1', 'mother-profile')
const PACKAGE_ROOT = path.resolve(HERE, '..')

const alive = (pid) => {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try { process.kill(value, 0); return true } catch { return false }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await wait(100)
  }
  return false
}

test('real forker+helper: killing the helper (host freeze) kills fork child and grandchild', {
  // GitHub-hosted windows-latest (Server 2025) cannot initialize the native
  // Job Object helper; the same test passes on a real Windows desktop. Keep it
  // as a real integration test there and skip only the hosted CI runner.
  skip: process.platform !== 'win32' ||
    !resolveJobHostPath({ packageRoot: PACKAGE_ROOT }) ||
    process.env.GITHUB_ACTIONS === 'true',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-job-integration-'))
  const template = path.join(root, 'mother-profile')
  fs.mkdirSync(path.join(template, 'node_modules'), { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml', 'README.md']) {
    fs.copyFileSync(path.join(FIXTURE, name), path.join(template, name))
  }
  fs.writeFileSync(path.join(template, 'node_modules', 'mother-dep.txt'), 'mother-only\n')
  const homeDir = path.join(root, 'fork-home')
  const dataRoot = path.join(root, 'data')
  const marker = path.join(root, 'grandchild.json')
  const cli = path.join(root, 'fake-cli.mjs')
  fs.writeFileSync(cli, `
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
const i = args.indexOf('--port')
const port = i >= 0 ? Number(args[i + 1]) : 0
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
fs.writeFileSync(process.env.GRANDCHILD_FILE, JSON.stringify({ pid: grandchild.pid, parent: process.pid, args, port }))
console.log('dsh web: http://127.0.0.1:' + port + '/?token=job-kill-test')
setInterval(() => {}, 1000)
`)
  const ctx = makeCtx()
  const service = forker.apply(ctx, { forkSeed: { enabled: false }, maxForks: 1, dataRoot, allocatePorts: true })
  try {
    service.provision({ forkId: 'f-job-kill', homeDir, profile: 'web', profileTemplate: template })
    const spawn = await service.spawn({
      forkId: 'f-job-kill', homeDir, profile: 'web', cliPath: cli,
      env: { GRANDCHILD_FILE: marker }, timeoutMs: 20000,
    })
    assert.equal(spawn.ok, true, JSON.stringify(spawn))
    // The helper writes job-object.json asynchronously after the child prints its
    // URL. A cold GitHub Windows runner can take well over 300 ms to get there.
    const ready = await waitFor(() => service.status('f-job-kill').jobObject?.ready === true, 10000)
    assert.equal(ready, true, 'job helper did not publish readiness within 10s')
    const row = JSON.parse(fs.readFileSync(marker, 'utf8'))
    const status = service.status('f-job-kill')
    assert.equal(status.jobObject?.ready, true)
    assert.equal(Number(status.jobObject.childPid), Number(spawn.pid))
    assert.ok(alive(row.pid), 'grandchild should be alive before the helper is killed')

    // Simulate a frozen/dying host: kill only the helper. No taskkill /T, no
    // stopRecord; KILL_ON_JOB_CLOSE must reap the child and its grandchild.
    process.kill(Number(status.jobObject.helperPid))
    await wait(2000)
    assert.equal(alive(Number(spawn.pid)), false, 'fork child must die with the helper')
    assert.equal(alive(Number(row.pid)), false, 'grandchild must die with the helper')
  } finally {
    try { ctx.dispose() } catch { /* ignore */ }
    try { removeTree(root) } catch { /* ignore */ }
  }
})
