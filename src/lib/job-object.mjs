// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// Windows Job Object plumbing (pure helpers + one tiny native launcher).
//
// Node has no public Job Object API. `native/win32/fang-job-host.exe` creates
// a job with KILL_ON_JOB_CLOSE, starts the fork host suspended, assigns it to
// the job, then resumes it. This module only computes paths/argv and reads the
// helper's readiness record; it never claims a job exists unless the helper
// wrote childPid.

import fs from 'node:fs'
import path from 'node:path'

export const JOB_HELPER_X64 = 'fang-job-host.exe'
export const JOB_HELPER_ARM64 = 'fang-job-host-arm64.exe'
export const JOB_HEARTBEAT_TIMEOUT_MS = 120_000
export const JOB_HEARTBEAT_GRACE_MS = 30_000
export const JOB_READY_FILE = 'job-object.json'
export const JOB_LOG_FILE = 'job-object.log'

/** Resolve the correct helper for this Windows architecture. Empty = unsupported. */
export function resolveJobHostPath({ platform = process.platform, arch = process.arch, packageRoot = '' } = {}) {
  if (platform !== 'win32') return ''
  const name = arch === 'arm64' ? JOB_HELPER_ARM64 : arch === 'x64' ? JOB_HELPER_X64 : ''
  if (!name || !packageRoot) return ''
  const file = path.join(String(packageRoot), 'native', 'win32', name)
  try { return fs.existsSync(file) ? file : '' } catch { return '' }
}

/** Paths written under the fork home so a helper crash is diagnosable after the fact. */
export function jobObjectPaths(homeDir) {
  const root = String(homeDir ?? '')
  if (!root) return null
  return {
    readyFile: path.join(root, 'run', JOB_READY_FILE),
    logFile: path.join(root, 'run', JOB_LOG_FILE),
  }
}

/** Exact argv handed to fang-job-host.exe (no secrets; PID/file paths only). */
export function buildJobHostArgs({
  spec = {},
  forkId = '',
  homeDir = '',
  heartbeatFile = '',
  hostPid = process.pid,
  timeoutMs = JOB_HEARTBEAT_TIMEOUT_MS,
  graceMs = JOB_HEARTBEAT_GRACE_MS,
  memoryMb = 0,
  totalMemoryMb = 0,
} = {}) {
  const paths = jobObjectPaths(homeDir)
  if (!paths) throw new Error('job-object: no homeDir')
  if (!spec.command) throw new Error('job-object: no command')
  const args = [
    '--log', paths.logFile,
    '--ready-file', paths.readyFile,
    '--host-pid', String(Number(hostPid) || 0),
    '--heartbeat', String(heartbeatFile ?? ''),
    '--heartbeat-timeout-ms', String(Math.max(1000, Math.floor(Number(timeoutMs) || JOB_HEARTBEAT_TIMEOUT_MS))),
    '--heartbeat-grace-ms', String(Math.max(0, Math.floor(Number(graceMs) || JOB_HEARTBEAT_GRACE_MS))),
    '--job-name', `fang-${String(forkId || 'fork').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80)}`,
  ]
  const processMemory = Math.floor(Number(memoryMb) || 0)
  const jobMemory = Math.floor(Number(totalMemoryMb) || 0)
  if (processMemory > 0) args.push('--job-process-memory-mb', String(processMemory))
  if (jobMemory > 0) args.push('--job-memory-mb', String(jobMemory))
  if (spec.shell === true) args.push('--shell')
  args.push('--', String(spec.command), ...(Array.isArray(spec.args) ? spec.args.map(String) : []))
  return args
}

/** Parse the helper readiness file. Missing/invalid fails closed (ready:false). */
export function readJobReady(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(String(file), 'utf8'))
    const childPid = Number(doc?.childPid)
    const helperPid = Number(doc?.helperPid)
    return {
      ok: Number.isInteger(childPid) && childPid > 0 && !doc?.error,
      ready: true,
      childPid: Number.isInteger(childPid) && childPid > 0 ? childPid : null,
      helperPid: Number.isInteger(helperPid) && helperPid > 0 ? helperPid : null,
      jobName: String(doc?.jobName ?? ''),
      mode: String(doc?.mode ?? ''),
      error: doc?.error ? String(doc.error) : null,
    }
  } catch {
    return { ok: false, ready: false, childPid: null, helperPid: null, jobName: '', mode: '', error: null }
  }
}

export function jobObjectSummary(job) {
  if (!job) return null
  return {
    enabled: job.enabled === true,
    ready: job.ready === true,
    mode: String(job.mode ?? ''),
    helperPid: Number(job.helperPid) || null,
    childPid: Number(job.childPid) || null,
    jobName: String(job.jobName ?? ''),
    error: job.error ?? null,
    heartbeatFile: job.heartbeatFile ? String(job.heartbeatFile) : null,
  }
}
