// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// decision-ingest CLI — 独立进程把 ticket 送进母体决策中心的最低成本方式：
//   node tools/decision-ingest.mjs --outbox-dir <dir> --payload '{"producer":"PJM",...}'
//   node tools/decision-ingest.mjs --outbox-dir <dir> --flush
// 母体地址默认读 env DSH_FANG_MOTHER，也可 --mother-dir 显式指定。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { createForkIngestClient } from '../src/lib/decision-ingest-client.mjs'

function parseArgs(argv = []) {
  const out = { payload: '', payloadFile: '', outboxDir: '', motherDir: '', flush: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--flush') { out.flush = true; continue }
    if (arg === '--json') { out.json = true; continue }
    const next = () => argv[++i]
    if (arg === '--payload') { out.payload = String(next() ?? ''); continue }
    if (arg === '--payload-file') { out.payloadFile = String(next() ?? ''); continue }
    if (arg === '--outbox-dir') { out.outboxDir = String(next() ?? ''); continue }
    if (arg === '--mother-dir') { out.motherDir = String(next() ?? ''); continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outboxDir = args.outboxDir || process.env.DSH_FANG_INGEST_OUTBOX || path.join(process.cwd(), '.fang-decision-outbox')
  const motherDir = args.motherDir || process.env.DSH_FANG_MOTHER || ''
  const client = createForkIngestClient({ dataDir: outboxDir, motherDataDir: motherDir })
  let payload = null
  if (args.payload) payload = JSON.parse(args.payload)
  else if (args.payloadFile) payload = JSON.parse(fs.readFileSync(args.payloadFile, 'utf8'))
  const result = {}
  if (payload) result.submitted = await client.submit(payload)
  if (args.flush || !payload) result.flushed = await client.flush()
  result.pending = client.pending()
  if (args.json) console.log(JSON.stringify(result))
  else {
    if (result.submitted) console.log(result.submitted.queued ? `queued: ${result.submitted.outboxId}` : `sent: ${result.submitted.ticket?.id ?? 'ok'}`)
    if (result.flushed) console.log(`flush: sent=${result.flushed.sent} failed=${result.flushed.failed} remaining=${result.flushed.remaining}`)
    console.log(`pending: ${result.pending}`)
  }
}

main().catch((error) => {
  console.error(`[decision-ingest] ${String(error?.message ?? error)}`)
  process.exitCode = 1
})
