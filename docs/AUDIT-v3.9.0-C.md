# C1–C6 收口记录（未发布）

- 日期：2026-11-26
- 依据：用户确认 `C：C1-C6 全同意`
- 状态：源码/测试/文档已改；**未提升版本、未构建、未打 tag、未发布 npm/GitHub**。v3.9.0 已发布包仍是调整前行为。

## C1 — `lastHostMetrics` 落盘 15s → 5s

- `src/plugins/orchestrator.mjs` 新增 `HOST_STATE_WRITE_INTERVAL_MS = 5000`，heartbeat 改为 `setInterval(writeHostHeartbeat, HOST_STATE_WRITE_INTERVAL_MS)`。
- 原来 `hostWatchdogTick` 每 5s 更新 `lastHostMetrics`，但 `host-state.json` 每 15s 才写一次；硬杀时最多回退 15s。现在最多回退一个 5s tick。
- 未改 `memoryWatchIntervalMs`（15s）和 watchdog 的 5s tick。

## C2 — `host-crashes.json` 窗口可配置

- 新增 Config `hostCrashWindowMinutes`：`1..1440`，默认 `10`。
- `recent` 过滤、`host-crashes.json.windowMinutes`、safe-mode 原因和 `safeModeStatus().windowMinutes` 全部使用同一变量。
- 默认仍生成 `crash-loop-10m`；自定义窗口生成 `crash-loop-<n>m`；`client.js` 的 `safeModeReasonText(reason, windowMinutes)` 解析该值并展示实际分钟数。
- 历史 `crash-loop-10m` 仍按 10 分钟显示。

## C3 — `allTasks` 不再跳过 `ARCHIVED`

- `hostEmergency` 的循环条件改为：`allTasks=false` 时才跳过 archived 或非 READY/RUNNING；`allTasks=true` 会扫描包括归档在内的全部任务。
- `quarantineTask(..., { preserveArchived:true })` 对归档任务只清浏览器/PID/token/URL 和 adapter，**保留 `ARCHIVED` 状态**；审计增加 `archivedSwept`。
- 启动恢复已隔离任务时也保留 archived，不会把归档任务降级成 `FAILED`。

## C4 — `allowMultiFork` UI/HTTP confirm

- 新增 `MULTI_FORK_CONFIRM_TOKEN = 'MULTI-FORK'`、`multiForkStatus()`、`confirmMultiFork()`。
- HTTP：`GET /fang/api/forks/multi-fork` 返回 `requested / enabled:false / hardLimit:1 / confirmRequired`；`POST` 需 `{confirm:true, token:'MULTI-FORK'}`，仅记录审计，仍返回 `enabled:false / hardLimit:1`。
- UI：分身看护卡片新增“多开二次确认（仍限 1）”按钮，`askConfirm` 需要键入 `MULTI-FORK`，确认后提示“不会开启第二个分身”。
- 硬限未动：生产路径 `allowMultiFork` 仍被强制为 false，第二次 create 仍返回 `quota-exceeded`。

## C5 — 进程优先级增加 Idle 档位

- `src/lib/browser-guard.mjs` 新增 `PROCESS_PRIORITY_CLASSES` / `normalizePriorityClass()`；`buildPriorityTreeScript(pid, priorityClass)`、root fallback、`lowerProcessPriority(pid, { priorityClass })` 均支持 `BelowNormal` 与 `Idle`。
- `src/plugins/orchestrator.mjs` 新增 Config `processPriority: below-normal | idle`，默认 `below-normal`；托管浏览器 launch 与三个 fork 启动/恢复点统一传 `priorityClass`。
- Idle 只显式配置时使用，避免默认把页面/分身饿死；status 暴露 `processPriority.mode/class`。

## C6 — `openMigrationReport` 定位与修

- 结论：这不是 DSH 客户端 API 不匹配。`openMigrationReport` 是 Fang `client.js` 自己的闭包函数，并在 `app` 对象中注册；3.8.3 的问题是 banner 通过 `app.openMigrationReport` 间接调用，遇到 `app` 表面缺方法时报 `TypeError`。
- 修法：`renderMigrationReportBanner` 的按钮改为直接调用本地 `openMigrationReport()`，不再依赖 `app` 方法；`app` 注册保留兼容性。
- 回归：`test/client-migration-report.test.mjs` 与 `test/client-safe-mode.test.mjs` 断言直接调用且不存在 `app.openMigrationReport()` 调用点。

## 验证

- 定向：`v390-c-items`、`browser-guard`、`client-migration-report`、`client-safe-mode`、`v3810-host-redline`、`job-object`、`v388-redlines`、`commit-budget-v3813`、`main-gate`：69 tests / 69 pass / 0 fail。
- 全量：1592 tests / 1569 pass / 0 fail / 13 skipped / 10 todo，`duration_ms=200149.77`。

## 边界

- 所有改动是**未发布工作树**；`v3.9.0` 发布包仍是 48 MB 单文件紧急线、旧的 10 分钟 crash 窗口和旧优先级实现。
- C4 的确认是“显式确认 + 审计”，不是多开能力；硬限 1 没有被绕过。
- C3 保留归档状态，避免 panic 把归档任务改成失败状态；如果后续需要改变归档语义，应单独设计。
