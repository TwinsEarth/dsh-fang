# v3.8.6 审计（2026-11-25）

> 基线 v3.8.5。审计对象是用户最新 8 项“防止分身 Web 端崩溃”措施表；只记录本轮真正新增/核对过的代码与证据。

## 一、范围判定

- 本版做：CommitFree 6GB 核对、无 pagefile 证据与单分身 gate、打开前健康检查、浏览器崩溃日志、10 分钟 2 次崩溃闩锁、单 app 窗口、关闭前 flush/3s 强杀核对、崩溃根因落盘。
- 本版不做：官方 DSH Web client 的 session 事件全量渲染改造；`session-bridge` 只有 `limit`，不是分页/懒加载。
- 结论不变：4 万条 session 的 renderer 内存根因仍在官方客户端；Fang 只能在爆之前监控、拒绝打开、关闭或隔离。

## 二、逐项证据

1. **启动前 CommitFree 检查**
   - `src/plugins/orchestrator.mjs` Config：`memoryMinFreeMB=6144`、`hostWarnFreeMB=8192`、`hostCriticalFreeMB=4096`、`hostEmergencyFreeMB=2048`。
   - 该项在 v3.8.5 已是 6144，不是本轮从 4GB 提到 6GB；审计只核对，不虚报为新增。
2. **无 pagefile 检测 + 单分身**
   - `src/lib/memory-guard.mjs` PowerShell 读取：
     - `HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management` 的 `PagingFiles`
     - `Win32_ComputerSystem.AutomaticManagedPagefile`
   - 新增字段 `pagingFilesEmpty`、`commitLimitNearRam`、`pagefileMissing`。
   - `isCommitLimitNearRam(limit,total)`：`limit <= total * 1.1` 视为近似物理内存；`isPagefileMissing()`：`Win32_PageFileUsage` 无分配、`PagingFiles={}`、`CommitLimit≈RAM` 任一命中。
   - `evaluatePagefileSingleFork(memory,{activeForks})`：`activeForks=0` 允许一个且 `limited=true`；`activeForks>=1` 返回 `pagefile-single-fork`。
   - `memoryGate` 接入，拒绝第二个并写 `fork-pagefile-single-fork-refused`；`status.pagefilePolicy` 暴露 `missing/evidence/singleForkOnly/maxConcurrentForks/safeMode`。
   - 客户端 Safe Mode 审查与红色 pagefile banner 识别三个新字段并显示证据。
3. **分身健康检查**
   - 新增 `src/lib/fork-health.mjs`。
   - `countSessionEvents()` 用 `fs.createReadStream(...).pipe(zlib.createZstdDecompress())` 流式统计换行事件；超过 `maxEvents` 或解压字节预算立即 `destroy()`，不整文件进母体内存。
   - `inspectForkSessionHealth()` 扫描 `sessions/**`，按压缩字节找最大会话（不是按 mtime），返回 `sessions/totalBytes/largestBytes/largestSessionId/events/truncated`。
   - `evaluateForkHealth()` 汇总 `adapter.ok`、最大会话 64MB、50000 事件、HTTP health 失败。
   - `probeForkHealth()` 默认 `/fang/api/health`，404 回退 `/api/health`，body 上限 256KB，超时 2s。
   - `launchTaskBrowser()` 在真正新开浏览器前调用 `inspectTaskOpenHealth()`；失败写 `fork-open-health-refused` 并返回 `fork-health-*`，不打开。已存活浏览器复用、元主 runtime browser 不走该 gate。
   - 新增 `GET /fang/api/health`，`public:true` 但仍走 Host/Origin loopback；根 `/api/health` 仅为兼容别名，注册失败只写审计。
4. **浏览器崩溃日志**
   - `browser-guard.mjs` launch args 保留 `--enable-logging --log-file --enable-crash-reporter --crash-dumps-dir`；`launchManagedBrowser` 增加 `onExit`，`classifyBrowserExit()` 归一化 code/signal/hex/kind/oom。
5. **崩溃退避**
   - `fork-supervisor.evaluateCrashLoop(times,now,{windowMs,threshold})`，forker 默认 600000ms / 2 次。
   - 非预期退出维护 `rec.crashTimes`；窗口内 2 次写 `rec.quarantined={reason:'crash-loop',count,threshold,windowMs,at,...}`，不调用 `planRestart`。
   - `publicFork` / `writeForkMetaOf` 持久化 `crashTimes`、`quarantined`；`spawn` 清 `quarantined`；新增 `resetCrashLoop` 让手动 restore 同时清 `crashTimes`。
   - `syncTaskOnOpen` 把 `live.quarantined` 投影到 `task.quarantined`，用户点“打开”不能绕过隔离。
6. **浏览器单 app 窗口**
   - `selectExtraPageTargets()` 只挑 `type=page` 且非 `devtools/chrome-extension/edge-extension` 的额外 target。
   - `enforceSinglePageTarget()` 通过 `/json` + `/json/close/<id>` 关闭；`browserSingleAppWindow=true`；启动后立即执行，`browserWatchdogTick` 每轮再执行；关闭数量写 `fork-browser-extra-pages-closed` 审计。
7. **自动保存后重启**
   - `closeTaskBrowser()` 先 `flushForkSession(task)`（`/fang/adapter/flush-session`），再页面 flush，再 `closeManagedBrowser({graceMs: cfg.gracefulBrowserCloseMs})`；默认 3000ms。
   - 未保存时写 `closeWarning`、`fork-browser-unsaved-close` 审计；落到 `browserClosed.forkFlush`。
8. **崩溃根因记录**
   - `recordBrowserExit()` 记录：
     - `exit.code/unsignedCode/hex/signal/kind/oom/source/intentional`
     - 最后 CDP `nodes/heapMB/documents/listeners/layoutCount/visibility`
     - `pidTree {pids,count,workingSetMB,commitMB}`
     - `logFile/crashDir`
   - 写 `browser-events.jsonl`（`event:'exit'`）；非主动退出另写 `memory-samples.jsonl`（`kind:'browser-exit'`），避免正常 flush+close 污染崩溃样本。
   - `0xE0000008`（含 signed `-536870904`）分类 `oom`，写 `fork-browser-exit-oom` 审计；watchdog 发现 PID 已死未收到 exit 时补写 `source:'watchdog-pid-dead'`。

## 三、回归

- 新增 `test/v386-crash-closures.test.mjs`：pagefile 证据、单分身 gate、session 健康扫描/事件预算、health 404 回退、`0xE0000008` 归一化、额外 page 选择、10 分钟 2 次闩锁。
- 相关旧测试：`pagefile-safety` / `browser-guard` / `memory-guard` / `forker` / `client-pagefile-banner` 56 pass / 0 fail；`orchestrator` 74 pass / 0 fail。
- 全量测试：**1517 tests / 1494 pass / 0 fail / 13 skipped / 10 todo**（Mac，183,933 ms）。
- 修复本轮旧测试：`client-pagefile-banner.test.mjs` 与 `client-safe-mode.test.mjs` 的断言同步到新 pagefile 证据字段；不是放宽行为，只更新文本断言。

## 四、未闭环 / 风险

1. **Safe Mode 与单分身语义冲突**：无 pagefile 时 `pagefileRequiresSafeMode()` 仍返回 true；Safe Mode 阻止所有创建/打开/恢复，单分身 gate 不会实际放行第一个。若用户要“允许一个、禁止第二个”，需显式放宽 Safe Mode，本轮未擅自改。
2. 健康预检 64MB/50000 events 是默认预算，未用用户真实 session 规模校准。
3. `/fang/api/health` 根别名可能与官方 DSH 路由冲突；注册失败只写审计，不阻断，但未在真机确认。
4. 单 app 窗口、崩溃闩锁、健康预检未在真实 Windows Edge/Chrome + DSH fork 页面做端到端验证。
5. 官方 DSH Web client session 事件内存未改；4 万条 session 根因仍在。
6. `native/win32/fang-job-host*.exe` 未重编译。
7. 未 commit/push/tag/publish。

## 五、结论

本轮把 8 项措施中可代码化、可单测验证的部分补齐；不把 Safe Mode 下的“单分身”说成已放行，也不把未做真机 e2e 的项说成已生产验证。
