# 审计报告 · dsh-Fang v2.6.7（TaskHandle）

> 证据全部来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 自检同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 7 个补丁位（`2.6.6` → `2.6.7`）。

## 1. 范围

在 Forker（进程层）与 ForkClient（传输/命令层）之上实现 `TaskHandle`，把：

1. **启动链**：fork 未运行 → `forker.spawn()`（可选 spawnOptions）；用 `forker.adapterToken()`
   建 ForkClient 并 connect；
2. **状态机**：`idle → starting → running → reconnecting → running`，
   `stop → stopping → stopped`，不可恢复时 `failed`；
3. **崩溃重建连接**：监听 `fang/fork-crashed` → reconnecting；等 `fang/fork-started`
   （事件优先 + `forker.status()` 轮询兜底）→ 用**新 url / 新 token** 重建 client；
4. **命令代理**：`command(op,payload)` + dsh-Fang 9 个便捷方法；重连窗口内最多等
   `commandWaitMs`（默认 5s），超时 fail-closed；
5. **生命周期**：`stop()`（保留 home）、`recycle()`（stop + reap）、`dispose()`（只释放本地资源）；
6. **事件聚合**：SSE 事件 + task 事件（status-changed/crashed/restarting/reconnected/failed）。

文档：`docs/TASK-HANDLE.md`（状态机、恢复流程、Forker 接口约定、TS 映射、测试清单、边界）。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.7** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **384 pass / 0 fail / 1 skip（385 项，32.2s）** |
| e2e 实机验收 | 同上 | **45/45（44.4s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、132 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.7.tgz`（**243,067 B，85 entries**）<br>sha256 `19ad1586a4da0857a63a978593831a8f0a6f87306a4443c0c97f84c17444071f` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.7`（15 个模块可 import） |

## 3. 新增测试（17 项，`test/task-handle.test.mjs`）

start（spawn + token + connect）/ 已运行不重复 spawn / spawn 失败 / token 缺失 / connect 失败 /
start 幂等 / 崩溃后新端口新 token 重连 + 等待命令恢复 / 重启超时 failed / stop 幂等 /
stop 时命令 reject task-stopping / recycle（stop+reap）/ SSE 断开不改变状态 /
client onReconnect 转发 / 事件聚合隔离 / 命令代理 op payload 透传 / 未启动或已停止 fail-closed /
dispose 不杀 fork。

测试计数：368（v2.6.6）+ 17 = **385 项**（384 pass / 1 skip），与 preflight 输出一致。

## 4. 与设计稿的差异（诚实记录）

| 设计稿 | 本仓库落地 |
|---|---|
| `Forker.fork(opts)` 返回 `ForkHandle` | `forker.spawn({ forkId, ...spawnOptions })`；home 需先 `provision` |
| `Forker.kill` / `recycle` | `forker.stop` / `forker.reap` |
| `TokenRegistry` + token 落 ForkMeta | Forker 每次 spawn 用 `randomBytes(24)` 生成 token，只存内存；`adapterToken(taskId)` 读取；不落 meta.json/forks.json |
| `loadPlugin/unloadPlugin/...` | dsh-Fang 的 9 个 `ADAPTER_OP`（ping/status/flush-buffer/score-plugin/read-plugin/route-confirm/approvals/approval-decide/archive） |
| `ForkClientImpl` | `src/lib/fork-client.mjs` 的 `ForkClient` |

## 5. 风险 / 边界

1. **未接线 Orchestrator**：orchestrator 仍自行管理 tasks/fork；TaskHandle 是可独立使用的库，
   下一步迁移 createTask/archive/命令调用。
2. **Forker 自动重启默认关闭**（`supervise:false`）：崩溃后若无人重启，TaskHandle 在
   `restartTimeoutMs` 后进入 failed；需要自动恢复须显式开启 supervise 并处理 archive/reap 竞争。
3. **命令不缓冲**：重连窗口内等待有限时间后 reject；不排队到恢复后执行（避免副作用时序问题）。
4. **同 taskId 多实例无锁**：同一实例内 start/stop 幂等；跨实例并发不在保护范围。
5. **dispose 不杀 fork**：宿主卸载时由上层决定是否 stop；只释放订阅与 client。
6. **token 安全**：只在 Forker 内存与子进程 env 中；不落盘、不进 URL。

## 6. 提交状态

- 分支：`feat/task-handle`（stacked 在 PR #15 的 `feat/fork-ui-mode` 之上）；
- 发布物：`dist/dsh-fang-2.6.7.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
