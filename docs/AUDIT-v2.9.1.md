# 审计报告 · dsh-Fang v2.9.1（桌面端母体连接默认地址修复）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z`；这是 v2.9 的补丁位。

## 1. 问题（v2.9.0 实测）

桌面端瓮城面板「母体连接」卡片默认地址为 `dsh-app://app`，点击「测试连通」返回：

```
不可达  原因: target-scheme
```

根因：桌面壳里 `window.location.origin` 是 Electron 注册的自定义协议 `dsh-app://app`，
而 `probeLink` 只接受 `http(s)` origin（这是正确约束——分身在另一个进程里无法访问
`dsh-app://`）。v2.9.0 客户端把 `window.location.origin` 直接当默认探测目标，导致默认值
必然失败。

## 2. 修复

| 位置 | 改动 |
|---|---|
| `client.js` `resolveMotherOrigin()` | 优先读 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`（desktop `apps/desktop/src/main.ts:790` 注入的 `new URL(hostUrl).origin`，即 Host 真实 HTTP 源，如 `http://127.0.0.1:52648`）；普通 Web 回退 `location.origin`；都不可用返回空串，交给用户手填 |
| `client.js` `describeProbeError()` | 错误码翻译为可操作原因：`target-scheme` 明确提示"桌面壳地址 dsh-app://app 不是可探测的 HTTP 源"，`target-empty`/`timeout`/`network-error`/`status-http-error`/`fetch-unavailable`/`target-credentials`/`target-query` 各有提示 |
| 服务端 | **无改动**：继续只接受 http(s) origin，拒绝 `dsh-app://`（安全不变） |

## 3. 门禁结果（v2.9.1）

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.9.1** |
| 测试 | **513 pass / 0 fail / 1 skip** |
| e2e | **58/58** |
| allow-list | **38 路由 / 0 findings**（174 文件扫描；74 包文件） |
| 构建 | `dist/dsh-fang-2.9.1.tgz`（291,046 B / 91 entries / sha256 `34070362811a48399b98d7fe41dfa9f47dcef77c85b9a37ebb8a0a3364ec1f2d`） |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.9.1`（16 模块） |

## 4. 生效方式（重要）

desktop profile 通过 `link:E:/GPT/dsh-fang` 直接加载仓库：客户端半是 `client.js`。
**刷新页面即可重新加载客户端模块**；若宿主缓存了模块图，重启桌面应用也可。
服务端代码（`src/plugins/orchestrator.mjs`）未变，无需重启宿主进程即可兼容。

## 5. 边界

- 修复只在客户端：若用户手动把地址改回 `dsh-app://…`，服务端仍会返回 `target-scheme`
  （正确行为，不会被静默接受）。
- 分身旁路（ForkHostNotice）的默认地址保持为空：分身 Web UI 自身是 `http://127.0.0.1:<forkPort>`，
  但"母体地址"必须由用户提供，不能自动推断。
- `__DSH_TRANSPORT__` 是 desktop 注入的全局对象；普通浏览器里不存在，回退路径已覆盖。

## 6. 提交状态

- 分支：`feat/mother-link-fix`（stacked 在 `feat/mother-link` / v2.9.0 之上）
- 发布物：`dist/dsh-fang-2.9.1.tgz` + manifest/preflight/allowlist
- 未合并 main；公共 Release/tag 与私有镜像同步留待本 PR 合并后执行
