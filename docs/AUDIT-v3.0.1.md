# 审计报告 · dsh-Fang v3.0.1（镜像状态条件 GET：ETag / If-None-Match）

> 证据来自本机真实输出（2026-11-02）。版本线：`v2.9.2 → v2.9.3 → v2.9.9 → v3.0.1`。

## 1. 交付范围

| 交付物 | 内容 |
|---|---|
| `src/lib/mirror-etag.mjs` | `computeMirrorStatusEtag`（稳定字段哈希，排除 `diskUsageBytes`）、`ifNoneMatchMatches`（多值 / `*` / `W/`）、`buildMirrorStatusResponse`（200 / 304） |
| `GET /fang/api/mirror/status` | 读 `If-None-Match`；未变化 → **304 空 body + ETag + Cache-Control**；变化 → 200 + 新 ETag + Content-Length |
| `client.js` | 镜像卡片轮询带 If-None-Match；304 保持现状并清错误；新增「刷新」按钮强制跳过 ETag；操作后强制刷新 |
| 测试 | `test/mirror-etag.test.mjs` 7 项 + orchestrator 路由 304 断言 |

## 2. ETag 语义（关键权衡）

- **排除 `diskUsageBytes`**：它是唯一每次请求必然漂移的字段（日志/临时文件），纳入则永远 304 不命中。
- 304 时客户端沿用上一次状态：磁盘占用可能滞后（≤ 轮询间隔）；用户点「刷新」走 force 路径取最新值。
- 其他低/中频字段（版本、`updateAvailable`、备份列表、`lastBackupAt`、活跃会话数）纳入 ETag：真实变化返回 200。
- 服务端不带 ETag 时客户端自动置空，后续不再发 If-None-Match（兼容旧服务端）。
- `Cache-Control: no-cache, must-revalidate` 与 ETag 配合，避免代理/浏览器启发式缓存绕过条件校验。

## 3. 门禁结果（v3.0.1）

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 3.0.1** |
| 测试 | **559 pass / 0 fail / 1 skip**（新增 7 项 ETag） |
| e2e | **58/58** |
| allow-list | **44 路由 / 0 findings** |
| 构建 | 见 `dist/dsh-fang-3.0.1.tgz` + manifest |
| 健康检查 | **HEALTHY** `@twinsearth/dsh-fang@3.0.1` |

## 4. 语义不变量（有测试）

- 相同稳定状态 → 相同 ETag；`diskUsageBytes` 变化不改变 ETag；
- 版本 / 备份增删 / 活跃会话数 / 备份间隔变化 → ETag 变化；
- `If-None-Match` 支持逗号多值、`*`、`W/` 前缀；
- 未匹配 → 200 + body + ETag + Content-Length 且 body 可反序列化为原状态；
- 匹配 → 304、body 为 null；orchestrator 路由实测 304 空 body。

## 5. 已知缺口

1. ETag 只用于 `/fang/api/mirror/status`；备份列表等操作没有条件化（操作本身即写）。
2. 客户端 304 时保留旧 `diskUsageBytes`，属刻意权衡（见 §2）。
3. 后续 `v3.0.9` 计划：Derived 派生（merged 复制 + ensureFresh + per-essence 互斥），`v3.1.0`：Onboarding/MirrorBootstrap 三盘初始化，`v3.1.1`：DSH client-half 插件包。

## 6. 提交状态

- 分支：`feat/etag-status`（stacked 在 `feat/mirror-settings` / v2.9.9 之上）
- 未合并 main；Release/tag 待 PR 合并后按版本线发布。
