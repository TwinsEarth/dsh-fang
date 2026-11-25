// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
// Worker side of the pipe-exec protocol (ESM - loaded from a data: URL).
// stdin : RAW JavaScript source (no JSON wrapper, avoids PowerShell serialization quirks)
// stdout: {"ok":true,"result":<parsed result.json>} | {"ok":false,"error":"..."}
import fs from 'node:fs'
import { createRequire } from 'node:module'

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

;(async () => {
  let code = await readStdin()
  code = code.replace(/^\uFEFF/, '')
  if (!code.trim()) return out({ ok: false, error: 'empty-code' })

  // Provide require to submitted code (ESM has no require).
  try {
    globalThis.require = createRequire('file:///' + process.cwd().replace(/\\/g, '/') + '/')
  } catch { /* */ }

  try { fs.rmSync('result.json', { force: true }) } catch { /* */ }
  const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
  let thrown = null
  try { await import(url) } catch (e) { thrown = String((e && e.message) || e) }
  let result = null
  try { result = JSON.parse(fs.readFileSync('result.json', 'utf8')) } catch { result = null }
  if (thrown) out({ ok: false, error: thrown, result })
  else out({ ok: true, result })
})()
