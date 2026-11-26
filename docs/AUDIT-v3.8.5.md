# v3.8.5 审计（2026-11-25）

> 基线 v3.8.4。本版按用户指令只做“能闭环”的子集，不把 v3.8.0 十项审计表说成“全部完成”。

## 一、范围判定

- 本版做：CDP 采样 15s、母体面板按 active task 懒渲染、统一客户端缓存上限、`pauseHiddenTab` 实验开关、Job Object 内存上限源码/参数。
- 本版不做：官方 DSH Web client 的 session 事件全量渲染改造；`session-bridge` 只有 `limit`，不是分页/懒加载。
- 结论不变：v3.8.0 只解决了“浏览器可监控、可杀、可隔离”和宿主熔断，没有解决官方 Web client 的事件内存本身；4 万条 session 的页面仍可能把 renderer 撑爆，只是现在能在爆之前关掉它。

## 二、逐项证据

1. **CDP 精确采样**
   - `browserCdpSampleIntervalMs` 默认 45000→15000，`browserWatchdogTick` 的 fallback 也改为 15000。
   - `sampleManagedBrowser` 使用 `Performance.getMetrics`、`Memory.getDOMCounters`、`Runtime.getHeapUsage`，返回 `heapBytes/nodes/documents/listeners/layoutCount/visibility`。
   - `browserHeapLimitMB=1536` 已参与 `overHeap`，命中后 `quarantineTask(task, reason)`。
2. **母体面板懒渲染**
   - 新增 `S.activeTaskId`；`renderForkCard` 只对 active task 走完整卡，其他任务走 `renderForkSummary`。
   - `refresh()` 只预热 active task 的 `loadForkSessions`；切换时 `setActiveTask()` 才加载该任务 session。
   - DOM 用例断言：24 个任务只有 1 张完整卡、23 张摘要；切换后仍只有 1 张完整卡。
3. **统一缓存上限**
   - `CACHE_LIMITS`：任务 200、母体会话 200、fork session 缓存 16 个任务/每任务 80 条、日志 64KB、预览 240 字符。
   - `archiveTask` / `deleteArchive` 成功立即 `releaseTaskCache()`，清理 `forkSessions`、展开状态、active 指针。
4. **隐藏暂停实验开关**
   - `pauseHiddenTab=false` 默认关闭。
   - 开启后 hidden→`Page.setWebLifecycleState=frozen`，visible→`active`；失败 60s 冷却重试并写审计。
5. **Job Object 内存兜底**
   - `fang-job-host.c` 新增 `--job-process-memory-mb` / `--job-memory-mb`，设置 `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`。
   - `forker` 新增 `jobProcessMemoryMB=2048`、`jobTotalMemoryMB=4096`，`buildJobHostArgs` 仅在非 0 时传参，保持旧 argv 兼容。

## 三、回归

- 新增 `test/v385-closures.test.mjs`：CDP 默认/精确指标、隐藏暂停开关、懒渲染、缓存上限、Job Object 内存参数。
- `test/client-layout-dom.test.mjs` 新增懒渲染 DOM 用例。
- `test/job-object.test.mjs`、`test/memory-watch-sampling.test.mjs`、`test/cdp-metrics-wiring.test.mjs` 通过。
- 全量测试：**1510 tests / 1487 pass / 0 fail / 13 skipped / 10 todo**（Mac，183,496 ms）。版本断言同步 3.8.5。

## 四、未闭环 / 风险

1. 官方 DSH Web client 的 session 事件内存未改；`session-bridge` 的 `limit` 不能替代官方客户端分页。
2. 隐藏暂停未在真实 Windows Edge/Chrome + DSH fork 页面验证“隐藏→恢复可见→可输入”，因此默认关闭。
3. Job Object 的 C 源码/参数已改，但 macOS 本机无 MinGW/Windows SDK，未重编译 `fang-job-host*.exe`；现有 exe 仍是旧二进制。需 Windows CI 或 Windows 真机 rebuild 后内存上限才生效。
4. `/fang/api/panic` 路由缺失、`maxForks=8`、母体 RSS/Private 连续采样不在本版范围。
5. **Windows 真机 E2E 未跑**：`/fang/adapter/flush-session` 的 3s 端到端落盘、`browser-health.jsonl` 真机采样都只有单测/静态证据，需在 Windows 自托管环境补 `preflight` / `e2e`。
6. **无 pagefile 且 Commit < `hostCriticalFreeMB` 仍进 Safe Mode**：这是防止第一个分身打爆 Commit 的安全兜底，保持不放宽。
7. **发布门禁未绿**：`dist/manifest.json` 的 `preflight` 仍是旧 3.8.5 结果（`pass=-1` / `fail=-1`），本次构建走 `--skip-preflight`；不得据此宣称 preflight GREEN。
8. 未 commit/push/tag/publish；发布动作需用户明确确认。
