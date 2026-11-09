// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// mirror-official-source — 最小可用的「官方源 adapter」（manifest 协议 v1）。
//
// 协议：
//   GET  <baseUrl>/manifest.json
//   {
//     "version": "3.2.0",
//     "files": {
//       "package.json": "{\"name\":\"dsh-profile\"}",
//       "cordis.patch.yml": "insert: []\n"
//     }
//   }
//   download(version, staging)：校验 version 后把 files 写到 staging（防路径逃逸）。
//
// 远程必须 HTTPS（loopback 允许 http）。MirrorManager 现在会 await
// getLatestVersion()/download()，因此 adapter 可以是 async。

function isLoopbackHost(hostname) {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(String(hostname))
}

export function validateOfficialSourceUrl(baseUrl) {
  let endpoint = null
  try { endpoint = new URL(String(baseUrl ?? '').trim()) } catch { return { ok: false, reason: 'base-url-required' } }
  if (!/^https?:$/.test(endpoint.protocol)) return { ok: false, reason: 'base-url-required' }
  if (endpoint.username || endpoint.password) return { ok: false, reason: 'base-url-userinfo-forbidden' }
  if (!isLoopbackHost(endpoint.hostname) && endpoint.protocol !== 'https:') return { ok: false, reason: 'https-required-for-remote-endpoint' }
  return { ok: true, url: endpoint.toString().replace(/\/+$/, '') }
}

/** 只允许 staging 内的相对路径；拒绝绝对路径、`..`、NUL。 */
export function safeRelativePath(relative) {
  const raw = String(relative ?? '')
  if (!raw || raw.includes('\0')) return null
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) return null
  const parts = raw.replace(/\\/g, '/').split('/')
  if (parts.some((part) => part === '..')) return null
  if (parts.some((part) => part === '')) return null
  return parts.join('/')
}

export function createManifestOfficialSource({ baseUrl, fetchImpl = globalThis.fetch, headers = {}, token = '' } = {}) {
  const checked = validateOfficialSourceUrl(baseUrl)
  if (!checked.ok) throw new Error(`official source: ${checked.reason}`)
  if (typeof fetchImpl !== 'function') throw new TypeError('official source: fetchImpl required')
  const manifestUrl = `${checked.url}/manifest.json`

  async function fetchManifest() {
    const auth = token ? { authorization: `Bearer ${token}` } : {}
    const response = await fetchImpl(manifestUrl, { headers: { accept: 'application/json', ...auth, ...headers }, redirect: 'error' })
    if (!response.ok) throw new Error(`official source manifest: http-${response.status}`)
    const text = await response.text()
    let manifest = null
    try { manifest = JSON.parse(text) } catch { throw new Error('official source manifest: bad-json') }
    const version = String(manifest?.version ?? '').trim()
    if (!version) throw new Error('official source manifest: version-required')
    const files = manifest?.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files) ? manifest.files : null
    if (!files) throw new Error('official source manifest: files-required')
    return { version, files }
  }

  return {
    baseUrl: checked.url,
    async getLatestVersion() {
      return (await fetchManifest()).version
    },
    async download(version, stagingDir) {
      const manifest = await fetchManifest()
      if (manifest.version !== String(version)) {
        throw new Error(`official source version mismatch: manifest=${manifest.version} requested=${version}`)
      }
      const root = String(stagingDir ?? '')
      if (!root) throw new Error('official source download: staging required')
      const fs = await import('node:fs')
      const path = await import('node:path')
      fs.mkdirSync(root, { recursive: true })
      const rootResolved = path.resolve(root)
      for (const [relative, content] of Object.entries(manifest.files)) {
        const safe = safeRelativePath(relative)
        if (!safe) throw new Error(`official source download: unsafe path ${relative}`)
        const target = path.resolve(rootResolved, safe)
        if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
          throw new Error(`official source download: path escape ${relative}`)
        }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, String(content ?? ''), 'utf8')
      }
      return { version: manifest.version, files: Object.keys(manifest.files).length }
    },
  }
}
