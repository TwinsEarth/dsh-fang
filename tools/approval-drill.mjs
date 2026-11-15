#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/approval-drill.mjs — 隔离审批 drill：真实 request→decide→snapshot→rollback。
// 用法：node tools/approval-drill.mjs [--json]
import { cleanupApprovalDrill, runApprovalDrill } from '../src/lib/approval-drill.mjs'

const json = process.argv.slice(2).includes('--json')
const result = await runApprovalDrill()
const cleanup = cleanupApprovalDrill(result)
result.cleanup = cleanup
if (json) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`${result.ok ? 'GREEN' : 'RED'}  approval drill`)
  console.log(`  request   : ${result.request?.id ?? '-'} kind=${result.request?.kind ?? '-'} risk=${result.request?.risk ?? '-'} outcome=${result.request?.outcome ?? '-'}`)
  console.log(`  pending   : before=${result.pendingBefore ?? '-'} after=${result.pendingAfter ?? '-'}`)
  console.log(`  snapshot  : ${result.snapshot?.ok === false ? 'FAIL' : 'ok'}`)
  console.log(`  rollback  : ${result.rollback?.ok === true ? 'ok' : 'FAIL'} restored=${result.restored === true}`)
  console.log(`  residue   : ${cleanup ? 'clean' : 'kept ' + (result.dataRoot ?? '')}`)
  if (result.error) console.log(`  error     : ${result.error}`)
}
process.exitCode = result.ok && cleanup ? 0 : 1
