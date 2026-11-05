# 审计报告 · dsh-Fang v2.6.8（Adapter 命令入口扩展）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 8 个补丁位（`2.6.7` → `2.6.8`）。

## 1. 范围

Adapter 侧的 `POST ${prefix}/adapter/commands` 是母体 `ForkClient` 的对偶。本仓库在
v2.6.1（Adapter v3）/ v2.6.3（CommandCache.run）已实现：路由、Bearer、入参校验、幂等、
同步/异步分派、`command-done` SSE、cursor/session 语义。v2.6.8 补齐扩展面：

1. **`adapter.registerCommand(op, executor)`**：外部插件注册命令；
   - executor 拿到 `{ commandId, trackingId, emit, logger }`；
   - 返回值决定同步/异步：普通对象 → 200；`{status:'completed',result}` → 200；
     `{status:'rejected',code,message}` → 失败信封；`{status:'accepted',trackingId}` → **202**，
     executor 自行异步执行并 `emit command-done`；
   - `trackingId` 缺省 = `track_<commandId>`（同一 commandId 重试稳定）；
   - 内置 op 不可覆盖；disposer 后回到 `unknown-op`；
   - 仍由 `CommandCache.run(commandId, …)` 包裹：accepted 也缓存，重试不会重复执行。
2. **body 超限 413**：`/adapter/commands`、`/adapter/command` 请求体超过 1 MB 时，
   由 400 `bad-request` 改为 **413 `body-too-large`**（`ADAPTER_ERROR_STATUS`），executor 不被调用。
3. 文档：`docs/ADAPTER-COMMANDS.md`（设计稿组件 → 仓库实现映射、HTTP 状态表、
   SSE cursor/session 语义、注册示例、为什么复用 DSH webServer 而非独立端口、边界）。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.8** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **388 pass / 0 fail / 1 skip（389 项，14.0s）** |
| e2e 实机验收 | 同上 | **45/45（11.3s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、134 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.8.tgz`（**244,138 B，85 entries**）<br>sha256 `80804d93f1ff684cafb046458488aa06a79913d35661fed7b5fa645e0bc2e02b` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.8`（15 个模块可 import） |

测试计数：385（v2.6.7）+ 4 = **389 项**（388 pass / 1 skip），与 preflight 输出一致。

## 3. 新增测试（`test/adapter.test.mjs`，36 项）

1. `registerCommand` 同步命令：200 + commandId 幂等 + disposer 后 `unknown-op`；
2. `registerCommand` 异步命令：202 + EventLog 中 `command-done`（trackingId/结果同构）+
   重试同一 commandId 返回同一 trackingId 且不重复执行；
3. `registerCommand` 拒绝覆盖内置 op；`{status:'rejected'}` 映射为失败信封；
4. 请求体超过 1 MB → 413 `body-too-large`，executor 不被调用。

## 4. 与设计稿的差异（诚实记录）

| 设计稿 | 本仓库落地 |
|---|---|
| `CommandHttpHandler` / `CommandHandler` / `EventLog` / `AdapterServer` 独立文件 | 已存在于 `src/plugins/adapter.mjs` + `src/lib/adapter-protocol.mjs`；v2.6.8 在 adapter 内加注册表，未拆文件 |
| 独立端口 AdapterServer（Forker 分配第二个端口） | 复用 DSH `webServer.register({path,handler})`（e2e 已验证）；独立端口仅作为回退，未实现（避免端口池翻倍） |
| 异步命令按 kind 白名单（load-plugin/stop） | 通用 `async:true` 标志用于内置 op；外部注册命令由 executor 返回值决定，二者并存 |
| `CommandCache` 缓存 accepted + 稳定 trackingId | 一致：`CommandCache.run` 缓存 accepted；trackingId 由 executor 提供或默认 `track_<commandId>` |
| `CommandResult {status:'completed'|'accepted'|'rejected'}` | 兼容该形状：completed/rejected 归一化为 v3 信封；accepted 直接 202 |

## 5. 边界

- accepted 之后进程崩溃：`command-done` 永远不会到达；母体 `ForkClient` 的 asyncTimeout 兜底；
  Adapter 侧无法补偿（进程已不存在）。
- 最终结果不写回 CommandCache：只走 EventLog（cursor 补发保证断线续传）；重放 accepted
  不会重复执行异步任务。
- 1 MB body 上限为硬编码；超限 413，不进入 executor。
- 外部注册命令不经过内置 op 的协议校验（executor 自行校验 payload）；文档已注明。

## 6. 提交状态

- 分支：`feat/adapter-command-registry`（stacked 在 PR #16 的 `feat/task-handle` 之上）；
- 发布物：`dist/dsh-fang-2.6.8.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
