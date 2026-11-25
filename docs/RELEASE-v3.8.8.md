# v3.8.8 发布记录（三条红线：Job Object / 聚合 commit 分级 / Panic 崩溃循环）

日期：2026-11-25
基线：v3.8.7
工作副本：`/Users/fang/Doubao/chats/2026-11-24/new-chat-7/fang-dsh-plugin`
状态：**源码与本地测试完成；未 commit / push / tag / publish。** 本地 DSH 安装仍为 3.8.2。

## 版本一致

| 项 | 值 |
|---|---|
| `package.json` / `package-lock.json` | 3.8.8 |
| `src/kernel/types.mjs` `FANG_VERSION` | 3.8.8 |
| README / CHANGELOG / RELEASES | 已更新到 3.8.8 |
| 发布记录 / 审计 | `docs/RELEASE-v3.8.8.md` / `docs/AUDIT-v3.8.8.md` |

## 三条红线

### 1. Windows Job Object 启动器

| 子项 | 落点 |
|---|---|
| browser 优先 | `browser-guard.mjs` 新增 `jobObject`；Windows 下先启动 `fang-job-host.exe`，helper 建 Job + `KILL_ON_JOB_CLOSE`，再启动 Chromium；返回 `helperPid` / `jobObject` |
| fork 随后 | forker 原 Job 启动链保留；`jobObject=true` 默认 |
| fail-closed | helper 缺失/启动失败/ready 超时：`job-object-unavailable` / `job-object-launch-failed`，不退化裸 spawn |
| 宿主强杀/冻结 | helper 读 `hostHeartbeatFile`；超时 `TerminateJobObject`；helper 自身退出则 Job 句柄关闭，内核回收子树 |
| 内存上限 | helper 参数 `--job-process-memory-mb` / `--job-memory-mb`；源码设 `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`（二进制待 Windows 重编） |

### 2. 聚合 commit 分级

| 阈值 | 行为 |
|---|---|
| 30%（`forkCommitWarnShare`） | `fork-commit-share-warning` 审计，60 秒节流 |
| 35%（`forkCommitSevereShare`） | `fork-commit-share-severe` 审计，60 秒节流 |
| 40%（`forkCommitShareLimit`） | `hostEmergency('fork-commit-share',{safe:true})` |
| CommitFree <8192MB | `host-memory-warning` |
| CommitFree <4096MB | `host-memory-severe`（只审计/告警，不再全停） |
| CommitFree <2048MB | `hostEmergency('commit-free-emergency',{safe:true})` |

- `hostMetrics` 采集 `forkCommitMB`、`browserCommitMB`、`totalCommitMB`、`forkShare`、`processCount`、`selfRssMB`、`selfPrivateMB`。
- 母体 RSS/Private 来自 PowerShell `Get-Process -Id <Node PID>` 的 `WorkingSet64` / `PrivateMemorySize64`。
- `/fang/api/status` 返回 `hostMetrics` 与 `forkCommitPolicy`。

### 3. Panic 路由与崩溃循环

- `POST /fang/api/panic` 已注册；成功 200 `{ok:true,mode:'panic'}`，失败 409。
- `service.panic()` 使用 `allTasks:true`，隔离所有非 ARCHIVED 任务并进入 safe mode。
- **安装令牌 bootstrap 宿主属主准入**：`GET /fang/api/auth-token` 在回环 + 同源之后，新增 TCP 对端进程属主校验（Windows `GetOwner` / macOS `lsof` UID / Linux `/proc` UID）；映射失败或属主不同一律 403 `not-host-owner`，不退回“仅回环”。
- `host-crashes.json` 只留 10 分钟 `recent`；完整历史写 `host-crashes.jsonl`，含 commit/RSS/Private/fork/browser/processCount。
- 10 分钟 2 次崩溃进入 `crash-loop-10m`；`host-state.json` 每 15 秒 heartbeat 写 `lastMetrics`，clean 退出不被回写为 unclean。

### 4. maxForks 与 sidecar

- `maxForks=1` 默认；`allowMultiFork=false` 时 `effectiveMaxForks()` 强制 1，不能只改 `maxForks` 绕过。
- `createTask` 每 200ms 轮询 `f.status`；spawn 后立即同步 `task.pid/port`、meta、persist、watchdog、优先级。
- forker spawn 后立即写 `fork-meta` PID；`writeWatchdog` 接受任何非 ARCHIVED 且 `pid>0` 的 fork。

## 测试

```bash
node --test test/v388-redlines.test.mjs
node --test test/job-object.test.mjs test/host-housekeeping.test.mjs \
  test/host-housekeeping-wiring.test.mjs
node --test test/kernel.test.mjs test/plugins-shape.test.mjs \
  test/role-extensions.test.mjs test/memory-policy-wiring.test.mjs
npm test
```

- 定向：v3.8.8 **10/10**；peer-owner **6/6**；Job/host housekeeping **10/10**；版本/主门禁/policy wiring **34/34**。
- 真机：Windows HSD（Node 宿主 + curl 对端）`verifyPeerOwner` 返回 `ok:true`，peerPid 为 curl；macOS 独立 curl 对端同样 `ok:true`。
- 全量：**1542 tests / 1519 pass / 0 fail / 13 skipped / 10 todo**（183.3s）。

## 构建

- `dist/dsh-fang-3.8.8.tgz`：890,114 bytes，228 entries
- `dist/dsh-fang-3.8.8.tgz.sha256`：`4f58bbb5fdf05e08dfc762300de4c8c5c2a9fa7f098c4403e70a4bb2d5ee514c`
- `dist/manifest.json`：version 3.8.8；构建使用 `--skip-preflight`（本机 macOS 无真实 DSH 母体），包内 `package smoke / crash-safety / allow-list / main-city gate` 四项均 PASS

## 已知边界

- `native/win32/fang-job-host*.exe` 仍是旧二进制；Job 内存上限需 Windows CI/真机重编后生效。kill-on-close 仍由旧 helper 提供。
- browser Job Object 无 Windows 真机启动测试；只有 helper 缺失 fail-closed 与静态/纯函数测试。
- 主机属主准入只能证明“同 OS 用户”，不能隔离同一用户下的恶意进程；同用户进程本来就可读 0600 token 文件。
- `lastHostMetrics` 最多滞后 15 秒；硬杀时 JSONL 为最后一次 heartbeat 快照。
- `host-crashes.json` 超过 10 分钟的记录只在 JSONL。
- 真实 Windows DSH 宿主的 `/fang/adapter/flush-session`、`browser-health.jsonl` 真机采样仍未端到端验证。
- V3.8.4 日志中的 `/fang/api/decisions/ai Failed to fetch` 不能仅凭日志断定为路由缺失；需目标机确认宿主/端口可达性。
