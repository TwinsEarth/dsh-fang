// SPDX-License-Identifier: AGPL-3.0-or-later
// dsh-Fang v3.0.3 — 客户端升级后的兼容性门禁（compat gate）。
//
// 触发时机：母体镜像（客户端版本）升级完成后。
// 目的：更新客户端版本后，默认不启用子插件；先验证
//   * 全部分子插件模块可导入且导出 apply（当前 16 个，后续增多自动纳入）；
//   * 内核入口可导入；
//   * 路由契约未破（数量 + 必需路径）；
// 通过 → 允许启用子插件并继续自动适配；失败 → 保持子插件关闭，
// 写入 compat-status.json，等开发者更新插件版本后再次检查。
//
// 纯逻辑 + 动态 import；测试可注入 importModule 与 routePaths。

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ensureDir, readJson, writeJsonAtomic } from '../kernel/index.mjs'

export const COMPAT_STATUS_FILE = 'compat-status.json'
export const COMPAT_KERNEL_ENTRY = 'src/kernel/index.mjs'
export const COMPAT_PLUGIN_DIR = 'src/plugins'
export const COMPAT_EXCLUDED_PLUGINS = Object.freeze(['imports.mjs'])
/** 路由契约：客户端升级后仍必须存在的核心路由（诊断/升级/镜像）。 */
export const REQUIRED_ROUTE_PATHS = Object.freeze([
  '/fang/api/status',
  '/fang/api/auth-token',
  '/fang/api/mirror/status',
  '/fang/api/mirror/upgrade',
  '/fang/api/mirror/recompute-status',
  '/fang/api/compat',
  '/fang/api/essence/list',
  '/fang/api/upgrade/status',
  '/fang/api/tasks/branches',
  '/fang/api/reflow/policy',
])
export const DEFAULT_EXPECTED_ROUTE_COUNT = 67

/**
 * 列出需要做导入检查的插件模块文件（排序稳定）。
 * @param {string} rootDir 仓库/安装根目录
 * @returns {string[]} 相对 rootDir 的路径
 */
export function listCompatModules(rootDir) {
  const dir = path.join(rootDir, COMPAT_PLUGIN_DIR)
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs') && !COMPAT_EXCLUDED_PLUGINS.includes(entry.name))
    .map(entry => entry.name)
    .sort()
  return files.map(file => `${COMPAT_PLUGIN_DIR}/${file}`)
}

/**
 * 运行兼容性门禁。
 * @param {{rootDir: string, expectedRouteCount?: number, routePaths?: string[],
 *   requiredRoutes?: string[], importModule?: (url: string) => Promise<any>}} options
 * @returns {Promise<{ok:boolean, checkedAt:number, moduleCount:number, routeCount:number,
 *   expectedRouteCount:number, findings:Array<{code:string, severity:'error'|'warning', message:string}>}>}
 */
export async function runCompatGate(options) {
  const rootDir = String(options?.rootDir ?? '')
  if (rootDir.length === 0) throw new Error('runCompatGate: rootDir required')
  const importModule = typeof options?.importModule === 'function'
    ? options.importModule
    : (url) => import(url)
  const expectedRouteCount = Math.max(0, Math.floor(Number(options?.expectedRouteCount) || DEFAULT_EXPECTED_ROUTE_COUNT))
  const requiredRoutes = Array.isArray(options?.requiredRoutes) ? options.requiredRoutes : [...REQUIRED_ROUTE_PATHS]
  const routePaths = Array.isArray(options?.routePaths) ? options.routePaths : null
  /** @type {Array<{code:string, severity:'error'|'warning', message:string}>} */
  const findings = []

  // 1) 内核入口可导入
  try {
    await importModule(pathToFileURL(path.join(rootDir, COMPAT_KERNEL_ENTRY)).href)
  } catch (error) {
    findings.push({ code: 'kernel-import-failed', severity: 'error', message: `内核入口导入失败：${errorText(error)}` })
  }

  // 2) 每个子插件可导入且导出 apply（模块数量即“当前 16 个后续更多”）
  let moduleCount = 0
  let moduleFiles = []
  try {
    moduleFiles = listCompatModules(rootDir)
  } catch (error) {
    findings.push({ code: 'plugin-dir-unreadable', severity: 'error', message: `插件目录不可读：${errorText(error)}` })
  }
  for (const relative of moduleFiles) {
    try {
      const mod = await importModule(pathToFileURL(path.join(rootDir, relative)).href)
      moduleCount += 1
      if (typeof mod?.apply !== 'function') {
        findings.push({ code: 'plugin-apply-missing', severity: 'error', message: `${relative} 未导出 apply()` })
      }
      if (typeof mod?.name !== 'string' || mod.name.length === 0) {
        findings.push({ code: 'plugin-name-missing', severity: 'warning', message: `${relative} 未导出 name` })
      }
    } catch (error) {
      findings.push({ code: 'plugin-import-failed', severity: 'error', message: `${relative} 导入失败：${errorText(error)}` })
    }
  }

  // 3) 路由契约：数量 + 必需路径
  const routeCount = routePaths === null ? expectedRouteCount : routePaths.length
  if (routePaths !== null && routeCount !== expectedRouteCount) {
    findings.push({
      code: 'route-count-mismatch', severity: 'error',
      message: `路由数量 ${routeCount} != 期望 ${expectedRouteCount}`,
    })
  }
  if (routePaths !== null) {
    for (const required of requiredRoutes) {
      if (!routePaths.includes(required)) {
        findings.push({ code: 'route-missing', severity: 'error', message: `缺少必需路由 ${required}` })
      }
    }
  }

  const ok = !findings.some(finding => finding.severity === 'error')
  return {
    ok,
    checkedAt: Date.now(),
    moduleCount,
    routeCount,
    expectedRouteCount,
    findings,
  }
}

/** 把门禁结果落盘；`subPluginsEnabled` 是唯一允许启用子插件的判据。 */
export function writeCompatStatus(stateDir, status) {
  ensureDir(stateDir)
  const payload = {
    ok: status?.ok === true,
    subPluginsEnabled: status?.ok === true,
    checkedAt: Number(status?.checkedAt) || Date.now(),
    moduleCount: Number(status?.moduleCount) || 0,
    routeCount: Number(status?.routeCount) || 0,
    expectedRouteCount: Number(status?.expectedRouteCount) || DEFAULT_EXPECTED_ROUTE_COUNT,
    findings: Array.isArray(status?.findings) ? status.findings : [],
  }
  writeJsonAtomic(path.join(stateDir, COMPAT_STATUS_FILE), payload)
  return payload
}

/** 读取门禁状态；从未检查过时返回 subPluginsEnabled=false（安全默认）。 */
export function readCompatStatus(stateDir) {
  const raw = readJson(path.join(stateDir, COMPAT_STATUS_FILE), null)
  if (raw === null || typeof raw !== 'object') {
    return {
      ok: false, subPluginsEnabled: false, checkedAt: null,
      moduleCount: 0, routeCount: 0, expectedRouteCount: DEFAULT_EXPECTED_ROUTE_COUNT,
      findings: [], reason: 'not-checked',
    }
  }
  return { ...raw, subPluginsEnabled: raw.subPluginsEnabled === true }
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error)
}

export const _internals = Object.freeze({ errorText })
