# v3.8.13 审计

**日期**：2026-11-25  
**审计对象**：v3.8.12 → v3.8.13（maxForks 硬拒、fork Commit 4 GB 余量、sidecar 当刻 PID、页面文件 advisory）

## 一、代码证据

### maxForks

- `src/plugins/orchestrator.mjs`：
  - `export const HARD_MAX_FORKS = 1`
  - `maxForks: z.number().min(1).max(HARD_MAX_FORKS).default(HARD_MAX_FORKS)`
  - `allowMultiFork` 仅兼容；`apply()` 中检测到 `maxForks>1` 或 `allowMultiFork=true` 时强制 `cfg.maxForks=1`、`cfg.allowMultiFork=false`。
  - `effectiveMaxForks()` 生产路径返回 1；`createTask()` 在 `running >= maxForks` 时返回 `quota-exceeded`。
  - 测试钩子 `__testOnlyAllowMultiFork` 只在 `NODE_TEST_CONTEXT` 下生效。

### Commit 预算

- `src/lib/commit-budget.mjs`：
  - `FORK_COMMIT_SHARE_DEFAULT = 0.4`
  - `HOST_COMMIT_RESERVE_MB_DEFAULT = 4096`
  - `resolveForkCommitBudget({commitLimitMB, share, reserveMB})` 返回 `limitMB = min(shareLimitMB, reserveLimitMB)`；`limitMB<=0` 时 `ok=false`。
  - `evaluateForkCommitBudget()` 返回 `over` / `remainingMB`。
- `src/plugins/orchestrator.mjs`：
  - 配置 `forkCommitHostReserveMB` 默认 4096。
  - `currentForkCommitMB(rows)` 统一 fork + managed browser 进程树。
  - `enforceForkCommitBudget()` 用于 `create-fork`（fail-closed）、`host-watchdog-5s`、memory watchdog；失败调用 `hostEmergency('fork-commit-share')`。
  - `lastHostMetrics` 暴露有效预算字段。

### sidecar PID

- `createTask`、`restoreTask`、`autostartForks` 的 spawn 成功分支均写：
  - `task.pidStartedAt = nowMs()`
  - `task.pidStartedAtSource = 'spawn-provisional'`
- `captureTaskProcessIdentity()`：
  - 不再在开头把 `pidStartedAt` 置 null；
  - CIM 成功且 `createdAt` 有效时覆盖为 `source='cim'`；
  - CIM 失败/无 `createdAt` 时保留 provisional 时间戳；
  - `pidIdentity` 保留 `provisionalStartedAt` / `provisionalSource`。
- autostart 分支补 `writeWatchdog()`。

### 页面文件语义

- `decidePagefileBootPolicy()` 永远返回 `safeMode:false`；只返回 `advisory:'pagefile-missing'`、`lowFree`、`freeMB`。
- `evaluateSafeModeReset()` 删除 `pagefile-missing` 硬失败；只保留 `memory-probe-unavailable` 与 `commit-low`。
- `evaluatePagefileSingleFork()` 对 `activeForks>=1` 也返回 `ok:true`，仅标记 advisory。
- `memoryMinFreeMB` 默认 3000。
- `client.js` Safe Mode 弹窗：pagefile 缺失提示改为黄色 advisory；`canConfirm` 不再包含 `pagefileMissing !== true`；确认函数不再因 pagefile 直接 return。

## 二、测试证据

- `node --test test/commit-budget-v3813.test.mjs`：7 pass / 0 fail。
- `node --test test/orchestrator.test.mjs`：74 pass / 0 fail。
- `node --test test/v388-redlines.test.mjs`：10 pass / 0 fail。
- `node --test test/v385-closures.test.mjs test/memory-watch-sampling.test.mjs test/job-object.test.mjs`：12 pass / 0 fail。
- `node --test test/pagefile-safety.test.mjs test/v387-crash-prevention.test.mjs test/v386-crash-closures.test.mjs test/client-safe-mode.test.mjs`：全部通过。
- 全量：1579 tests / 1556 pass / 0 fail / 13 skipped / 10 todo（2026-11-25 复跑）。

## 三、发布门禁

- 构建命令：`node tools/release/build.mjs --skip-preflight`。
- `dist/manifest.json` 的 `preflight` 必须是 `{ green:false, skipped:true, reason:'--skip-preflight', at:... }`，不得复用旧 `dist/preflight.json`。
- 本版没有真实 Windows 宿主 preflight/e2e；Release 不得写“preflight GREEN”。

## 四、未闭环 / 风险

1. **真实 Windows DSH 宿主 E2E 未跑**：健康预检、单 app 窗口、崩溃闩锁只有单测/静态覆盖。需要真实 Windows 自托管 runner 跑 `/fang/adapter/flush-session` 3s 落盘与 `browser-health.jsonl` 采样。
2. **native helper 已重编但未 Windows 真机验证**：v3.8.5–v3.8.9 tarball 是 28KB/24KB 旧 helper；v3.8.10–v3.8.13 tarball 是 82KB/54KB 新 helper（PE 时间 2026-11-25 19:28）。C 源码含 Job/进程内存上限，但未在 Windows 真机启动验证，不能宣称 Job 内存上限或 kill-on-close 已生效。
3. **browser Job Object 无真机启动测试**：仅 macOS 上 helper 缺失 fail-closed 与静态/纯函数测试。
4. **lastHostMetrics 滞后**：最多 15 秒；硬杀 JSONL 是最后一次 heartbeat 快照。
5. **host-crashes.json 只保留 10 分钟**：更早历史只在 JSONL。
6. **allTasks 跳过 ARCHIVED**：归档任务不会被重新标记。
7. **allowMultiFork 已失效**：没有 UI/HTTP confirm 参数，也不需要；兼容字段不会改变上限。
8. **进程优先级**：主要 `BelowNormal`，`Idle` 未做成可配置档位。

## 五、最终全量（构建前）

- 命令：`npm test`
- 结果：1579 tests / 1556 pass / 0 fail / 13 skipped / 10 todo。
- 这不是“全绿发布门禁”；仅表示代码测试通过，Windows E2E 与 preflight 仍未闭环。
