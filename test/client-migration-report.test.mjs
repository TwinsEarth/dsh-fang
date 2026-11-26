// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const orchestrator = fs.readFileSync(path.join(root, 'src/plugins/orchestrator.mjs'), 'utf8')

test('orchestrator reads the latest migration report into the status layout', () => {
  assert.match(orchestrator, /import \{ readLatestMigrationReport \} from '\.\.\/lib\/migration-report\.mjs'/)
  assert.match(orchestrator, /const migrationReport = readLatestMigrationReport\(layout\.fangHome \|\| layout\.canonicalFangHome\)/)
  assert.match(orchestrator, /legacyDataDetected: layout\.legacyDataDetected === true,\n          legacyDataDir: layout\.legacyDataDir \|\| '',\n          migrationReport,/)
})

test('client renders a visible migration banner and report modal', () => {
  assert.match(client, /function renderMigrationReportBanner\(S, app\)/)
  assert.match(client, /'data-zone': 'migration-report-banner'/)
  assert.match(client, /数据迁移报告 · \$\{report\.stamp \|\| '未知时间'\}/)
  // The banner lives outside createConsole; it must go through the app surface.
  assert.match(client, /onClick: \(\) => app\.openMigrationReport\(\)/)
  assert.match(client, /onClick: \(\) => dismissMigrationReportBanner\(S, app, file\)/)
  assert.match(client, /dismissMigrationReportBanner: \(file\) => dismissMigrationReportBanner\(S, app, file\)/)
  assert.doesNotMatch(client, /onClick: \(\) => openMigrationReport\(\)/)
  assert.match(client, /probeMemory, openPagefileHelp, openMigrationReport, dismissMigrationReportBanner: \(file\) => dismissMigrationReportBanner\(S, app, file\), openDiskHygiene/)
  assert.match(client, /function renderMigrationReportModal\(S, app\)/)
  assert.match(client, /S\.modal\.kind === 'migrationReport'/)
  assert.match(client, /target: safeText|report\.target/)
  assert.match(client, /冲突文件/)
})

test('migration report banner is placed in the notice stack', () => {
  assert.match(client, /const migrationBanner = renderMigrationReportBanner\(S, app\)[\s\S]{0,80}nodes\.push\(migrationBanner\)/)
})
