// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildJobHostArgs, jobObjectPaths, jobObjectSummary, readJobReady, resolveJobHostPath,
} from '../src/lib/job-object.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fang-job-'))

test('job object: helper resolution is architecture-exact and never guesses', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'native', 'win32'), { recursive: true })
  fs.writeFileSync(path.join(root, 'native', 'win32', 'fang-job-host.exe'), 'x64')
  assert.equal(resolveJobHostPath({ platform: 'win32', arch: 'x64', packageRoot: root }),
    path.join(root, 'native', 'win32', 'fang-job-host.exe'))
  assert.equal(resolveJobHostPath({ platform: 'win32', arch: 'arm64', packageRoot: root }), '')
  assert.equal(resolveJobHostPath({ platform: 'linux', arch: 'x64', packageRoot: root }), '')
  assert.equal(resolveJobHostPath({ platform: 'win32', arch: 'ia32', packageRoot: root }), '')
  fs.writeFileSync(path.join(root, 'native', 'win32', 'fang-job-host-arm64.exe'), 'arm64')
  assert.equal(resolveJobHostPath({ platform: 'win32', arch: 'arm64', packageRoot: root }),
    path.join(root, 'native', 'win32', 'fang-job-host-arm64.exe'))
})

test('job object: argv preserves Node shell-launcher quoting and carries no secret', () => {
  const home = tmp()
  const args = buildJobHostArgs({
    spec: { command: 'C:\\DSH\\dsh.cmd', args: ['--profile', 'web', '--patch', '"C:\\Users\\Foo Bar\\x.yml"'], shell: true },
    forkId: 'task_abc/1',
    homeDir: home,
    heartbeatFile: 'C:\\data\\watchdog-123.heartbeat',
    hostPid: 123,
    timeoutMs: 120000,
    graceMs: 30000,
  })
  assert.equal(args[0], '--log')
  assert.equal(args[1], path.join(home, 'run', 'job-object.log'))
  assert.equal(args.includes('--shell'), true)
  const split = args.indexOf('--')
  assert.deepEqual(args.slice(split), ['--', 'C:\\DSH\\dsh.cmd', '--profile', 'web', '--patch', '"C:\\Users\\Foo Bar\\x.yml"'])
  assert.equal(args.includes('fang-task_abc_1'), true)
  assert.equal(args.join(' ').includes('token'), false)
  assert.equal(args.join(' ').includes('secret'), false)
})

test('job object: readiness fails closed and exposes only the helper-owned child pid', () => {
  const home = tmp()
  const paths = jobObjectPaths(home)
  assert.equal(paths.readyFile, path.join(home, 'run', 'job-object.json'))
  assert.deepEqual(readJobReady(paths.readyFile), {
    ok: false, ready: false, childPid: null, helperPid: null, jobName: '', mode: '', error: null,
  })
  fs.mkdirSync(path.dirname(paths.readyFile), { recursive: true })
  fs.writeFileSync(paths.readyFile, JSON.stringify({ helperPid: 100, childPid: 101, jobName: 'fang-x', mode: 'kill-on-close', error: null }))
  assert.deepEqual(readJobReady(paths.readyFile), {
    ok: true, ready: true, childPid: 101, helperPid: 100, jobName: 'fang-x', mode: 'kill-on-close', error: null,
  })
  fs.writeFileSync(paths.readyFile, JSON.stringify({ helperPid: 100, childPid: 0, jobName: 'fang-x', mode: 'kill-on-close', error: 'job-assign-failed' }))
  assert.equal(readJobReady(paths.readyFile).ok, false)
  assert.equal(readJobReady(paths.readyFile).error, 'job-assign-failed')
  assert.deepEqual(jobObjectSummary({ enabled: true, ready: true, mode: 'kill-on-close', helperPid: 100, childPid: 101, jobName: 'fang-x' }), {
    enabled: true, ready: true, mode: 'kill-on-close', helperPid: 100, childPid: 101, jobName: 'fang-x', error: null, heartbeatFile: null,
  })
})

test('job object: forker and orchestrator are wired to the helper, not a silent fallback', () => {
  const forker = fs.readFileSync(new URL('../src/plugins/forker.mjs', import.meta.url), 'utf8')
  const orchestrator = fs.readFileSync(new URL('../src/plugins/orchestrator.mjs', import.meta.url), 'utf8')
  assert.match(forker, /resolveJobHostPath\(\{ packageRoot: FANG_ROOT \}\)/)
  assert.match(forker, /job-object-unavailable/)
  assert.match(forker, /launchCommand = helper/)
  assert.match(forker, /launchArgs = buildJobHostArgs/)
  assert.match(forker, /shell: launchShell/)
  assert.match(forker, /rec\.pid = ready\.childPid/)
  assert.match(orchestrator, /watchdog-\$\{process\.pid\}\.heartbeat/)
  assert.match(orchestrator, /setInterval\(writeHostHeartbeat, 15000\)/)
})
