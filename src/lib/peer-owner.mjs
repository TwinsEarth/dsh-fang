// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Host-owner admission for the auth-token bootstrap route.
//
// The token endpoint is reachable over loopback, but loopback alone does not
// identify the caller: any local process could fetch the same response. For
// this route only, map the TCP peer to its owning process and require that
// process to run under the same OS user as the DSH host. This is defense in
// depth, not a claim that same-user processes are mutually isolated.
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function endpointPort(text) {
  const value = String(text ?? '').trim()
  const bracketed = /^\[[^\]]+\]:(\d+)$/.exec(value)
  if (bracketed) return Number(bracketed[1])
  const plain = /^[^:]+:(\d+)$/.exec(value)
  return plain ? Number(plain[1]) : 0
}

function splitLsofName(text) {
  const parts = String(text ?? '').split('->')
  if (parts.length !== 2) return null
  const from = endpointPort(parts[0])
  const to = endpointPort(parts[1])
  return from && to ? { from, to } : null
}

/** Parse `netstat -ano -p tcp` rows for the two directions of one connection. */
export function parseNetstatEstablished(text, localPort, remotePort) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue
    if (parts[3].toUpperCase() !== 'ESTABLISHED') continue
    const from = endpointPort(parts[1])
    const to = endpointPort(parts[2])
    const pid = Number(parts[4])
    if (!from || !to || !Number.isFinite(pid) || pid <= 0) continue
    if (from === Number(localPort) && to === Number(remotePort)) rows.push({ pid, direction: 'host' })
    else if (from === Number(remotePort) && to === Number(localPort)) rows.push({ pid, direction: 'peer' })
  }
  return rows
}

/** Parse lsof `-Fpcun` blocks into pid/uid/name records. */
export function parseLsofOwners(text) {
  const rows = []
  let current = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line) continue
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      if (current) rows.push(current)
      current = { pid: Number(value) || 0, uid: null, name: '' }
    } else if (current && field === 'u') {
      current.uid = Number(value)
    } else if (current && field === 'n') {
      current.name = value
    }
  }
  if (current) rows.push(current)
  return rows
}

/** Find the lsof row that owns the peer side of the connection. */
export function findLsofPeer(text, localPort, remotePort) {
  const rows = parseLsofOwners(text)
  for (const row of rows) {
    const endpoints = splitLsofName(row.name)
    if (!endpoints) continue
    if (endpoints.from === Number(remotePort) && endpoints.to === Number(localPort)) {
      return { pid: row.pid, uid: row.uid }
    }
  }
  return null
}

/** Parse /proc/net/tcp[6] rows and return the socket owner UID for each direction. */
export function parseProcNetTcp(text, localPort, remotePort) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8) continue
    if (parts[0] === 'sl') continue
    const local = parts[1].split(':')
    const remote = parts[2].split(':')
    if (local.length !== 2 || remote.length !== 2) continue
    const from = parseInt(local[1], 16)
    const to = parseInt(remote[1], 16)
    const uid = Number(parts[7])
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(uid)) continue
    if (from === Number(localPort) && to === Number(remotePort)) rows.push({ uid, direction: 'host' })
    else if (from === Number(remotePort) && to === Number(localPort)) rows.push({ uid, direction: 'peer' })
  }
  return rows
}

/** Extract local/remote TCP ports from an HTTP request socket. */
export function requestPeerPorts(req) {
  const socket = req?.socket ?? req?.connection
  const localPort = Number(socket?.localPort)
  const remotePort = Number(socket?.remotePort)
  if (!Number.isInteger(localPort) || localPort <= 0 || !Number.isInteger(remotePort) || remotePort <= 0) return null
  return { localPort, remotePort }
}

function sameOwner(left, right) {
  const a = String(left ?? '').trim().toLowerCase()
  const b = String(right ?? '').trim().toLowerCase()
  return Boolean(a && b && a === b)
}

async function verifyWindows({ localPort, remotePort, hostPid }) {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$lp = ${localPort}; $rp = ${remotePort}; $hostPid = ${hostPid}`,
    '$row = Get-NetTCPConnection -State Established -LocalPort $rp | Where-Object { $_.RemotePort -eq $lp } | Select-Object -First 1',
    'if (-not $row) {',
    '  $line = netstat -ano -p tcp | Select-String -Pattern "ESTABLISHED" | Where-Object { $_.Line -match ":$rp\\s+.*:$lp\\s+ESTABLISHED" } | Select-Object -First 1',
    '  if ($line) { $peerPid = [int](($line.Line.Trim() -split "\\s+")[-1]) }',
    '} else { $peerPid = [int]$row.OwningProcess }',
    'if (-not $peerPid) { [pscustomobject]@{ ok = $false; error = "peer-connection-not-found" } | ConvertTo-Json -Compress; exit 0 }',
    '$hostProc = Get-CimInstance Win32_Process -Filter "ProcessId=$hostPid"',
    '$peerProc = Get-CimInstance Win32_Process -Filter "ProcessId=$peerPid"',
    'function Owner($p) { if (-not $p) { return "" }; $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner; if ($o.ReturnValue -ne 0) { return "" }; return "$($o.Domain)\\$($o.User)" }',
    '$hostOwner = Owner $hostProc; $peerOwner = Owner $peerProc',
    'if (-not $hostOwner -or -not $peerOwner) { [pscustomobject]@{ ok = $false; error = "owner-unavailable"; peerPid = $peerPid } | ConvertTo-Json -Compress; exit 0 }',
    'if ($hostOwner -ne $peerOwner) { [pscustomobject]@{ ok = $false; error = "not-host-owner"; peerPid = $peerPid; hostOwner = $hostOwner; peerOwner = $peerOwner } | ConvertTo-Json -Compress; exit 0 }',
    '[pscustomobject]@{ ok = $true; peerPid = $peerPid } | ConvertTo-Json -Compress',
  ].join('\n')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { timeout: 8000, windowsHide: true, maxBuffer: 65536 })
  const text = String(stdout ?? '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'owner-parse-failed' }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed.ok === true ? { ok: true, peerPid: Number(parsed.peerPid) || null } : {
      ok: false, error: String(parsed.error ?? 'owner-unavailable'), peerPid: Number(parsed.peerPid) || null,
    }
  } catch { return { ok: false, error: 'owner-parse-failed' } }
}

async function verifyLinux({ localPort, remotePort }) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid == null) return { ok: false, error: 'owner-uid-unavailable' }
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try { text = await fs.readFile(file, 'utf8') } catch { continue }
    const rows = parseProcNetTcp(text, localPort, remotePort)
    const peer = rows.find((row) => row.direction === 'peer')
    if (!peer) continue
    return peer.uid === uid ? { ok: true, peerUid: peer.uid } : { ok: false, error: 'not-host-owner', peerUid: peer.uid }
  }
  return { ok: false, error: 'peer-connection-not-found' }
}

async function verifyDarwin({ localPort, remotePort }) {
  let stdout = ''
  try {
    const result = await execFileAsync('lsof', [
      '-nP', `-iTCP:${localPort}`, '-sTCP:ESTABLISHED', '-Fpcun',
    ], { timeout: 8000, maxBuffer: 65536 })
    stdout = result.stdout
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: 'lsof-unavailable' }
    stdout = String(error?.stdout ?? '')
  }
  const peer = findLsofPeer(stdout, localPort, remotePort)
  if (!peer) return { ok: false, error: 'peer-connection-not-found' }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid == null || peer.uid == null) return { ok: false, error: 'owner-uid-unavailable', peerPid: peer.pid || null }
  return peer.uid === uid ? { ok: true, peerPid: peer.pid || null } : {
    ok: false, error: 'not-host-owner', peerPid: peer.pid || null, peerUid: peer.uid,
  }
}

/**
 * Verify that the HTTP peer process belongs to the same OS user as this host.
 * Returns `{ok:false,error}` whenever the mapping cannot be proven (fail-closed).
 */
export async function verifyPeerOwner(req, options = {}) {
  const ports = requestPeerPorts(req)
  if (!ports) return { ok: false, error: 'peer-socket-unavailable' }
  const platform = String(options.platform ?? process.platform)
  const hostPid = Number(options.hostPid ?? process.pid) || process.pid
  try {
    if (platform === 'win32') return await verifyWindows({ ...ports, hostPid })
    if (platform === 'darwin') return await verifyDarwin(ports)
    if (platform === 'linux') return await verifyLinux(ports)
    return { ok: false, error: 'peer-owner-unsupported-platform' }
  } catch (error) {
    return { ok: false, error: `peer-owner-check-failed:${String(error?.message ?? error)}` }
  }
}

export const _internals = { endpointPort, splitLsofName, sameOwner }
