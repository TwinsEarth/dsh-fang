// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent watchdog. Runs outside the DSH host so it can still clean up
// managed browsers / fork trees if the host dies or is force-killed.
// It only acts on PIDs written by the host into watchdog.json.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const file = String(process.argv[2] ?? '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try { process.kill(value, 0); return true } catch { return false }
}

function killTree(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return
  try {
    spawnSync('taskkill.exe', ['/PID', String(value), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
  } catch { /* best effort */ }
}

async function main() {
  if (!file) process.exit(0)
  for (;;) {
    let data = null
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* host may be writing */ }
    if (!data) { await sleep(2000); continue }
    const hostPid = Number(data.hostPid)
    const targets = Array.isArray(data.targets) ? data.targets : []
    if (data.stop === true || data.clean === true || !alive(hostPid)) {
      for (const target of targets) killTree(target.pid)
      try { fs.writeFileSync(file, JSON.stringify({ ...data, stoppedAt: new Date().toISOString(), stop: true }, null, 2)) } catch { /* ignore */ }
      process.exit(0)
    }
    await sleep(2000)
  }
}

main().catch(() => process.exit(0))
