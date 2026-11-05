// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/release/allowlist.mjs — self-check: route allow-list, package file allow-list, secret/local-path scan.
// Usage: node tools/release/allowlist.mjs [--json] [--with-manifest]
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readJson, globMatch } from './lib.mjs'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const withManifest = args.includes('--with-manifest')
const findings = []
const fail = (code, file, detail = '') => findings.push({ code, file, detail })

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', '.tmp'].includes(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

// ── 1) HTTP route allow-list: every route must be under ${prefix}/api/ and use an allowed method ──
const ROUTE_RE = /route\('(GET|POST|PUT|PATCH|DELETE)',\s*`\$\{prefix\}([^`]*)`/g
// GET+POST share one exact route (DSH keys routes by path); register it as one
// logical path so the allow-list still sees it.
const ROUTE_METHODS_RE = /routeMethods\(`\$\{prefix\}([^`]*)`/g
const routes = []
const pluginDir = path.join(ROOT, 'src', 'plugins')
for (const file of fs.readdirSync(pluginDir).filter((f) => f.endsWith('.mjs'))) {
  const text = fs.readFileSync(path.join(pluginDir, file), 'utf8')
  let m
  ROUTE_RE.lastIndex = 0
  while ((m = ROUTE_RE.exec(text))) {
    const [, method, routePath] = m
    routes.push({ file, method, path: routePath })
    const isApi = routePath.startsWith('/api/')
    const isAdapterConstant = routePath.startsWith('${ADAPTER_ROUTE.')
    const isPortal = method === 'GET' && routePath === '/panel'
    if (!isApi && !isAdapterConstant && !isPortal) fail('route-not-under-api', file, `${method} ${routePath}`)
    if (!['GET', 'POST'].includes(method)) fail('route-method-not-allowlisted', file, `${method} ${routePath}`)
    if (routePath.includes('*') || routePath.includes('..')) fail('route-wildcard', file, routePath)
  }
  ROUTE_METHODS_RE.lastIndex = 0
  while ((m = ROUTE_METHODS_RE.exec(text))) {
    const routePath = m[1]
    routes.push({ file, method: 'GET+POST', path: routePath })
    if (!routePath.startsWith('/api/')) fail('route-not-under-api', file, `GET+POST ${routePath}`)
    if (routePath.includes('*') || routePath.includes('..')) fail('route-wildcard', file, routePath)
  }
}
if (routes.length < 8) fail('route-count-suspicious', 'src/plugins', `only ${routes.length} routes found`)

// ── 2) secret scan (test fixtures are intentionally excluded; they contain fake tokens) ──
const SECRET_RES = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
]
const LOCAL_PATH_RES = [/C:\\Users\\fangw/i, /E:\\GPT\\dsh-fang/i]
const scanned = []
for (const abs of walk(ROOT)) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
  if (rel.startsWith('test/') || rel.startsWith('dist/')) continue
  if (!/\.(mjs|js|json|yml|yaml|md|txt|ps1|cs|html|toml|dockerfile)$/i.test(rel) && !rel.endsWith('Dockerfile')) continue
  const text = fs.readFileSync(abs, 'utf8')
  scanned.push(rel)
  for (const re of SECRET_RES) if (re.test(text)) fail('secret-like-string', rel, String(re))
  for (const re of LOCAL_PATH_RES) if (re.test(text)) fail('local-absolute-path', rel, String(re))
}

// ── 3) package file allow-list (needs dist/manifest.json, produced by build) ──
let packageCheck = { checked: false }
if (withManifest) {
  try {
    const manifest = readJson('dist/manifest.json')
    const pkg = readJson('package.json')
    const always = new Set(['package.json', 'README.md', 'LICENSE-CORE', 'LICENSE-SDK', 'LICENSE-COMMERCIAL', 'NOTICE', 'CLA.md', 'LICENSES/cordis-MIT.txt', 'tools/fangctl.mjs'])
    const files = manifest.files.map((f) => String(f).replace(/^package\//, ''))
    const unexpected = []
    for (const rel of files) {
      const allowed = always.has(rel) || (pkg.files ?? []).some((pattern) => globMatch(rel, pattern))
      if (!allowed) unexpected.push(rel)
      if (/(^|\/)(dist|node_modules|test|\.git|\.env)(\/|$)/.test(rel) || /\.(log|tmp|bak|pem|key)$/i.test(rel)) unexpected.push(rel)
    }
    packageCheck = { checked: true, files: files.length, unexpected }
    for (const rel of new Set(unexpected)) fail('package-file-not-allowlisted', rel)
  } catch (e) {
    fail('manifest-missing', 'dist/manifest.json', String(e?.message ?? e))
    packageCheck = { checked: false, error: String(e?.message ?? e) }
  }
}

const ok = findings.length === 0
const report = {
  ok,
  at: new Date().toISOString(),
  routes: { count: routes.length, list: routes },
  scannedFiles: scanned.length,
  package: packageCheck,
  findings,
}
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'dist', 'allowlist.json'), JSON.stringify(report, null, 2) + '\n')
if (asJson) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`${ok ? 'PASS' : 'FAIL'}  allow-list self-check`)
  console.log(`      routes: ${routes.length} (all under \${prefix}/api/)`)
  console.log(`      scanned: ${scanned.length} files (secrets + local paths)`)
  if (packageCheck.checked) console.log(`      package: ${packageCheck.files} files allow-listed`)
  for (const f of findings) console.log(`      ${f.code}: ${f.file} ${f.detail}`)
}
process.exitCode = ok ? 0 : 1
