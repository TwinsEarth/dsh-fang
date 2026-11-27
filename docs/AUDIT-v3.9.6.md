# v3.9.6 审计记录

日期：2026-11-27。基线：v3.9.5（commit `dd34375` 的会话崩溃热修之后）。

## 1. 结论

- **P0 崩溃已闭合**：多帧 zstd 会话日志不再触发 `Unknown frame descriptor` / `ZSTD_error_prefix_unknown` 未捕获异常。
- **新阈值已落地**：单文件 200/300/500 MB；分身内合计 3000/3600/3900 MB；警告、二次确认、硬上限三级。
- **确认流程已贯通**：服务端 409 + `sessionPolicy`，客户端二次确认，硬上限不可绕过。
- **全量测试不是 GREEN**：与 v3.9.4/v3.9.5 相同的 orchestrator 临时夹具缺 bundle 问题仍在，不伪装为通过。

## 2. 崩溃根因证据

| 证据 | 结果 |
|---|---|
| `crash-2026-11-26T20-53-39-837Z-host.log` | `ZSTD_error_prefix_unknown` / `Unknown frame descriptor`，栈 `node:zlib:193` |
| `restart/runtime-crash.jsonl` | pid 10656、2076 两次同错误 |
| 旧 `countSessionEvents` 对“房主”3.1 MB 会话 | 只解 191 B / 1 事件，随后 `UNCAUGHT ZSTD_error_prefix_unknown` |
| DSH 会话格式 | `session.v4.jsonl.zstd` 为多帧 zstd 拼接；Node 流式解码只消费第一帧 |
| 新实现同一会话 | `ok:true`、`events:9553`、`bytes:17797140`、无未捕获异常 |

## 3. 阈值语义

| 范围 | 警告 | 二次确认 | 硬上限 |
|---|---:|---:|---:|
| 单文件 | `>200 MB` | `>300 MB` | `>500 MB` |
| 分身合计 | `>3000 MB` | `>3600 MB` | `>3900 MB` |

- 恰好 200 / 300 / 500 MB（合计 3000 / 3600 / 3900 MB）仍属于较低一档；“超过”才升级。
- 警告档：允许打开，返回 `sessionWarning`。
- 确认档：未带 `confirmLargeSession:true` 时 409 `fork-session-confirmation-required`；确认后放行。
- 硬上限：无论是否确认都 409 `fork-health-session-hard-limit`。

## 4. 代码检查点

- `src/lib/fork-health.mjs`
  - `FORK_HEALTH_DEFAULTS.maxSessionMB=500`、`warn/confirm=200/300`、`warn/confirm/hardTotal=3000/3600/3900`。
  - `MAX_COUNT_COMPRESSED_BYTES=256 MiB`；`maxEvents=1_000_000`；`maxUncompressedBytes=1 GiB`。
  - 多帧 zstd 按帧扫描，逐帧 `zstdDecompressSync`；警告/确认档 `scanSkipped:true`。
- `src/plugins/orchestrator.mjs`
  - schema 新增 `forkHealthWarnSessionMB` / `forkHealthConfirmSessionMB` / `forkHealthWarnTotalMB` / `forkHealthConfirmTotalMB` / `forkHealthHardTotalMB`。
  - `inspectTaskOpenHealth(task, {confirmLargeSession})` 传入全部阈值。
  - `POST /fang/api/tasks/open` 透传 `confirmLargeSession`，409 映射；成功体带 `sessionWarning` / `sessionPolicy`。
  - `browser-health.jsonl` 记录 `scanSkipped` / `policy`；确认待办写审计。
- `client.js`
  - `openTask(task, retryDepth, confirmLargeSession)`；确认弹窗；200 MB 警告；硬上限拒绝提示。

## 5. 测试

- `test/v386-crash-closures.test.mjs` + `test/v387-crash-prevention.test.mjs`：19/19 PASS（含多帧 zstd、200/300/500 MB、3000/3600/3900 MB、跳过事件计数）。
- `test/v386-crash-closures.test.mjs` 单独：10/10 PASS。
- `node --check`：`fork-health.mjs` / `orchestrator.mjs` / `client.js` 全部 PASS。
- 真机 fork 复验（打包后的 `dist/npm/package`，2026-11-27）：

| 分身 | 会话数 | 合计 | 最大 | 事件 | 结果 |
|---|---:|---:|---:|---:|---|
| 房主 `task_mwqenfnxpobe` | 2 | 2.98 MB | 2.97 MB | 9553 | ok |
| 2Xray `task_mwucxhevih6j` | 2 | 1.36 MB | 1.36 MB | 2113 | ok |
| 瓮城Plus `task_mwram4u9ylki` | 11 | 25.17 MB | 20.79 MB | 48931 | ok |
| W2M `task_mwqmo94y7lca` | 2 | 60.9 MB | 60.9 MB | 143549 | ok |
| IM2A `task_mwud2y1qbw95` | 1 | 25 MB | 25 MB | 52368 | ok |

- 旧 20 MB 口径下，瓮城Plus / W2M / IM2A 会直接 `session-too-large`；新口径全部通过。
- 全量 `node --test test/*.test.mjs`（最终执行）：1566 tests / 1513 pass / 30 fail / 13 skipped / 10 todo。
  - 30 条全部在 `orchestrator.test.mjs`，均为临时夹具 profile 缺真实 bundle → `fork-bundle-unavailable`；v3.9.4/v3.9.5 已记录为既有夹具问题。
  - 本版新增/修改的 health、threshold、client、版本与文档索引断言全部通过；没有新增失败。

## 6. 残余风险与未做

- `confirmLargeSession` 是请求体布尔值，不是一次性服务端 ticket；能访问本地 API 的调用方仍可显式确认。当前边界是“防误触，不防本机恶意调用”。
- 大会话只跳过事件计数，不修复会话本身；硬上限用户需自行归档/压缩。
- 本机 10 个会话头的 `cwd` 修复是运维数据修复，不在 npm 包内；新机器/新分身不继承该修复。
- 未新增阈值设置页 UI；阈值通过插件 schema 配置，需重启生效。
- 既有 orchestrator 夹具问题未在本版扩大范围修复。

## 7. 证据文件

- `E:\DBH\fang-report\test-396-full.log`
- `E:\DBH\fang-report\test-396-orchestrator.log`
- `E:\DBH\fang-report\build-396.log`
- `E:\DBH\fang-report\health-probe.mjs`
- `E:\DBH\fang-report\fix-dsh-fork-crash-20261127.md`
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-26T20-53-39-837Z-host.log`

