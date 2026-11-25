# 审计报告 · dsh-Fang v2.9.0（瓮城面板「母体连接」）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z` 每一位 0–9；`2.8.4` 已满位，本次进位到 **v2.9.0**。

## 1. 本次交付

| 交付物 | 内容 |
|---|---|
| `src/lib/mother-link.mjs` | 母体连接纯逻辑：地址归一化（只接受 http(s) origin，拒绝凭据/查询串/非 http）、描述生成、profile 共享配置摘要（读 `dsh.profile.bundles`，失败降级为 null）、只读探测（GET `/api/status`，超时夹在 [200,10000]ms，任何失败结构化返回、不抛） |
| `src/plugins/orchestrator.mjs` | 新增 `SERVICE.link='fangLink'` 服务（`describe()` / `probe()`）与两条母体路由（见下） |
| `src/kernel/types.mjs` | `SERVICE.link`、`AUDIT.LINK_PROBE='link-probe'` |
| `client.js` | 顶栏「母体连接」卡片：母体版本 / 母体 API / 分身 Adapter / 共享配置摘要 / 令牌策略 + 地址输入 + 复制地址 + 测试连通（只读）+ 关闭；分身 Web UI 的 `ForkHostNotice` 增加分身旁路模式（地址与结果仅本次会话内存态，不落盘） |
| 文档 | `CONTRACTS-V2.md §5.10`、`docs/UI-瓮城入口.md §9`、`CHANGELOG` |
| 测试 | `test/mother-link.test.mjs` 7 项 + `orchestrator.test.mjs` 路由清单/处理器断言 |

## 2. 路由与服务

```
GET  /fang/api/mother-link
POST /fang/api/mother-link/probe   { target, timeoutMs? }
SERVICE.link = 'fangLink' -> { describe(), probe({target, timeoutMs?}) }
```

探测目标只接受 http(s) origin；错误码：`target-empty` `target-invalid-url` `target-scheme`
`target-credentials` `target-query` `target-too-long` `status-http-error` `timeout` `network-error`
`fetch-unavailable`。每次探测写一条 `AUDIT.LINK_PROBE`。

## 3. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.9.0** |
| 测试 | **513 pass / 0 fail / 1 skip**（新增 7 项 mother-link） |
| e2e | **58/58** |
| allow-list | **38 路由 / 0 findings**（174 文件 secret+本地路径扫描；74 包文件 allow-list） |
| 构建 | `dist/dsh-fang-2.9.0.tgz`（290,333 B / 91 entries / sha256 `d50bf3a70ab517b0891657923e82ab548596988a9fdb34742fc903993bfb5931`） |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.9.0`（16 模块） |

## 4. 边界与语义

- **只描述、不持有**：令牌由 Forker 在 spawn 时注入，fang 不落盘、不回显；描述里不含 `Bearer`/token 值（测试断言）。
- **只读探测**：一次 GET，不写任何配置；失败不抛异常，返回结构化错误与可读原因。
- **共享配置语义**：`sharedConfig` 读取母体 profile 的 `dsh.profile.bundles`（只读摘要）；分身只读继承，
  不提供写入入口。
- **分身不保存插件设置**（既有设计）：分身旁路卡片的地址/结果只保留在本次会话内存里，刷新即失。
- **跨源限制**：分身直接读母体 `/fang/api/status` 受浏览器 CORS 约束；失败时展示 `cross-origin-or-network`，
  不伪造成连通（引导回母体窗口查看）。

## 5. 已知缺口

- 分身 Web UI 的端到端跨源探测依赖母体宿主的 CORS 配置；本版本不提供代理转发（刻意：不新增暴露面）。
- `agent/inbox/spliced` 队列持久化恢复的客户端提示仍未接入（路线 B 的后续工作，不在本版本）。

## 6. 提交状态

- 分支：`feat/mother-link`（stacked 在 `feat/release-mirror` 之上）；
- 发布物：`dist/dsh-fang-2.9.0.tgz` + manifest/preflight/allowlist；
- npm/GitHub Release 未执行；未合并 main。
