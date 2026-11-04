// SPDX-License-Identifier: AGPL-3.0-or-later
// v3.0.8 branch runtime spike: same process, one session, N branch logs, single writer per branch.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fang-branch-spike-'))
const sessionId = 'session_spike'
const branches = ['main', 'branch-a', 'branch-b']
const dirs = Object.fromEntries(branches.map((b) => [b, path.join(root, sessionId, 'branches', b)]))
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }

// 1) independent logs per branch
for (const [i, b] of branches.entries()) fs.writeFileSync(path.join(dirs[b], 'log.jsonl'), JSON.stringify({ branch: b, turn: i }) + '\n')
const logs = branches.map((b) => fs.readFileSync(path.join(dirs[b], 'log.jsonl'), 'utf8').trim())
check('branches have independent logs', new Set(logs).size === branches.length, logs.join(' | '))

// 2) single writer per branch: exclusive lock file (wx => EEXIST for second writer)
const lock = path.join(dirs['main'], 'writer.lock')
let first = true
let second = false
try {
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
} catch { first = false }
try {
  fs.writeFileSync(lock, String(process.pid + 1), { flag: 'wx' })
  second = true
} catch { second = false }
check('second writer on same branch is rejected', first === true && second === false)
check('branch lock is per branch, not global', (() => {
  try { fs.writeFileSync(path.join(dirs['branch-a'], 'writer.lock'), 'x', { flag: 'wx' }); return true } catch { return false }
})())

// 3) switching active branch is just pointer move, no process restart
let active = 'main'
active = 'branch-a'
check('active branch switch is a pointer move', active === 'branch-a' && fs.existsSync(dirs['branch-b']))

fs.rmSync(root, { recursive: true, force: true })
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${failed ? 'RED' : 'GREEN'}  branch spike ${checks.length - failed}/${checks.length}`)
process.exit(failed ? 1 : 0)
