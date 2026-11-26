## v3.9.1（2026-11-26）
**主题：包元信息热修 + B2 / C1–C6 收口**

### 包元信息
- `cordis.patch.yml` 自带的 `maxForks: 8` 改为 `1`；`Config.maxForks` 接受旧配置的 1–64，但 `apply()` 仍硬限 1、禁用 `allowMultiFork`。
- 打包层过滤 `locale/._*`、`.DS_Store`；package-smoke 增加 locale language-id / AppleDouble 与 `maxForks: 8` 门禁。
- 新增 `postinstall` 清理 locale 的 macOS 伴随文件；`tools/release/clean-locale-sidecars.mjs` 随包发布。
- 本版修复 `3.9.0` 的 `maxForks: 8` 与 locale sidecar 安装错误；详见 `docs/AUDIT-v3.9.0-PKG.md`。

### C1–C6
- C1：`lastHostMetrics` 落盘间隔 15s → 5s，与 5s host tick 对齐；硬杀后 `host-state.json` 最多滞后一个 tick。
- C2：`host-crashes.json` 崩溃循环窗口改为配置 `hostCrashWindowMinutes`（默认 10，1–1440 分钟）；safe-mode 原因、状态与 UI 文案同源。
- C3：`hostEmergency` 的 `allTasks` 不再跳过 `ARCHIVED`；只清 PID/token/浏览器并保留归档状态，不把归档任务降级为 `FAILED`。
- C4：新增 UI 按钮与 `GET/POST /fang/api/forks/multi-fork` 二次确认；仍需显式 token，且只返回 `enabled:false / hardLimit:1`，不构成多开旁路。
- C5：新增 `processPriority` 档位 `below-normal | idle`；托管浏览器与三个分身启动/恢复点统一传 `priorityClass`，Idle 只在显式配置时使用。
- C6：迁移报告按钮改为直接调用本地 `openMigrationReport()`，不再依赖 `app.openMigrationReport` 方法；定位结论见 `docs/AUDIT-v3.9.0-C.md`。
- 随 v3.9.1 发布；v3.9.0 已发布包不含以上改动。

### B2
- 单文件 session 紧急线由 48 MB 调整为 64 MB；警告 16 MB、严重 32 MB 与合计 512/1024/2048 MB 门保持不变。60.91 MB 现场文件不再触发单文件 `gate`，但仍显示 critical；64 MB 起才 gate。详见 `docs/AUDIT-v3.9.0-B2.md`；随 v3.9.1 发布。

## v3.9.0（2026-11-26）
**主题：将 v3.8.14 宿主守卫提升为正式发布版本（Host JS heap + session 文件体量 + 全盘 pagefile）**

### 发布

- 以 `98a8b83`（v3.8.14）为源码基线，仅提升版本号与发布材料；不并入未选择的 B/C/D/E 审计项。
- 正式发布三方：GitHub `v3.9.0` tag / Release、npm `@twinsearth/fang-dsh-plugin@3.9.0`、项目目录发布报告与校验和。
- 代码能力与 v3.8.14 相同：Host heap 1024/1536/2048 MB 三级阈值并按 V8 `heap_size_limit` 65%/80%/90% 收紧；session 单文件 16/32/48 MB、合计 512/1024/2048 MB；pagefile/commit 覆盖所有活动/配置分页文件与所有卷。
- `openMigrationReport` 仍未修，发布文案不得写成已修；真实 Windows DSH 宿主 E2E 未跑，preflight 为 `skipped:true / green:false`，不得写成门禁 GREEN。

### 测试与构建

- 全量回归与构建结果见 `docs/AUDIT-v3.9.0.md`；v3.8.14 的 6 项宿主守卫测试继续纳入全量。
- 发布工具：`tools/release/build.mjs` 改为显式文件清单打包，移除 tarball 目录条目；否则 npm registry 以 HTTP 415 `invalid path: package/` 拒收。
- v3.8.14 真机证据仍有效：TOFUTURE 页面文件在 D:、`CommitLimitOSMB=44821`、Host session 206 个合计 222.56 MB、最大单文件 60.91 MB，见 `docs/evidence/memory-probe-all-drives-2026-11-26.md`。

## v3.8.14（2026-11-26）
**主题：宿主守卫改看 Host JS heap + session 文件体量；pagefile/commit 全盘探测**

### 修复

- **Host JS heap 独立采样**：5s host tick 读取 `process.memoryUsage().heapUsed` 与 `v8.getHeapStatistics().heap_size_limit`；默认 1024 MB 警告、1536 MB 严重、2048 MB 紧急，且按 V8 上限 65%/80%/90% 收紧。达到严重阈值即拒绝新分身/新浏览器；连续 3 次采样达到紧急阈值才按宿主紧急处置。即使 PowerShell/CIM 内存探针失败，heap 仍继续采样。
- **session 文件体量**：新增只读扫描 `src/lib/session-footprint.mjs`，对 Host `$DSH_HOME/sessions` 与每个任务 home 的 `sessions/`、`quarantine-sessions/` 统计 `session.v4.jsonl.zstd`；默认合计 512/1024/2048 MB、单文件 16/32/48 MB 三级阈值，60s 缓存，不读、不解压会话内容。单文件达到 48 MB 时拒绝新分身/新浏览器；客户端新增宿主压力横幅，显示 top 文件与总/单文件阈值。
- **pagefile/commit 全盘**：`readSystemMemory()` 现在同时读 `Win32_PageFileUsage`（每个活动分页文件）、`Win32_PageFileSetting`（每个配置分页文件）、`Win32_LogicalDisk`（所有固定/可移动卷）与 `PagingFiles` 注册表；输出 `pageFileDrives`、`pageFileOffSystemDrive`、`pageFileDetails`、`pageFileUsageMB`、`volumes`。Commit 上限取 `max(OS TotalVirtualMemorySize, 物理内存 + 所有活动分页文件)`，不再可能只按 C 盘分页文件估算。
- **`openMigrationReport` 不动**：作为独立客户端 API 问题保留原防御，不并入本次宿主 OOM 修复，也不通过重装客户端/改 asar 解释或掩盖。

### 测试

- 新增 `test/v3814-host-guard.test.mjs` 6/6：阈值钳制、heap 分级、session 总/单文件分级、临时 home 扫描、C+D 双分页文件映射、源码接线。
- 全量回归见 `docs/AUDIT-v3.8.14.md`；真机 pagefile 全盘证据见 `docs/evidence/memory-probe-all-drives-2026-11-26.md`。真实 DSH 宿主内的 heap/session 实时读数仍需安装本版后跑一次（本轮只验证纯逻辑与 Windows PowerShell 探针）。

## v3.8.13（2026-11-25）
**主题：三条宿主红线收口 + 页面文件语义纠正**

### 修复

- **maxForks 硬拒 >1**：`Config` 上限收为 1，`apply()` 对直接配置也强制回落；`allowMultiFork` 不再提供旁路；第二次 create 返回 `quota-exceeded`。
- **fork 总 Commit 4 GB 宿主余量**：新增 `src/lib/commit-budget.mjs`，有效上限取 `min(40% CommitLimit, CommitLimit-4096MB)`；spawn 前 fail-closed，5s 宿主 tick 与 15s 看门狗共同执行。
- **sidecar spawn 当刻 PID**：create/restore/autostart 三处 spawn 成功即写 `pidStartedAt` + `spawn-provisional`；CIM 成功再覆盖，失败不再清空。
- **页面文件改为 advisory**：不再因无 pagefile 强制 Safe Mode 或拒绝第一个分身；启动/解除按 Commit 余量与探测可用性判断，`memoryMinFreeMB` 默认 3000；客户端提示改为黄色建议，不阻止确认。
- **autostart 补 `writeWatchdog()`**：避免只 persist 不刷新 watchdog。

### 测试

- 新增 `test/commit-budget-v3813.test.mjs` 7/7；`orchestrator` 74/74；v3.8.8 redline 10/10；v3.8.5 定向 12/12；pagefile/client-safe-mode 全通过。
- 全量结果见 `docs/AUDIT-v3.8.13.md`；Windows DSH 宿主 E2E 与 native helper 的 browser/fork 完整编排链路仍未闭环；helper 本身的 kill-on-close + Job/进程内存上限已于 2026-11-26 Windows 11 真机三例 PASS，browser Job Object 也已用 headless Edge 真机验证 root + 13 子进程全部随 helper 退出，证据见 `docs/evidence/job-object-e2e-2026-11-26.md` 与 `docs/evidence/browser-job-e2e-2026-11-26.md`。

## v3.8.12（2026-11-25）
**主题：页面文件缺失时 Safe Mode 解除硬门**

### 修复

- **服务端权威解除门**：`safeModeStatus()` 返回 `reset`（`canReset`、`memoryKnown`、`pagefileMissing`、`commitFreeMB`、`detail`、`checkedAt`），UI 不再自行猜测。
- **客户端 fail-closed**：页面文件缺失、Commit 低于 `hostCriticalFreeMB`、内存探测不可用或其他 blocker 时，复选框 disabled、确认按钮 disabled，本地直接拒绝。
- **解除前二次探测**：`resetSafeMode()` 在释放闩锁前再 `force` 探测一次；第二次仍缺页面文件或 Commit 不足，返回 409，审计 `stage:'postcheck'`。
- **`openMigrationReport` 分离**：该调用来自 DSH 0.2.2-rc.5 客户端/设置插件组合，不是 Fang 定义；已有 `typeof` 防御，不作为本次 OOM 根因。

### 测试

- Safe Mode / 页面文件定向 12/12 通过；全量 1572 / 1549 pass / 0 fail。

## v3.8.11（2026-11-25）
**主题：状态对账与 handler-threw 可观测性**

### 修复

- **500 不再吞原因**：`route` / `routeMethods` 的 catch 统一走 `handlerFailure()`，响应增加 `route`、`method`、`requestId`，审计增加 `detail` 与 `stack`（3000 字符截断）。
- **fang-meta 自动修复**：`taskView` 读取任务前检查 `fang-meta.json`；无 live 进程但 meta 仍写 running/pid/port 时，按任务注册表清空并审计 `fork-meta-reconciled`。
- **打开/恢复对账纳入 meta**：`reconcileOpenState` 同时读 meta；meta 旧端口参与占用探测，被元主运行态占用时标记 `stale-port-conflict`，不复用。
- **暂停等待真实停止**：`pauseOtherForks` await `f.stop(id)`，浏览器关闭与进程停止分别兜底审计；清 token、同步 meta，`fork-auto-paused` 记录 `browserCloseOk/stopOk/metaSynced`。
- **meta 写失败可见**：`syncTaskMeta` 写失败写 `fork-meta-write-failed` 审计。

### 测试

- 新增 meta-only、task-only 残留与 handler-threw 路由/审计测试；全量 1571 / 1548 pass / 0 fail。

## v3.8.10（2026-11-25）
**主题：严禁把宿主搞崩——十条宿主红线与独立兜底**

### 安全 / 可靠性

- **母体 5s 常驻采样**：`hostWatchdogTick` 不再因“没有活跃 fork/browser”提前返回，每 5s 读自身 RSS/Private 与系统 CommitFree；8 GB 警告、4 GB 严重、2 GB 紧急。
- **紧急准入闸门**：`hostAdmissionClosed` 在 `hostEmergency` 第一步置位，再逐任务关浏览器、停 fork、隔离；`fork-commit-share`、`commit-free-emergency`、`manual-panic` 全部 `allTasks:true`；create/restore/open 立即 423。status 与 panic 保持可达。
- **独立看门狗判卡死**：`watchdog-sidecar.mjs` 新增 `heartbeatState()`，`host-state.json` 超过 `watchdogHostStuckMs=60000` 未更新即 `host-heartbeat-stale`；与 `host-exit`、`host-pid-reused`、`host-clean-stop` 分因记录后清理。
- **正式 flush 去猜测**：删除 `/api/session/flush`、`/api/session/save`、`/api/sessions/flush` 三个虚构端点；只保留 configured、health-capability、adapter-route，并把 `source` 写入 attempted/last/flushView。
- **Windows Job helper 重编**：x64 82,944 bytes、arm64 54,784 bytes；x64 真机以 64/128 MB 限额启动成功，强杀 helper 后 Job 内子进程被内核回收。

### 测试

- 全量 1568 / 1545 pass / 0 fail / 13 skipped / 10 todo。
- 新增 `v3810-host-redline` 12 项、`watchdog-sidecar-stuck` 3 项；相关回归 63 项。

### 已知边界

- arm64 helper 只做了 PE/导入表静态核对，未在 ARM64 Windows 真机执行。

## v3.8.9（2026-11-25）
**主题：不惜关闭——托管浏览器强制关闭八条措施与 2 GB / 1.5 GB / 200k / 4 GB 硬阈值**

### 安全 / 可靠性

- **新增 `autoClose`**：默认 `true`，命中内存或空闲条件直接关浏览器，不再二次确认；关闭只清进程，home、会话、存档保留。`autoClose=false` 可关内存/空闲自动关闭；宿主 <2 GB 的紧急处置仍生效。
- **硬阈值**：`browserMemoryLimitMB=2048`、`browserHeapLimitMB=1536` 改为硬上限；自适应阈值只能更严，不能把 32 GB 机器放宽到 4 GB。DOM 上限 200000，宿主 CommitFree <4096 MB 触发。
- **新增纯策略**：`src/lib/browser-auto-close.mjs` 的 `effectiveBrowserAutoCloseLimits()` / `evaluateBrowserAutoClose()`。浏览器自身超限返回 `scope:'task'`（关浏览器→停 fork→清端口/Token）；宿主低余量返回 `scope:'browser'`（只关浏览器，保留 fork/home）。CDP 采样失败不参与 heap/DOM 误判。
- **接线**：`browserWatchdogTick()` 记录 `hostCommitFreeMB`、调用策略、写审计 `fork-browser-auto-close`（trigger/commit/heap/nodes/host free/四条硬阈值）；`/fang/api/status` 暴露 `browserAutoClose`。空闲关闭也受 `autoClose` 总开关控制。
- **UI**：`task.memoryGuard` 时按钮显示“重新打开”，chip 显示“内存保护关闭”，并注明必须手动重开、不会自动重开；宿主 Commit 余量进入 title。

### 测试

- 新增 `test/v389-browser-auto-close.test.mjs` 11 项：硬阈值不被自适应放宽、2 GB/1.5 GB/200k 边界、宿主 4095 vs 4096、autoClose=false、idle 需 `turnRunning=false`、Browser.close→taskkill 顺序与 3 s 宽限、flush→close→fork stop→port/token、memoryGuard 持久化、不删 home + 手动重开、启动/5 分钟孤儿扫描、默认配置。

### 边界 / 未闭环

- 浏览器 watchdog 与 taskkill 仍仅 Windows；Windows 真机未跑阈值触发。
- `native/win32/fang-job-host*.exe` 未重编，Job 内存上限不生效。
- 宿主余量来自最近一次 host watchdog 采样，最多滞后一个周期。

## v3.8.8（2026-11-25）
**主题：三条红线：browser/fork Windows Job Object、聚合 commit 30/35/40 分级、Panic 路由与崩溃循环证据**

### 安全 / 可靠性

- **browser 接 Job Object**：`launchManagedBrowser()` 在 Windows 且 `browserJobObject=true` 时先启动 `fang-job-host.exe`；helper 建 Job + `KILL_ON_JOB_CLOSE`，browser 以 suspended 方式入 Job 后 resume；返回真实 PID、`helperPid`、`jobObject`。helper 缺失/启动失败/ready 超时 fail-closed，不退化裸 spawn。`task.browser` / taskView 暴露 `helperPid` / `jobObject`。
- **聚合 commit 分级**：新增 `forkCommitWarnShare=0.3`、`forkCommitSevereShare=0.35`，保留 `forkCommitShareLimit=0.4`；`memoryWatchdogTick` 分项统计 `forkCommitMB`、`browserCommitMB`、`totalCommitMB`、`forkShare`、`processCount`、`selfRssMB`、`selfPrivateMB`。30%/35% 只告警（60 秒节流），40% 才 `hostEmergency`。`hostWatchdogTick` 改为 CommitFree <8192 warning、<4096 severe、<2048 emergency；`hostEmergencyFreeMB` 真正生效。`/fang/api/status` 返回 `hostMetrics` 与 `forkCommitPolicy`。
- **母体真实内存**：PowerShell 探针用 `Get-Process -Id <Node PID>` 的 `WorkingSet64` / `PrivateMemorySize64` 取 RSS/Private，不再用 heap+external 近似。
- **安装令牌 bootstrap 宿主属主准入**：`GET /fang/api/auth-token` 在回环 + 同源校验之后，新增 `src/lib/peer-owner.mjs` 把 TCP 对端映射到进程并校验其 OS 属主与 DSH 宿主一致：Windows 用 `Get-NetTCPConnection`/`netstat -ano` + `Win32_Process.GetOwner`，macOS 用 `lsof -Fpcun` 的 UID，Linux 用 `/proc/net/tcp[6]` 的 socket UID。映射不到或属主不同一律 403 `not-host-owner`，fail-closed；不再只凭回环地址发放审批/重启 token。实测 Windows（Node 宿主 + curl 对端）与 macOS（Node 宿主 + curl 对端）均通过，测试见 `test/peer-owner.test.mjs`。
- **Panic 路由**：新增 `POST /fang/api/panic`，调用 `service.panic()`；成功 200 `{ok:true,mode:'panic'}`，失败 409。`service.panic` 使用 `allTasks:true`，隔离所有非 ARCHIVED 任务并进入 safe mode。
- **崩溃证据与 10 分钟循环**：`host-crashes.json` 只保留 10 分钟 `recent`；完整历史追加 `host-crashes.jsonl`，字段含 `commitFreeMB/selfRssMB/selfPrivateMB/forkCommitMB/browserCommitMB/totalCommitMB/processCount`。`host-state.json` 每 15 秒 heartbeat 写 `lastMetrics`；clean 退出不被 heartbeat 回写为 unclean。
- **maxForks 默认 1**：`allowMultiFork=false` 时 `effectiveMaxForks()` 强制 1，接入配额、status、`maxConcurrentForks`；forker DEFAULTS/Schema 同步，不能只改 `maxForks` 绕过。
- **sidecar 启动即见 PID**：`createTask` 在 `await f.spawn()` 期间每 200ms 轮询 `f.status`；拿到 PID 立即同步 `task.pid/port`、`syncTaskMeta`、`persist`、`writeWatchdog`、`lowerProcessPriority`。forker spawn 后立即写 `fork-meta` PID；`writeWatchdog` 接受任何非 ARCHIVED 且 `pid>0` 的 fork。

### 测试

- 新增 `test/peer-owner.test.mjs` 6 项：netstat/lsof/proc 解析、缺失 socket/对端 fail-closed、bootstrap 403/200。
- 新增 `test/v388-redlines.test.mjs` 10 项：Config 默认、helper 内存参数、browser helper 缺失 fail-closed、browser 接 Job helper、orchestrator 路由/阈值/崩溃日志/sidecar、`host-crashes.json` 10 分钟清理 + JSONL 指标、真实 `POST /fang/api/panic` 200、native 源码内存限制、母体 RSS/Private 来源。

### 边界 / 未闭环

- `native/win32/fang-job-host*.exe` 仍是旧二进制；kill-on-close 可用，但 Job 内存上限需 Windows CI/真机重编后生效。
- browser Job Object 无 Windows 真机启动测试；只有 helper 缺失 fail-closed 与静态/纯函数测试。
- `lastHostMetrics` 最多滞后 15 秒；硬杀时 JSONL 为最后一次 heartbeat 快照。
- `host-crashes.json` 超过 10 分钟记录只在 JSONL。
- V3.8.4 的 `/fang/api/decisions/ai Failed to fetch` 不能仅凭日志断定为路由缺失；需目标机确认宿主/端口可达性。
- 未 commit/push/tag/publish；发布动作需用户明确确认。

## v3.8.7（2026-11-25）
**主题：按纠偏收口“防止分身 Web 端崩溃”的 P0/P1（健康阈值、真实 flush、pagefile 单活跃、崩溃退避、关闭原因）**

### 安全 / 可靠性

- **健康预检收紧**：`forkHealthMaxSessionMB` 64→**20**、`forkHealthMaxEvents` 50000→**20000**（严格按“> 20MB / > 20000 事件”拒绝）；`probeForkHealth` 记录端口响应 `latencyMs`；打开前健康结果写 `browser-health.jsonl`，含 adapter/session/http/flush 证据。
- **无 pagefile 强制单活跃**：新增 `decidePagefileBootPolicy()`；缺失 pagefile 且 Commit 仍高于 `hostCriticalFreeMB` 时不再全停 Safe Mode，而是 `singleForkOnly=true`，启动闸门只清理 pagefile-only Safe Mode 闩锁，保留 crash-loop 等其他闩锁。`/fang/api/status` 顶层与 `pagefilePolicy` 均返回 `pageFileMB/hasPageFile`；`maxOpenForkBrowsers` 在 `hasPageFile=false` 时硬限 1；前端红色 banner 改为“未启用页面文件，已强制单分身”。
- **正式 flush 先核实再调用**：不新造 DSH HTTP 端点。`flushForkSession()` 在 **3s 总预算**内依次实测配置路径、`/fang/api/health` 通告的 `flush.path`、推导的 `/<prefix>/adapter/flush-session`，再回退 `/api/session/flush`、`/api/session/save`、`/api/sessions/flush`；只有服务端显式 `saved:true` 才算落盘。全部 404/405/超时返回 `code:'flush-unsupported'` 并写“未保存强杀”警告，不假装保存。
- **浏览器崩溃记录与退避**：`child.on('exit')` 记录 `rawCode/unsignedCode/hex/signal/at/kind/oom`、最后 CDP/PID 树；新增 `browser-crashes.jsonl`（`{taskId,pid,code,oom,lastMetrics,pids,...}`）；同一 task 在 10 分钟内 2 次崩溃写 `quarantined.reason='browser-crash-loop'` 并停 fork。正常 code 0 退出不算崩溃。
- **单 app 标签强制**：CDP `/json` 只保留 1 个 `type=page`；启动后与 watchdog 周期执行；即使 `browserSingleAppWindow=false`，无 pagefile 时也强制单标签。
- **关闭原因分类**：新增 `classifyCloseReason()`，把原始原因归一为 `user / idle / browser-oom / dom-limit / host-panic / crash-loop`；`closeReason`、`browserClosed.reasonKind`、`memoryGuard.reasonKind` 持久化；任务卡显示“上次崩溃于 OOM/exit 0x…”。

### 边界 / 未闭环

- 缺失 pagefile 且 Commit 余量低于 `hostCriticalFreeMB` 时仍进入 Safe Mode（避免连第一个分身都直接打爆 Commit）；这是“单活跃”之外的安全兜底，不是正常态。
- 真实 DSH Windows 宿主的 fork `/api/health` 是否通告 `flush.path`、以及 `/fang/adapter/flush-session` 的 3s 端到端落盘，仍只有单测/纯函数覆盖；需 Windows 自托管环境重跑 preflight/e2e。
- 官方 DSH Web client 的 session 事件全量渲染未改；4 万条 session 的 renderer 内存根因仍在。
- `native/win32/fang-job-host*.exe` 仍是旧二进制，Job Object 内存上限需 Windows CI/真机 rebuild 后生效。
- 未 commit/push/tag/publish；发布动作需用户明确确认。

## v3.8.6（2026-11-25）
**主题：分身 Web 端防崩溃 8 项措施落地（在 v3.8.5 基础上补代码，不重复计算已有能力）**

### 安全 / 可靠性

- **启动前 CommitFree 检查**：核对 `memoryMinFreeMB=6144`（6GB），不是 4GB；`hostWarnFreeMB=8192`、`hostCriticalFreeMB=4096`、`hostEmergencyFreeMB=2048` 保持不变。该项为 v3.8.5 已有能力，本轮未改阈值。
- **无 pagefile 证据与单分身 gate**：Windows 探针增加注册表 `PagingFiles`、`AutomaticManagedPagefile`；新增 `pagingFilesEmpty`、`commitLimitNearRam`、`pagefileMissing`。`PagingFiles={}`、`CommitLimit <= 物理内存 × 1.1`、或 `Win32_PageFileUsage` 无分配任一命中即视为缺页文件。新增 `evaluatePagefileSingleFork()`：无 pagefile 时 `activeForks=0` 允许一个、`activeForks>=1` 返回 `pagefile-single-fork`；`memoryGate` 拒绝第二个并写 `fork-pagefile-single-fork-refused` 审计。
- **分身打开前健康检查**：新增 `src/lib/fork-health.mjs`。`inspectForkSessionHealth()` 扫描 fork home 的 `sessions/**`，流式 zstd 解压统计最大会话事件数，超预算立即销毁流；`probeForkHealth()` 默认请求 `/fang/api/health`，404 回退 `/api/health`。`launchTaskBrowser()` 在真正新开浏览器前检查 `task.adapter.ok`、单会话 64MB/50000 事件预算、fork HTTP health；失败返回 `fork-health-*` 并写 `fork-open-health-refused` 审计，不打开浏览器。新增 `GET /fang/api/health`，响应含 `ok/role/version/pid/uptimeMs/session/adapter`。元主 runtime browser 与已存活浏览器的复用不走该 gate。
- **浏览器崩溃日志**：托管浏览器保留 `--enable-logging --log-file --enable-crash-reporter --crash-dumps-dir`；`launchManagedBrowser` 新增 `onExit`，把 exit code/signal 归一化后交给 orchestrator。
- **10 分钟 2 次崩溃闩锁**：`fork-supervisor.evaluateCrashLoop()` 默认 `crashWindowMs=600000`、`crashThreshold=2`；forker 在非预期退出时维护 `crashTimes`，窗口内达到 2 次即写 `quarantined={reason:'crash-loop',...}`、不进入自动重开，并发 `fang/fork-crashed` / `fang/fork-restart-failed`。`publicFork` 与 `fork-meta` 持久化 `crashTimes/quarantined`；用户手动 restore 会清除隔离并重置 `crashTimes`。
- **浏览器单 app 窗口**：`selectExtraPageTargets()` / `enforceSinglePageTarget()` 通过 CDP `/json` 只保留一个 app page，关闭多余 page（忽略 devtools/extension）；启动后立即执行一次，`browserWatchdogTick` 每轮再执行，关闭数量写 `fork-browser-extra-pages-closed` 审计。
- **关闭前 flush + 3s 强杀**：沿用已有 `gracefulBrowserCloseMs=3000`、`forkFlushPath=/fang/adapter/flush-session`；`closeTaskBrowser` 先 `flushForkSession`，再页面 flush，再 `closeManagedBrowser` 3s 强杀。本轮未改代码，只补回归核对。
- **崩溃根因记录**：`recordBrowserExit()` 记录 `exit.code/unsignedCode/hex/signal/kind/oom/source/intentional`、最后 CDP `nodes/heapMB/documents/listeners/layoutCount/visibility`、PID 树 `pids/count/workingSetMB/commitMB`；写入 `browser-events.jsonl`，非主动关闭的退出另写 `memory-samples.jsonl`（`kind:'browser-exit'`）。`0xE0000008` 分类为 `oom`，写 `fork-browser-exit-oom` 审计；watchdog 发现 PID 已死但未收到 exit 事件时补写 `source:'watchdog-pid-dead'`。

### 边界 / 未闭环

- 无 pagefile 时启动预检仍沿用 v3.8.4 的 **Safe Mode 硬门禁**：Safe Mode 会阻止所有创建/打开/自动恢复，单分身 gate 在 Safe Mode 下不会实际放行第一个。因此“允许一个、禁止第二个”与当前更严格的“先全停、启用 pagefile 再开”存在语义差异，未擅自放宽。
- `/fang/api/health` 与根 `/api/health` 的别名、单 app 窗口、崩溃闩锁、健康预检均只有纯函数/单测覆盖，尚未在真实 Windows DSH 宿主做端到端验证。
- 官方 DSH Web client 的 session 事件全量渲染未改；4 万条 session 的 renderer 内存根因仍在。
- `native/win32/fang-job-host*.exe` 仍是旧二进制，Job Object 内存上限需 Windows CI/真机 rebuild 后生效。
- 未 commit/push/tag/publish；发布动作需用户明确确认。

## v3.8.5（2026-11-25）
**主题：闭环子集：CDP 15s、母体面板懒渲染、统一缓存上限、隐藏暂停实验开关、Job Object 内存上限**

### 安全 / 可靠性

- **CDP 精确采样**：`browserCdpSampleIntervalMs` 默认 45000→15000；沿用 `Performance.getMetrics` / `Memory.getDOMCounters` / `Runtime.getHeapUsage`，`JSHeapUsedSize`、Nodes、Documents、LayoutCount、listeners、visibility 全部进入采样结果；`browserHeapLimitMB=1536` 超限继续走 `quarantineTask`。
- **母体面板懒渲染**：新增 `S.activeTaskId`；只有 active task 渲染完整 `renderForkCard`，其他任务渲染 `renderForkSummary`（标题/健康状态/状态胶囊）；`renderForkPanel` 不再对所有任务预热 `loadForkSessions`，切换任务才加载该任务 session/附件/日志。
- **统一客户端缓存上限**：`CACHE_LIMITS` 统一任务 200、母体会话 200、fork session 缓存 16 个任务/每任务 80 条、日志 64KB、预览 240 字符；`archiveTask`/`deleteArchive` 成功即 `releaseTaskCache()`，释放 `forkSessions`、展开状态与 active 指针。
- **隐藏暂停实验开关**：新增 `pauseHiddenTab=false` 默认关闭；开启后 hidden→CDP `Page.setWebLifecycleState=frozen`，visible→`active`，失败 60s 冷却重试；未完成真机“恢复可见→可输入”验证前不默认开启。
- **Job Object 内存兜底**：helper 新增 `--job-process-memory-mb` / `--job-memory-mb`，设置 `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`；forker 新增 `jobProcessMemoryMB=2048`、`jobTotalMemoryMB=4096` 配置并传入 helper。
- **回归**：新增 `test/v385-closures.test.mjs`；`client-layout-dom.test.mjs` 新增“只有 active task 完整渲染、切换后仍只有一张完整卡”的 DOM 用例。

### 边界 / 未闭环

- 官方 DSH Web client 的 session 事件全量渲染没有改；`session-bridge` 只有 `limit`，不能替代官方客户端分页/懒加载。4 万条 session 的 renderer 内存根因仍在。
- 隐藏暂停只做到实验开关，未在真实 Windows Edge/Chrome + DSH fork 页面完成恢复可见验证，因此默认关闭。
- Job Object C 源码与参数已改，但 macOS 本机没有 Windows 工具链，未重编译 `fang-job-host*.exe`；现有 exe 仍是旧二进制，需 Windows CI/真机 rebuild 后才生效。
- `/fang/api/panic` 路由、`maxForks=8`、母体 RSS/Private 连续采样不在本版范围。
- 真实 Windows DSH 宿主的 `/fang/adapter/flush-session` 3s 端到端落盘、`browser-health.jsonl` 真机采样未跑，需在 Windows 自托管环境补 `preflight` / `e2e`。
- 无 pagefile 且 Commit 低于 `hostCriticalFreeMB` 时仍进入 Safe Mode；这是防止第一个分身打爆 Commit 的安全兜底，不放宽。
- `dist/manifest.json` 的 `preflight` 仍是旧 3.8.5 红色结果（`pass=-1` / `fail=-1`）；构建走 `--skip-preflight`，不能宣称发布门禁通过。
- 未 commit/push/tag/publish；发布动作需用户明确确认。

## v3.8.4（2026-11-25）
**主题：页面文件硬门禁 + 启动前 Safe Mode 预检 + 迁移报告 API 防护**

### 安全 / 可靠性

- **Safe Mode 解除硬门禁**：`resetSafeMode` 每次强制 `readSystemMemory({ force: true })`，实际读取 `Win32_PageFileUsage`；只有 `hasPageFile === true` 且 `pageFileMB > 0`、`commitFreeMB >= hostCriticalFreeMB` 才允许解除。页面文件缺失、Commit 低于宿主紧急阈值、探测失败均返回 409 并写 `safe-mode-reset-refused` 审计，不修改 `safeMode`。
- **启动前页面文件预检**：Fang `apply()` 在 Windows 上启动异步 pagefile gate；检测到页面文件缺失/被禁用时直接进入 Safe Mode（`reason=pagefile-missing`），`createTask` / `restoreTask` / `syncTaskOnOpen` / `autostartForks` 都先等这个 gate，缺失时拒绝自动拉起分身或浏览器。看门狗不再等到插件加载后才反应。
- **客户端硬拦截**：Safe Mode 弹窗按 `pageFileMB` 与服务端 `memoryPolicy.hostCriticalFreeMB` 判断；页面文件缺失或 Commit 低于紧急阈值时禁用页面文件 checkbox、禁用确认按钮并显示原因，不再只信用户勾选。
- **迁移报告调用点防护**：横幅点击“查看迁移报告”前做 `typeof app.openMigrationReport !== 'function'` 判断；缺失时提示并单独归为 DSH 客户端 API 问题，不混入 Host/Commit 崩溃修复。`app` 面仍挂回 `openMigrationReport`。
- **修复旧子进程句柄泄漏**：`stop → 重启` 后上一子进程的晚到 `exit` 事件不得把新 child 句柄置空，否则新分身可能失去句柄控制；`forker` 现在只清理当前 child，旧 spawn 的 promise 单独 settle，避免测试/宿主退出时遗留 `fake-dsh-cli` 进程（V3.8.4 发布门禁发现）。
- **回归**：新增 `test/pagefile-safety.test.mjs`，用模拟 `Win32_PageFileUsage` 结果断言页面文件缺失/Commit 低不能解除、启动预检进入 Safe Mode；新增 Safe Mode 下 `autostartForks` 不得 spawn 的集成用例；现有 Safe Mode/迁移报告/页面文件 banner 定向测试同步更新。
- **收录 v3.8.3 未发布内容**：Job Object、旧 workspace 映射、拒绝外部浏览器回退、P1/P2 接线、元主 Web boot 修复、打开分身状态归位、service 面修复、迁移报告漏挂修复一并进入本版。

### 边界

- 不修改 DSH 安装文件、不自动安装/更新插件；部署/重启仍需用户手动二次确认。
- 页面文件是系统级前置条件，Fang 只能检测并进入 Safe Mode，不能替代启用页面文件。
- 真实 Windows 宿主上的 pagefile 缺失场景需在用户授权部署后复测；本版代码/单测在 VM 完成。
- 未 commit/push/tag/publish（发布动作见 v3.8.4 审计/发布记录）。

## v3.8.3（2026-11-25，已并入 v3.8.4，未单独发布）
**主题：P0 硬保障：Job Object 内核回收、旧 workspace 映射、无托管浏览器拒绝回退**

### 安全 / 可靠性

- **Windows Job Object**：新增 `fang-job-host.exe`，`KILL_ON_JOB_CLOSE` + 宿主心跳；helper 死亡或宿主冻结时内核杀整棵 fork 子树。缺 helper 时 fail-closed，不退化裸 spawn。
- **旧 workspace 映射**：`E:\DSH\DS` / `E:\DSH` / `E:\DS` 等旧路径映射到各 fork home；启动扫描已有 fork home；仅改 Fang metadata 与 session header，事件帧字节不动，带清单/备份可回滚。
- **拒绝外部浏览器回退**：托管浏览器不可用时 `POST /fang/api/tasks/open` 返回 503，客户端不再 `window.open`；essence runtime Web 纳入托管浏览器/panic/watchdog；显式 browserPath 失效 fail-closed。
- **P1**：fork flush 端点、空闲关闭活动判定、sidecar identity、日志轮转、Safe Mode UX。
- **P2**：会话压缩、缓存治理、阈值自适应、CDP 趋势图、页面文件红色 banner。
- **修复元主 Web boot**：`ui-theme` 被旧 overlay 禁用导致 layout/sidebar/chat 全部 pending；`repairOfficialEssence`、`applySourcePluginSurface` 与运行态启动路径统一强制启用核心 UI 行并补回归测试。
- **修复打开分身 `handler-threw`**：打开/还原前归位 task、`fang-meta`、端口三方状态；open/restore 逐步骤返回 `{step,error,detail}`，旧 pid/port 不再残留。
- **修复 open/safe-mode 路由的 service 面**：`openManagedBrowser`、`probeMemory`、`safeModeStatus`、`resetSafeMode` 等宿主级方法必须挂在 orchestrator service 上，不能混入 mirror service；补 service 面回归断言，避免打开成功后被 `service.openManagedBrowser is not a function` 再次打成 `handler-threw`。
- **修复迁移报告按钮 TypeError**：`client.js` 的 `app` 面漏挂 `openMigrationReport`，页面文件/迁移横幅点击“查看迁移报告”会报 `app.openMigrationReport is not a function`；已挂回并补客户端回归断言。

### 边界

- 不复制/删除旧 workspace 文件；只 redirect。
- 真实 DSH 宿主 fork/浏览器端到端待在线复测。
- 未 commit/push/tag/publish。

## v3.8.2（2026-11-24）
**主题：数据根隔离：默认 D:\ToFuture\FangData，禁止与宿主/工程目录混用**

### 紧急修复

- **默认数据根固定为 `D:\ToFuture\FangData`**：mirror（母体登记/审计）、essence（元宝）、forks（分身）、sessions（会话）全部落在该根下，不再落进 DSH_HOME 或工程目录。
- **数据隔离红线**：`enforceDataIsolation=true`；数据根/分身 home 落在 `E:\DSH\DS` 等宿主/工程目录时，拒绝创建分身/启动元主运行态，状态接口返回 `dataIsolationBlocked`。
- **旧数据安全迁移工具**：`tools/migrate-fang-home.mjs`，只复制不删除、不覆盖，宿主运行中拒绝执行；生成 `migration-*.json` 报告并写 `fang-home.txt` 指针。迁移前旧布局继续可读，UI 显示「旧数据待迁移」，不会静默显示空面板。
- **分身 workspace 隔离**：新空会话默认落到 `<fork home>\workspace`，禁止默认使用母体/客户端工程目录；显式传入 `E:\DSH\DS` 会被拒绝并回退本地 workspace。
- **部署工具识别新根**：`deploy-profile.mjs` 优先使用 `D:\ToFuture\FangData\mirror\<profile>`，兼容旧布局。

### 迁移步骤（必须停宿主）

```powershell
# 完全退出 DeepSeek Harness 后
node tools/migrate-fang-home.mjs --apply
# 再部署 v3.8.2 / 启动
```

工具只复制、不删除源；目标已有 tasks.json 时默认拒绝（需人工确认）。

### 门禁（发布前必填，来自 dist/preflight.json）
- tests: pass=1341 fail=0 skip=2
- e2e: 125/125
- routes: ?（allowlist） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）
- 不自动删除/移动旧目录；迁移必须显式执行，避免数据丢失。
- 旧分身的既有 workspace 元数据不强制改写；新建空会话才强制本地 workspace。历史 workspace 需人工确认后迁移。
- Windows Job Object、官方 client 会话懒加载仍留待下一版。

### 回滚锚点
- 升级前快照/上一代目录：active-v3.8.2-pre（母体）；merged-v3.8.2-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.8.1（2026-11-24）
**主题：修复 v3.8.0 sidecar 拉起第二宿主；关闭链路与宿主红线加固**

### 紧急修复

- **v3.8.0 严重回归**：看门狗用 `process.execPath` 启动 sidecar；打包宿主是 `DeepSeek Harness.exe`，RunAsNode 被关闭时会拉起第二个 DSH 宿主，导致母体 `Failed to load plugins`、客户端全部 pending waiting theme/layout、分身打开 `handler-threw`。
- 现在只使用 DSH 自带 Node：`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`；找不到就**不启动 sidecar**，绝不回退到 `process.execPath`。
- `/fang/api/tasks/open` 的托管浏览器调用加 try/catch，浏览器异常返回 JSON，不再让路由抛 `handler-threw`。
- 回归测试：`test/watchdog-safety.test.mjs` 断言源码不得出现 `spawn(process.execPath`。

### 关闭链路

- CDP `Browser.close` → 等待 `gracefulBrowserCloseMs=3000` → 仍在才 `taskkill /T /F`。
- 新增 `browserHeapLimitMB=1536`：JS heap 超 1.5GB 关闭并隔离。
- 空闲关闭只对确认空闲的 fork 生效（`idleCloseOnlyWhenIdle=true`）；无法确认活跃状态时不自动关，避免误杀长任务。
- 关闭原因统一写入 `task.memoryGuard = {reason, at, pid, metrics, graceful, forkFlush}`；UI 显示「内存保护关闭」。
- 孤儿清理默认每 5 分钟一次。
- `forkFlushPath` 可配置正式落盘端点；未配置时显式记录 `unsupported`，不伪造保存成功。

### 宿主红线

- 母体自身 RSS/Private 采样进入警告/熔断审计。
- 10 分钟内宿主崩溃 2 次才进入 Safe Mode（`host-crashes.json`），单次崩溃不直接锁死。
- 新增 `POST /fang/api/panic` 与顶部「释放全部内存」按钮。
- fork/browser 根进程设 BelowNormal。
- fork+browser PID 树 commit 总和超过 `forkCommitShareLimit=0.4` 时熔断。
- sidecar 在 create/restore spawn 成功后立即登记 PID。

### 门禁（发布前必填，来自 dist/preflight.json）
- tests: pass=1338 fail=0 skip=2
- e2e: 125/125
- routes: ?（allowlist） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）
- **Windows Job Object 仍未实现**：当前是 detached sidecar + `taskkill`；宿主被冻结时不如内核 Job 可靠。
- **官方 DSH Web client 的会话事件限流/懒加载未做**：仍靠 DOM/Commit 上限 + 关闭/隔离。
- `maxForks=8` 是任务/归档容量；实际同时运行由 `singleActiveFork` 限制为 1，不是字面 maxForks=1。

### 回滚锚点
- 升级前快照/上一代目录：active-v3.8.1-pre（母体）；merged-v3.8.1-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.8.0（2026-11-24）
**主题：托管浏览器 + 宿主熔断 + 隔离闩锁 + Safe Mode**

### 新增

- **托管浏览器**：Fang 后端以独立 profile 启动 Edge/Chrome（`--app` + `--remote-debugging-port`），记录 browser/renderer PID 树；不再依赖系统默认浏览器裸开。支持 `browserPath` 覆盖。
- **浏览器内存看门狗**：每 30 秒采样托管浏览器 PID 树 Commit、CDP DOM 节点数、JS heap、visibility；超过 `browserMemoryLimitMB` / `browserDomNodeLimit` 时关闭浏览器并隔离任务；隐藏超过 `autoCloseIdleMinutes` 自动关闭。
- **宿主紧急熔断**：每 5 秒检查 CommitFree；低于 `hostCriticalFreeMB` 时**先关托管浏览器，再停/隔离所有运行中分身**；低于 `hostEmergencyFreeMB` 时额外进入 Safe Mode。
- **隔离闩锁**：任务写入 `quarantined`，吊销 token、清空 URL、关闭端口；`/fang/api/tasks/open` 返回 **423**；只有显式还原（新 PID/token）或母体重启才能清除。
- **Safe Mode**：宿主非正常退出时写 `host-state.json`，下次启动进入 Safe Mode，禁止创建/打开/自动恢复；提供 `GET/POST /fang/api/safe-mode` 与顶部「解除 Safe Mode」按钮。
- **独立看门狗**：detached sidecar 监控宿主 PID 与 `watchdog.json`；宿主被强杀时清理已登记的浏览器/fork PID 树。
- **浏览器崩溃留证**：`--enable-logging --log-file`、`--enable-crash-reporter --crash-dumps-dir`；日志/转储在任务 home 的 `browser-logs/`。
- **单活跃 + 浏览器上限**：`singleActiveFork=true`、`maxOpenForkBrowsers=1`；启动新分身会关闭其他托管浏览器并暂停其他 fork。

### 默认配置

```yaml
memoryGuard: true
memoryMinFreeMB: 6144
hostWarnFreeMB: 8192
hostCriticalFreeMB: 4096
hostEmergencyFreeMB: 2048
singleActiveFork: true
maxOpenForkBrowsers: 1
managedBrowser: true
browserMemoryLimitMB: 2048
browserDomNodeLimit: 200000
autoCloseIdleMinutes: 10
quarantineOnGuard: true
safeModeAfterCrash: true
autoRestoreForks: false
```

### 门禁（发布前回填）
- tests: pass=1337 fail=0 skip=2
- e2e: 125/125
- routes: ?（allowlist） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）
- **会话事件限流/懒加载未改官方 DSH Web client**：本轮用托管浏览器 DOM/Commit 上限 + 隔离/关闭保护；真正的历史事件分页需要改官方 client，留待下一版。
- **Job Object 原生 `KILL_ON_JOB_CLOSE` 未在本版启用**：当前由 detached sidecar + `taskkill /T /F` 完成宿主死亡后的清理；Job Object 作为下一版原生加固项。
- 托管浏览器默认使用 Edge 独立 profile；首次打开不继承用户日常浏览器登录态，这是内存/崩溃隔离的代价。

### 回滚锚点
- 升级前快照/上一代目录：active-v3.8.0-pre（母体）；merged-v3.8.0-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.7.8（2026-11-24）

**主题：提交内存护栏 + 单活跃分身 + 孤儿清理**

### 新增

- **打开/创建/还原分身前的 CommitFree 护栏**：读取 Windows `CommitLimit / CommitFree`，低于 `memoryMinFreeMB`（默认 4096MB）直接返回 `memory-low`，不再拉起新 renderer。
- **单活跃分身策略**（默认开启）：启动或打开一个分身时，暂停其他运行中的分身，母体面板只保留当前任务；被暂停的分身保留 home/会话，可随时「还原」，不自动归档、不删除。
- **内存看门狗**：每 30 秒采样每个运行中分身的 PID 树（含子进程）的 Working Set / Commit，写入 `fang/memory-samples.jsonl`；单树 Commit 超过 2GB 且相对低点增长超过 768MB 时只杀该分身的进程树，不拖死母体。
- **孤儿进程清理**：启动时和归档/失败任务中，按任务 PID + 命令行中的 taskId/profile 双重校验后清理残留进程，避免旧分身继续跑。

### 配置

```yaml
memoryGuard: true
memoryMinFreeMB: 4096
memoryWatchdog: true
memoryWatchIntervalMs: 30000
memoryKillCommitMB: 2048
memoryGrowCommitMB: 768
singleActiveFork: true
```

### 门禁（发布前回填）

- tests: pass=1334 fail=0 skip=2
- e2e: 125/125
- routes: 89（allowlist 0） / plugins: 16
- preflight: GREEN

## v3.7.7（2026-11-23）

**主题：仓库改名 + Vault 对话框修复**

### 修复

- **分身标签栏「导入/导出」点击无反应**：DSH Desktop 的 Electron webview 不实现 `window.prompt()`；旧代码拿到 `null` 后直接 return，用户看不到任何弹窗。改为应用内对话框：
  - 导出：目标文件夹输入 + 「同时打包工作区项目文件」复选框（默认不勾）；
  - 导入：导出包文件夹输入；
  - 支持 Enter/Esc/遮罩取消。
- 新增回归：禁止 `window.prompt`，必须存在 `vaultDialog` 与 `/fang/api/vault/*` 调用。

### 仓库改名

- GitHub：`TwinsEarth/dsh-fang` → **`TwinsEarth/fang-dsh-plugin`**（旧地址 301 重定向）。
- `package.json` / `build.mjs` / `healthz` / release 工具 / Docker / README / AGENTS 的 canonical URL 已更新。
- 插件市场目录另提交：新条目 `TwinsEarth/fang-dsh-plugin`，旧条目移除（外部审核）。

### 门禁（发布前回填）

- tests: pass=1331 fail=0 skip=2
- e2e: 125/125
- routes: 89（allowlist 0） / plugins: 16
- preflight: GREEN

## v3.7.6（2026-11-22）

**主题：加速核 team/mode 历史兼容**

### 修复

- **切到“分身 Core 加速引擎”后历史会话加载失败**：加速核 3.5.0 不识别 stock DSH 的 `team/mode` 事件，报 `unknown ... not marked ignorable`，会话看似丢失。
  - 旧 sanitizer 会把加速核不认识的**所有**事件标 `ignorable`，包括会话 header 帧里的 `session`；
  - 随后 header 字节校验失败返回 `header-frame-changed`，整个修复被静默放弃，`team/mode` 始终没有标记。
  - 现改为**只标记明确的新事件类型**：`team/mode`、`team/task`、`team/status`、`deliverables/presented`；绝不再修改 header/已知事件。
  - 修复结果会正确计入 `markedIgnorable`，不再出现“改了但不上报”的情况。
- 现有受损会话已按新规则修复：2 条 `team/mode` 标 `ignorable:true`，header 字节不变，原日志备份保留 `.bak-catalogv3-*`。
- 回归测试：把 header 类型故意从 known 集合移除，sanitizer 仍必须成功且只标 1 条 team/mode；`accelerated-fork` 15/15。

### 门禁（发布前回填）

- tests: pass=1330 fail=0 skip=2
- e2e: 125/125
- routes: 89（allowlist 0） / plugins: 16
- preflight: GREEN

## v3.7.5（2026-11-22）

**主题：全局红线 + Vault 导出导入 + 会话状态/同步修复**

### 新增

- **Vault 独立子插件** `vault/`（`@twinsearth/dsh-fang-vault`）：按会话仓库结构导出/导入分身。
  - `00_MANIFEST`、`10_SESSIONS`、`20_ATTACHMENTS`、`40_FORK_PROFILE`、`50_RUNTIME_DATA`、`60_LOGS`、`70_SECRETS`、可选 `30_WORKSPACES`。
  - 默认导出会话原始日志、元数据、派生索引、协作数据、fork 配置、血缘、日志、凭据；**工作区项目快照默认不勾选**，显式确认后才复制。
  - 导入校验 `dsh-fang-vault/v1`，会话平铺目录还原为 `sessions/<workspaceKey>/<sessionId>`，profile 重命名，重建 node_modules 后以 `preserveProfile` 启动并完成 Adapter 握手。
- **全局红线**：所有 fork 进程安装 fs 写守卫，只能写自己的 DSH_HOME；写母体 profile、DSH 安装目录、官方元主/runtime、其他 fork、tasks/auth/audit 等一律 `EPERM + fangRedline`，并记录到自己的 `fang/global-redline.log`。
- **等待启动**：分身 `failed` 状态由红色「启动失败」改为黄色「等待启动」；`crashed` 保留红色「已崩溃」。

### 修复

- `restoreTask` 不再自动搬移会话（EB-01/EB-07）；超额只在面板显示 warn chip。
- `restore-session.mjs --attach-only` 真正进入分支，并校验 session 存在、宿主运行需 `--force-running`（EB-04/EB-08）。
- `open-url` GET 只读；显式打开走 `POST /fang/api/tasks/open`，避免 GET 触发 stop/rebuild（EB-10）。
- 存量分身补 `syncSourceId`；无 fingerprint 视为 changed，首次打开主动同步（EB-12）。
- 来源插件面默认对齐（bundles + dependencies + patch rows），修复“已同步”假阳性（EB-14）。
- node-compat 作为第一个 bundle，写 dependencies；修复被 pnpm 剪到 `.ignored`（EB-06）。
- 失败/停止任务不再显示僵尸 PID/端口；面板“进行中”排除 failed/stopped；超额会话有提示（EB-13）。
- open-url/repair 错误码按 400/404 契约返回。

### 隔离/部署（沿用 3.7.3）

- 宿主存活时 deploy API 409；deploy-profile 原子部署/回滚；watcher EPERM 降级。
- 安装快照默认关闭，`DSH_FANG_INSTALL_SNAPSHOT=1` 显式启用。
- 母体安装红线：必须完全退出宿主后部署；热替换 profile 禁止（EB-03/EB-15）。

### 门禁（发布前回填）

- tests: pass=1330 fail=0 skip=2
- e2e: 125/125
- routes: 89（allowlist 0） / plugins: 16
- preflight: GREEN

## v3.7.3（2026-11-22 已发布）

**主题：分身每次打开主动同步元主插件 + 实验性永久固化**

### 修复

- **每次打开分身都主动同步元主**：`GET /fang/api/tasks/open-url` 现在先捕获来源元主运行态（settings、patch entries、bundles/dependencies、node_modules），修官方元宝，比较 merged fingerprint；源变化则停止旧分身、按新 merged profile 重新 provision + spawn，再返回新 URL。打开动作不再只是取 URL。
- **实验性插件永久固化**：不再依赖 orchestrator 的 post-provision 步骤。forker 在**每次 spawn 前**无条件把官方 15 个实验性 bundle + enabled patch 行写入 fork profile（accelerated 除外），修复 repair/restore 重新 provision 后实验性全关。
- **ready 但进程已死**：`restoreTask` 不再返回 `not-archived`，会清理 stale 状态后重新拉起；解决真机反复「启动失败」。
- **所有分身（含空白/模板）默认同步源 = 开发者推荐（官方）**，不再因为没有 essenceId 而跳过同步。

### 同时包含的隔离加固

- P1：宿主存活时部署 API 409；`deploy-profile.mjs` 原子部署/回滚；watcher EPERM 降级；fork 私有 fang 视图。
- P2-A：每版本不可变 DSH 安装快照（hardlink），stock 分身使用自己的快照 CLI；独立 TEMP/TMP。
- queue-journal 默认关闭（父/子 patch，子包 0.1.8）。
- 边界：Job Object/per-fork 防火墙未实现，当前不是 VM 级隔离；运行中旧分身需重新打开。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1325 fail=0 skip=2（ tests）
- e2e: 125/125
- routes: 113（allowlist 0） / plugins: 16
- preflight: GREEN

## v3.7.2（2026-11-22 已发布）

**主题：元主插件状态/配置同步 + 官方实验性全量启用 + patch 格式修复**

### 修复

- **官方元宝被误判 stale，导致分身全部回退 clean template（根因）**：`ensureDefaultEssence` 在官方已是默认时直接 return，不再 repair；official merged profile 长期停在 fang 3.6.2。分身派生时 `profileUsesCurrentFangBundle` 判 false，静默回退干净模板，实验性插件/第三方插件全部丢失。现在每次 create/restore/repair/打开元主都会 repair 官方，并按版本补齐 node_modules（不再只补“缺失”）。
- **官方实验性插件只匹配了前缀**：DSH 的「实验性插件」实际是固定的 15 个官方 bundle（含 `@deepseek-ai/dsh-personalized-recommendations`、`dsh-cua-bundle`、`dsh-deepseek-chat-import` 等不带 experimental 前缀的包）。现在官方与所有分身都写入完整 15 个 bundle + 启用行；Windows 上 `dsh-cua-bundle` 由 DSH 自身按 darwin 平台跳过。
- **`cordis.patch.yml` 格式错误**：DSH app-boot 要求 profile 的 `cordis.patch.yml` 是**顶层 YAML 数组**；essence 之前序列化成 `{ insert: [...] }`，会导致 profile 加载失败/包不可解析（2xray 等报错的重要来源）。serializer 与 fork patch 写入统一改为顶层数组，旧的 official/runtime profile 重算时自动归一。
- **设置/配置参数未捕获**：运行态 capture 现在同时捕获 `settings/*`（插件配置参数）、patch entries（开关/配置）、package.json（安装/卸载/更新后的 bundles+dependencies）和 node_modules（被更新/卸载的包）。分身创建/还原/修复前都会先捕获元主 Web 的最新状态。

### 功能

- 开发者推荐（官方）保持 v3.7.1 清单：安装不开启 10 项、安装并开启 3 项；所有官方实验性 bundle 默认开启。
- 任何由官方/模板派生的分身，创建或重新打开时都会补齐官方实验性表面（bundles + enabled patch 行）。
- queue-journal 仍默认关闭（父/子 `disabled: true`，子包 0.1.8）。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1320 fail=0 skip=2（ tests）
- e2e: 125/125
- routes: 111（allowlist 0） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 已经在运行的旧分身不会热改 profile；必须重新启动/重建该分身才会套用新状态（DSH 的插件组合在启动时读取）。
- 推荐清单中本机未安装的第三方包仍不自动 pnpm 安装；只对已安装项落启用/禁用行。
- Windows 上 `@deepseek-ai/dsh-cua-bundle` 是 darwin-only，DSH 会跳过；其余 14 个实验性 bundle 正常。
- 官方元主锁定；不改变 FANG_HOME 布局。

### 回滚锚点

- 升级前快照/上一代目录：active-v3.7.2-pre（母体）；merged-v3.7.2-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.7.1（2026-11-22 已发布）

**主题：官方推荐行去重（dsh-context 安装不开启仍被开启）**

### 修复

- **官方推荐清单与镜像同名行冲突**：母体/镜像 profile 如果已有同名行（当前实际是 `dsh-context`），合并后会把推荐清单的 `disabled: true` 重新打开。现在用镜像行 id 的 disabled 影子条目删除镜像行，推荐行保持“安装不开启”；`dshmarket`、实验性插件等同样处理。
- 3.7.0 的其余修复不变：元主插件设置开分身时同步、默认元宝保底官方、运行态缺包补齐、queue-journal 默认关闭。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1318 fail=0 skip=2（ tests）
- e2e: 125/125
- routes: 111（allowlist 0） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 推荐清单中本机未安装的包仍不自动 pnpm 安装；已安装项才落启用/禁用行。
- 官方元主锁定；不改变 FANG_HOME 布局。

### 回滚锚点

- 升级前快照/上一代目录：active-v3.7.1-pre（母体）；merged-v3.7.1-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.7.0（2026-11-22 已发布）

**主题：元主插件同步 + 开发者推荐默认元宝 + 运行态缺包修复**

### 修复

- **元主 Web 插件设置同步到分身**：分身创建/还原/换核前，先把运行中的 `essence-runtime` profile（内置、实验性、第三方插件开关）捕获回元宝 overlay 并重算 merged，分身下一次打开即可拿到最新开关（不再只在停止元主时捕获）。
- **宿主重启不再无限增加「默认元宝」**：默认优先使用「开发者推荐（官方）」；自动捕获快照只在没有官方元宝时兜底，官方存在时不再每次启动捕获一个；历史自动生成的「默认元宝」在切换时归档（不删除数据）。
- **元主运行态缺包**：merged/runtime profile 中声明但 `node_modules` 缺失的顶层依赖，启动时从母体补齐（修复 `@twinsearth/dsh-2xray` 的 `cannot resolve profile bundle`）。

### 功能

- **开发者推荐（官方）**：安装不开启 10 项（`dsh-better-sidebar`、`dsh-context`、`dshmarket`、`@xmanrui/dsh-im`、`@twinsearth/dsh-2xray`、`@twinsearth/dsh-master`、`@michengai/dsh-agency-agents`、`@twinsearth/dsh-im2a-plugin`、`@liustack/modlens`、`@liustack/modsearch`）；安装并开启 3 项（`@twinsearth/ai-prison-dsh-plugin`、`@openviking/dsh-memory-plugin`、`@twinsearth/w2m-dsh-plugin`）；所有已安装的 `@deepseek-ai/dsh-experimental-*` 默认开启。
- **queue-journal 默认关闭**：父 bundle 与子包 patch 都写入 `disabled: true`，需要用户在插件管理里手动开启；queue-journal 子包版本 0.1.8。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1318 fail=0 skip=2（1330 tests）
- e2e: 125/125
- routes: 111（allowlist 0） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 推荐清单中**本机尚未安装**的第三方包不会由本版自动执行 pnpm 安装（只对已安装项写入启用/禁用行；未安装项留给插件管理/后续版本处理）。
- 官方元主锁定，不支持改设置/重命名/归档；这是既有边界。
- 不改变 FANG_HOME 布局、不复制凭据/会话到新元宝。

### 回滚锚点

- 升级前快照/上一代目录：active-v3.7.0-pre（母体）；merged-v3.7.0-pre（原身）；plugin-snapshot-<ts>（插件层）
## v3.6.2（2026-11-22 已发布）

**版本快照：与 v3.6.1 无功能/代码差异（重新发布，便于分发与回滚锚点）。**

### 说明

- 本版**没有新增代码提交**：`main` 自 v3.6.1（`61a257b`）之后无任何变更，本版仅为版本号/发布记录。
- v3.6.1 已包含：加速分身会话兼容 shim（catalog v3→v1、去 `name`、未知事件 `ignorable`）、还原强制 reprovision、「启动」按钮修正（非归档分身直接启动）。
- 如果你期望 v3.6.2 修复某个具体问题（例如完全权限切换的界面表现），请把现象发我，我会在下一版补上；不会在没有代码变更时假装修了问题。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1314 fail=0 skip=2（1326 tests）
- e2e: 125/125
- routes: 111（allowlist 0 findings） / plugins: 16
- preflight: GREEN

### 边界

- 无代码变更；安装 v3.6.2 与安装 v3.6.1 行为完全一致（仅版本号不同）。
- 不改变 FANG_HOME 布局；不改变既有会话/分身数据。

### 回滚锚点

- 插件回滚：`npm i @twinsearth/fang-dsh-plugin@3.6.1`
- 升级前快照/上一代目录：active-v3.6.2-pre（母体）；merged-v3.6.2-pre（原身）；plugin-snapshot-<ts>（插件层）
## v3.6.1（2026-11-22 已发布）

**主题：加速分身兼容 stock 新会话格式（catalog v3 / 未知事件），并修复还原时「stock 配置 + 加速 CLI」混搭导致的 timeout。**

### 修复

- **加速分身打不开从 stock 母体复制来的历史会话**：加速核 `@twinsearth/dsh@3.5.0` 的会话格式比当前 stock DSH 旧，连续卡在三层：
  1. `subagent/catalog` v3（加速核只认 v0/v1/v2）→ `SessionFormatError`；
  2. 降级到 v1 后 `name` 字段不被 v1 严格 schema 接受 → `unrecognized_keys`；
  3. stock 新事件（如 `team/mode`）加速核不认识且未标 `ignorable` → 整份日志拒绝解析。
  现在加速 spawn / provision / import 时会自动读取加速核的 `KNOWN_SESSION_EVENT_TYPES`，对**分身内的会话副本**做兼容（逐帧重压、带 `.bak-*` 备份）：catalog v3→v1、删除 v1 禁用的 `name`、把加速核不认识的事件标记 `ignorable: true`。母体原会话不动。
- **「启动」按钮误弹「还原存档」确认**：状态栏的启动按钮此前直接复用还原确认（failed 分身也会弹「还原存档？」）。现在非归档分身点「启动」直接拉起，仅 archived 才走还原确认。
- **还原 timeout**：还原流程先 `resetForkConfig` 把 profile 重置回 stock 形状，旧逻辑因 `task.coreMode` 已是 accelerated 而跳过重新 provision → 加速 CLI 加载 stock 配置，bundle 解析失败、60s 不 ready。现在还原/一键修复在 reset 后**强制 reprovision**。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1314 fail=0 skip=2（1326 tests）（全量）
- e2e: 125/125
- routes: 111（allowlist 0 findings） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 兼容垫片只保证加速核能**读取**历史；加速核不认识的事件（`team/mode` 等）在该视图中会被跳过/不渲染。根治需升级加速核（npm 最新仍 3.5.0）。
- 只改分身会话副本，不改母体会话；每次改写都有 `.bak-catalogv3-*` / `.bak-accelcompat-*` 备份。
- stock 档行为不变；不改变 FANG_HOME 布局。

### 回滚锚点

- 插件回滚：`npm i @twinsearth/fang-dsh-plugin@3.6.0`
- 升级前快照/上一代目录：active-v3.6.1-pre（母体）；merged-v3.6.1-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.6.0（2026-11-22 已发布）

**Stable 稳定版：母体面板分身状态栏（4 态 + 启动/一键修复）；核心切回 stock 时清理加速别名桩；还原失败任务不再强制归档。**

### 新增

- **分身状态栏**：每张分身卡片显示 **运行中 / 等待启动 / 已停止 / 故障** 四态（折叠时也可见），并提供两个操作：**启动**、**一键修复**。
- **一键修复**：`POST /fang/api/tasks/repair` —— 停残留进程 → 清加速别名桩 → 按来源原身重置 profile 配置 → 修复 node_modules mirror → 重新分配端口拉起；逐步返回 `steps[]`，不删除 home/会话/存档（运行中的分身会重启，面板二次确认）。
- 路由契约：路由数 86 → 87（`DEFAULT_EXPECTED_ROUTE_COUNT` 同步）。

### 修复

- **核心切回 stock 后无法启动/还原**：fork profile 残留 `@deepseek-ai/*` 加速别名桩，stock CLI 会导入加速模块并因缺少子路径而启动失败（`2 required plugins did not activate` / `ERR_PACKAGE_PATH_NOT_EXPORTED`），还原报 `spawn-failed exited`。现在 stock spawn/provision 前自动 `pruneAliasStubs()`，旧 profile 也会被修复（只删 `0.0.0-fang-alias` 桩，不碰真实包）。
- **不再强制归档**：`restoreTask` 直接接受 `failed` 与 `archived` 任务；客户端删除“先归档再还原”的 fallback，启动失败的任务点「启动/还原」不会再被自动归档。
- 状态栏「故障」优先于「进程在跑」：进程在但适配器失联同样显示故障，并给出一键修复。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1311 fail=0 skip=2（1322 tests）
- e2e: 125/125
- routes: 111（allowlist 0 findings） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 一键修复只做“进程/配置/模块”层修复，不动会话内容，不删除 home；不改变核心选择（仍按当前 fork-core 设置）。
- 归档会话仍不能作为派生导入源（服务端校验不变）。
- 不改变 FANG_HOME 运行数据布局（`D:\ToFuture` 仍在原位）。

### 回滚锚点

- 插件回滚：`npm i @twinsearth/fang-dsh-plugin@3.5.9`
- 升级前快照/上一代目录：active-v3.6.0-pre（母体）；merged-v3.6.0-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.5.9（2026-11-21 已发布）

**主题：修复加速分身派生失败「fork-bundle-unavailable」——加速 profile 的 fang bundle 链接名与发布包名对齐（发布构建改名后 junction 仍停在开发别名）。**

### 修复

- **加速分身派生失败 `fork-bundle-unavailable`**：`src/lib/accelerated-fork.mjs` 在生成加速分身 profile 时，把 fang bundle 的 junction 写死在 `node_modules/@local/dsh-fang`；而发布构建会把源码常量 `@local/dsh-fang` 改名为 `@twinsearth/fang-dsh-plugin`。orchestrator 的 bundle 探测按发布名查找 → 找不到 → 判定 `fork-bundle-unavailable` 并回收任务（现场：`task_mwqlvcejfego`）。现改为：
  - junction 与 profile 的 `bundles / dependencies` 一律以 `fangRoot/package.json` 的真实包名为准（开发链 `@local/dsh-fang`，npm 安装 `@twinsearth/fang-dsh-plugin`）；
  - 两套名字不同时额外保留 `@local/dsh-fang` 兼容别名 junction；
  - `isFangBundle` 识别发布名，避免同步路径把本体当第三方插件复制。
- 新增回归测试：以「发布名 fixture」生成加速 profile，断言 profile bundles/dependencies 使用发布名、`node_modules/@twinsearth/fang-dsh-plugin` junction 存在且可解析。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1307 fail=0 skip=2
- e2e: 125/125
- routes: 110（allowlist 0 findings） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 不改加速核版本（仍 `@twinsearth/dsh@3.5.0`）；不改母体/原身 core；
- 不改 FANG_HOME / 三区数据布局（`D:\ToFuture` 原地保留）；
- 本机 `fang-forker.acceleratedCliPath` 属运行配置（profile 补丁），不随 npm 包分发；新机器需先安装加速核或配置该路径。

### 回滚锚点

- 插件回滚：`npm i @twinsearth/fang-dsh-plugin@3.5.8`
- 升级前快照/上一代目录：active-v3.5.9-pre（母体）；merged-v3.5.9-pre（原身）；plugin-snapshot-<ts>（插件层）

## v3.5.8（2026-11-21 已发布）

**主题：母体会话目录与 DSH 宿主侧栏对齐（只列工作区注册根会话 + 投影缓存标题）；派生弹窗/母体面板按「活跃中（7 天）/ 已归档 / 旧会话（>7 天）」三分组，组内按最后活跃时间从新到旧。**

### 修复

- **会话目录三边不一致（宿主侧栏 / 母体面板 / 派生弹窗）**：`src/plugins/session-catalog.mjs` 原来直接扫 `$DSH_HOME/sessions` 目录，把**子代理会话（裸 UUID 目录）**与未登记目录也列出来（本机实测 193 条 vs 宿主 5 条），且标题因有界读取截断回退成工作区名/首条任务提示。现改为：
  - 只列 `workspace.json` 工作区成员里的**根会话**（与宿主侧栏同源）；归档/置顶取 `global.archivedSessionIds / pinnedSessionIds`；
  - 标题优先读 DSH 投影缓存 `storages/session_projcache/sessions/<id>.json`（宿主侧栏同一份数据），日志有界读取仅兜底；
  - 注册表没有成员清单的旧 home 保持原目录扫描兼容行为。
- **三分组 + 组内排序**：会话按互斥优先级 ① 活跃中（7 天内、未归档）② 已归档 ③ 旧会话（超过 7 天、未归档）分组，组内按最后活跃时间（`updatedAt`）从新到旧；母体面板新增分组小标题与计数；派生弹窗已归档组灰色只读、旧会话折叠可选；空会话（宿主侧栏也不显示）不再进入派生列表。
- **归档分组可见**：`cordis.patch.yml` 中 `fang-session-catalog.allowArchived` 由 `false` 改为 `true`，使「已归档」分组可在面板/派生弹窗显示（灰色只读；仍不能作为派生导入源）。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1306 fail=0 skip=2
- e2e: 125/125
- routes: 110（allowlist 0 findings） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 归档会话只用于展示/分组，仍不能作为派生导入源（服务端硬校验不变）；
- 不改宿主侧栏行为；其它工作区/项目会话仍由宿主管理；
- 不改变 FANG_HOME 运行数据布局（`D:\ToFuture` 仍在原位）。

### 回滚锚点

- 升级前快照/上一代目录：active-v3.5.8-pre（母体）；merged-v3.5.8-pre（原身）；plugin-snapshot-<ts>（插件层）
- 插件回滚：`npm i @twinsearth/fang-dsh-plugin@3.5.7`

## v3.5.7（2026-11-21 已发布）

**主题：项目迁入 E:\DSH\DS\Fang；派生弹窗三分组 + 7 秒倒计时 + 移除面板页脚提示行（跳过未发布的 3.5.6，用户明确指定 v3.5.7，见 `docs/RELEASE-WAIVER-v3.5.7.md`）。**

### 新增与变更

- **项目整体迁移（2026-11-21）**：从 `E:/GPT/dsh-fang` 迁入 `E:\DSH\DS\Fang`（完整 git 历史 68 tag、历史发布物、会话快照与官方 ZIP、契约子仓库 1.2.0、会话工具）；旧仓库保留只读。运行时行为不变；发布工具去掉旧根硬编码（allow-list 忽略本地目录、contract 默认 `<repo>/contract`、凭据读取顺序加仓库 `.secrets/`、LSP staging 改到 `scratch/`）。
- **派生弹窗会话三分组**（互斥，优先级 1→2→3）：① 最近 7 天活跃（未归档，默认展开、可选）；② 已归档（归档优先于时间，单独折叠、灰色 disabled、不可选）；③ 更早（超过 7 天且未归档，折叠后可选）。两处派生入口改为 `?limit=500&includeArchived=1`，分类在弹窗内完成。
- **派生倒计时 5 秒 → 7 秒**（`DERIVE_PICKER_TIMEOUT_MS = 7000`）；超时仍默认新建空会话。
- **移除母体面板页脚提示行**（双击/单击提示 + 刷新时间 + 版本号 + 独立门户链接），两栏内容独占纵向空间；独立门户入口保留在顶部工具区。
- 测试：`client-derive-picker-timeout.test.mjs` 更新为 7 秒 + 三分组 + 页脚移除断言；新增跳号豁免 `docs/RELEASE-WAIVER-v3.5.7.md`。

### 门禁（发布前必填，来自 dist/preflight.json）

- tests: pass=1302 fail=0 skip=2
- e2e: 125/125
- routes: 110（allowlist 0 findings） / plugins: 16
- preflight: GREEN

### 边界（本版明确不做的事）

- 不改 DSH 本体；不迁移 FANG_HOME 运行数据（`D:\ToFuture` 仍在原位，约 3.5 GB）；
- 不改变派生/审批/安全语义（仅 UI 分类与展示）；
- 不发布未存在的 3.5.6（跳号由用户当次明确指定 v3.5.7）。

### 回滚锚点

- 升级前快照/上一代目录：active-v3.5.7-pre（母体）；merged-v3.5.7-pre（原身）；plugin-snapshot-<ts>（插件层）
- 插件回滚：`npm i @twinsearth/fang-dsh-plugin@3.5.5` 或恢复 profile 备份

## v3.5.5（2026-11-21 已发布）

**安全与静默错误修复（R28 / R23 / R13 / R14 / R15，按优先级）。**

### 修复

- **R28 `GET /fang/api/auth-token` bootstrap 收紧**：仅本机回环 peer + 同源 Origin（host:port 与 Host 完全一致）+ `Sec-Fetch-Site: same-origin|none`；拒绝跨站/同站/Origin 不匹配/非回环 peer，响应 `cache-control: no-store`。同机同用户进程仍可读 0600 token 文件——本层只收敛浏览器侧攻击面（`src/lib/http-auth.mjs`、`src/plugins/orchestrator.mjs`）。
- **R23 pro 审批票参数绑定修复**：`POST /fang/api/contract/pro/approval` 必须携带 `params`（要审批的精确负载）；票据摘要 = `proParamsDigest(params)`（排除 `approvalTicket` 自身）；consume 侧强制校验摘要，无摘要旧票 `params-unbound` 一律失效，参数不符 `params-mismatch`（`src/lib/pro-delegation.mjs`、`src/plugins/orchestrator.mjs`、`tools/e2e.mjs`）。
- **R13 镜像官方源 Promise 修复**：`mirror.getStatus()` 改为只读同步缓存，永不 `String()` 一个 Promise；新增 `refreshOfficialLatest()`（60s 缓存/in-flight 去重/异常捕获/保留上次成功版本），`GET /fang/api/mirror/status` 先 await 刷新缓存（`src/lib/mirror.mjs`、`src/plugins/orchestrator.mjs`）。
- **R14 会话目录脱敏与服务形状**：`listSessions`/`getSession` 的 title/preview、digest/seed 文本统一走 `redact()`（email/token/手机/绝对路径）；服务补 `.list`/`.get` 别名（契约/编排器/adapter 读取的形状）；`src/compose.mjs` 补装载 `session-catalog`（`src/plugins/session-catalog.mjs`、`src/compose.mjs`）。
- **R15 审计链失败不再静默**：`auditor.appendStrict()`（失败即 throw）与 `auditor.status()` 健康面；`append()` 失败累计失败数/限频告警/事件；orchestrator 的 `audit()` 记录失败并在 `GET /fang/api/status.audit.health` 暴露；pro 审批签发改为 **auditStrict**（审计写不进 → 503 拒绝签票）（`src/plugins/auditor.mjs`、`src/plugins/orchestrator.mjs`）。
- 测试：`http-auth` R28 ×3、`pro-delegation` R23 ×3、`mirror` R13 ×N、`session-catalog` R14 ×3、`auditor` R15 ×2、`plugins-shape` compose 守护；e2e 新增「签票缺 params 400」「参数不符 params-mismatch」→ **125/125**。

## v3.5.4（2026-11-18 已发布）

**UI 布局调整：母体&元主 与 决策中心&分身 左右对调；右列改为「分身在上 / 决策中心在下」。**

### 新增与变更

- **母体操作面板左右对调**（2026-11-18）：左列 = 「母体&元主」；右列 = 「分身（上）/ 决策中心（下）」；
- **右列上下对调**：分身在上、决策中心在下，中间水平分隔条沿用（拖动 / ↑↓ / 双击 50:50，比例仍存本机 `fang.panel.decision.split`；该值语义始终为“决策中心占比”，向后兼容）；
- 列分隔条语义不变（`fang.panel.split` = 左列占比），文案更新为「母体&元主 ↔ 右侧（分身/决策中心）」；
- 响应式（≤1100px）仍为单列堆叠：母体&元主 → 分身 → 决策中心。

### 验证

- `test/client-layout-dom.test.mjs`：三块 DOM 顺序（母体在左；右列上分身/下决策中心）、双分隔条（拖动/键盘/双击/持久化）全部通过；
- 门禁与发布结果见 `docs/RELEASE-v3.5.4.md`。

## v3.5.3（2026-11-18 已发布）

**母体操作面板三块（母体&元主 / 决策中心 / 分身）；修复原身派生加速分身的插件面同步。**

### 新增与变更

- **母体操作面板三块布局**（2026-11-18）：左列为「决策中心（上）/ 分身（下）」并带水平分隔条（拖动或 ↑/↓ 微调，双击恢复 50:50，比例存本机 `fang.panel.decision.split`）；右列为「母体&元主」；列分隔条保留（`fang.panel.split`）。决策中心不再嵌在分身滚动区，成为独立面板块（`data-zone="decision"`）。

### 修复

- **真机：v3.5.2「分身核心加速引擎」无法启动 & 按钮点击无效（2026-11-18）**，四层根因一并修复：
  1. `forker` 仅在显式配置 `dataRoot` 时才解析 layout → 生产 profile（bundle 层未配 dataRoot）里
     `acceleratedHome=''`，`/fang/api/fork-core` 报 `accelerated.installed=false`（按钮只弹“未安装”，
     看似点击无效），派生加速分身直接 `409 accelerated-cli-missing`。修复：layout 始终解析，
     加速核安装位置统一走 `FANG_HOME` / `fang-home.txt`（与 forker 数据目录解耦）。
  2. `orchestrator` 创建/还原/自启动分身时把**母体 stock CLI** 当 `cliPath` 传给 forker；加速档现在
     只接受加速核入口（config / state / layout），不再把 stock CLI 当候选（JS 入口的 stock CLI 会被
     误判成加速核，静默跑官方 core）。
  3. `buildForkChildEnv` 白名单丢掉宿主的 `ELECTRON_RUN_AS_NODE`；桌面宿主里 JS 入口（加速核 `lib/bin.js`）
     由 Electron 壳的 `process.execPath` 启动，变量丢失时壳把脚本当应用 → 子进程 **exit 0 且无输出**
     （真机“无法启动”的直接原因）。修复：JS 入口 spawn 时显式补 `ELECTRON_RUN_AS_NODE=1`（真 node 无害）。
  4. 面板「分身Core核心加速引擎」按钮的 `onClick` 调用了未定义的 `toast()`（ReferenceError）→ 点击
     无任何反馈；改用 `app.notify()`。同时 spawn 失败响应带回 `code/signal/log`，便于定位。
  回归测试：`test/forker-accelerated-discovery.test.mjs` 4 项 + `test/client-fork-core-dom.test.mjs` 2 项；
  真机等价端到端：隔离母体（stock 3.5.3 + fang 3.5.3）创建加速分身 → `status=ready`、`adapter.version=3.5.3`。

- **修复：原身派生的「加速核心」分身插件面不同步（静默退回 minimal）**（2026-11-18）：
  `forker.provision()` 在 accelerated 分支里误用了 `spawn()` 作用域的 `acceleratedHome`，`ReferenceError` 被
  空 `catch` 吞掉 → `accelNodeModules` 恒为空 → `writeAcceleratedForkProfile()` 静默走 minimal 分支
  （`sync=null`）。表现为：加速分身能启动，但**原身/生产 profile 的第三方插件与 client half 全部失效**。
  修复：在 `provision()` 内按同一规则解析加速核 home；并在「给了 source profile 却解析不到加速核模块树」时
  **显式失败 `accelerated-sync-unavailable`**，不再静默退回。回归测试 `test/forker-accelerated-sync.test.mjs` 3 项。
## v3.5.2（2026-11-17 已发布）

**LSP 能力缝（路线 A/B）+ M5 回流对端 + B-8 专业版激活链 + UI client half 映射 + release 自检修正。**

### 新增与变更

- **B-8 专业版激活链**（`fang.code.run`，默认关闭）：① `contract.delegate.pro.enabled`（默认 false）→ ② `pro.allow` 逐项显式授权 → ③ 每次调用一次性审批票（`POST /fang/api/contract/pro/approval`，TTL + 能力/参数摘要绑定，重放显式拒绝）→ ④ 审计（stage/outcome/limits，ticket 仅存哈希）+ 资源限额（`maxConcurrent`/`timeoutMs`/`maxOutputBytes`）；四环缺一即显式拒绝（错误码 + `detail.stage`）。当前无 `code-runtime` provider，四环通过后仍 `contract-unavailable` + `stage='provider-missing'`（无副作用、不假成功）。新增 `src/lib/pro-delegation.mjs`、`test/pro-delegation.test.mjs`（10 项）、e2e 5 项（**121/121**）；文档 `docs/B-CONTRACT-CAPABILITIES.md` §0.7。
- **UI client half 映射实现（非 spike）**：synced 加速分身对第三方 client half 做**浏览器作用域重写**——`dsh.client.inject` / `external` 与客户端 bundle 中的 `@deepseek-ai/*` 仅在加速核存在对应 client half（含 `dsh-client-ui-primitives` 等 web 静态 seed）时改写为 `@twinsearth/*`，未映射项原样保留并写入 `sync.unsupportedClientHalves`；同时具名纠正 web 组合必需的 `ui-theme` client 行（`CLIENT_ROW_ENABLE_OVERRIDES`，其余 disabled 行不动）。新增 `npm run smoke:ui-client-render` 真机 headless 验收（启动图 88 项含 dsh-context、inject 6/6 重写、app shell 挂载、零模块解析错误）；`dsh-context`「上下文」tab 需打开工作区会话（headless welcome 屏限制已记录）。文档 `docs/UI-CLIENT-HALF-IMPL.md`。
- **M5 回流对端交付（2026-11-17）**：房主探针 `fang-relay-probe.mjs --peer fang` 实测 **exit 0**（`peer=dsh-fang-bundle`、`vendoredFilesOk=true`、`peerLabelSource=src/plugins/orchestrator.mjs`、`relayHandlersRegistered=true`、幂等通过）；交付物 = `src/contract/`（vendored 1.2.0 八文件，VENDOR.json 逐文件 sha256）+ orchestrator 两处可识别注册 + 公共 health `{ok,role,version,peer,accepted}`；publish 幂等/批量口径（运行时 maxBatch=32、maxPayloadBytes=512000）与 `hello` relay 方法已由新测试 `test/m5-contract-delivery.test.mjs`（6 项）覆盖；证据入 `docs/M5-fang-relay-evidence.json`，说明见 `docs/M5-CONTRACT-DELIVERY.md`。本会话 `npm pack` 受本地打包守卫需人工确认，自测用等价解包目录（内容与 npm files 选择一致）。

- **LSP 决策落地（2026-11-17）**：① 语言服务器来源 = **bundle 依赖 npm `typescript-language-server` + `typescript@5.9.3`**；② 安装位置 A+B 都装、能力目录区分（A 母体先做、B 后续增强）；③ workspaceRoot = **母体配置根 + 所有 fork 工作区根（任务 registry 显式登记，`includeForkWorktrees` 可关）** + realpath 校验 + 审计；④ 写类 LSP 不提供；⑤ 母体 Agent 同时挂 `dsh-tool-lsp`。新增配置型 bundle `lsp-provider/`（`@twinsearth/dsh-fang-lsp`：依赖官方三件套 0.2.2-rc.3 + 语言服务器，patch 挂 seam/provider/tool）与 bundle 完整性测试；fang 委托层新增 `collectForkWorkspaceRoots`/`resolveLspAllowedRoots`/`lspAuditRecord`；e2e `--lsp` **124/124**（TS 双文件 fixture 真实 definition/hover/references + fork 工作区根自动登记 + 越界根/文件逃逸拒绝 + workspaceRoot 审计 trail）。
- **M3.5 语言服务器锁定（已落地）**：`typescript-language-server@6.1.0` + `typescript@5.9.3` + 官方三件套 `0.2.2-rc.3` 精确随 bundle 依赖锁定；新增 `lsp-provider/LOCKED-VERSIONS.json`（与 package.json 双向一致性测试，bundle 测试 4 项）；`setup:lsp-live` 同版本可复现；锁版本后 e2e `--lsp` 124/124、`test:lsp-bundle` 5/5。**路线 B 再评估：暂缓（保留 `forkLsp` 探测，不安装不默认启用），触发条件与风险见 RESEARCH §6.2。**
- **B-6 契约口径修订（2026-11-17）**：能力目录 `fang.tool.invoke` **仅 advertise provider 实提供的 4 个只读操作**（definition/references/implementation/hover；无 provider → `actions: []`）；**移除 diagnostics 对外宣称**（测试缝保留，结果标 `testSeam:true/nonProduction:true`，目录 `provider.nonProduction` 标记 test-hook）；写类动作（format/rename/...）从官方语义移除、可读拒绝，**通用审批门禁路径保留**给未来自定义 provider；**错误码映射固定**：`LSP_UNAVAILABLE`→contract-unavailable、`LSP_FILE_OUTSIDE_WORKSPACE`/`LSP_INVALID_PROVIDER`→contract-invalid-request、`LSP_MALFORMED_RESPONSE`/`LSP_SERVER_ERROR`→contract-unavailable（附 `detail.lspCode/serverMessage`，单测 5 组逐条断言）。
- **3.1 母体侧实现口径落地（2026-11-17）**：`fang-lsp-provider` 配置型 bundle（trio 依赖 + patch 行 + 默认 TS 服务器模板）；`ctx.get('lsp')` 可用时注册真实 provider、否则 `contract-unavailable`；动作映射 4 只读；**参数口径改为 0-based 非负整数**（seam 原生坐标直接透传，负数/非整数 → invalid）；workspaceRoot 必填 + realpath 包含校验，**越界 → contract-invalid-request**；**结果归一化** locations→`{path,line,character}`（1-based 展示）、hover→`{contents}`，超限裁剪（maxLocations/maxResultChars + truncated）；超时/并发/审计复用 M5（LSP 查询使用 writeTimeoutMs 冷启动预算）。e2e `--lsp` **124/124**、默认 118/118。
- **bundle 最小组合与安装形式（2026-11-17）**：`lsp-provider/` patch 改为官方 README 组件集的最小组合（fs-local + subprocess-local + dsh-lsp + dsh-lsp-stdio + dsh-tool-lsp）；boot 探针实测本 DSH 解析器要求 `insert:` + 行 id（裸 `- name:` 行被静默忽略），bundle 使用 insert 形式且组件与官方一致；`test:lsp-bundle` 5/5（真实 install→boot：ctx.lsp present+query、tools/lsp 广告）。
- **B-6 动作集合对齐（2026-11-17）**：契约动作 ↔ 官方 seam 操作逐项对齐（definition→goToDefinition、references→findReferences、implementation→goToImplementation、hover→hover）；**implementation 已补入**并用真实 TS interface implementation e2e 验证；diagnostics 仅测试缝（不 advertise、nonProduction）；写类无对象、通用审批门禁保留。e2e `--lsp` **125/125**。
- **母体委托最小正确路径（2026-11-17 确认）**：handler 直接 `ctx.get('lsp').query({operation,filePath,position,workspaceRoot}, signal)`——无需伪造 Agent Session、不走 tools 服务（E7 能力缝；E10 只约束模型工具 dsh-tool-lsp）；e2e 母体无 Agent Session 亦完成 4 只读动作。
- **安装前提证据复核 E1–E5（2026-11-17）**：新增 `npm run verify:lsp-evidence`（只读）——E1 运行时 `0.2.2-rc.3`、E2 官方 LSP 包 0.2.2-rc.3（latest 仅 0.0.1-rc.1，须显式版本）、E5 加速核 npm 有 3.5.0 trio 但本机未安装（forkLsp.available=false）；E3/E4 记录自 asar 提取（Desktop 未带 trio / 底座插件已存在）。记录于 RESEARCH §6.0。
- **能力缝证据 E6–E9（2026-11-17 复核）**：`ctx.lsp` = Cordis Service（registerProvider/query，E6，无 provider 枚举 API）；查询必填 workspaceRoot、四操作闭集、位置 0-based UTF-16、结果闭集 locations/hover（E7）；能力缝故意排除 diagnostics/rename/format/symbol/JSON-RPC（E8）；stdio 按 workspace 懒启动并池化、trusts server 无沙箱、要求 fs/subprocess 同一执行世界（E9）。`verify:lsp-evidence` 扩展为 10 项（E6–E9 静态复核 official 包类型/README）。实现对齐：参数 0-based 透传、结果 1-based 展示、bundle 挂 fs-local/subprocess-local、允许根 fail-closed。
- **模型工具/本机环境/委托层证据 E10–E12（2026-11-17 复核）**：E10 模型工具 `lsp` 为 1-based + Agent Session（无 Session → `LSP_WORKSPACE_REQUIRED`），与委托层 0-based + 显式 workspaceRoot（E7）是两条独立入口；E11 本机无 typescript-language-server（rust-analyzer 仅 Rust），语言服务器必须显式来源；E12 既有委托层已具备白名单/validateToolInvoke/读写分类/审批门禁/审计/e2e 测试缝。`verify:lsp-evidence` 扩为 15 项全绿。
- **母体正式 profile 安装自检与清单（2026-11-17）**：新增 `npm run check:lsp-mother`（只读自检：fang 插件版本、bundle 安装/patch 行、语言服务器绝对路径与可粘贴的 patch 覆盖片段、可选母体 contract 探针）；新增 [`docs/INSTALL-LSP-MOTHER.md`](INSTALL-LSP-MOTHER.md) 人工安装清单（实测状态：profile `desktop`、fang 3.4.2 需先升级、bundle 未装、本机无 tls；含 allowedRoots 安全配置与回滚）。
- **probe:mother 扩展 LSP 探测（2026-11-17）**：`npm run probe:mother` 增加 `capability.list` 的 `lspProvider` 检查，支持 `--workspace-root/--definition-file/--line/--character` 跑真实 definition + hover，`--require-lsp` 在 provider 缺失时退出非 0；`check:lsp-mother` 同步支持真实 hover。安装清单 §5 更新为 `probe:mother --require-lsp` 验收。
- **fork-local 变体 bundle（2026-11-17）**：新增 `lsp-provider-fork/`（`@twinsearth/dsh-fang-lsp-fork`）——路线 B 形态：依赖 `@twinsearth/dsh-lsp@3.5.0` 三件套 + 精确锁定 `typescript-language-server@6.1.0`/`typescript@5.9.3`，patch 挂 seam/stdio/可选 tool（fs-local/subprocess-local 由加速核自带）；**安装默认关闭**、不经过契约委托；完整性测试 3 项。文档 §6.4 说明“复用 patch 形状而非依赖域”。
- **provider 显式区分与安全边界（2026-11-17）**：能力目录 `lspProvider.providers` 显式区分 `mother`（mode=`delegated`/source=`mother-process`）与 `fork-local`（mode=`local`/source=`fork-worktree`），各自只 advertise 实提供能力；fork-local 就绪由加速核探测（`forkLsp`）进入目录但**不改变执行路径**；fork-local 语义上让 LSP 跑在分身 workspace（优于把分身路径交给母体进程）；母体委托坚持 `workspaceRoot` 允许根 realpath fail-closed + 审计（`dsh-lsp-stdio` 无沙箱）。e2e `--lsp` 124/124、默认 118/118。
- **M3.2 母体 LSP 栈原型（已验收）**：`npm run test:lsp-bundle` 把 `lsp-provider/` bundle 安装到**临时测试 profile** 并真机 boot：5/5 PASS（bundle 链接 / 母体 boot / `ctx.lsp` 存在且 query 可用 / tools 服务可见 / 已知工具含 `lsp`）；不写用户 profile。
- **B-6 LSP 真实 provider 接入（路线 A 先行 + 路线 B 增强）**：新增 `src/lib/lsp-provider.mjs`——契约四动作 `definition/references/implementation/hover` 映射官方 `ctx.lsp.query`（无需 Agent Session），1-based→0-based、locations/hover 归一化、seam 错误码映射；**workspaceRoot 显式传入 + `contract.delegate.lsp.allowedRoots` realpath 包含校验（空=拒绝，fail-closed）**；契约口径与官方能力缝对齐（legacy `format/rename/codeAction/apply` → 可读 `contract-unsupported`；`diagnostics` **仅测试缝可用、不 advertise**）；**按实提供能力 advertise**（`advertisedActionsFromSeam` 取 provider 声明与官方 4 操作的交集；无 provider 时 `actions: []`）；`fang.capability.list` 按 provider 区分（`provider`/`lspProvider`，未安装时 available=false）；`detectForkLspSupport()` 探测加速核 fork-local LSP 栈（增强，默认关闭）。单测 12 项；e2e 测试缝模式 **118/118**；**真实 provider 闭环：`npm run setup:lsp-live` + `npm run test:lsp-live`（e2e --lsp 119/119，definition/hover 走真实 `ctx.lsp`，provider=mother）**。**路线 B（fork-local）契约口径已定（2026-11-17）**：契约不新增 fork-local 方法/错误码（fork-local LSP 在分身本地 ctx.lsp 执行、不走契约），能力目录只 advertise 母体真实 provider（不虚假宣称 fork-local），其可用性通过 ccelerated.forkLsp 任务视图字段呈现；**安装默认关闭，等语言服务器来源确定后再做**（本次仅口径修订 + 探测字段传播）。**诚实边界：母体正式 profile 尚未安装 LSP 栈，未安装时读类动作仍显式 contract-unavailable。**

## v3.5.0（2026-11-17）

**加速分身：P0 地基 + P1 开关与运行 + P2 兼容与文档。**

### 新增

- `src/lib/accelerated-install.mjs`：加速核安装/发现（`<FANG_HOME>/accel/cli` + `state.json`；只接受 `lib/bin.js`，拒绝 `.cmd` shim；解析链 config → `FANG_ACCEL_CLI` → state → 标准位置；缺失即 `accelerated-cli-missing`）；
- `src/lib/accelerated-fork.mjs`：加速分身极简 profile（`@twinsearth/dsh-base` + `@twinsearth/dsh-web-app` + `@local/dsh-fang`，恒定三项）+ fang/子插件 junction + 模型 overlay（`@deepseek-ai/dsh-` → `@twinsearth/dsh-`，避免 name mismatch）；
- `src/lib/fork-core-settings.mjs`：`<dataDir>/fork-core.json`（mode/sessionMode），原子写、损坏降级 stock+new；
- `tools/release/accelerated-fork-smoke.mjs` 与 `npm run test:accel-live`；
### 新增

- **D2 混合插件面（加速分身）**：`writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})` 同步原身插件面——官方 bundle 映射、第三方插件包复制、`@deepseek-ai/*` → `@twinsearth/*` alias 桩包（`export * from` 加速实现），不支持项写入 `task.acceleratedSync`（mapped / unsupportedBundles / copiedPlugins / alias）；真机验证 0 导入失败；
- `tools/release/accel-alias-spike.mjs`（`--accel-nm` + `--essence-profile`）：量化 alias 覆盖率（baseline vs 桩包）；
- `npm run smoke:accel-plugins`（`tools/release/accel-plugin-smoke.mjs`）：逐插件功能冒烟——真实 synced profile 启动、逐插件 activated/pending/failed 分类、host 页面 + fang identity 探针（3/3 目标插件激活、identity role=fork）；
- `tools/release/accelerated-install.mjs`（`npm run install:accel`）：安装加速核到 `<FANG_HOME>/accel/cli`；**体积上限 1 GiB，超过需二次确认**（交互提示；CI 用 `--confirm-oversize`），未确认不登记安装；
- 文档：`docs/ACCELERATED-FORK.md`、`docs/ACCEL-FORK-COMPAT.md`、`docs/AUDIT-v3.5.0.md`。

### 变更

- **加速边界**：加速引擎只服务分身 Web；桌面/母体与元主运行态始终原厂 core（essence 的 provision/spawn 显式 `coreMode:'stock'`，源码守卫测试）；
- 旧「加速模式」侧车下线：`/fang/api/accelerated/status|start|stop` 移除，新增 `GET/POST /fang/api/fork-core`（同路径经 `routeMethods` 注册）；路由契约 88 → 86；
- forker：`provision({coreMode:'accelerated'})` 生成极简 profile；`spawn` 按 coreMode 解析 CLI，缺失即失败（**删除静默回退 stock**）；加速模式跳过 fork-seed、官方 node_modules 镜像与官方 headless overlay；`publicFork.coreMode`；
- 开关**不是热更新**：只决定「下一次打开分身」用哪个 core；新派生 / 归档还原 / autostart 会在启动前按开关**重新 provision** 该分身 profile（会话目录不动），运行中的分身保持原 core 直到重新打开；
- 面板按钮文案：**「分身Core核心加速引擎：官方 / 一键加速」**；切换后提示「重新打开分身 Web 生效」；
- **未安装加速核 fail-closed**：点「一键加速」→ 明确提示 `accelerated-cli-missing`（设置未改变）；服务端 POST 同样返回 409 + `unchanged:true` 且不写设置；GET 视图 `effectiveMode:null` + `blocked`（不做静默 stock 降级）；
- orchestrator：新派生/归档还原/autostart 读取开关；`taskView.coreMode`；加速缺失错误透传 `accelerated-cli-missing` + `searched`；会话策略：**默认只新会话**（`new`），`copy` 允许把旧会话**复制成新副本**导入（绝不原地挂载），`inherit` 归一为 `copy`；
- client.js：母体头部「分身核心：原版/加速版」开关（M-09）+ 分身卡「加速核」徽标 + 刷新轮询 `/fang/api/fork-core`；
- approver：Windows ACL 检查改为「仅宽泛主体 + 写权限」才禁用文件桥（继承只读条目不再误判）。

### 验证

- 加速核真机安装：`@twinsearth/dsh 3.5.0`（651 包）；
- `accelerated-fork-smoke` 7/7；`FANG_ACCEL_LIVE=1` forker 真派生通过（identity role=fork, version=3.5.0）；
- 单测：accelerated-install 10、accelerated-fork 9、fork-core-settings 8；
- **M1 能力注册表**：`CAPABILITY_CATALOG` + `DEFAULT_READ_ALLOW`；hello 广告按实际注册 handler（新增 3 个委托方法）；白名单校验/错误码表/版本裁剪（1.1 对端裁剪 1.2 方法）/payload 64KiB 上限均有单测（`test/contract-registry.test.mjs`）；**contract SDK 升到 1.2.0（仅追加）**：METHODS/METHOD_VERSION/ERROR_CODES 追加委托方法与 7 个委托错误码；vendored `src/contract` 从 contract 仓库重新同步（8 文件 sha256 钉死）；
- `npm run probe:mother`（`tools/release/mother-capability-probe.mjs`）：只读探测生产母体服务/契约就绪（实测 `sessionCatalog` READY、`/fang/api/sessions` 200）；
- **B 契约委托 P0**（`src/lib/contract-delegation.mjs` + orchestrator invoke 守卫）：`envelope.meta.delegate=true` 才走委托白名单（默认只读 5 项）、64KiB / 5s 限额超时、`contract-unavailable/unsupported/timeout/invalid-request` 错误码、每次委托审计 `{capability,source,outcome,latencyMs}`；未声明 delegate 的旧调用方语义不变；
- **LSP 真实 provider 调研**（`docs/LSP-PROVIDER-RESEARCH.md`）：官方 LSP 为可选包族（`dsh-lsp` 能力缝 + `dsh-lsp-stdio` + `dsh-tool-lsp`），npm 有与运行版本一致的 `0.2.2-rc.3`；`ctx.lsp.query({operation,filePath,position,workspaceRoot})` 无需 Agent Session，可由母体 fang 插件直接调用；官方仅 4 个只读操作（definition/references/implementation/hover，明确排除 diagnostics/format/rename/JSON-RPC escape）；本机无语言服务器，需先定来源；B-6 动作口径按 provider 实提供能力修订；
- **UI client half spike**（`npm run spike:ui-client`）：真实 synced 加速分身启动页清单 87 项；第三方 client half（dsh-context / dshmarket / fang）bundle 均 200 可提供；缺口为 `@deepseek-ai/*` 作用域行别名（client module system 无 alias 表，加速核已有 `@twinsearth/*` 目标行）；修复 `accelNodeModulesRoot` 路径推导（forker 同步插件面 alias 依赖它）；报告见 `docs/UI-CLIENT-HALF-SPIKE.md`；
- **P2 决议**：`fang.code.run` 定为**单独专业版能力**（默认关闭、不进目录/默认白名单、需手动单独每项授权激活 + 每次调用审批 + 独立安全评审；当前请求显式 `contract-unsupported`）；B-9 UI client half 走浏览器模块映射（不进契约）；B-10 任意工具透传**明确不做**；
- **M5 审计与限流**：委托并发上限 `contract.delegate.maxConcurrent`（默认 4，超限立即 `contract-rate-limited`，fail-closed 不排队）；委托审计覆盖成功/拒绝/超时/限流（`{capability,source,outcome,error,latencyMs}`）；e2e 审计账本完整性 + 并发压测（`maxConcurrent=2` → ok=2/limited=6）；
- **M4 chat.import 委托**：`fang.chat.import`（source=deepseek；`dryRun` 默认 true，确定性预览；真实导入返回 `contract-approval-required` 且零副作用）；新增 `npm run smoke:contract-delegation`（对运行中母体的 B 委托冒烟：能力目录/会话只读/lsp 读+写/chat.import dryRun 一致性+审批拒绝）；
- **M3 lsp 委托**：`fang.tool.invoke`（首批 `tool:'lsp'`）——只读子命令（diagnostics/hover/definition/references）自动放行；写类子命令（format/rename/codeAction/apply）返回 `contract-approval-required` 且不执行；未知 action → `contract-invalid-request`；能力默认不在白名单（需显式放行）；执行 provider 当前仅 e2e 测试缝（真实母体 LSP provider 待接入）；
- **M2 P0 只读能力**：`fang.session.events`（母体 sessionCatalog.readHead 有界头读，≤200 行/≤256KB）；capability.list 目录扩至 6 项只读；白名单为权威放行表、目录仅自述；e2e 新增 `session.events` 与 `contract-timeout`（测试缝 `fang.test.sleep`，仅 `FANG_CONTRACT_TEST_HOOKS=1`）；
- `tools/e2e.mjs` **117/117**（新增 fork-core 契约断言：view shape、essence=stock、未安装切档 409+unchanged、设置不变；新增 B 契约基线：`contract.hello` 200/1.1.0/17 方法、`fang.orchestrator.status` 真实委托、`fang.session.list` 可读错误码；新增 B 委托：白名单目录、`contract-unsupported` 拒绝、只读委托成功、缺服务映射 `contract-unavailable`、`session.events` 有界读、超时 `contract-timeout`、lsp diagnostics 成功 / 写类 `contract-approval-required` / 非法 action `contract-invalid-request`、chat.import dryRun 两次一致 / 真实导入 `contract-approval-required`、并发 `contract-rate-limited`、审计 `contract-delegate` 完整性）；allow-list 110 路由 findings=0；main-city source gate grade=A；`tools/ui-rich-smoke.mjs` 新增 FORK-CORE-00..04（按钮文案/切换 toast/回切/加速核徽标/端点）

### 注意

- 加速分身默认不带第三方插件与官方可选 bundle（见兼容矩阵）；
- 真实模型对话与旧会话继承未做端到端验证；
- 本版**未发布**（无 tag/Release/npm）。

## v3.4.2（2026-11-16）

**加速 Web sidecar + 母体面板加速模式。**

### 新增

- `src/lib/accelerated-web.mjs`：启动/停止/状态、独立 profile/端口、同 `DSH_HOME` 的 `@twinsearth/dsh` Web sidecar；
- `/fang/api/accelerated/status|start|stop`；
- 母体面板「加速模式」按钮：原厂进程不变，启动 sidecar 后打开新窗口；
- forker `coreMode: stock|accelerated` 与 `acceleratedCliPath`；
- 路由契约 85 → 88。

### 验证

- forker/compat 40 pass；orchestrator 68 pass；
- sidecar 实际启动/停止验证通过；
- 原厂启动器与 core 保持不动。

## v3.4.0（2026-11-15）

**收件箱滚动修复 + 测试稳定性修复（3.3.10 的发布阻断解除）。**

### 修复

- 收件箱 `.fang-inbox-body` 明确 flex 高度、纵向滚动、12px 滚动条、wheel 兜底；
- `decision-level-policy` 测试改为有界轮询，消除 Node22 定时器竞态/挂起；
- 3.3.10 tag 未发布，本版包含其全部代码。

### 验证

- `client-inbox-dom` 20 pass；
- `decision-level-policy` 11 pass；
- 全量构建/e2e 见输出。
## v3.3.10（2026-11-15）

**修复：收件箱无法鼠标滚轮滚动、无滚动条。**

### 修复

- `.fang-inbox-body` 明确 `flex:1 1 0; height:0; overflow-y:scroll`；
- 收件箱 drawer 固定 `100vh/100dvh`，AI 区限高 32vh；
- 增加 12px WebKit 滚动条与轨道/滑块样式；
- 增加 wheel 兜底，滚轮显式转给收件箱 body。

### 验证

- `client-inbox-dom` 20 pass；
- 全量构建/e2e 见输出。
## v3.3.9（2026-11-15）

**P0：决策中心工具结果非 lossless JSON。**

### 修复

- `request_human_decision` / `ask_user_choice` 的所有 execute 返回值统一经 `toLosslessJson`；
- 删除 `undefined` 字段，非法数值转 null，BigInt 转字符串；
- 覆盖母体与 fork 两条工具注册。

### 验证

- 新增 resolved 结果无 undefined 回归测试；
- decision-center tests 全绿。
## v3.3.8（2026-11-15）

**主题：默认元主自动同步到当前版本，避免升级后仍派生旧 3.x 快照。**

### 新增

- `profileUsesCurrentFangBundle` 增加同名 bundle 的**版本**判断；
- 启动后异步检测默认元主，旧则 capture 当前 profile + setDefault；
- 审计 `essence-auto-refreshed`，状态字段 `essenceAutoRefresh`；
- 失败不阻塞启动，派生请求仍有 clean-template 兜底。

### 验证

- 旧 legacy bundle / 同名旧版本 → false；当前版本 → true；
- 全量测试/构建见输出。
## v3.3.7（2026-11-15）

**主题：放开门禁，用户两次确认后可自动看护并执行母体重启。**

### 新增

- `restart-guard.autoWatchdog`：批准后无 supervisor 时自动启动 watchdog；
- `tools/restart-watchdog.mjs` / `tools/restart-supervisor.mjs` 加入 npm 包与主城门禁；
- watchdog 写 `supervisor.present` 后 guard 再查三重门禁，避免“先 exit 再发现没人拉”；
- 失败 fail-closed：工具缺失/启动超时/无 marker 不写清单、不退出；
- bundle 默认改为 enforce + allowProcessRestart + autoWatchdog（仍需用户两次确认）。

### 角色边界

- 自动看护仅接在 mother 的 restart-guard；
- fork / 元主运行态仍由 Forker / EssenceRuntime 监督，不直接 exit(75)。

### 验证

- restart-guard 33 pass；orchestrator 68 pass；
- 全量测试/真实 e2e/install drill 见构建输出。
## v3.3.6（2026-11-15）

**主题：重启母体增加红色风险弹窗、分身预确认与二次点击放行。**

### 新增

- 面板头「重启母体」按钮；
- `GET /fang/api/restart/impact`：只读影响面与武装状态；
- `POST /fang/api/restart/request`：缺 `forkChecked`/`finalConfirm` 返回 428；
- 红色弹窗展示：中断会话/工具调用、分身孤儿、未发送队列丢失、staging 需重启生效；
- 第一步必须点「我已在分身确认」，第二步才启用「二次确认：放行重启」。

### 安全边界

- guard 未武装（observe / allowProcessRestart=false / 无 supervisor）时，只记录红色审批，不自动退出；
- 只有 enforce + allowProcessRestart + supervisor 在位，才 exit 75 交给外部 supervisor；
- 不把审批通过伪装成已重启。

### 验证

- orchestrator restart confirmation tests；
- restart-guard 审计含 confirmation；
- 全量测试/真实 e2e/install drill 见构建输出。
## v3.3.5（2026-11-15）

**主题：审批/提升/回滚从“已加载”变成可执行、可验证。**

### 修复

- `/fang/api/approvals` 只聚合 `ready/running` 分身；
- 死分身/停止/回收的分身进入 `skipped`，不再导致整个审批聚合 `degraded=true`；
- 只有活跃分身的真实 adapter 失败才进入 `failed`。

### 新增

- `src/lib/approval-drill.mjs` + `tools/approval-drill.mjs`：临时 dataRoot 内真实执行
  `requestPromotion(red) → pending → decide(approved) → snapshot → rollback`；
- `POST /fang/api/approvals/drill`：运行中宿主可通过同一路由执行隔离 drill，不写生产数据；
- `fangctl approvals drill --url ...` 命令；
- 测试：`test/approval-drill.test.mjs`，orchestrator `/approvals` 聚合跳过离线分身 + drill 路由。

### 验证

```text
approval drill: outcome=approved pending 1→0 snapshot=ok rollback=ok restored=true residue=clean
orchestrator tests: 67 pass
```
## v3.3.4（2026-11-15）

**主题：npm 包改名 + 队列子插件默认关闭 + 新包公开访问修复。**

### 1) npm 包改名

- 新发布身份：`@twinsearth/fang-dsh-plugin`（v3.3.3）；
- 旧包 `@twinsearth/dsh-fang` 保留，`findFangPackageDir` / `FORK_BUNDLE_NAMES` 继续兼容旧安装；
- 本地开发 bundle 名仍是 `@local/dsh-fang`，构建时统一改写为新包名；
- 发布门禁 registry URL、install/reinstall drill、web-entry 配置键、README/当前流程文档同步新名；
- 官方插件市场尚未上线（DSH 当前不内置索引源），本版**不提交任何市场收录**。

### 2) 队列子插件默认禁用

- `dsh-fang-queue-journal` 的 bundle 行默认 `disabled: true`；默认不加载、不注册 composer journal UI；
- queue-journal host half 升级到 `0.1.7`，只有行启用时才 `provide("fangQueueJournal")`；
- orchestrator 的 `/fang/api/composer/journal`、`/history`、`/composer/queue` 在服务缺失时 **503 `queue-journal-disabled`**（fail-closed）；
- `/fang/api/status.services.queueJournal` 暴露真实能力；queue client 再做一次能力探测，旧缓存/残留 client 不会显示 UI；
- 主 client 按 `status.services` 隐藏未激活子插件的对应界面（approver 待批区、forker 看护区）；
- boot-guard 跳过 disabled 行，不因可选子插件未安装而阻塞启动。

### 3) 新 scoped 包公开访问修复

- npm 对新建 scoped 包默认按私有处理，自定义 REST 发布体缺少 `access: "public"` 时返回 402；
- `publish-npm.mjs` 增加 `access: "public"`；构建的 staged package 增加 `publishConfig.access = "public"`；
- 主城门禁新增 `package: publish access public` 检查，防止回归；
- v3.3.3 未发布成功（tag 已删除，不复用），本版为实际发布版本。

### 验证

- `test/queue-journal-gate.test.mjs`：host half 提供 service、bundle 默认 disabled、boot-guard 跳过 disabled；
- orchestrator：queue 服务缺失时 3 条 journal/queue 路由全部 503，服务存在时正常；
- 全量测试 / 真实 e2e / install drill / 主城门禁见构建输出。
## v3.3.2（2026-11-14）

**主题：母体（宿主）浮窗总开关——一键隐藏/显示瓮城在宿主的所有浮窗。**

### 为什么

瓮城在宿主里同时存在多个浮层：决策中继浮标/面板、红色告警、收件箱抽屉、Mother 浮窗、
确认/截图弹层、toast、元主落地提示。逐个关闭既慢又容易漏；用户需要一个「全部收起」
的宿主级开关，同时不能把自己关到无法恢复。

### 新增

- 宿主侧栏底部常驻按钮：`浮窗` / `浮窗已隐藏`（隐藏后仍可见，作为恢复入口）；
- 控制台面板头按钮：`隐藏浮窗` / `显示浮窗`；
- 切换 `html[data-fang-overlays]`，CSS 统一隐藏 7 类浮层；不销毁 DOM、不关闭状态；
- 偏好写 `localStorage["fang.overlays.hidden"]`，刷新/重启保持；
- `storage` 事件跨窗口同步；
- 不隐藏宿主自身 UI 与瓮城控制台，开关按钮本身永不隐藏。

### 覆盖的浮层

决策中继 FAB/面板、红色告警栈、收件箱抽屉/遮罩、Mother 浮窗、确认/截图弹层、toast、
元主落地提示。

### 验证

- client DOM 新增用例：挂载侧栏按钮 → 点击 → html 属性 hidden、localStorage=1、
  5 类浮窗节点仍在 DOM；再次点击恢复；
- 全量队列/决策/客户端测试保持；
- 门禁：source / workflows / package / publish 全部 GREEN。
## v3.3.1（2026-11-14）

**主题：主城门禁补第七类目标 `workflows`——CI/发布工作流自身也要过审计。**

### 为什么

工作流是「谁能发布、能写什么」的执行入口；如果 CI/Release 被改成 `pull_request_target`、`write-all`、
`secrets: inherit`，或者把 PR 标题直接插值进 `run:`，源码门禁可以被完全绕过。
因此把 workflows 提升为与源码/产物同级的门禁目标，而不是只检查业务代码。

### 新增检查

- `workflows` 目标：必需 `ci.yml` + `release.yml`，`on/jobs` 结构、每 job timeout；
- 阻断：`pull_request_target`、`permissions: write-all`、`secrets: inherit`、
  `github.event.pull_request.title/body/head.ref` 直接插值进 `run:`；
- 阻断：CI 必须调用 `tools/gate/main-city.mjs` 且跑全量测试；
- 阻断：Release 必须调用 source gate 且通过 `tools/release/build.mjs`（内含 package/publish gate）；
- `source` 目标同时跑 workflows 检查（双保险）。

### 接线

- CI hygiene：`--target source` + `--target workflows` 两步；
- Release guard：`--target source` + `--target workflows`；
- CLI：`GATE_TARGETS` 现为 source/package/publish/install/deploy/**workflows**/profile。

### 验证

- main-gate 新增 workflows 用例：真实仓库 GREEN；临时注入 `pull_request_target` 变红；
  缺少 release.yml 变红；
- 现有 package/publish/profile/runtime/崩溃循环测试保持。
## v3.3.0（2026-11-14）

**主题：主城门禁——打包、发布、安装、部署、新建 profile 全部先过瓮城查验。**

### 为什么

DSH 是「一切皆是插件」的 Agent 运行时：profile 层叠、插件副作用、Session 日志、沙箱/审批/守卫共同构成系统。
一次错误的 profile 写入、错误的发布产物或崩溃循环重启，可能造成崩溃、卡死、错乱，甚至重装都难以恢复。
因此把「进主城」的动作收敛到同一个 fail-closed 门禁，而不是依赖每次发布时的临时检查。

### 新增：`src/lib/main-gate.mjs` + `tools/gate/main-city.mjs`

- 六个 target：`source` / `package` / `publish` / `install` / `deploy` / `profile`；
- 统一 blocker/warning/info、修复建议、评分（A–E，A/B 才放行）、JSON 报告；
- 产物校验 sha256/sidecar/manifest/必需文件/禁用条目；
- profile 校验路径不越界、bundle 不重复、patch 可解析、活跃宿主拒绝、备份要求；
- 运行时防线：崩溃循环、restart 安全模式、审计哈希链；
- `profile --create` 是唯一允许的建 profile 路径，先过门禁再写；
- `--repair` 在写 profile 前生成 `.gate-backups/<stamp>/`；
- 门禁结论写入链式审计（`main-city-gate`），链坏时拒绝追加。

### 接线（Fail-closed）

| 链路 | 接入点 |
|---|---|
| 构建 | `tools/release/build.mjs` 末尾跑 `--target package`，blocker 即构建失败 |
| 预检 | `tools/release/preflight.mjs` 跑 `--target source` |
| 发布 | `tools/release/publish-npm.mjs` 先跑 `--target publish`，再触碰 registry |
| 安装 | `install-drill` / `reinstall-drill` 在 boot 前跑 `--target install` |
| 部署 | `restart-watchdog` 在 boot-guard 之后跑 `--target deploy`（execute 时自动备份） |
| 新建 profile | `forker.provision` 新 profile 首次落盘前跑 `--target profile --create` |
| CI | ci hygiene / release guard 增加 source gate |

### 重启卫士：崩溃循环制动

- `detectCrashLoop`：15 分钟内 ≥3 次 uncaughtException = 崩溃循环；
- 崩溃循环自动写 `restart/safe-mode.json`，**即使 enforce + allowProcessRestart + supervisor 全绿也拒绝交接执行权**；
- `clearSafeMode({by,note})` 归档 crash ledger 后人工恢复，并写链式审计；
- 启动/status/policy/executionContract 全部暴露 safeMode/crashLoop。

### 评分、审批、审计、修复

- scorer：新增 `scoreGateFindings`（0 warning=A / 1–2=B / 3+=C / blocker=E）；
- approver：门禁在写 profile 前生成审批式快照（`.gate-backups`），不覆盖；
- auditor：部署/安装/发布校验链，坏链拒绝；门禁结论写链；
- healer：提供修复建议，不确定时 fail-closed（门禁 blocker）。

### 验证

- 新增 `test/main-gate.test.mjs`（9 例）：源码/产物/发布/profile/运行时/崩溃/建 profile/评分；
- 新增 `test/restart-crash-loop.test.mjs`（3 例）：检测、安全模式、人工解除；
- 现有 forker/restart/approver/auditor/scorer 测试全部保持；
- 真实 e2e 仍为 95/95。
## v3.2.2（2026-11-14）

**主题：决策等级显式化——优先级 P0–P3、风险程度 high/medium/low/info，四色分组常驻。**

### 为什么

实测运行实例仍只有红色 ticket 与红色提醒，黄/蓝/绿既没有生成记录，也不容易在收件箱确认
（无记录时整组消失）。同时缺少可排序、可审计的优先级与风险字段。

### 优先级与风险

| 等级 | 默认优先级 | 默认风险 | 语义 |
|---|---|---|---|
| 红 | P0 | high | 真正阻塞，必须人工 |
| 黄 | P1 | medium | 影响方向/进度，3 分钟后继续可补选 |
| 蓝 | P2 | low | 低风险日常建议，1 分钟后按推荐执行 |
| 绿 | P3 | info | 阶段完成/自动执行留底 |

- 新增 `priority` / `risk` 正式字段，随 ticket 落库、API 返回、重启恢复；
- 可由调用方显式覆盖（例如低等级但高风险的安全票：`level=blue, priority=P0, risk=high`）；
- 未知值安全回落到等级默认值；`risk` 支持 `critical→high` 等别名。

### 工具协议

- `request_human_decision` 新增可选 `priority` / `risk`，返回带两者；
- `ask_user_choice` 不再固定转红：可选 `level=red|yellow|blue|green`（默认 red），
  并遵循黄/蓝/绿的等待与自动执行策略；工具描述明确要求按风险选等级，不要全部用红色。

### 收件箱/右栏

- 四色分组**常驻显示**（0 条也显示等级、优先级、风险与“暂无记录”），不再整组消失；
- 每个 ticket 显示优先级与风险徽标（服务端字段优先，旧数据按等级推导）；
- 右栏等级标题改为「红色 · P0/高」等，条目附带优先级与风险。

### 验证

- 新增优先级/风险默认、覆盖、别名与落库测试；
- 新增 `ask_user_choice` 显式黄/蓝/绿策略测试；
- 新增 jsdom 测试：0 条时五组常驻、优先级/风险徽标；
- 真实母体 e2e 增加 P3/info 默认、P2/high 覆盖、P0/high 默认与磁盘断言。
## v3.2.1（2026-11-14）

**主题：四色决策状态机复盘加固——不丢票、不重复、不追溯。**

### 查漏补缺

1. **黄色 defer 幂等**：调度定时器与 wait 定时器同时到期时只写一次，不重复升 rev/审计；
2. **pending 防修剪**：达到 `maxTickets` 时只淘汰已处理历史，黄色 pending 不再被静默删除，
   真正满足「一直等待选择」；
3. **取消不等于放弃**：Agent abort 等待时只有红色转 abandoned；黄/蓝保留，黄色仍可补选，
   蓝色仍按窗口自动执行；
4. **旧票兼容**：没有 `waitDeadlineAt` 的旧 pending 不再被 `Number(null) <= now` 误判为已到期，
   不会被追溯自动执行；
5. **fork 蓝色竞态**：轮询超时前再取一次最终状态，避免母体刚自动执行而 fork 误报失败。

### 验证

- 新增 `test/decision-policy-hardening.test.mjs`（4 例）：并发/重复 defer 幂等、pending 防修剪、
  黄蓝 abort 保留、旧票无 deadline 不误执行；
- v3.2.0 的四色策略、真实落库、重启与 DOM 测试继续通过。
## v3.2.0（2026-11-14）

**主题：决策中心四色状态机——红色强制人工、黄色超时继续可补选、蓝色推荐自动执行、绿色静默留底。**

### 红色：强制暂停等待人工
- 保持唯一硬阻塞等级；未选择前不继续，不由 AI/超时自动代选；人工选择与动作结果落库。

### 黄色：3 分钟后继续，永久可补选
- 默认等待窗口 3 分钟；窗口结束返回 `outcome=deferred`、`continueWithoutDecision=true`；
- ticket 保持 `pending` 与原黄色，**不灰化、不过期**，收件箱仍可直接选择；
- 后续人工选择写 `lateResponse=true`，并在此时执行对应 action handler。

### 蓝色：1 分钟后按推荐自动执行
- 默认等待 1 分钟；未选择则自动选推荐项（无推荐标记时确定性取第一项）；
- 写 `autoResolved=true`、`autoReason=blue-timeout`、`resolvedBy=auto:blue-timeout`；
- 只执行已注册 action handler，`ticket.execution` 记录 running/done/failed。

### 绿色：自动执行并留底，不提醒
- 创建即按推荐/ACK 闭环，`autoReason=green-immediate`；
- 不进入 pending 计数、不触发红色强提醒；收件箱绿色分组与历史保留记录。

### 收件箱与历史修复
- 黄/蓝/绿的已处理记录按原颜色展示，不再只有红色可见；
- pending 与历史同组展示、pending 置顶；灰色组仅放真正的灰色归档，避免重复；
- 状态文案覆盖：等待人工、3 分钟后继续、已超时继续可补选、1 分钟后推荐执行、已自动执行、已补选。

### 数据契约
- 新增 `waitMode`、`waitDeadlineAt`、`deferredAt`、`autoResolved`、`autoReason`、`lateResponse`、`policyTimeoutMs`；
- `waitDeadlineAt`（流程等待窗口）与 `expiresAt`（归档期限）彻底分离；
- 重启只恢复带 `waitMode` 的新策略票；旧版 pending 票不会被追溯自动执行。

### 验证
- 新增 `test/decision-level-policy.test.mjs`（8 例）：四色默认值、红色人工、黄色补选执行、
  蓝色自动执行、绿色静默、四色历史、JSON 落库与重启恢复、Agent 工具返回；
- 新增真实 jsdom 收件箱测试：四色历史、黄色补选按钮、绿色无强提醒、pending 计数；
- 更新原决策测试到新语义；contract/relay 等其它功能不变。
## v3.1.35（2026-11-13）

**主题：适配 @twinsearth/dsh-fang-contract@1.1.0 —— 新增两个回流（relay）方法。**

### 一、同步 vendored 契约副本到 1.1.0

- `src/contract/` 从 npm 包 `@twinsearth/dsh-fang-contract@1.1.0` 逐字节同步（8 个文件，1.0.0 是 7 个）；
- 新增 `relay.js`（`validateRelayEvents` / `createRelayStore` / `relayHandlers` / `createRelayContractServer`）；
- `CONTRACT_VERSION` 1.0.0 → **1.1.0**；
- 新增 `src/contract/VENDOR.json`：钉死来源版本与每个文件的 sha256，供一致性测试比对。

### 二、注册回流 handler

`src/plugins/orchestrator.mjs`：

```js
const relayStore = createRelayStore({
  peerLabel: 'dsh-fang-bundle',   // 房主据此判定「已与真实瓮城对接」
  role: gate.role,
  instanceId: `fang-${gate.role}-${process.pid}`,
})

const contractServer = createContractServer({
  role: gate.role,
  instanceId: `fang-${gate.role}-${process.pid}`,
  handlers: {
    ...relayHandlers(relayStore),  // ← 1.1 新增，只加这一行
    // …1.0 handler 全部原样保留
  },
})
```

- 方法自动进 `hello().methods`（来自 handler registry），文件兜底与 HTTP `/invoke` 自动生效；
- `/fang/api/contract/*` 继续走现有 Bearer token，**未新开无鉴权路由**；
- health 增加只读回流计数 `relay: { peer, cursor, accepted, duplicates, rejected, lastAt }`。

### 三、协议约束（由 1.1.0 实现保证）

- 幂等：同一 `event.id` 重复投递只接受一次，其余计入 `duplicates`；
- 有界：单批 ≤128 / 单事件 ≤32KB / 整批 ≤512KB，超限抛 `relay-events-invalid`，**不静默截断**；
- 游标单调：`cursor` 只增不减；
- peer 自报：`fang.relay.status().peer === 'dsh-fang-bundle'`；
- 内存有界：`maxRecords: 5000`。

### 四、兼容性

| 瓮城 contract | 房主 | 结果 |
|---|---|---|
| 1.1 | 3.3.1 | 回流开启，`peer=dsh-fang-bundle` |
| 1.1 | 3.3.0 | 老房主不认识新方法，`negotiate()` 裁剪，不受影响 |
| 1.0（旧瓮城） | 3.3.1 | 回流关闭，房主给出 `peer-contract-without-relay:1.0.0`，其余照常 |

1.0 方法（fork/decision/session/orchestrator）行为**一字未改**。

### 验证

- 新增 `test/contract-vendor-sync.test.mjs`（4 例）：版本钉死 / 8 文件 sha256 逐字节一致 /
  `relay.js` 在位 / 无游离文件；
- 新增 `test/contract-relay-1.1.test.mjs`（5 例）：hello 宣告两方法 + `event-relay` /
  重投幂等 accepted:0 duplicates:1 且 cursor 不倒退 / 超限与空批报错不截断 /
  `peer === 'dsh-fang-bundle'` / 1.0 方法行为不变；
- contract 相关测试合计 **38 例全过**。
## v3.1.34（2026-11-13）

**主题：分身会话 1–3 约束与默认空会话；派生弹窗 5 秒兜底；POSIX 工作区编码修复。**

### 一、分身会话数约束 1..3（用户规格）

> 默认一个分身 Web 端的分身会话，默认不能为 0 至少有 1 个（空会话），不超过 3 个，可以有多个分支。

新增 `src/lib/fork-sessions.mjs`：

- **下限 1**：`ensureForkEmptySession()` 在空白派生前补一个空会话；
  日志严格按 DSH 实测格式生成（5 帧 / `session` v4 / zstd，实测 285–397 B 与真实空会话同构）；
- **上限 3**：`enforceForkSessionCap()` 保留最新 3 个，其余移入 `quarantine-sessions/`（**不删除**）；
- **分支豁免**：`keepSessionIds` 里的分支会话不参与淘汰；
- v3.0.9 的「单会话强制」升级为「1..3 会话护栏」（`applySingleSessionGuard` → `applyForkSessionGuard`）。

### 二、派生弹窗 5 秒兜底

- `DERIVE_PICKER_TIMEOUT_MS = 5000`：倒计时文案「N 秒内不选择将默认新建空会话」；
- 超时 `settle(null)` → 不导入母体历史，直接派生空会话分身；
- 新增「新建空会话」按钮可立即跳过；`settled` 幂等 + `clearInterval` 清理。

### 三、POSIX 工作区编码修复（MacMini 分身空列表）

实测：DSH 把 `/Users/fang/Desktop/DS` 编码为 `--Users-fang-Desktop-DS--`，
fang 的 `encodeWorkspaceKey()` 却编码成 `---Users-fang-Desktop-DS--`（多一个前导 `-`）。
导入会话时用错误的 key 去合并工作区索引 → 永远匹配不上 → 分身 `workspace.json` 为空
→ Web UI 里既看不到导入的会话，也没有「新建会话」入口。

修复：折叠非法字符后**去掉首尾多余的 `-`** 再包 `--`。已验证：

```text
E:\GPT                 → --E-GPT--                    （无回归）
C:\Users\a\b\c        → --C-Users-a-b-c--            （无回归）
/Users/fang/Desktop/DS → --Users-fang-Desktop-DS--   （修复）
/Users/fang/Desktop/DS/→ --Users-fang-Desktop-DS--   （尾斜杠）
```

### 验证

- 新增 `test/fork-sessions.test.mjs`（6 例）：边界 1..3 / 空会话合法性（zstd 往返解出 5 帧）/
  下限幂等 / 上限隔离 / 分支豁免 / 空目录 summary；
- 新增 `test/workspace-key-posix.test.mjs`（5 例）：Windows 无回归、POSIX 不多前导 `-`、
  尾分隔符、绝不产生三段连字符、空输入；
- 新增 `test/client-derive-picker-timeout.test.mjs`（4 例）；
- `test/session-format.test.mjs` 14 例无回归。
## v3.1.33（2026-11-13）

**主题：修 macOS 上「启动元主 Web 失败 · runtime-spawn-failed: spawn-error」。**

### 实测报错（MacMini 母体端）

```text
启动元主 Web 失败
请求失败：runtime-failed
runtime-spawn-failed: spawn-error
  (forkId=rt-1794546949341-9c73b5,
   homeDir=/Users/fang/.dsh/fang/desktop/runtime/essence-1794546949341-9c73b5/home,
   profile=essence-runtime)
```

### 根因

`resolveCliPath()` 是**纯 Windows 实现**：只探测 `dsh.cmd` / `dsh.exe`，
安装根反推只拼 `resources/runtime/cli/bin/dsh.cmd`，最后还有两条硬编码盘符：

```js
'E:\\DS\\resources\\runtime\\cli\\bin\\dsh.cmd',
'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
```

macOS 上的真实结构是：

```text
/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness     ← 宿主
/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
                                         ↑ 大写 Resources，且无 .cmd 扩展名
```

→ 全部候选都落空 → 回落到裸 `dsh` → 若不在 PATH 中，`spawn('dsh')` 抛 ENOENT
→ 被 forker 捕获成 `spawn-error` → 元主运行态启动失败。

### 修复

1. `resolveCliPath()` 改为平台感知：
   - Windows：`dsh.cmd` / `dsh.exe` / `dsh`，目录 `resources` → `Resources`；
   - macOS/Linux：`dsh` / `dsh.sh`，目录 **`Resources` 优先**（.app 的真实大小写）；
   - 安装根反推向上 6 层，同时尝试 `resources` 与 `Resources`；
   - 非 Windows 兜底：`.app/Contents/Resources/runtime/cli/bin/dsh`、`~/Applications/...`、
     `/opt/homebrew/bin/dsh`、`/usr/local/bin/dsh`、`/usr/bin/dsh`。
2. spawn 失败的报错带上真实 errno 与启动规格：

```text
runtime-spawn-failed: spawn-error (forkId=…, homeDir=…, profile=essence-runtime)
  message=spawn dsh ENOENT
  spec=/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh --profile … --port …
  log=…
```

### 验证

- 新增 `test/cli-resolve-platform.test.mjs`（4 例）：
  显式路径优先 / PATH 上的无扩展名 launcher / macOS .app Resources 布局 / 绝不回落 Windows 专属路径；
- Windows 实机解析仍返回 `E:\DSH\DS\resources\runtime\cli\bin\dsh.cmd`（无回归）。
## v3.1.32（2026-11-13）

**主题：绿色「派生新分身」改为「默认元主 + 选择一个进行中会话」。**

### 实测问题（v3.1.31 界面）

点绿色「派生新分身」后直接出现红色提示：

```text
派生失败 · session-required
请求失败：session-required
派生分身需要先选择一个进行中的会话（一次只能导入一个）
```

原因：绿色按钮执行的是 `deriveTask({ title: '派生新分身' })`——**没有 sessionId**，
而 v3.1.30 起服务端 `derive()` 已强制要求一个会话，于是必然被拒。
同时它也没有关联「开发者推荐（官方）」默认元主。

### 修复

新增 `deriveQuick()`，绿色按钮改走它：

1. 读取 `GET /fang/api/essence/list`，取 `defaultId`（开发者推荐/官方默认元主），
   没有默认则取第一个活跃元主；没有元主时明确提示先克隆母体；
2. 读取进行中会话，弹 `showDerivePicker` **单选**一个会话；
3. `POST /fang/api/tasks/create` 带 `essenceId` + `importSession: { sessionId }`。

空状态里的「派生新分身」同样改走 `deriveQuick()`。

### 验证

- 新增 `test/client-derive-quick.test.mjs`（4 例）：按钮接线、默认元主解析、单选复用、app 暴露；
- 真实母体实测派生链路：

```text
模板      : essence-official-dev「开发者推荐（官方）」  ← defaultId 命中
可选会话  : 26
tasks/create → 200  ok=true  port=18001
status    : ready  adapter=true
imported  : { ok:true, sessionId:…, title:"GPT", workspaceKey:"--E-GPT--" }
落库      : sessions/--E-GPT--/session-…/session.v4.jsonl.zstd（50,050,146 B）
profile   : package.json readonly=false，cordis.patch.yml readonly=false
残留      : reap → removed=true，fork home 已删除
```
## v3.1.31（2026-11-13）

**主题：修「生成元主失败」（折行纯量解析）+ 让 CI 的远端复核/终检真正执行。**

### P1 · 生成元主失败（阻塞功能）

实测报错：`capture: mother patch parse failed: line 93: unexpected indentation / content`。

母体 `cordis.patch.yml` 第 92–93 行是 **DSH 自己写出的折行纯量**：

```yaml
        description: Stronger agentic coding, ...; suited
          to complex or quality-critical tasks at higher cost.
```

合法 YAML，但 `parseYamlSubset()` 的逐行子集解析器不接受续行，
在 `src/lib/rule-registry.mjs:293` 抛出 `unexpected indentation / content`，
于是**只要 profile 里有折行描述，生成元主 100% 失败**。

修复：新增 `foldContinuations()`，在三处纯量赋值点之前吸收更深缩进的**非结构**续行
（既不是 `key:` 也不是 `- item`），按 YAML 折行语义用单个空格拼接；
结构行一律不吸收，避免吞掉兄弟键。

实测：真实母体 patch 解析 **0 错误**，折行值拼成 `Stronger agentic coding; suited to complex ...`。

### P2 · CI 的 healthz / final verify 一直 skipped

`if` 仍引用已在 v3.1.25 删除的 `npm` / `github-release` job：

```yaml
healthz: if: needs.npm.outputs.published == 'true'        # job 不存在 → 永远 false
verify : if: needs.github-release.result == 'success'     # 同上
```

→ 三方发布的远端复核与终检**从 v3.1.25 到 v3.1.30 从未真正执行**。

修复：
```yaml
healthz: if: always() && needs.build.result == 'success'
verify : if: always() && needs.build.result == 'success' && needs.mirror.result == 'success'
```

### 验证

- 新增 `test/yaml-folded-scalar.test.mjs`（5 例）：折行 / 多折行 / 不吞兄弟键 / 序列内联键 / 引号共存；
- `test/rule-config.test.mjs` 37 例全过（无回归）；
- 真实母体 patch 复现 → 修复后 0 错误。
## v3.1.30（2026-11-12）

**主题：修「分身启动/还原失败 spawn-failed」真因，并让元主无对话启动、派生必须导入一个会话。**

### 一、spawn-failed 根因（P0）

v3.1.28 实测：派生与还原分身都失败，审计里是 `fork-crashed exited` + `restart-given-up:never-ready`。
手工用同一个 fork profile 启动，拿到原始报错：

```text
Error: EPERM: operation not permitted, open
  '<forkHome>\profiles\<profile>\package.json'
  at writeFileSync (dsh-app-boot/lib/index.js writeProfileManifest)
  at dropRetiredBundles (… loadProfileDirectory → loadProfile → prepareProfile)
```

原因：`setProfileConfigReadonly()` 把 profile 的 `package.json` / `cordis.patch.yml` 设成 0444，
而 **DSH 0.2.2 每次启动都会重写 package.json**（dropRetiredBundles），于是子进程在引导阶段
直接 EPERM 退出 → 上层只能看到 spawn-failed。解除只读后同一 profile 立刻正常启动（已复验）。

修复：
- `setProfileConfigReadonly(profileDir, true)` **不再 chmod** 任何 DSH 引导必须写的文件
  （`READONLY_LOCKED_FILES` 为空）；
- `readonly=false` 仍执行 `chmod 0644`，并返回 `repaired[]`，**自动修复历史版本留下的只读分身**；
- 行为锁不变：`applyForkConfigLock()` 继续禁用 `tool-plugin-manager` / `ui-settings-plugin-inventory`，
  分身里依旧装不了插件、改不了插件设置。

### 二、元主 Web 无对话启动（需求 1）

- 打开元主 Web 不再弹「导入进行中会话」选择器，直接 `startEssenceRuntime(essenceId, [])` 无对话启动；
- 与 v3.1.23 的界面收敛一致：元主不允许会话，会话按钮与工作区已隐藏。

### 三、派生必须导入一个会话（需求 2）

- 服务端 `service.derive()` 硬校验（此前只有客户端提示，API 可以绕过）：
  - 不给 `sessionId` → `session-required`；
  - 给多个 `sessionIds` → `session-multi-not-allowed`（一次只能导入一个）；
- UI 侧派生仍然弹「选择一个进行中的会话」，单选。

### 验证

- 新增 `test/fork-config-lock.test.mjs`（3 例）：锁不得只读、解锁修复历史 0444、行为锁仍在；
- `test/orchestrator.test.mjs` 更新派生契约（62 例通过）：无会话/多会话均被拒绝且不建任务；
- `build` preflight GREEN（含 e2e）。
## v3.1.29（2026-11-12）

**主题：README 增加 DSH 运行时版本徽章（docs-only，无运行时行为变化）。**

### 变更
- `README.md` 顶部徽章区新增 `DSH 0.2.2-rc.1`（Shields.io，deepseek logo，链接到 deepseek-harness），
  与 CI / license / SDK / npm 徽章并列；
- `package.json` / `FANG_VERSION` / 版本断言测试 → 3.1.29（仅版本元数据）。

### 验证
- `node tools/git/pr-gate.mjs` GREEN（docs-only + 版本元数据）；
- `node tools/release/build.mjs` preflight GREEN。
## v3.1.28（2026-11-12）

**主题：发布流水线定稿——删掉与 build 重复的 npm / GitHub Release 独立 job。**

### 修复
- v3.1.27 中 build job 已直发 npm 与 Release，但独立的 `npm publish` job 又发一次，报
  `HTTP 409 Cannot publish over previously staged version "3.1.27"`，把流水线打红，
  连带 `healthz` / `final verify` 被 skip；
- 本版**删除** `npm` 与 `github-release` 两个独立 job（内容已由 build 覆盖），
  发布链定稿为：`guard → test → build（含 npm + Release）→ mirror / healthz → verify`。

### 验收
- v3.1.28 全链零人工兜底跑通（build / Release / mirror / npm / healthz / verify 全 success）。
## v3.1.27（2026-11-12）

**主题：发布流水线最后一个单点——build job 缺 contents: write。**

### 决策中心浮窗（用户当面要求）
- 浮窗**居中**（	op:50%;left:50%;translate(-50%,-50%)），高度 **1/3**（height:33vh），宽度保持不变；
- 无遮罩、不挡会话与工作区；选完 / 点外部自动收起为小浮标（沿用 v3.1.24 行为）。

### 修复
- build job 现在亲自创建 GitHub Release 并上传资产，但 workflow 级权限是 contents: read，
  导致 POST /releases → HTTP 403 Resource not accessible by integration（v3.1.26 就是卡在这里，
  npm 已发成功、Release 没发出去）。本版给 build job 显式加 permissions: contents: write。

### 流水线现状（v3.1.26 → v3.1.27 的修复链）
| 单点 | 症状 | 修复版本 |
|---|---|---|
| artifact 上传 ENOTFOUND | npm/Release 被 skip | v3.1.25（非阻塞） |
| 工作区复用 .githooks 撞名 | Move-Item 失败 | v3.1.26（解包前清空） |
| runner 无 gh CLI | gh: not recognized | v3.1.26（改 REST 脚本） |
| build job 无 contents: write | 403 Resource not accessible | **v3.1.27（本版）** |
## v3.1.26（2026-11-12）

**主题：把发布流水线剩下的两个单点修掉（自托管 runner 无 gh、工作区复用撞名）。**

### 修复
- **runner 没有 gh CLI**：v3.1.25 的 build job 在直传 Release 时 gh: not recognized。
  新增 	ools/release/upload-release-assets.mjs（纯 REST，幂等：release 复用、同名资产替换），
  workflow 改为调用它；
- **工作区复用导致 .githooks 嵌套撞名**：v3.1.24/v3.1.25 的 Move-Item 报
  Cannot create ...\.githooks\.githooks。build job 解包前新增「工作区清空」步骤，
  残留在拦截时直接失败（不静默继续）；
- upload-artifact 保持 continue-on-error（仅存档），npm / Release 都不再依赖它；
- healthz / mirror / erify 依赖 uild，避免上游 skip 连锁 skip。

### 验证
- 本版发布即验证：完整走 build → npm → Release → healthz → mirror → verify，无需人工兜底。
## v3.1.25（2026-11-12）

**主题：让「大模型主动开票」真正生效 + 修掉发布流水线的单点（artifact 上传）并三方发布。**

### 一、PM 主动开票策略（新增）
- 新增 `PM_DECISION_POLICY` / `PM_PROACTIVE_HINT`（`src/plugins/decision-center.mjs` 导出）：
  把「什么情况必须开票、什么情况不要开票、怎么问」写进 **模型可见的工具 description**
  （`ask_user_choice` / `request_human_decision` 主母体与 fork 两侧都注入）；
- 新增 `docs/PM-DECISION-POLICY.md`：mustAsk 7 条 / mustNotAsk 3 条 / 提问规则 5 条 /
  `autoDecide` 边界（red 与 blocking 永不自动）；
- 判据写死：只有「决策代价 > 打断一代价」才开票，避免注意力噪音。

### 二、发布流水线修单点（v3.1.24 发布卡住的真因）
- 现象：build job 本身绿（`tests pass=1044 fail=0`、`e2e 81/81`、`green true`），
  但 `upload-artifact` 对 `results-receiver.actions.githubusercontent.com` 解析间歇 `ENOTFOUND`，
  导致 `npm publish` / `GitHub Release` 全部被 **skip**（重跑 3 次同一处）；
- 修复：
  1. `upload-artifact` 改为 **非阻塞**（`continue-on-error: true` + `if-no-files-found: warn`），
     artifact 只作存档，不再作为发布路径的单点；
  2. build job 内 **直接发布**：npm（主包 + queue-journal，幂等跳过已存在版本）与
     GitHub Release 资产上传（`gh release upload --clobber`，幂等）；
  3. 下游 `healthz` / `mirror` / `verify` 改为依赖 `build`（而非 npm/Release job），
     避免上游被 skip 时连锁 skip，远端复核仍然执行。

### 验证
- `build` preflight GREEN（含 e2e 81/81）；
- `test/decision-center.test.mjs` 84 例通过（含策略注入后的工具描述契约）。
## v3.1.24（2026-11-12）

**主题：决策中心浮窗改造——底部 1/3 高度、不遮挡会话与工作区、选完/点外部自动收起为小浮标。**

### 变更
- `客户端 · 决策中继面板`：由「右侧全高抽屉 + 半透明遮罩」改为 **底部悬浮卡片**
  （`height:33vh`、`min-height:220px`、`bottom:12px`、圆角、无遮罩），不再挡住会话与工作区；
- **点击面板外部任意位置**（`pointerdown` 捕获）即收起为右侧小浮标；
- **完成选择后自动收起**（`submitOption` / `submitCustom` 成功后 `setOpen(false)`）；
- 遮罩层保留 DOM 但 `display:none`，确保旧引用不炸、也不再拦截点击。

### 决策中心可见性 / 自动化修复（用户反馈"开发了一整天都没见它出来"）

1. **入口常驻**：会话右侧的「待选」小浮标 **0 待选也显示**（半透明 + 计数 0 + 提示语），
   不再"没有 pending 就完全看不到决策中心"；
2. **重启不丢 pending**：此前重启会把所有 pending 强制改为 `expired/gray`（刷新后收件箱空白）；
   现在**未过期 pending 保留**（人仍可回答），只把真过期的置灰；恢复时 `isBlocking=false`，绝不挂起 Agent；
3. **AI 自动决策（新增）**：`autoDecide` 配置（默认开，`levels:["green"]`、`minConfidence:0.8`、要求推荐项低风险），
   满足条件时 AI 建议直接落为决策（`resolvedBy=ai-auto`，审计 `decision-ai-auto-resolved`）；
   **red / blocking 永不自动**，仍需人工明确选择。

### 验证
- 新增 `test/client-decision-relay.test.mjs`（3 例）：1/3 高度 CSS、无阻塞遮罩、点外部收起、选完自动收起；
- `npm test` 全绿；`build` preflight GREEN。
## v3.1.23（2026-11-12）

**主题：元主 Web 只做「插件控制台」+ 3.1.21 上站后的两处收口。**

> 版本说明：`3.1.22` 未发布，本版直接以 `3.1.23` 上站（见 `docs/RELEASE-WAIVER-3.1.23.md`）。

### 修复
- **`tools/recover-queue.mjs` 未进 npm 产物**：`package.json#files` 原清单没有它，
  导致 3.1.21 安装后工具不存在。已补入 `files`，并随本版重新上架。
- **queue-journal 误采集自家 UI**：历史快照里出现过 `恢复全部 / 队列 1 / 清除` 这类按钮文案
  （JournalDock 自己渲染的条目被 `[class*="queue"]` 宽松扫描抓到）。
  0.1.6：扫描时跳过 `[data-fang-entry]` 子树，并把「恢复全部/恢复草稿/队列 N/历史 N/清除」
  加入动作标签过滤。

### 元主（essence）Web 界面收敛（v3.1.23 内容并入本版）

1. **不允许执行会话/任务/指令**：隐藏输入区（composer）与发送按钮，Enter 在输入区内被拦截；
   底部常驻提示「仅插件安装/设置与系统设置可用；会话、任务与指令请在母体或分身中执行」。
2. **派生必须选会话**：元主在没有 `sessionId` 的状态点「派生新分身」时直接拒绝并提示；
   **分身内隐藏「新会话/新建会话」**，只允许「分叉会话」。
3. **隐藏「工作区」与「新会话」**，只保留插件安装/插件设置/系统设置；
   首次进入自动落到**插件设置页**（`html[data-fang-essence-landing="plugins"]` 可观测）。

**实机核查发现并修复的两处**（在真实元主 Host + 无头浏览器里点验）：
- 宿主侧栏文案带快捷键后缀（`新会话Ctrl+Alt+N`），原来的「标签 + 空格」匹配会漏 → 改为**标签前缀匹配**；
- 「工作区」不是单个按钮而是**分组标题 + 工作区行**，按钮级隐藏不够 → 新增 `hideWorkspaceBlock()` 整段收起。

实现：`client.js` 新增 `mountEssenceUiLocks()`（DOM 收敛 + 事件捕获拦截 + 一次性落地页跳转，
不依赖宿主内部 API）；`mountForkUiLocks()` 的侧栏隐藏清单加入「新会话/新建会话」；
`deriveTask()` 增加元主无会话护栏。

### 验证
- 真实运行态（3.1.21 已生效）核对：
- 真实运行态（3.1.21 已生效）核对：
  - `@twinsearth/dsh-fang@3.1.21` + `dsh-fang-queue-journal@0.1.5` 均已激活；
  - `GET /fang/api/composer/journal/history` 路由存在；
  - **真实 dataDir（D:\ToFuture\mirror\desktop）已出现 `composer-journal-history.jsonl`，
    且捕获到真实排队消息内容**（证明「变化即写 + append-only 历史」已在线上工作）。
- `npm test`：1091 tests / 1080 pass / 0 fail
## v3.1.21（2026-11-12）

**主题：队列永不丢 —— 客户端采集 + 恢复 UI + 恢复工具（升级 `dsh-fang-queue-journal` 到 0.1.5）。**

### 根因（v3.1.20 及以前）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | journal key 塌缩到 `/`（插件源码注释自述） | 多会话共用一条记录，后写覆盖前写 |
| 2 | 只在 dock 被扫描时保存 | 窗口不在前台/面板未开 → 队列变化不落盘 |
| 3 | 无关闭前 flush | 刷新/关窗瞬间的队列永远丢失 |
| 4 | 无历史留档 | 主记录被覆盖即不可恢复 |
| 5 | 写入乱码（`"???????"`） | 即便有记录也读不回原文 |

### 修复

- **queue-journal 0.1.5**（`queue-journal/`，独立包，随本次发版一并上架 npm）：
  1. **按会话键**：优先 slot 的 SessionId → DOM 探测 → URL → 本页实例键（写 sessionStorage，跨刷新稳定），
     **绝不再用 `/`**；
  2. **变化即写**：`MutationObserver`（`[data-queue-dock]` + body childList）+ **15s 兜底** +
     `pagehide` / `visibilitychange` / `beforeunload` 前 `fetch(keepalive)` flush；
  3. **恢复 UI**：`JournalDock` 增加「历史 N」入口，逐条显示快照并「恢复」→ `POST /fang/api/composer/queue`；
  4. **回读校验**：保存后 GET 比对；不一致或出现 `??` 乱码即重试一次并打诊断；
  5. **UTF-8 往返**：新增单测覆盖中文/emoji/CRLF 原样落盘。
- **服务端（dsh-fang）**：`composer-journal` 增加 append-only **历史快照**（`composer-journal-history.jsonl`，500 条上限），
  新路由 `GET /fang/api/composer/journal/history?limit=&sessionKey=`；`POST /journal` 把 `sessionId` 记为 `sessionKey`。
- **恢复工具 `tools/recover-queue.mjs`**：扫描所有 fang dataDir（journal + history），列出可恢复草稿/队列（自动标记疑似乱码），
  支持 `--json`、`--dry-run`、`--restore <url> --token <t> --session <id> [--index n]` 显式写回官方队列。

### 验证

- `npm test`：1089 tests / 1078 pass / 0 fail
- 新增 `test/composer-journal-history.test.mjs`（5 例）：分会话键、历史追加/排序、草稿不刷历史、上限裁剪、UTF-8 往返
- 恢复工具实测（你本机 dataDir）：正确列出 2 条旧记录，并对 `??????` 标注「疑似乱码（原文已丢失）」
## v3.1.20（2026-11-12）

**主题：分身「插件」入口隐藏的兼容性与可诊断性（3.1.19 在个别宿主上未生效的收口）。**

### 修复
- **入口匹配不再依赖 `panelRow` 类名**：宿主（desktop / web / 不同 DSH 版本）侧栏行的 class 会变，
  3.1.19 只认 `panelRow`，导致部分环境「插件」仍在。现在三条判据：
  ① `panelRow` 快速路径；② 位于 `nav` / `aside` / `[class*=sidebar]` 容器内的按钮；
  ③ 文本为 `插件` / `Plugins`（容忍零宽字符、多余空白、`插件 3` 这类计数徽标）。
- **诊断可见**：锁生效时在 `<html>` 打 `data-fang-fork-locks="applied"`，并写 `window.__fangForkLocks`，
  便于「到底是不是没生效」一眼确认。
- 「启动 / 开始使用 / 启用」的 capture 拦截同样改用新的文本判据。

### 说明
- **已存在的分身窗口不会自我更新**：分身是启动时复制母体profile的快照，
  旧窗口（例如 Fang 3.1.14）需**关闭后重新派生**才载入新版客户端；母体无需重启。

### 验证
- `npm test`：1084 tests / 1073 pass / 0 fail / 11 skip
- 新增 jsdom 用例：宿主丢弃 `panelRow` 类名时仍能隐藏入口，并断言诊断属性
## v3.1.19（2026-11-12）

**主题：品牌重塑（3.1.18 一并合入）+ 分身 Web 界面收敛 + 关闭二次确认。**

### 品牌
- 插件主名称：`dsh-Fang（母体-分身插件开发）` → **`瓮城：DSH的第一台虚拟机！`**
- 插件简介改为面向三类用户的定位文案（插件开发狂魔 / 多任务并发狂 / 安全焦虑症患者），英文同步；
  `package.json` description 与 README 首屏同步。
  > 说明：原计划的 3.1.18 未单独发版，内容并入本版（见 `docs/RELEASE-WAIVER-3.1.19.md`）。

### 分身 Web 界面收敛
- `role=fork` 时**隐藏左侧栏「插件」入口**（DOM 隐藏 + capture 拦截 + MutationObserver 补回）。
- 插件设置页「启动 / 开始使用 / 启用」在分身里**无操作**：不切换面板、不弹提醒、不打印错误；
  残留错误气泡就地隐藏；母体 / 元主行为不变。

### 关闭二次确认
- **元主 / 分身 Web** 关闭前触发浏览器原生确认（`beforeunload`），防止右上角误触直接关窗；
  母体（主机式长驻窗口）不拦截。

### 验证
- `npm test`：1083 tests / 1072 pass / 0 fail / 11 skip
- 新增 jsdom 用例：`client-fork-locks`（3 例）、`client-close-confirm`（2 例）
- 真实 fork Host（安装 3.1.19）：侧栏仅「自动化任务 / 瓮城 / 更多」，「插件」`display:none`；徽标 = 分身
## 变更
- **隐藏分身 Web 左侧栏「插件」入口**：`role=fork` 时不再显示该按钮，
  且对其点击做 capture 拦截（DOM 被宿主重渲染后由 MutationObserver 立刻补回隐藏状态）。
  母体 / 元主 不受影响。
- **「启动」按钮在分身里变为无操作**：插件设置页的「启动 / 开始使用 / 启用」按钮在 `role=fork` 下
  于 capture 阶段被拦截 —— 不切换面板、不弹提醒、不打印错误（此前会冒出一条无法处理的报错噪音）。
  若提示已在别处触发，含错误语义的气泡会被就地隐藏。

### 说明
- 实现位于 `client.js` 的 `mountForkUiLocks()`，随 `apply()` 注册，卸载时恢复被隐藏的入口。
- 仅前端呈现层收敛；服务端能力与路由不变，3.1.18 契约完全兼容。
## 3.1.18（2026-11-12）

**主题：品牌重塑 —— 「瓮城：DSH 的第一台虚拟机！」**

- 插件主名称：`dsh-Fang（母体-分身插件开发）` → **`瓮城：DSH的第一台虚拟机！`**（`locale/zh.json`）
- 插件简介：改为面向「插件开发狂魔 / 多任务并发狂 / 安全焦虑症患者」三类用户的定位文案（`locale/zh.json`）；
  英文同步更新（`locale/en.json`）为 *Fangcheng: DSH’s First Virtual Machine!*
- `package.json` description 同步为重定位后的摘要；README 首屏改为同一套叙事，保留原有版本历史。
- 版本号 3.1.18（`FANG_VERSION` 与测试断言同步）。

> 功能无变更：本版仅改名与文案，接口/路由/协议保持 3.1.17 兼容。
## v3.1.17（2026-11-11）
**主题：身份徽标兜底 + 身份诊断字段 + 会话映射透传 + 发版钩子兼容 annotated tag。**

### 修复
- **元主 Web 看不到蓝标（v3.1.16 报告）**：`mountWebRoleBadge` 原来只挂宿主侧栏品牌词标右侧，
  brand 槽不存在或被宿主整段重渲染摘掉时就静默不显示。v3.1.17 增加**兜底挂载**：
  3 次重试（250ms）仍找不到品牌槽 → 挂到 `document.body` 右上角固定角标；
  MutationObserver 同时监听品牌行与兜底容器，被摘掉即补回；
- **发版钩子与 annotated tag 冲突**：`.githooks/pre-push` 与 `tools/git/guard-main.mjs`
  现在先把版本 tag **peel 到 commit** 再判断「tag 是否在 main 的 first-parent 上」，
  annotated tag 不再被误判为“非 main 提交”（这正是 v3.1.16 release 的 `final verify` 失败原因）。

### 新增
- `GET /fang/adapter/identity` 增加 **`surface`** 与 **`clientLoaded`/`clientReportedAt`**：
  便于一眼判断“服务端有身份、客户端没加载”（不含 taskId/sessionId/token）；
- `POST /fang/adapter/client-report`：client half 加载后自报（只记时间戳）；
- 会话目录 `listSessions` 支持 `sessionKey` / `ticketId` 参数并**原样透传**到结果，
  便于 3_Sessions 把房主 Router 的 Ticket→会话映射与母体会话目录对齐。

### 测试
- 新增 `test/v3117.test.mjs`（5 例）：identity 字段与脱敏、client-report 路由、
  sessionKey 透传、徽标兜底与 3 次重试、钩子 peel。

## v3.1.16（2026-11-11）
**主题：跨进程契约桥“零配置”——原身运行态注入 `DSH_FANG_MOTHER` + 契约 HTTP headers 同步。**

### 修复 / 新增
- **原身（essence-runtime）spawn 注入 `DSH_FANG_MOTHER: layout.dataDir`**：
  房主 dsh-Master 的 Router 在原身内可据此自动推导共享契约 outbox
  （`<motherDataDir>/contract-outbox`），无需再手工配置 `dispatch.contractFileDir`；
  普通分身（`DSH_FANG_ROLE=fork`）此前已有该注入（任务 spawn / 恢复 / 队列三处），本版只补齐原身运行态这一处；
- **契约 SDK HTTP 传输支持自定义 headers**：`createHttpTransport({ headers })` /
  `createContractClient({ config: { httpHeaders } })`；瓮城的契约 HTTP 端点同时需要
  Bearer contract token 与安装级 `x-fang-auth`，房主可一次带齐；
  该改动为**加性**扩展：不传 `headers` 时行为与 1.0.0 完全一致；
- 内嵌契约 SDK 与 npm 已发布 `@twinsearth/dsh-fang-contract@1.0.0` 的导出面/常量/方法表/
  错误码保持一致（房主侧有对应一致性测试保护）。

### 兼容性
- 不改变任何既有服务键、环境变量语义或 HTTP 路由；旧版房主（3.2.4 及以前）仍可用 `legacy` 传输；
- `DSH_FANG_MOTHER` 只是在原身 spawn 时多注入一个既有变量，未注入时房主行为不变（仍需显式配置）。

### 测试
- `test/contract.test.mjs` 2/2；全量 `npm test` **1034 pass / 0 fail**；
- release preflight（含 e2e）见发布记录。

## v3.1.15（2026-11-11）

**主题：与房主 dsh-Master 的独立互联契约（fang-master contract 1.0）+ 多级保底通讯。**

### 新增
- 内嵌 @twinsearth/dsh-fang-contract 1.0.x 同源 SDK（src/contract/）；
- mother 提供 angContract 服务：hello/health、ang.fork.spawn/stop/list、ang.decision.create/resolve、ang.session.list、ang.orchestrator.status；
- 可选 HTTP 契约端点 /fang/api/contract/{hello,invoke,health}（Bearer token，常量时间比较；token 留空禁用）；
- 可选 file outbox 兜底（contract.fileDir）；DSH_MASTER_* env 白名单；fork 角色不暴露契约服务；
- 文档 docs/CONTRACT-INTEROP.md、docs/RELEASE-3.1.15.md。

### 兼容性
- 原有服务键与旧版房主直连方式全部保留；新版房主按 local→http→file→legacy 自动降级；
- contract 1.x 只增不改；删除/改义需 2.0 + 双写一个 MINOR 周期。

### 测试
- 	est/contract.test.mjs 2/2；全量 preflight/e2e 见 release run。

## v3.1.14（2026-11-11）

**主题：修复元主/分身 Web 不显示身份徽标；徽标改为红/蓝/绿三色。**

### 修复
- **元主/分身 Web 没有徽标**：v3.1.13 的徽标识别调用 `/fang/adapter/hello`，但该路由要
  `Authorization: Bearer <adapterToken>`——浏览器拿不到 adapter token，分流后返回 401，
  客户端判定失败直接隐藏徽标。母体走 `/fang/api/status` 所以正常（红标可见）。
- 新增**公开只读**路由 `GET /fang/adapter/identity`：只返回 `{ role, kind, version, protocol }`
  （不含 taskId/sessionId/token），服务端仍只监听 loopback；`kind` 由
  `identityKind({role, taskId, essence})` 纯函数计算：`mother` / `essence` / `fork`
  （元宝运行态由 `DSH_FANG_ESSENCE=1` 或 `rt-` forkId 识别）。
- 客户端 `detectWebRole()` 顺序：`/fang/api/status`（母体）→ `/fang/adapter/identity`
  （元主/分身）→ 旧宿主 `hello` 兜底；失败仍隐藏，不显示错误身份。
- **颜色区分**：母体 **红**（`#C8102E`）、元主 **蓝**（`#0A6BE0`）、分身 **绿**（`#17803D`），
  通过 `.fang-web-role--mother|essence|fork` 变体实现。

### 测试
- `test/client-role-badge-dom.test.mjs`：母体红 / 元主蓝（identity）/ 旧宿主 rt- 前缀兜底 /
  分身绿（identity）/ 颜色 CSS 契约 / 接线断言，6/6；
- `test/adapter-identity.test.mjs`：`identityKind` 四类映射，1/1；
- 发布前 `preflight --e2e`（含 crash-safety + 打包后门禁）。

### 已知边界
- 需要升级到 3.1.14 并**重启元主/分身 Web 宿主**才会加载新的 identity 路由与客户端；
  已运行的旧实例仍为旧代码（不会热更新）。
- 公开 identity 路由只暴露角色/版本，不含任何 token 或任务标识。

## v3.1.13（2026-11-11）

**主题：决策中心深入每个会话 —— 右侧「待选」悬浮入口 + 从右向左的决策栏（选项/自定义输入）。**

### 新增
- **会话内决策中继**：母体 Web 中，当前会话存在 pending 决策时，右侧边缘出现红色
  「◈ 待选 N」悬浮按钮；点击从右向左滑出决策栏：
  - 只显示 `source.sessionId` 匹配当前会话的 ticket（其他会话/分身的票仍在收件箱）；
  - 预置选项按 **A/B/C/D**（超过 4 个续 E/F…）展示，点击即提交；
  - 也可直接**输入决定**（如「按 B 方案，先灰度 10%」），作为 custom decision 提交；
  - 无选项的绿票显示「确认收到（ACK）」；`Esc` / 遮罩关闭；无待决策时按钮隐藏。
- **总界面仍在母体**：收件箱（侧栏入口 + 右侧抽屉）不变，继续汇总所有来源的待决策。
- 服务端：`POST /fang/api/decisions/resolve` 新增 **仅显式** `custom` 字段
  （trim、≤2000 字符）；`resolvedOption = custom`、`customInput: true`、
  `resolutionNote = custom`；未传 custom 的未知 option 仍 fail-closed。
- Agent 侧：`request_human_decision` 的 `selectedValue` 即用户选择/输入，Agent 按此继续任务。
- 文档：`docs/DECISION-RELAY.md`（行为、协议语义、边界），随 tarball 发布。

### 测试/门禁
- `test/decision-relay-dom.test.mjs` 5/5：入口出现/隐藏、面板滑出、A/B 选项提交、
  自定义输入提交、其他会话过滤、fork 角色不挂载、socket 接线；
- `test/decision-center.test.mjs` 新增：custom 解析（resolvedOption/customInput/note）+
  未知 option 仍拒绝；
- 版本断言随 3.1.13 更新；发布走 `preflight --e2e`（含 crash-safety 与打包后门禁）。

### 发布说明
- v3.1.12 的产物（npm/GitHub Release）由上一轮发布流程已产出；按人类要求 **v3.1.12 不发布**：
  本版发布后会把 npm 3.1.12 标记 deprecated、删除其 GitHub Release 页面，正式版本以 3.1.13 为准。

## v3.1.12（2026-11-11）

**主题：Web 端身份徽标（母体 / 元主 / 分身）+ 派生分身默认第三方插件种子。**

### 新增
- **侧栏身份徽标**：在侧栏 HARNESS 词标右侧用红字显示当前 Web 端身份 ——
  `母体`（`/fang/api/status` 返回 role=mother）、`元主`（元宝运行态）、`分身`（任务）。
  不替换宿主 `sidebar.brand.name` 单槽（避免抹掉官方词标），而是在词标后追加只读徽标；
  宿主重渲染摘掉节点时自动补回；识别失败时隐藏，不显示错误身份。
- **adapter hello 增加 `kind`**：`mother` / `essence` / `fork`；元宝运行态由 orchestrator
  注入 `DSH_FANG_ESSENCE=1`，旧运行态按 `rt-` forkId 前缀兜底。客户端据此区分元主与分身。
- **派生分身默认插件种子**（新机器/新用户不再“裸奔”）：`forkSeed` 配置两组清单，
  默认值即用户给定列表：
  - 安装不激活：`@twinsearth/dsh-2xray`、`@michengai/dsh-agency-agents`、`dsh-better-sidebar`、
    `dsh-context`、`@liustack/modlens`、`@liustack/modsearch`；
  - 安装并激活：`dshmarket`、`@twinsearth/dsh-im2a-plugin`、`@openviking/dsh-memory-plugin`、
    `@twinsearth/w2m-dsh-plugin`。
  种子在独立 seed home 用 DSH 自带 pnpm 安装（按指纹缓存），模块 hardlink 合并进分身
  `node_modules`；install 只写 dependencies，activate 额外写入 `dsh.profile.bundles` 随分身启动加载。
  两种派生入口（开发者推荐 / 绿色“派生新分身”）都走同一 Forker.spawn，因此行为一致。
  失败不阻塞分身启动，结果保留在 spawn 返回值 `forkSeed` 与审计里。
- 配置项：`fang-forker` Config 的 `forkSeed.enabled/install/activate`；环境变量
  `DSH_FANG_FORK_SEED=0` 可全局关闭（e2e/CI 使用）。

### 测试/门禁
- `test/fork-seed.test.mjs` 6/6：默认清单、归一化、profile patch、scope 合并、装一次缓存、
  **每次 spawn 重放模板后重新打 patch 且不重复安装**、禁用 no-op；
- `test/client-role-badge-dom.test.mjs` 5/5：母体/元主/分身/前缀兜底/适配器字段；
- `test/forker.test.mjs` 29/29（单测禁用种子，避免联网）；
- 既有全量 + crash-safety + 打包后门禁由 `preflight --e2e` 复跑。

## v3.1.11（2026-11-11）

**主题：修复元宝运行态「更新/卸载插件」被 pnpm 供应链观察期拦截（ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION）。**

### 修复
- **现象**：元宝 web 端更新/卸载插件报
  `Lockfile failed supply-chain policy check`，点名 `@twinsearth/dsh-fang@3.1.10`、
  `@twinsearth/dsh-fang-queue-journal@0.1.4` 落在 pnpm 11 `minimumReleaseAge`（24h）观察期内。
  DSH 插件管理器只在**安装**成功时自动追加 `minimumReleaseAgeExclude`；更新/卸载或某些 profile 的
  lockfile 校验会先被策略拦下。
- **运行态修复**：`ensureEssenceRuntimePnpmConfig` 现在显式写
  `minimumReleaseAge: 0`（仅元宝运行态；母体 profile 的供应链策略不动），
  每次打开元宝运行态自动生效，更新/卸载自家刚发布插件不再被观察期拒绝。
- **回归保护**：`test/pnpm-store.test.mjs` 覆盖「缺省时必须补上 `minimumReleaseAge: 0`」
  与二次运行幂等（6/6）。
- **环境处置（不入代码）**：本机 desktop profile 的 `minimumReleaseAgeExclude` 增加
  `'@twinsearth/*'` 通配（备份 `pnpm-workspace.yaml.bak-policy-*`），元宝运行态 profile
  同时写 `minimumReleaseAge: 0`；已安装 3.1.10 做了等价热补丁（备份
  `pnpm-store.mjs.bak-releaseage-*`），本机可立即重试插件更新。
- **边界**：母体 profile 由 DSH 管理，Fang 不修改其策略；第三方包仍受 24h 观察期保护。

### 测试/门禁
- `node --test test/pnpm-store.test.mjs` 6/6；版本一致性测试随 3.1.11 更新。
- 发布走 `preflight --e2e`（含 crash-safety 与打包后门禁），证据见 `docs/AUDIT-v3.1.11.md`。

## v3.1.10（2026-11-10）

**主题：流程固化 + 把「瓮城防崩溃方案」变成可回归测试/打包/发布门禁。**

### 新增
- `docs/WORKFLOW-UI.md`：UI 改动与发版固定流程（先判定纯样式/结构、浏览器冒烟上限、合并前一次性验证、发版前置硬门禁、发布后不再移 tag、Token/时间预算、运行中 profile 升级安全规程、完成定义）。**发布必须由人类显式授权。**
- `docs/CRASH-SAFETY.md`：防崩溃防线清单（boot-guard / RestartGuard / 分身监督与孤儿回收 / role fail-closed / 待处理缓冲 / 未清洁启动检测）、强制点矩阵、运行手册与边界。
- `tools/release/crash-safety.mjs`：防崩溃门禁。源码模式校验防线文件/导出/插件闸门/client 半浏览器安全/文档与打包清单；打包模式在最终产物上校验必需防线文件、版本与 `dsh.client`、候选包 `apply()` 隔离冒烟、manifest sha256、tarball 内约束文档。
- `test/crash-safety.test.mjs`：门禁自身的回归（源码绿灯、坏包必须红、fail-safe 导出、门禁接线与文档约束）。
- 两篇约束文档进入 npm tarball（`files`），随产物一起发布、可审计。

### 接线
- `tools/release/preflight.mjs`：新增 `crash-safety: fail-safe invariants` 检查，发布前 RED 即阻断。
- `tools/release/build.mjs`：tarball 生成后再跑 `crash-safety --package --tarball`，未过不进 GitHub Release / npm。
- CI：全量测试包含 `crash-safety.test.mjs`；release build job 内置 preflight 与打包后门禁。

### 事故记录（环境，不入代码）
- 2026-11-10 21:33 在**运行中**的 desktop profile 上执行 `dsh plugin add @twinsearth/dsh-fang@3.1.9`，DSH 崩溃且用户层被重置（bundles 回退为 base+web-app、`cordis.patch.yml` 被模板覆盖）。已从 `.bak-*` 恢复 bundles 与 patch，3.1.9 安装校验通过（boot-guard dry-run: 19 rows, ok）。升级运行中 profile 的正确步骤已写入 `docs/WORKFLOW-UI.md` §5。

### 发布状态
- **已发布**：v3.1.10 → npm `latest` / GitHub Release / tag 三渠道完成（release run 42836350924 attempt 2，全绿）。

## v3.1.9（2026-11-10）

**主题：元主 / 分身工作区滚动（鼠标滚轮 + 可拖动滚动条），中间分隔条调节两栏宽度。**

### 修复
- **元主/分身变多后无法选中列表项**：控制台两栏原来没有可靠的高度约束——`.fang-console` 用 `min-height:100%`，`.panel` 用 `max-height:calc(100vh - 132px)`，而 DSH `main` 面板（`mainPanel` = `flex:1;min-height:0;overflow:hidden`）实际给的高度更小，整块内容被裁掉且没有滚动容器；同时左栏的元主卡片（`.essence-list`）在滚动区之外，卡片一多就把母体会话滚动区挤到几乎 0 高。现在：
  - `main` 槽的 DOM 挂载节点改为 `display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%`，高度链贯通到 DSH 主面板；
  - `.fang-console` = `height:100%;overflow:hidden`，`.fang-body` = `align-items:stretch;height:100%;overflow:hidden`，`.panel` = `height:100%`；
  - 左栏把「元主卡片 + 母体会话」收进同一个 `.panel-scroll[data-sk="left"]`，右栏保持单一 `.panel-scroll[data-sk="right"]`；
  - `.panel-scroll` 明确 `overflow-y:auto;scrollbar-gutter:stable`，滚动条 12px 宽、可拖动；鼠标滚轮 / 触控板滚动；
  - 窄屏（≤1100px）改为整页滚动 + 每栏 `max-height:62vh` 内部滚动，中间分隔条隐藏。
- **中间分隔条**：保持拖动调节两栏宽度（grid 列），左右两栏各自滚动、互不影响。

### 测试/门禁
- 新增 `test/client-layout-dom.test.mjs`（jsdom）：主槽高度链、两栏各一个滚动容器、元主卡片在左滚动区内、CSS 契约（overflow/滚动条/窄屏规则）、中间分隔条存在。
- 本地 headless Edge 实测（1440×900，30 元主 + 30 分身）：左栏 wheel 0→420（scrollHeight 3056 / clientHeight 342）、右栏 wheel 0→420（5777 / 445），拖动中间手柄列宽 692/692 → 850/534。
- 既有 client DOM/HTTP 套件 22/22 通过。

## v3.1.8（2026-11-10）
**主题：元宝运行态内 pnpm 插件更新/卸载修复（ERR_PNPM_UNEXPECTED_STORE）。**

### 修复
- **元宝运行态无法更新/升级/移除插件**：DSH 0.2.2-rc.1 自带 pnpm 11，pnpm 11 的 `.npmrc` 只读鉴权/网络键，`store-dir`、`package-import-method` 等非鉴权设置改为从 `pnpm-workspace.yaml`（camelCase）读取；Fang 旧逻辑只写 `.npmrc`，于是运行态 pnpm 选了“按盘符默认 store”（D: 项目 → `D:\.pnpm-store\v11`），而模块树记录的是母体 C: store → `[ERR_PNPM_UNEXPECTED_STORE]`。新增 `src/lib/pnpm-store.mjs`：写入 `pnpm-workspace.yaml` 的 `nodeLinker: hoisted` / `storeDir` / `packageImportMethod: copy`（保留原设置与注释），同步 `.npmrc` 兼容旧工具链，并把运行态 `node_modules/.modules.yaml` 的 `storeDir`/`virtualStoreDir` 对齐为“本项目自己的 `.pnpm`”（复制来的 manifest 仍写着母体 virtual store）。
- 每次打开元宝运行态（`startEssenceRuntime`）都会自动应用，返回体新增 `pnpmConfig` 诊断字段；失败不阻塞实例启动。
- **运行态插件变更持久化回元宝**：`stopEssenceRuntime` 与下次 `startEssenceRuntime` 会在重放前调用 `captureRuntimeProfileIntoEssence()`：把运行态 `package.json`（dependencies + `dsh.profile.bundles`）、有差异的 `cordis.patch.yml` 条目、`pnpm-lock.yaml`/`pnpm-workspace.yaml`/`.npmrc` 写回元宝 overlay，重算 merged（`materializeMerged` 现在保留既有模块树并投影 overlay 的 pnpm 文件），再把 pnpm 重新物化的包目录 hardlink 复制进元宝模块树、删掉已卸载的包；回归保护新增 `test/runtime-capture.test.mjs` 与 essence 的模块树保留测试。
- 回归保护：新增 `test/pnpm-store.test.mjs`（6 例：manifest 读取、settings upsert 保序、.npmrc 更新、manifest 对齐幂等、端到端 ensure）。
- **测试稳定性（buffer-keeper）**：`state()` 可能在 watch/poll 事件到达前先由 digest 兜底看到 pending，此时 `lastEventAt` 为 null，CI（Node 22 时序）偶发 `pending-high-risk` 但时间戳为 null 的断言失败；现在观察到 pending 时补记观察时间，并移除已无读者的 `startedAt`。

### 测试/门禁
- 发布前重跑 `preflight --e2e`；证据见 `docs/AUDIT-v3.1.8.md`。
- 现场证据：官方元宝运行态 profile 修复后 `pnpm store path` 返回 C: store；以相同依赖图/锁文件的隔离副本执行 `pnpm remove dsh-better-sidebar` 成功（13.7s，storeDir=C:、virtualStoreDir=副本路径，无 store/virtual-store 报错）。

### 已知边界
- 捕获时机是「停止运行态」与「下次打开运行态」——运行中的插件操作不会实时回流；宿主异常退出后，下次打开会先捕获再重放。
- 模块回流按「包名+版本」比较；同版本内容被就地替换（无版本号变化）的插件目录不会被 hardlink 覆盖（pnpm 正常安装/升级都会改版本号，命中该边界的是手工改包内容）。
- 运行态/元主模块树仍是镜像共享结构，捕获只 hardlink 被 pnpm 重新物化的条目。

## v3.1.7（2026-11-10）
**主题：分身/元主运行态的模块解析与无头 Web 目录选择修复。**

### 修复
- **分身内“下任务&指令失败”**：`Invalid schema for function 'w2m_report'`。根因是分身 profile 的 `node_modules` 是“整树 junction”到母体 profile 树，DSH 的 profile-scope 解析器只对 profile 树内或 linked-root（逐条目链接）下的 importer 供给安装包，导致插件里的 `import('@deepseek-ai/dsh-tools')` 落到插件自带离线 shim；w2m shim 把参数默认值写成 `required:false` 属性注解，供应商拒绝整次请求。forker 现在把 `node_modules` 物化为**逐条目 junction 镜像**（`mirrorModuleTree`），并在每次 spawn 就地修复历史 junction（`ensureModuleMirror`）；元主运行态同样处理。
- **分身/元主 Web“选择工作区失败”**：分身在 `dsh.cmd --no-open`（无 Electron 壳）下由 `directory-picker-auto` 解析为 `native`，原生目录对话框没有窗口可弹。spawn 现在写入 `fang-headless.patch.yml` 并以 `--patch` 传入，固定为 `directory-picker-browse`（浏览器对话框）+ 对应客户端面；安装缺 browse 包时保持 DSH 默认，可用 `DSH_FANG_HEADLESS_PICKER_PATCH=0` 关闭。
- **回归保护**：kernel 新增 `mirrorModuleTree` / `ensureModuleMirror` 单测；forker 新增 `--patch` argv、overlay 内容与安装门禁单测；provision/template 断言从“整树 junction”改为“逐条目镜像”。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.7.md`。
- 本地 live 验证明细：真实 `dsh.cmd` 子进程以逐条目镜像启动母体插件全集（含 w2m）无 `ERR_MODULE_NOT_FOUND`；探针插件在子进程内成功 `import('@deepseek-ai/dsh-tools')`。

## v3.1.6（2026-11-10）

**主题：回滚 v3.1.5 的两个回归（元宝运行态启动失败、分身 client 插件 pending）。**

### 修复
- **元宝运行态启动失败**：v3.1.5 在 `forker.spawn` 里跳过 essence-runtime 的生产盘锁并解锁，导致 DSH 启用 plugin-manager 后因运行态模块树不完整退出（`runtime-spawn-failed: exited`）。恢复 v3.1.4 行为：spawn 重新写入锁并设置只读。
- **分身 client pending**：v3.1.5 禁用了 `ui-plugin-manager`，而它提供 `pluginNavigation`，导致 `dsh-client-ui-plugin-recommendations` pending。改回只禁用 `ui-settings-plugin-inventory`；并自动移除历史 profile 里的 `ui-plugin-manager disabled:true`。
- 保留 v3.1.5 的 queue-journal 0.1.4 排队列表恢复、分身 Web 说明页、元宝卡片等改动。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.6.md`。

# CHANGELOG

> **发布豁免（人工批准，2026-11-03）**：v3.0.0–v3.0.6 **永不发布**，首个 Release 为 **v3.0.7**；
> 此后不得再覆盖“不跳号”规则——任何跳版本必须单独申请并经人工手动豁免、书面记录。详见 docs/RELEASE-WAIVER-v3.0.7.md。


## v3.1.5（2026-11-09）

**主题：排队消息列表恢复真正可用 + 分身界面不再出现母体 404 错误。**

### 修复
- **queue-journal 0.1.4**：DSH QueueDock 使用 hashed CSS class，旧扫描器只能靠 `class*=queue` 命中不到 → 只保存单草稿。新增稳定锚点 `[data-queue-dock]` 扫描，恢复时显示并放回完整排队消息列表。
- **分身 Web UI**：`role=fork` 只渲染分身说明页，不再无条件渲染母体状态/任务/会话/审批/看护的 404 错误横幅，也不再发起母体 API 请求。
- **fork 插件设置入口**：分身 profile 额外锁定 `ui-plugin-manager` / `ui-settings-plugin-inventory`，隐藏插件设置入口，避免点击启用时因只读 package.json 报 EPERM。
- **essence-runtime 不再被 spawn 重新上锁**：元宝运行态 spawn 时跳过生产盘锁并解锁历史锁。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.5.md`。

### 已知边界
- 分身仍是生产盘；插件配置请在母体或元宝运行态完成。
- PluginUpdater/SuperAgent/HarnessMM/PJM/Worker 本体未接。

## v3.1.4（2026-11-09）

**主题：元宝工作区卡片 UI + 元宝运行态插件管理修复 + 发布流水线幂等。**

### 新增/修复
- **元宝工作区卡片**：每个元宝独立方框，两行信息；第一行名称（微软雅黑 16px），第二行“生成时间 / 最后一次与母体同步时间”；操作收为图标按钮，不再挤在一起。
- **元宝运行态不再套生产盘锁**：`essence-runtime` 是配置实例，跳过 `applyForkConfigLock`；新增 `clearForkConfigLock()` 清理历史 provision 写入的 `tool-plugin-manager disabled:true`，避免插件设置被锁。
- **发布流水线幂等**：npm publish 对已发布版本（202/403 previously published）视为成功；final verify checkout 增加 `fetch-tags: true`，annotated tag 不再被误判 lightweight。
- **queue-journal 0.1.3** 继续锁定（恢复列表）。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.4.md`。

### 已知边界
- DSH 设置页插件列表只读；行级激活需“能唯一定位的 profile patch 行”，第三方插件建议走侧边栏「插件」页。
- PluginUpdater/SuperAgent/HarnessMM/PJM/Worker 本体未接。

## v3.1.3（2026-11-09）

**主题：新机器迁移修复 + 排队消息列表恢复真正生效。**

### 修复
- **queue-journal 0.1.3**：恢复列表代码此前只在仓库里，npm 仍发 0.1.2（只能恢复单草稿）；本版把 `@twinsearth/dsh-fang-queue-journal` 锁到 **0.1.3**，支持“恢复全部 (n)”把队列逐条放回官方输入队列。
- **npm 安装名分身检查**：`fork-bundle-unavailable` 硬编码只认 `@local/dsh-fang`；现在同时接受 `@twinsearth/dsh-fang`，npm 安装的新机器不再误判。
- **运行态 node_modules 自愈**：迁移后 runtime profile 的 junction 可能指向不存在的 `merged/profile/node_modules`；现在检测 broken junction、重建到 `essenceModules`，元宝不再因 `cannot resolve profile bundle` 丢插件。
- **迁移 profile 的旧机器路径**：后续版本继续过滤 `file:`/`link:`/绝对路径依赖与不可解析 bundle。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install drill、reinstall drill；证据见 `docs/AUDIT-v3.1.3.md`。

### 已知边界
- 旧机器迁移数据仍可能含不可移植依赖；建议用新机器重新安装插件，或按 `docs/AUDIT-v3.1.3.md` 的修复步骤处理。
- PluginUpdater/SuperAgent/HarnessMM/PJM/Worker 本体未接。

## v3.1.2（2026-11-09）

**主题：把 v3.1.1 未发布的启动韧性/自检/更新器门禁收口，并完成首次四方发布。**

### 新增
- **boot-guard**：bundle 行解析、重复 id、子进程 `import()`/`apply()` 冒烟；`--apply` 禁用失败行（profile patch 备份）、`--safe-mode` 全禁用；`--candidate-dir` 供更新器做候选包冒烟。
- **启动入口自动自检**：`desktop-launch` / `restart-watchdog` 默认自动跑 boot-guard；未给 profile 时自动探测 `DSH_PROFILE_DIR` / `DSH_HOME/profiles/<profile>`；失败 + execute → 安全模式，dry-run 只报告。
- **运行时崩溃记录/熔断**：restart-guard `boot-state.json`（booting/running/clean/crashed）+ `runtime-crash.jsonl`（`uncaughtExceptionMonitor`）；launcher 检测上次 booting/crashed 且 pid 已死 → 自动安全模式。
- **restart-guard selfCheck**：`GET /fang/api/restart/selfcheck`（state/HMAC/清单/supervisor/unclean-boot/crash-ledger）。
- **持久化**：多代快照（`snapshotGenerations` 默认 3，A–J）+ 崩溃 journal（request/settled/orphaned，重启只标 orphaned）。
- **重装/毒数据 drill**：同一 DSH_HOME 覆盖安装 + 16 类毒文件后二次 boot。

### 修复
- 无效/旧盘 `fang-home.txt` 迁移指针自动回退本机布局，避免 apply 阶段 ensureDir 抛错。
- 真实 EssenceManager 冲突不出票（`recomputeAll()` 数组长度），未读计数口径，drawer `requestAnimationFrame` guard。
- 重复路由注册导致后续路由静默丢失（`/api/forks/supervision`、`/api/essence/default`）。

### 测试/门禁
- `preflight --e2e` **GREEN**：1026 tests / 1015 pass / 0 fail / 1 skip / 10 todo（179.9s）；e2e **81/81**（16.9s）；allow-list routes=104 findings=0；compat COMPATIBLE；syntax vet 0 失败。
- 安装 drill **10/10**（boot-guard precheck、client half、19 行、零残留）；reinstall drill **7/7**（覆盖安装 + 16 类毒数据后二次 boot）；healthz **HEALTHY @3.1.2**。
- 产物：`dist/dsh-fang-3.1.2.tgz`（510,726 B / 135 entries）sha256 `558a81da140005879c830a80048e4a89a00e2562fee2e782de8dfe2586b809b2`。

### 已知边界
- PluginUpdater / SuperAgent / HarnessMM / PJM / Worker **本体未接**；契约/client/CLI/fork tool/boot-guard 候选门禁已就绪。
- DSH 宿主内其他插件 apply 硬失败无法当场拦截；只能记录 + 下次启动熔断。
- npm 发布依赖仓库 `NPM_TOKEN` secret；私有镜像 verify 依赖 `MIRROR_TOKEN`/`MIRROR_REQUIRED`；自托管 e2e runner 需在线。

## v3.1.1（2026-11-09）

**主题：决策中心（注意力收件箱）+ fork outbox/ingest + AI 流式/多模型/SSRF + 镜像官方源 + 重启监督闭环 + 分身看护 UI。**
**诚实说明：外部业务生产者本体（PluginUpdater/SuperAgent/HarnessMM/PJM/Worker）仍未接入；本版只交付契约、客户端与测试。**

### 新增
- **决策中心**：红/黄/蓝/绿/灰 ticket、会话日配额、注意力预算、红票硬上限、批量 resolve/abandon、动作执行钩子、SSE 推送、AI 建议/采纳审计、执行状态 chip。
- **AI**：token 级流式建议（SSE）、多模型/多 provider/多 Key 路由（`profiles/routes`）、私网 allowlist、SSRF 防护（元数据/私网字面量 + 请求前 DNS 预检）。
- **fork 转发**：fork outbox（失败落盘/退避/flush）、独立进程 ingest client/CLI、`ADAPTER_OP.DECISION_INGEST`、`request_human_decision`/`report_pjm_timeout`/`report_worker_deviation` 工具、母体 `originForkId/taskId` 标签与跨 fork 聚合（含 AI 建议采纳统计）。
- **业务生产者**：统一 producer 契约 v1（`normalizeProducerPayload`/`createProducerSubmitter`/`producerCatalog`）+ 目录路由；MirrorUpgrade、EssenceManager、PM、umbrella 已接线；PJM/Worker 客户端与工具就绪（本体未调用）。
- **镜像升级**：officialSource manifest adapter（`officialSourceUrl`/`officialSourceToken`）、真实下载/替换、成功 → 红色 restart ticket（`confirm_restart`）。
- **重启监督**：HMAC 签名清单/回执、supervisor/watchdog、desktop launcher、启动恢复与执行回执校验。
- **客户端**：独立收件箱侧栏入口 + 右侧 pane / 固定 drawer 回退；五色分组折叠、分组头三态全选、键盘导航、批量失败逐条 UI、AI 流式、分身看护开关；主面板移除旧决策中心渲染。
- **持久化**：approver 快照从 A/B 扩展为多代（`snapshotGenerations` 默认 3，A–J 可回滚；index v2 跨重启保留）；新增 `dsh-approval-journal.jsonl` 崩溃 journal（request/settled/orphaned），重启把未结 request 标记 orphaned，不复活已死 Promise。
- **启动韧性**：无效/旧盘 `fang-home.txt` 迁移指针自动忽略回退；新增真实重装 drill（同一 DSH_HOME 覆盖安装 + 毒数据后二次 boot）。
- **启动自检**：`tools/boot-guard.mjs`（bundle 行解析/重复 id/子进程 import 冒烟；`--apply` 禁用失败行、`--safe-mode` 全禁用；`--candidate-dir` 候选包冒烟）；restart-guard `selfCheck()` + `GET /fang/api/restart/selfcheck`；`tools/desktop-launch.mjs` 与 `tools/restart-watchdog.mjs` 已自动接 boot-guard（自动探测 profile；失败 + execute → 安全模式；dry-run 只报告；watchdog 可 `--no-boot-guard`/`--no-safe-mode`）。
- **运行时崩溃记录/熔断**：restart-guard 写 `boot-state.json`（booting/running/clean/crashed）+ `runtime-crash.jsonl`（`uncaughtExceptionMonitor`，不改变宿主退出）；launcher 检测上次 booting/crashed 且 pid 已死 → 自动安全模式，避免启动期崩溃循环。
- **更新器门禁**：boot-guard 新增候选包 `smokePackage()` / `--candidate-dir`（子进程 import + 导出 apply）；更新器可按“快照 → 候选冒烟 → 转正/回滚”接线（PluginUpdater 本体仍不在本仓）。
- **测试**：jsdom 客户端 DOM harness（13 项）；SSRF、producer 契约、outbox、streaming、restart HMAC、fork 聚合、多代快照/崩溃 journal 等用例。

### 修复
- **真实 EssenceManager 冲突不出票**：`recomputeAll()` 返回的是 id 数组，旧代码 `Number(array)=NaN` 导致 conflicted/failed 统计为 0；改为数组长度并补真实冲突/失败测试。
- **未读计数口径不一致**：侧栏/tab 用 `rev>seenRev`，收件箱标题用 pending；统一为 pending，`seenRev` 仅做新票提醒去重。
- **无 `requestAnimationFrame` 环境的 drawer ReferenceError**：增加 guard，jsdom 下不再抛错。
- **路由数保持 84**：新增 `/api/forks/supervision`（GET+POST 单注册）后同步删掉重复注册的 `/api/essence/default`；`compat`/allow-list/门禁同步，避免宿主 duplicate-path 抛错导致后续路由静默丢失。
- 其他：AI Key 持久化说明、fork umbrella `decisionTicketPromise` 异步回传、三态全选不误触折叠。

### 测试/门禁
- `preflight --e2e` **GREEN**：1026 tests / 1015 pass / 0 fail / 1 skip / 10 todo（176.8s）；e2e **81/81**（17.4s）；allow-list routes=104 findings=0；compat COMPATIBLE；syntax vet 0 失败。
- 干净 profile 实机安装 drill：**GREEN 9/9**（client half、version=3.1.1、19 行、zero-residue temp home/port）；healthz HEALTHY。
- 产物：`dist/dsh-fang-3.1.1.tgz`（510,730 B / 135 entries）sha256 `385951cd8d1910fe243b190e57f8ebe7fbcba5bf29b573394a578c71d1b53e34`；package-smoke PASS；allow-list(pkg) 117 files。
- **六方发布未执行**：本机缺 npm/GitHub 凭据、工作树未 commit、tag 未落在 main、.exe 安装器不在本仓构建链。详见 `docs/AUDIT-v3.1.1.md`。

### 已知边界
- PluginUpdater / SuperAgent / HarnessMM / PJM / Worker **本体未接**：契约、client/CLI、fork tool、adapter op 已就绪，需外部进程实际调用。
- Agent Loop hook、真实官方 manifest 源、真实 .exe 安装器与桌面壳真机验证未完成。
- 多 Agent 投票/仲裁不做；WebSocket 不做（SSE 足够）。

## v3.1.0（2026-11-07）

**主题：元主运行态继承本机插件/设置；修复 essence 派生 JSON 补丁导致的 `spawn-failed`、派生会话丢失、元主设置 EPERM；隔离迁移遗留会话。**

### 修复
- **元主运行态继承元主配置**：`startEssenceRuntime` 现在传 `cleanTemplate: false` + `nodeModulesSource`，从 essence `merged/profile` 克隆，而不是退回 `base + web-app + fang` 的 clean template。官方/用户元主打开后能看到本机插件与设置。
- **JSON 形状 profile patch 归一化**：`applyForkConfigLock` 识别 `{ insert: [...] }` 与 JSON 数组，结构化合并锁条目/欢迎说明；不再在 JSON object 后追加 YAML 列表，修复 essence 派生分身启动即退出的 `spawn-failed: exited`。
- **元主行派生的会话复制**：`POST /fang/api/tasks/create` 透传 `importSession` / `seed`，元主栏选中的会话会真正复制进分身 home。
- **元主运行态可写**：`setProfileConfigReadonly` 跳过 `essence-runtime`，启用内置插件/修改设置不再 `EPERM rename package.json.<tmp>`；真正的分身仍保持只读。
- **欢迎说明预置**：clean template 与 fork lock 均写入 `ui-settings-general.welcomeNoticeVersion`，首次运行预览说明可正常保存。
- **迁移遗留会话隔离**：官方元主运行态 home 中由旧运行态迁移带入的 4 个历史会话与 workspace 索引移入 `quarantine-sessions/`（数据保留），新打开默认不带历史会话；需要时显式「启动并导入」。

### 测试
- `fork-config-lock`：JSON `{insert}` 结构化合并、`essence-runtime` 不设只读。
- `orchestrator`：`startEssenceRuntime` 的 provision 必须 `cleanTemplate=false` 且带 `nodeModulesSource`。

### 门禁
- `preflight --e2e` GREEN：754 pass / 0 fail / 1 skip；e2e 75/75；allow-list routes=84 findings=0。
- `dist/dsh-fang-3.1.0.tgz`（396,470 B，119 entries）sha256 `a78ab4eb443d8d4f9702ea52322fc13605745c8d1f1e3857a1cc90c8e71a5ac7`。
- `package-smoke` PASS；`install-drill` GREEN 7/7（干净 profile boot 含 `@twinsearth/dsh-fang/client.js`，version=3.1.0）；`healthz` HEALTHY。

## v3.0.10（2026-11-07）

**主题：修复 npm 发布包剥离 `dsh.client` 导致 Web「瓮城」主面板不加载；发布门禁补上 client half 物化断言。**

### 修复
- **npm 包恢复浏览器 client half**：`tools/release/build.mjs` 不再删除 `dsh.client`。v3.0.9 的发布包在 staging 时删掉了该字段，安装后 Web 端只剩设置页入口，侧边栏「瓮城」与主面板（元主/分身 50:50 控制台）全部不出现；构建现在在 `dsh.client` 缺失时直接失败。
- **smoke 断言反转**：`package-smoke.mjs` 由「client half 必须禁用」改为断言 `dsh.client.platform === 'web'`、`client.js` 注册发布包 ID、包含 `sidebar.panellist` 与 `main` 槽位；v3.0.9 的 tarball 会在该门禁直接 FAIL。
- **安装 drill 真实拉取 boot 页**：`install-drill.mjs` 在干净 profile 启动 Web 后请求首页（先交换 302 的 set-cookie），断言 `@twinsearth/dsh-fang/client.js` 在插件清单中；profile 现在写入 `dependencies`，与 `pnpm add` 落盘一致。drill 结束时用 `taskkill /T` 清理宿主进程。
- **healthz 增加 client half 启用检查**。
- **PR 门禁识别 GitHub 合成 merge ref**：`pr-gate` 在 CI 的 `refs/pull/N/merge` 检出上会先解包到真实 PR 提交，再做线性历史与 conventional-commit 检查，避免平台生成的 merge 提交被误判为本 PR 的提交。

### 门禁
- `preflight --e2e` GREEN：751 pass / 0 fail / 1 skip；e2e 75/75；allow-list routes=84 findings=0。
- `dist/dsh-fang-3.0.10.tgz` sha256 `6afe97710f54a6dc84cfff1cb7d8d425a73a5c241d3bb6b3f3488964b240bbb0`。
- `package-smoke` PASS；`install-drill` GREEN 7/7（干净 profile boot 含 `@twinsearth/dsh-fang/client.js`）；`healthz` HEALTHY。
- 详见 `docs/AUDIT-v3.0.10.md`。

## v3.0.9（2026-11-06）

**主题：三区数据布局落地、元主默认元宝与派生入口、分身生产盘硬禁修复、发布物 v3.0.9。**

### 新增
- **三区布局**：`mirror/<tag>`、`essence/`、`forks/`、`sessions/<essenceId>/home` 实拆；`fang-home.txt` 迁移指针；跨区路径守卫（`path-escape` / `invalid-workspace-key`）。
- **迁移工具**：`tools/migrate-to-fang-home.mjs`（dry-run 默认、自动备份、junction 感知、结构化路径重写、运行态归口）、`tools/migrate-runtime-homes.mjs`、`tools/rewrite-fang-paths.mjs`、`tools/repair-fork-patches.mjs`。
- **默认元宝**：`copy-local` 模式只复制本机插件启用状态与设置（不复制会话/数据/代码/凭据）；无用户元主时自动创建，快速派生默认使用。
- **元主「派生」按钮**：替代详情按钮；选一个进行中会话 → 创建分身沙箱并整目录复制会话。
- **物理分支**：adapter `fork-session` op（分身内 `ctx.sessions.fork`）+ 分支库 `sessionId` + `activeBranchId`；分身卡分支面板。
- **运行态开关**：运行中显示「停止 + 进入」，停止后回「打开」；工作区比例 50:50。

### 修复
- 分身 profile patch 的 `[]` 残留导致 YAML 非法、`spawn-failed: exited`；`cordis.yml` 只读导致启动 `EPERM`；两处均已修复并修复存量分身。
- 元主派生时 `cleanTemplate` 覆盖原身模板的问题；派生模板固定为来源元主 `merged/profile`，每次 spawn 重放配置。
- `forker.spawn` 缺 `homeDir` 的 `no-home-dir` 诊断与回归测试。
- 显式 `dataRoot` 不再自动跳 `D:\ToFuture`。

### 门禁
- 全量测试 **750 pass / 0 fail / 1 skip**；rich UI smoke **21/21**。
- 发布物：`dsh-fang-v3.0.9.zip`；PC 安装包 `DSH-Fang-3.0.9-x64-Setup.exe`（默认安装目录 `D:\ToFuture\app`，升级沿用原目录，不删数据区）。
- 已知边界：官方源升级适配器未接入；物理分支真实 `sessions.fork` 待现场验收；分身硬禁的文件系统 ACL 需宿主权限位。

## v3.0.8（2026-11-05）

**主题：分支/回流运行时、MCP 只读桥、FANG_HOME 数据根、DSH Web 侧边栏入口。**

### 新增
- **分支 HTTP**：`GET/POST /fang/api/tasks/branches`、`/activate`、`/status`；`BranchStore` 原子持久化，单写者与不可合并约束沿用。
- **回流策略**：`GET /fang/api/reflow/policy`（sealed→verified→quarantine→adopted，禁止字段，不合并）。
- **MCP**：`tools/mcp/{tools,server}.mjs`；stdio JSON-RPC；默认只读工具 + 高风险 `get_op`/`abandon_op`；输出递归清洗 token/path/template。
- **FANG_HOME**：`$FANG_HOME/mirror/<profile>`、`$FANG_HOME/essence`、`$FANG_HOME/sessions`；未设置时保持旧布局兼容。
- **DSH Web 入口**：侧边栏「瓮城」图标 + 主面板自动唤起 `dsh-fang://open`；插件配置页保留「打开瓮城控制台」。
- **Electron 桌面端**：宿主自动发现、托盘常驻/退出、连接信息掩码弹窗、日志分类与 100/300 分页、标题栏 Slogan；安装器默认 `D:\ToFuture`，AGPL 源码随包。

### 修复
- 任务创建异常返回空响应 → 结构化 500；母体 palette `app is not defined`。
- 代理绝对 URL 可崩溃主进程 → 仅接受单一 `/` 路径 + origin 校验 + 400（absolute-form/`//`/反斜杠/控制字符全部拒绝）。
- 启动器默认开 CDP、写死 Electron 路径；`desktopInfo` 下发 token；`#fang-fallback` 残留。
- **HTTP 契约审计（docs/AUDIT-v3.0.8-HTTP-CONTRACT.md）**：
  - 修复 DSH exact 路由以 path 为键导致的 GET+POST 同路径吞并：`/tasks/branches` 与 `/bridge/sessions` 改为单注册按 method 分发（否则 POST 405、后续路由不注册）。
  - `/sessions*`、`/bridge/*`、`/sync/*`、`/route` 接入与 `/status` 相同的 Host/Origin/CSRF/token 门禁；鉴权先于 method（无 token 不再拿到 405）。
  - 未知 `/fang/api/*` 统一 JSON 404（先鉴权）；branches 未知 taskId 404、taskId/branchId 路径穿越拒绝、分支错误映射 400/404/409。
  - adapter 路由补 loopback Host、Origin/CSRF、JSON 写校验与 405 `Allow`；代理层 403/404/502 统一 JSON，接住 `file://`/`//`/反斜杠 target，token 轮换后自动 bootstrap 并重试 GET；`client.js` 不再因 `headers` 覆盖丢失 `x-fang-auth`。
  - Host 严格解析，拒绝 `[::1]evil` 等 loopback 前缀伪造。

### 门禁
- 路由 **67**；单测 **718 pass / 0 fail / 1 skip**；e2e **73/73**；桌面代理套件 **51/51**；preflight `--e2e` GREEN；安装包 `DSH-Fang-3.0.8-x64-Setup.exe` + SHA256SUMS。

## v3.0.7（2026-11-03）

**主题：发布门禁加固——e2e 不可跳过、client half 物化断言、16 行完整性、.sha256 伴随产物。**

### 门禁修复
- **preflight**：未传 `--e2e` 时新增失败项 `e2e: required for release green`，不再可能 `e2e:null` 仍发绿灯；
  已存在 tarball 时校验同目录 `.sha256`（缺失/不匹配均失败）。
- **e2e**：新增两条免疫本次线上故障的断言：
  - `client half registers @local/dsh-fang`：vm 执行 client.js，确认 `window.__ModuleLoader__.load` 注册；
  - `client half materializes apply()`：调用 factory（stub React）后确认导出 `{inject, apply}`；
  - `16 fang plugin rows composed`：`dsh --profile e2e --dump-config` 统计 `fang-*` 行 ≥16。
- **build**：默认调用 `preflight --e2e`；构建前清理同版本旧产物；生成 `dist/dsh-fang-<ver>.tgz.sha256`。
- **release workflow**：build job 改为 self-hosted Windows 且执行带 e2e 的构建；artifact 与 GitHub Release 均上传 `.sha256`。
- **fallback 面板鉴权**：`/fang/panel` 注入 `<meta name="fang-auth">`，内联 `api()` 自动携带 `x-fang-auth`
  （修复页面「派生失败: unauthorized」）。
- **client half 发现机制纠正**：验证后确认 client half 由宿主 Loader 对**bare 包名行** `@local/dsh-fang`
  的 `dsh.client` 扫描发现；**不新增** `ui-fang → @local/dsh-fang/client` 行（子路径不是包根，会被当作坏插件：
  `failed to import`）。e2e 改为断言 `package declares dsh.client` 与 `no inactive plugin entries`。
- **测试计划**：新增 `docs/TEST-PLAN-v3.0.7.md`（87 条用例，PKG/SEC/ESS/DRV/UI/MIR/CMP/BR/MCP/REL）。
- **PKG-01**：新增 `tools/release/package-smoke.mjs` 并接入 build：解包 tarball、校验入口/16 行/插件 `apply`/
  client 归一一致/`.sha256`；**SEC-07** 增加 e2e 磁盘断言（tasks.json/forks.json 无 token）。
- **S1 UI 动作语义**：新增 `src/lib/ui-actions.mjs`（稳定 action id：分身 6 项 / 元主 7 项；
  每项 `{enabled, code, reason, confirm}`；任务/元主接口统一返回 `actions + blocks`），
  UI-10/UI-11 转为真实断言，剩余 UI 用例以 todo 追踪。

### 验证（本机）
- 无 `--e2e`：**RED**（e2e required + sidecar missing）；
- `--e2e`：**GREEN 3.0.7**（**648 tests**、e2e **66/66**、62 路由、sha256 match）；
- build：preflight GREEN → package smoke PASS → tarball 生成 + `.sha256` 一致。

## v3.0.6（2026-11-03）

**主题：元主 CRUD + 默认元主 + 分身列表契约字段（后端契约 B，先行；UI 移植随后）。**

### 新增
- `EssenceManager`：`rename/archive/setDefault/getDefault/copy/pluginCount/downloadBundle`；
  - 复制只带 overlay/settings，**不复制 credentials**；导出 JSON 附件同样排除凭据；
  - locked 官方原身拒绝 rename/archive；默认元主持久化到 `essences/default.json`，官方兜底。
- orchestrator 路由（10 条）：`essence/create|rename|archive|delete|copy|default|download`、
  `tasks/rename|copy|download`；`essence/list` 增加 `defaultId/defaultEssence/capacity{slots:7,defaultLimit:5,used}` 与
  `locked/official/archived/pluginCount`。
- 分身列表字段：`phase`、`health{adapter,error}`、`sessionTitle`、`startedAt/updatedAt`、`projectBytes`、`essenceId`。
- 契约文档：`docs/API-v3.0.6.md`。

### 测试
- 新增 `test/essence-crud.test.mjs` 5 项（rename/archive/default/copy 无凭据/导出无凭据）；
- orchestrator 路由断言更新（62 路由），create→rename→list 契约链路。

### 未交付（明确）
- 配额准入执行（reserve/commit/tombstone）、元主 pause/restart、分身完整项目归档、分支/单会话租约（v3.0.7+）。

## v3.0.5（2026-11-03）

**主题：安全止血（完整包）：B1 路由鉴权/CSRF/Host + B2 Adapter fail-closed + B3 路径穿越/大小上限 + B4 token 去 URL/不落盘 + B5 派生 env 白名单 + B6 官方原身 create-only + B8 凭据不复制。**

### 安全修复
- **B1** 新增 `src/lib/http-auth.mjs`：安装级 token（`<dataDir>/fang-auth.json`，0600，env/显式配置可覆盖）；
  所有 `/fang/api/*` 默认要求 `x-fang-auth`（或 Bearer）；loopback Host 校验、Origin/`Sec-Fetch-Site` CSRF 校验、
  写请求 JSON content-type；面板通过同源 `GET /fang/api/auth-token` bootstrap（仍受 Host/Origin 校验）；
  `client.js` 统一缓存并携带 header。e2e 作为本机客户端按真实方式读取 token 文件。
- **B2** `adapter.mjs`：fork 角色未拿到 `DSH_ADAPTER_TOKEN` 时默认 **fail-closed**（控制面 401），
  v2 兼容必须显式 `allowLegacyNoToken: true`；启动时记录 warn。
- **B3** `session-bundle.mjs`：导入时校验 `file/sessionId` 必须落在 bundle/sessions 与 targetRoot 内，
  拒绝 `../` 穿越；新增单文件/总大小/文件数上限（默认 64MB/512MB/2000）。
  `session-sync.mjs`：bundleId 只允许安全段；bundleDir 必须位于 bundleRoot 内；
  targetHome 只允许当前 DSH_HOME 或 fork homes 根；请求体上限 1MB（413）。
- **B4** `remote.mjs`：token 只走 `Authorization` header，不再拼进请求 URL；
  `forker.mjs`：`publicFork`/`forks.json` 的 URL 去 token、不再持久化 token；
  `orchestrator`：`tasks.json` 不落 token、列表 URL 去 token；新增 `GET /fang/api/tasks/open-url`
  在内存中临时下发带 token 的 URL（client.js 打开分身改走该接口）。
- **B5** `forker.mjs`：新增 `buildForkChildEnv` 环境变量白名单，不再 `...process.env` 全量继承；
  云密钥/自定义 token 不进入派生子进程（Adapter token 仍由 forker 显式注入）。
- **B6** `essence.mjs`：`create()` 改为 **create-only**（已存在 id 直接拒绝，不能抢占官方原身）；
  `ensureOfficialEssence()` 发现 locked/official 被篡改时修复 meta（uid 不删数据）；
  `locked/official` 只能由内部 official seed 设置。
- **B8** `essence.mjs`：物化 `merged/profile` 时**永不复制 credentials**（镜像与原身凭据都不进入派生 profile）。

### 测试
- 新增 `test/security-hardening.test.mjs`（5 项：create-only、seed 修复、env 白名单、bundle 穿越、大小上限）；
  新增 `test/http-auth.test.mjs`（7 项：token 文件 0600、Host/Origin/CSRF、415、bootstrap 校验）；
- 更新 `essence` 凭据断言、`adapter` legacy auth 断言、`remote`/`adapter-client`/`orchestrator`/`e2e` 的 token 断言；
- 门禁：**636 tests / 0 fail / 1 skip**、**e2e 59/59**、**52 路由**。

### 说明
- B1/B4 已包含在本版本内，v3.0.5 达到“安全止血包”退出条件（可进入 tag 流程，但仍需按 v3.0.0 起的严格序列补发）。
- 已知例外：SSE `eventsUrl` 仍以查询参数携带 token（EventSource 无法设 header），后续改为 fetch streaming 时消除。

## v3.0.4（2026-11-02）

**主题：三层产品形态权限契约 + 官方推荐原身（fast derive 默认基底）。**

### 新增
- `src/lib/permissions.mjs`：三层权限矩阵（母体禁插件/禁会话、原身可插件/禁会话、分身禁插件/可会话），
  `checkPermission` / `createEnvironmentGuard`（can/check/assert + `PermissionDeniedError`）/
  `describePermissions`；未知环境或未知动作 **fail-closed**（供 UI 与 Adapter 第二道门）。
- `EssenceManager` 官方推荐原身：
  - `ensureOfficialEssence()` 首次启动幂等 seed（`essence-official-dev`，locked + official，
    预装默认插件条目 `DEFAULT_OFFICIAL_PATCH_ENTRIES`）；
  - 锁定保护：`update/remove/setTier` 对 locked 原身一律拒绝；
  - `create()` 支持显式 id / locked / official / skipQuota / defaultPatchEntries。
- orchestrator：启动时 seed 官方原身（失败仅 warn，不阻塞主插件）；
  新增 `GET /fang/api/essence/list`（`{officialId, official, essences}`）。
- 测试：`permissions` 7 项、`official-essence` 5 项 + orchestrator 路由断言。
- compat 门禁路由契约更新为 50 条，必需路由增加 `/fang/api/essence/list`。

### 边界
- 分身派生（DerivedInstanceManager）与三种 Web 视图路由为 v3.0.5+；
- 真正的硬隔离仍靠 profile 组合（装不装插件/会话），本版本提供第二道门与默认基底。

## v3.0.3（2026-11-02）

**主题：客户端升级后的兼容性门禁（compat gate）——子插件默认关闭，验证通过才启用。**

### 新增
- `src/lib/compat.mjs`：`runCompatGate`（内核入口可导入、全部子插件模块可导入且导出 `apply`（当前 16 个，后续自动纳入）、
  路由契约数量 + 必需路径检查）；`writeCompatStatus`/`readCompatStatus`（`compat-status.json`，
  **`subPluginsEnabled` 是唯一允许启用子插件的判据，未检查/失败时均为 false**）。
- `MirrorManager` 新增 `compatGate` / `onCompatResult`：客户端版本升级成功后先跑 compat 门禁；
  未通过 → 保留新版本但 `reason: 'compat-gate-failed'`、子插件保持关闭、**跳过原身重算钩子**；
  门禁抛错按失败处理；通过 → 正常触发重算。升级返回体携带 `compat` 结果。
- orchestrator 接线：`GET /fang/api/mirror/recompute-status`（协调器状态）、`GET /fang/api/compat`、
  `POST /fang/api/compat/check`；启动 1.5s 后自动跑一次门禁；门禁使用真实 webServer 路由列表
  （期望 49 条）+ 必需路由清单。
- 测试：`compat` 10 项（模块导入/apply/路由契约/状态默认关闭/门禁与升级联动）+ orchestrator 路由断言。

### 语义
- 更新客户端版本后默认不开启子插件；门禁通过才写 `subPluginsEnabled: true`；
- 失败时主插件继续服务（面板/路由可用），等待开发者更新插件版本后再次检查（POST compat/check）；
- 门禁失败不回滚客户端版本（保留新版本），回滚仍可走镜像备份/还原盘。

## v3.0.2（2026-11-02）

**主题：升级后重算协调 + 镜像偏好 schema 化 + 空闲降级审计。**

### 新增
- `src/lib/semaphore.mjs`：计数信号量（并发上限）。
- `EssenceManager.recomputeAll(options)` 异步增强：ensureFresh（fingerprint 匹配 → skipped）、
  `concurrency`（默认 4）、`perEssenceTimeoutMs`（默认 60s）、`AbortSignal`、`onProgress`；
  返回 `{recomputed, skipped, conflicted, failed, aborted, durationMs}`，单原身失败/超时不中断整批。
- `MirrorManager.postUpgradeHook`：升级成功后 fire-and-forget 触发（`postUpgradeTriggered`），
  失败/回滚不触发，钩子异常只 warn，不影响升级结果。
- `src/lib/upgrade-coordinator.mjs`：`onUpgradeSuccess` 去重并发批次、`getRecomputeStatus`、
  `waitForRecompute`，向 UI 暴露 running/startedAt/finishedAt/progress/lastResult/lastError。
- `src/lib/preferences.mjs` 重写为 schema 驱动：6 个字段描述符（交互超时/活跃与空闲轮询间隔/
  备份保留天数/空闲提示/严格冲突模式），默认值、min/max/step、enum options、migrate、
  `normalizePreferences` 纯函数、未知字段丢弃、损坏文件不覆盖；新增
  `GET /fang/api/mirror/preferences` 与 `POST /fang/api/mirror/preferences/set`。
- `src/lib/status-store.mjs`：外部 store（每个订阅者共享状态、304 只更新 lastUpdatedAt、
  订阅计数、`acquireActive` 引用计数 + `pokeActive` + 30s 无交互降级、`setActiveIdleTimeout`）。
- `src/lib/idle-audit.mjs`：空闲降级事件聚合（单条审计 + 周期 summary、byTimeout 统计、
  rapidAway/fullTimeout、样本足够时生成建议）；滚动窗口 `getRecommendations()` 输出结构化建议
  （fieldKey/suggestedValue/text/sampleCount/confidence），快照窗口与滚动窗口分离。
- `src/lib/interaction-poke.mjs`：DOM 交互节流 poke（框架无关）。
- 测试：`upgrade-coordinator` 8 项、`status-store` 12 项、`idle-audit` 7 项、
  `idle-recommendations` 7 项、`preferences` 9 项 + orchestrator preferences 路由断言。

### 边界
- coordinator / status-store / idle-audit 的 UI 接线在客户端包与后续版本完成；
- 自动备份清理、dismissals 7 天冷却等仍待实现。

## v3.0.1（2026-11-02）

**主题：母体镜像管理（文件夹 1）：备份 / 恢复 / 自动备份 / 升级 / 回退 + 小光盘面板入口。**

### 新增
- `src/lib/mirror.mjs`（零依赖）：
  - 目录布局 `active/ + backup/ + restore/ + backups.json + meta.json`；
  - `backup()`（自动/手动分桶）、`restore()`（先自动备份当前 active 再替换）、`deleteBackup()`、
    `setBackupInterval()`（仅 6/12/24）、`maybeAutoBackup()`（到期检查）、`checkUpdate()`；
  - `upgrade({autoBackup, autoRollback, onProgress})`：检查 → 备份 → 下载 staging → 原子替换 → 失败自动回滚；
    未配置官方源时显式返回 `official-source-unavailable`（不假装成功）；
  - `getStatus()`：版本/官方最新/更新可用/备份列表/磁盘占用/活跃分身数；`backupId` 正则防路径穿越。
- 服务 `SERVICE.mirror = 'fangMirror'`（由 `fang-orchestrator` 提供）+ 6 条路由：
  `GET /fang/api/mirror/status`、`POST /fang/api/mirror/{backup,restore,backup/delete,backup-interval,upgrade}`。
- orchestrator 每 60s 检查自动备份到期；新增 `Config.mirrorRoot`（空 = `<dataRoot>/mirror`）。
- `client.js`：顶栏「镜像」按钮（蓝色小光盘 `IconDisc`）+ 「母体镜像」卡片：状态轮询（8s）、
  6/12/24 小时间隔、立即备份、备份列表恢复/删除（二次确认）、升级（indeterminate + 已用时间）。
- `test/mirror.test.mjs` 16 项 + `test/orchestrator.test.mjs` 路由/处理器断言；
  `docs/MIRROR.md`（布局/路由/升级语义/边界/未交付）。

### 未交付（明确边界）
- 官方源未接入：`checkUpdate/upgrade` 显式降级，升级按钮在无更新/无源时禁用；
- 原身（文件夹 2）与会话（文件夹 3）的派生与隔离（P2/P3）；
- 升级进度的 SSE 推送（当前为 indeterminate + 已用时间）。

> 版本策略：`x.y.z`；新增能力进 minor 位（v2.10.0 → v3.0.1）。

## v2.10.0（2026-11-02）

**主题：Essence 原身覆盖层合并库（镜像 × 原身，零依赖实现）。**

### 新增
- `src/lib/essence.mjs`（v2.10.0）：
  - 纯合并 `mergeProfiles(mirror, overlay)`：patch 条目按 id（覆盖/禁用/新增，config 深合并）、
    package.json 依赖并集与主版本兼容判定、settings 深合并、锁定项 fatal 保护、重复 id warning；
  - 冲突模型：`missing-plugin` / `locked-plugin-overridden` / `locked-plugin-disabled` /
    `version-incompatible` / `duplicate-id`，分 `fatal` 与 `warning`；
  - `EssenceManager`：`create/update/remove/list/listChildren/setTier/recompute/recomputeAll/getConflicts`，
    磁盘布局 `overlay/ + merged/profile/ + meta.json (+ conflicts.json)`；fatal 时保留上一次物化结果并标记
    `status: conflicted`；物化时剔除镜像凭据、只复制原身 `credentials/`；
  - 配额：`VIP_QUOTAS`（free 5 / vip10…vip100 100）+ `checkEssenceQuota` / `checkSubEssenceQuota` /
    `checkActiveSessionQuota`；两级原身、父原身删除保护；
  - YAML 复用 `rule-registry` 的 `parseYamlSubset`（无新增依赖）；写出 JSON（JSON 是合法 YAML）。
- `test/essence.test.mjs` 23 项：合并语义 / 冲突分级 / 配额 / 物化 / 凭据边界 / 配额上限 / 两级原身 / recomputeAll。
- `docs/ESSENCE.md`：三层数据边界、合并语义、配额表、冲突状态机、未交付项。

### 未交付（明确边界）
- 本版本不接 HTTP 路由、不接面板 UI、不创建分身进程；`merged/profile` 已可作为 `--profile` 供后续 P3 派生使用。

> 版本策略：`x.y.z`；新增能力进 minor 位（v2.9.x → v2.10.0）。

## v2.9.2（2026-11-02）

**主题：顶栏新增「母体打开」按钮（蓝色地球图标）。**

### 新增
- `client.js`：顶栏在「母体连接」与「派生新分身」之间新增「母体打开」按钮（`IconGlobe`，
  INFO 蓝色地球图标）；点击在新窗口打开母体瓮城独立门户 `/fang/panel`。
- 桌面壳下用 v2.9.1 的 `resolveMotherOrigin()` 拼绝对地址（如
  `http://127.0.0.1:52648/fang/panel`），避免 `dsh-app://app/fang/panel` 这类自定义协议
  在新窗口里打不开；普通 Web 下回退相对路径 `/fang/panel`。
- `window.open` 被拦截时回退到同标签页跳转，不静默失败。

> 版本策略：`x.y.z`；这是 v2.9 的补丁位。

## v2.9.1（2026-11-02）

**主题：修复桌面端「母体连接」默认地址不可探测（`dsh-app://app` → target-scheme）。**

### 修复
- `client.js`：新增 `resolveMotherOrigin()`——桌面壳里 `window.location.origin` 是
  `dsh-app://app`（自定义协议，不是可探测的 HTTP 源），改为优先读取宿主注入的
  `__DSH_TRANSPORT__.streamBaseUrl`（desktop `main.ts` 注入的 Host 真实 HTTP 源，
  如 `http://127.0.0.1:52648`）；普通 Web 下回退 `location.origin`；两者都不可用时
  返回空串让用户手动填写，而不是预填一个必然失败的地址。
- `client.js`：探测错误码翻译为可操作原因（`target-scheme` → “桌面壳地址不是可探测的
  HTTP 源”，`timeout`/`network-error`/`target-empty` 等各有提示），不再把原始码直接丢给用户。
- 服务端无改动：`probeLink` 继续只接受 http(s) origin（拒绝 `dsh-app://` 是正确行为，
  分身无法跨进程访问该协议）。

> 版本策略：`x.y.z`；这是 v2.9 的补丁位。

## v2.9.0（2026-11-02）

**主题：瓮城面板「母体连接」——只描述、只读探测，不持有连接状态。**

### 新增
- 服务 `SERVICE.link = 'fangLink'`（由 `fang-orchestrator` 提供）：
  - `describe()`：`{ ok, role, version, at, prefix, motherApiBase, adapterBase, probe, tokenPolicy, sharedConfig, forkInstructions }`；
  - `probe({ target, timeoutMs? })`：只读 GET `<target>/fang/api/status`，失败结构化、绝不抛异常。
- 母体路由：`GET /fang/api/mother-link`、`POST /fang/api/mother-link/probe`（prefix 默认 `/fang`）。
- `src/lib/mother-link.mjs`：地址归一化（只接受 http(s) origin，拒绝凭据/查询串/非 http）、
  profile 共享配置摘要（读 `dsh.profile.bundles`，失败降级 null）、探测超时夹在 [200, 10000]ms。
- 客户端：顶栏「母体连接」卡片（母体版本 / 母体 API / 分身 Adapter / 共享配置 / 令牌策略 +
  地址输入 + 复制地址 + 测试连通 + 收起）；分身 Web UI 的说明页增加分身旁路模式，地址与结果
  仅本次会话内存态（分身不保存插件设置）。
- 审计：`AUDIT.LINK_PROBE='link-probe'`（target / ok / latencyMs / error）。

### 语义与边界
- 令牌由 Forker 在 spawn 时注入 `DSH_ADAPTER_TOKEN`；fang 不落盘、不回显（描述里不含 token 值，有测试断言）。
- 共享配置 = 母体 profile 层（分身只读继承）；本版本不提供写入入口。
- 分身跨源直读母体受浏览器 CORS 约束：失败显示 `cross-origin-or-network`，不伪造成连通。
- 探测不写任何配置，不改变副本状态。

### 文档与测试
- `docs/CONTRACTS-V2.md §5.10`、`docs/UI-瓮城入口.md §9`、`docs/AUDIT-v2.9.0.md`。
- `test/mother-link.test.mjs` 7 项；`orchestrator.test.mjs` 增路由与处理器断言。

> 版本策略：`x.y.z` 每一位 0–9；v2.8 的补丁位已满（2.8.4），本次进位到 v2.9.0。

## v2.8.4（2026-11-02）

**主题：公共仓 / 私有镜像仓 发布管理 —— 可重复的 REST 同步 + 内容树/资产双重校验。**

### 新增
- `tools/release/sync-private.mjs`（零依赖，仅 GitHub REST API）：
  - `verify --tag vX.Y.Z`：比较两仓 tag→commit→**内容树 SHA**，下载各自 Release tarball 校验
    `manifest.json`、`.sha256`、实际哈希三者自洽；不一致退出码 1；支持 `--json`；
  - `sync --tag vX.Y.Z`：以内容寻址做增量 blob（复用未变文件）、断言私有 tree == 公共 tree、
    私有 `main` 仅 fast-forward、创建 annotated tag 与 Release 资产；支持 `--dry-run`；
  - 用 REST 而非 git push：发布机只放行 `api.github.com`/`uploads.github.com`。
- `docs/RELEASE-MIRROR.md`：两仓定位（公共=唯一事实来源、私有=只读镜像）、版本流转、
  同步语义、发布后三件核对、故障表与红线（禁手工提交/禁 force push/同步后必须 verify）。
- `test/sync-mirror.test.mjs` 8 项：参数解析、增量 blob 计划、资产自洽判定、树比较、SHA-256 向量。

### 同步实践（v2.8.3 已镜像）
- 私有仓 `main` 更新到 **v2.8.3 内容**（tree `cd9e53f4…`，与公共仓 tag 树一致），annotated tag `v2.8.3`，
  Release 资产 3 个（tarball 286,944 B / sha256 `3c97748e…`、`manifest.json`、`.sha256`）；
- 公共 Release v2.8.3 的 `.sha256` 已按 CI 重建产物校正为 `8bc30c67…`（286,952 B）；
- `verify --tag v2.8.3` 通过（`trees.ok=true`、两仓资产均自洽）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 4 个补丁位。

## v2.8.3（2026-11-02）

**主题：严格模式 + 语法错误的回退语义（组 4 扩展）——事务化 rebuild，失败层对后续层不可见。**

### 变更
- `rule-registry.rebuild` 重构为**纯计算** `computeRebuild(layerList)`：不再就地修改 `effective`/`status`，
  返回 `{ applied, effective, status }`；`applyLayer`/`applyConfig`/`clearLayers` 只在 `applied` 时提交。
  失败时 `layers`/`effective`/`status`/`strictMode` **全部保持上一次成功值**，失败层对后续层完全不可见。
- 失败结果新增 `revertedToLayerIndex`（`-1` = 内置全集），审计与 `ruleConfigStatus()` 可直接回答
  「哪一层被拒绝、回退到了哪一层」。
- **YAML 解析修正**：支持 flow 映射 `{ k: v, k2: v2 }` 与嵌套 flow 列表 `[{ re: "..." }]`
  （深度感知、尊重引号）。此前 `settings: { failOnInvalidPattern: true }` 会被当成标量字符串，
  导致 `settings` 静默回落到默认值——写了严格设置却不生效。这是组 4 测试暴露的真 bug。

### 测试
- 扩展组 4（`test/rule-config.test.mjs` 30 → **35 项**）：严格层编译失败回退到上一个成功层、
  第二个严格层失败回退到第一个严格层（不是内置全集）、失败后 `inherit:true` 层叠加到上一个成功层、
  失败层状态隔离（layers/effective/strictMode 均不被污染）、插件层状态报告。
- 全量测试 **494 → 499 项**（498 pass / 1 skip）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 3 个补丁位。

## v2.8.2（2026-11-02）

**主题：`inherit: false` 严格模式 —— 项目可完全替换可调规则集，但拆不掉安全边界。**

### 新增
- YAML 顶层 `inherit`（boolean，默认 `true`）。`inherit: false` 表示**丢弃此层之前所有可调规则**，
  只保留硬规则（`hard-deny`/`non-negotiable`）+ 兜底 `unknown-tool`，再从该层开始叠加。
- `registry.applyLayer` 支持多段严格模式：以**最后一个** `inherit: false` 层为起点重建；它之前的层全部丢弃；
  之后的 `inherit: true` 层叠加在严格结果上，**不会**恢复被丢弃的内置可调规则。
- 后续层可按 id **重新引入**被丢弃的内置规则（用内置定义"复活"再覆盖），避免严格模式后必须重写谓词。
- 严格模式返回 `source: 'strict-replaced'` 与 `strictMode: { layerIndex, preservedHardRules, preservedFallback, discardedRuleCount }`；
  `ruleConfigStatus().strictMode` 同步可见。
- 审计：严格模式激活时写一条 `AUDIT.UMBRELLA_STRICT_MODE`（`umbrella-strict-mode`），
  记录层号、保留的硬规则、丢弃数量与各层应用结果（新增 kernel 审计类型）。
- 安全网：rebuild 结果若不含 fallback 规则视为 bug，直接拒绝应用。
- `docs/RULES-BASELINE.md §8`：严格模式语义矩阵、优先级重置、审计、示例；`CONTRACTS-V2.md §5.9` 同步。

### 语义要点
- `inherit: false` + 无规则定义 = 只剩 3 条硬规则 + 兜底的「极简安全模式」，**合法**，不报错；
- 硬规则在严格模式下仍受锁定约束：不可关闭、不可降级；可追加 pattern、可提升灯色；
- 严格模式层自身的 `errors` 按该层 `settings` 判定 fatal；锁定违规一律 fatal；
- 被拒绝的层从层栈弹出，effective 保持上一次有效规则。

### 测试
- `test/rule-config.test.mjs` 23 → **30 项**：极简严格模式、只保留自定义可调规则、硬规则拒绝关闭/降级、
  严格后叠加不回退、较晚严格模式覆盖较早层、`inherit` schema、插件状态与审计事件。
- 全量测试 **487 → 494 项**（493 pass / 1 skip）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 2 个补丁位。

## v2.8.1（2026-11-02）

**主题：Umbrella 推荐基线配置 + 三层叠加 + 硬规则锁定。**

### 新增
- `defaults/umbrella-rules.yaml`：随包分发的**推荐基线**。只显式锁定 4 条规则——
  `dsh-lifecycle` / `destructive-command` / `credential-access`（red，hard-deny + non-negotiable）
  与兜底 `unknown-tool`（yellow，priority 9999）；11 条可调规则**留空 = 用内置默认**（注释里给推荐值），
  项目按需在自己的叠加层里覆盖。`package.json files` 新增 `defaults/**`。
- 分层加载（`registry.applyLayer`）：**基线 → 项目 `rulesFile` → 环境 `UMBRELLA_RULES_PATH`**（`envRulesFile` 可覆盖路径）；
  后层按 id 覆盖前层；被拒绝的层**从层栈弹出**并恢复上一次有效规则（否则坏层会污染后续 rebuild）。
- 硬规则锁定（`NON_NEGOTIABLE_TAGS = hard-deny | non-negotiable`）：不可 `enabled: false`、不可降低灯色；
  允许提升灯色 / 追加 `pathPatterns`·`commandPatterns` / 改 reason / 改 priority。锁定违规**一律 fatal**。
- 插件配置新增 `baselineFile`（空 = 随包基线；`:none:` = 关闭）与 `envRulesFile`；
  `ruleConfigStatus()` 现在返回每层 `name/file/applied/found/errors`。
- `docs/RULES-BASELINE.md`：基线内容、分层与合并、锁定语义、部署位置与加载顺序、覆盖率边界。

### 测试
- `test/rule-config.test.mjs` 18 → **23 项**：基线文件可解析且带锁定标签、三层合并顺序、
  锁定拒绝关闭/降级且整层回退、允许追加 pattern、插件默认加载随包基线、环境层叠加。
- 全量测试 **482 → 487 项**（486 pass / 1 skip）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 1 个补丁位。

## v2.8.0（2026-11-02）

**主题：动作规则表 YAML 化 —— 内置规则 + 叠加层，按需启用/禁用/调参而不改代码。**

### 新增
- `src/lib/rule-registry.mjs`：
  - **YAML 子集解析器**（`parseYamlSubset`）：块映射 / 序列 / 引号标量 / 简单 flow 列表 / 注释；
    tab 缩进、多文档、结构错误都给出明确错误（不静默）；
  - **schema 校验**（`validateRuleConfig`）：`version` / `settings` / 规则字段 / 9 种 matcher kind /
    pattern 长度与数量上限；错误逐条给出，**不做部分接受**；
  - **正则安全启发式**（`isSafePatternSource`）：拒绝明显灾难回溯形状（`(a+)+`、`(.*)*`）与超长模式，
    `settings.rejectUnsafeRegex: false` 时可关闭（不推荐）；
  - **声明式编译器**（`compileDeclarativeRule`）：9 种 matcher（`command-pattern` / `path-pattern` /
    `path-outside` / `url-host-in` / `url-host-not-in` / `tool-in` / `pid-equal` / `always` / `never`）
    + 3 种 evidence（`pattern-match` / `list-match` / `static`）；
  - **RuleRegistry**（`createRuleRegistry`）：内置规则 + YAML 叠加，**事务化**应用
    （失败保留旧规则）；支持 `enabled:false`、`light/priority/reason/tags/category` 覆盖、
    给内置规则追加 `commandPatterns`/`pathPatterns`、声明式新规则、`resetToBuiltin`；
  - **文件加载 + 热加载**：`loadRuleConfigFile` / `watchRuleConfigFile`（`fs.watch` + 防抖，失败保留旧规则）。
- 插件 `fang-umbrella` 配置新增 `rulesFile` / `rulesWatch` / `rulesDebounceMs`；
  服务面新增 `ruleConfigStatus()` / `reloadRules()` / `applyRuleConfig()` / `ruleRegistry`。
- `createUmbrella({ registry })`：动作评分改用注册表规则（不传则沿用原规则集）。
- `docs/UMBRELLA-RULES.example.yaml`：带注释的完整示例（开关 / 覆盖 / 追加正则 / 声明式新规则）。

### 语义要点
- 内置规则**永远存在**，YAML 只是叠加层；未提及的规则保持原样；
- 优先级：`DEFAULT_RULE_PRIORITIES`（10…9999）为基线，YAML 可覆盖；同优先级按内置顺序稳定排序；
- 未知 id 默认只警告；`settings.failOnUnknownRule: true` 时整份拒绝；
- 正则编译失败：`failOnInvalidPattern: false` 跳过该条、`true` 整份拒绝；
- 热加载失败 **不得** 让评分器裸奔：先构造新数组、校验通过才替换。

### 测试
- 新增 `test/rule-config.test.mjs` **18 项**（YAML 解析、schema、正则安全、9 种 matcher、
  禁用/覆盖/优先级/追加正则、未知 id、failOnInvalidPattern 事务化、文件加载、热加载管线、
  插件接线、门面 registry 接线）。
- 全量测试 **464 → 482 项**。

> 版本策略：`x.y.z` 每一位 0–9；`2.7.9` 已满位，本次进位到 `2.8.0`（v2.8 的首个补丁位）。

## v2.7.9（2026-11-02）

**主题：把 `parseShellRedirects` 从正则升级为 shell 词法/语法解析（AST-lite）。**

### 变更
- `src/lib/umbrella.mjs` 新增 **AST-lite 词法器**（`tokenizeShell`），`parseShellRedirects` 改为在其上按语法结构提目标：
  - 重定向操作符语义化：`>` `>>` `>|` `&>` `&>>`、`<`、`<>`、`>&`、`<&`、`<<`、`<<-`、`<<<`，支持 fd 前缀（`2>` `3>>`）；
  - **fd 复制不是文件**：`2>&1` 不再被误判为「写目标 `&1`」；
  - **heredoc 正文整段跳过**（`cat <<EOF > out.txt` 只认 `out.txt`，正文里的 `>` 是数据）；
  - **引号内的 `>` 不是重定向**（`bash -c 'echo x > out.txt'` 不误抓，落 exec 规则判黄）；
  - 动态目标（`$VAR` / `$(...)` / 反引号 / brace / 通配）标记 `dynamic` 并写进 `warnings`，不当作路径；
  - 命令段边界（`;` `&&` `||` `|` `&` 括号 换行）使重定向只归属自己那段命令；
  - 隐式文件命令从 argv 取目标：`tee`、`dd if=/of=`、`Set-Content`/`Out-File`/`Add-Content`、`cat/Get-Content/type/less/head/tail/more`。
- `buildActionContext()` 新增 `parseFailed` / `parseError` / `heredocs` / `warnings`；规则据此 **fail-closed**：
  - `exec-read-only` 在解析失败时不再匹配（不宣称只读）；
  - 有 `>` 且解析失败 → `write-outside-buffer` 命中，证据 `unparsed-redirect-fail-closed`（黄）；
  - 否则 → `exec-side-effect` 的 `unparsed-command-fail-closed`（黄）。
- 未引入第三方依赖：`shell-quote` 只 tokenize 不认操作符，`@aliou/sh`（v0.3.4，MIT AND BSD-3-Clause，零运行时依赖）
  虽是合理选择但会破坏本仓库零依赖约束，因此手写只覆盖重定向提取的词法器；PowerShell 走同一词法器并如实声明边界。
- TypeScript 参考实现同步（`tokenizeShell` / 新 `parseShellRedirects` / `parseFailed` / 规则 fail-closed）。

### 测试
- `test/umbrella.test.mjs` **45 → 53 项**：操作符全覆盖、fd 复制、heredoc 跳过、引号、动态目标、命令边界、
  隐式文件命令、语法错误 fail-closed、token 结构断言。
- 全量测试 **456 → 464 项**；TS 参考实现行为断言 **76 → 95 项**。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 9 个补丁位。

## v2.7.8（2026-11-02）

**主题：动作规则表声明化 —— 与 AST 规则表同粒度（`match` / `evidence` 可独立测试）。**

### 新增
- `src/lib/umbrella.mjs`：
  - `DEFAULT_ACTION_RULES`：15 条**声明式规则**，字段统一为
    `{ id, category, light, reason, tags[], match(evidence, context), evidence(evidence, context) }`，
    数组顺序即优先级、**首个命中胜出**；规则 id / 灯色与 v2.7.6 完全一致（行为不变）。
  - `buildActionContext()`：`mode` / `commandText` / `targetPath` / `url{raw,host,hostPort}` / `targetPid` /
    `writeTargets[]` / `readTargets[]`，一次解析供 15 条规则共享。
  - `parseShellRedirects()`：`>` `>>`、`tee`、`dd of=`、`Set-Content`/`Out-File` 的写目标，
    `cat/less/head/tail/more/Get-Content/type` 的读目标；**只解析字面量**，`$VAR`/`$(...)`/通配等动态构造一律跳过
    （交给兜底规则判黄，不静默放行）。
  - `parseUrlParts()`：不依赖 `URL` 全局对象，带默认端口（http 80 / https 443）。
  - `createActionRuleSet()` + `assertActionRule()`：`register(rule, {before|after})` / `override` / `remove` / `reset`。
    注册**必须显式给位置**（追加到表尾等于永不命中）；重复 id、未知 `category`、未知灯色、缺 `match`/`evidence`
    一律在注册时抛错，不会在评分路径上静默漏判。
  - `baseLight()` 改为表驱动，返回新增 `category` / `tags` / 结构化 `evidence`（`matchedPattern` 等）；
    `assessAction` 与 `umbrella-decision` 审计记录同步带 `category` + `evidence`。
- 插件面 `fangUmbrella` 新增：`explain(evidence)`、`rules`、`ruleIds()`、
  `registerRule/overrideRule/removeRule/resetRules`。
- TypeScript 参考实现同步声明式规则表（`DEFAULT_ACTION_RULES` / `createActionRuleSet` / 上下文解析），
  编译产物上跑 76 项行为断言。

### 测试
- `test/umbrella.test.mjs` **35 → 45 项**：规则表形状/顺序/冻结、15 条规则逐条命中与证据形状、
  上下文解析（重定向/URL/相对路径/PID）、规则集注册/覆盖/移除/重置与错误分支、
  自定义规则影响真实评分与决策审计、评分调用不修改规则表。
- 全量测试 **446 → 456 项**。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 8 个补丁位。

## v2.7.7（2026-11-01）

**主题：保护伞的 TypeScript 参考实现 —— 可编译、可验证、不随包发布。**

### 新增
- `types/umbrella/`（7 个 `.ts`）：`types` / `paths` / `cache` / `plugin-scorer` / `action-scorer` /
  `umbrella` / `index` —— v2.7.6 运行时语义的**可编译镜像**。它不 import 任何 `node:` 内建模块，
  文件系统（mtime/hash）、时钟、评分服务、审计全部走注入端口，因此任意宿主只需一个 `tsc` 即可编译。
- `types/tsconfig.json`：`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` +
  `noUnusedLocals/Parameters` + `noImplicitReturns` + `noEmit`。
- `tools/release/typecheck.mjs` + `npm run typecheck`：找到编译器就**真的编译**（失败非零退出）；
  找不到就打印 `SKIP` 与安装方法并退出 0，**绝不会在未编译的情况下说 PASS**。
- `types/README.md`：编译方法（`npx tsc -p types/tsconfig.json` 或 `DSH_FANG_TSC=…`）、Node 宿主适配示例、
  `.mjs ↔ .ts` 映射、8 条与设计稿的差异、边界（无 realpath / 无 UNC / 无强制拦截）。

### 说明
- 运行时仍是纯 `.mjs`；`types/` **不进 `package.json files`**，tarball 不含它；CI 零第三方依赖策略不变
  （未新增 workflow job，也没有新增 `devDependencies`）。
- 本地证据：TypeScript **5.9.2** 严格编译 **0 error**；编译产物跑 35 项行为断言 **35/35**
  （15 条规则、两张下限表、决策矩阵、指纹缓存 / LRU / mtime 失效、审计记录形状）。
- `types/` 与运行时出现分歧时，以 `.mjs` + `docs/UMBRELLA.md` 为准，并应同步修正 `types/`。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 7 个补丁位。

## v2.7.6（2026-11-01）

**主题：保护伞系统（Umbrella）—— 一个证据管道，两个评分出口。**

### 新增
- 新增子插件 `fang-umbrella`（`src/plugins/umbrella.mjs`，loader 行 `fang-umbrella`，
  服务键 `fangUmbrella`，母体 + 分身都激活）与纯逻辑库 `src/lib/umbrella.mjs`：
  - **插件评分**：复用既有 `fang-scorer` 的 import 层扫描与 A–E 分档（不重复扫源码），
    按入口文件 `mtime`（或 inline 源码 sha1）做 LRU 缓存；拿不到 scorer 时失败往坏里判（E + degraded）。
  - **动作评分**：`green / blue / yellow / red` 四色，15 条规则（生命周期、破坏性、凭据、外连、
    动态加载、写、只读 shell、只读、未知工具），每条带 `matchedRule` 供审计追溯。
  - **耦合**：`effectiveLight = max(baseLight, gradeFloor(grade))`，等级只抬不降；
    下限表 `umbrella`（A/B 绿、C 蓝、D 黄、E 红，= 设计稿）与 `strict`（= kernel `GRADE_COLOR`）可选。
  - **决策矩阵**：`allow / mark / ask / delegate / deny`；DSH 生命周期动作委托 restart-guard
    （带 `originLight`），凭据访问是唯一硬拒绝。
  - **审计**：一次 `decideAction` 落一条 `umbrella-decision`；插件评分沿用 scorer 的 `score`，不双写。
- kernel 词汇：`SERVICE.umbrella`、`ROW.umbrella`、`LIGHT`（四色）、`LIGHT_RANK`、
  `AUDIT.UMBRELLA_DECISION`、`MATRIX.umbrella: ['mother','fork']`。
- 依赖注入：`fang-umbrella` 在 `bufferRoot` 未配置时读 `buffer-keeper` 的实时 `dir`，
  策略以函数形式传入，buffer root 变化不需要重建保护伞（缓存不受影响）。

### 文档
- 新增 `docs/UMBRELLA.md`：三层结构、两张下限表的取舍、15 条规则表与顺序、
  决策矩阵、服务面、缓存策略、与 Router/Approver/RestartGuard/HotReloader 的**接线现状**
  （含「没有工具拦截钩子，保护伞是决策库不是强制闸门」这一边界）、审计形态、校准三问、差异表。
- `docs/CONTRACTS-V2.md §5.9`：`fangUmbrella` 服务契约（输入/输出/失败语义）。

### 测试
- `test/umbrella.test.mjs` 35 项：灯色词汇、两张下限表、4×6 单调性属性、15 条规则与优先级、
  决策矩阵七行、缓存命中/失效/逐出/失效接口、失败往坏里判、等级耦合、审计、实时策略、延迟预算、插件形态。
- `test/role-extensions.test.mjs`、`test/plugins-shape.test.mjs`、`test/kernel.test.mjs`、
  `tools/e2e.mjs` 同步版本号与矩阵行数（15 → 16）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 6 个补丁位。

## v2.7.5（2026-11-01）

**主题：端口生命周期文档化 —— Adapter 复用 DSH 端口，不存在第二个 Adapter 端口。**

### 说明（设计评审结论，非代码变更）
- 设计稿提出「Forker 分配 DSH + Adapter 两个端口、写 `adapterPort`、注入 `DSH_ADAPTER_PORT`、
  AdapterServer 独立 listen、双端口 waitReady / 归还」。本仓库在 v2.6.8 已明确采用
  **单端口**方案：Adapter 的路由挂在分身自己的 DSH `webServer` 上
  （`docs/ADAPTER-COMMANDS.md §1`），没有第二个监听者，因此没有第二份端口生命周期。
- Forker 仍是唯一端口分配者：每分身 1 个池端口（18000–18100，101 个；`maxForks` 默认 8），
  失败/超时/退出/stop/reap/死孤儿六条归还路径均已有代码与测试覆盖；
  Adapter 就绪由 Orchestrator 在同端口做 `/fang/adapter/hello` 握手判定，而不是第二个端口探活。

### 文档
- 新增 `docs/PORT-LIFECYCLE.md`：端口所有权、env 契约、就绪判定、六条归还路径、
  「为什么不需要双端口」、以及未来若真要独立端口的完整改动清单与风险。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 5 个补丁位。

## v2.7.4（2026-11-01）

**主题：连接三步流程可观测化 —— version 信息 / 协议区间 / session 一致性诊断。**

### 说明
- 「GET /version → GET /state → SSE」自 v2.6.1 起已是 `createAdapterClient().connect()`
  的固定顺序（`negotiateProtocol` 先于 state，协议不兼容时不拉快照、不订阅）；
  本版本只补**可观测性**，不改变连接行为。

### 新增
- `connect()` 结果新增 `version`（最近一次 version 响应）与 `sessionMismatch` 字段；
- `client.lastVersionInfo`：version 原始响应（protocol / version / sessionId…）；
- `client.protocolRange`：本次协商实际使用的 `{min,max}`；
- `client.sessionMismatch`：version 与 state 的 `sessionId` 不一致时记录
  `{versionSession, stateSession, at}`（Adapter 在两次请求之间重启过）；
  此时仍以 state 为准续流，不重试三步（state 已是新进程的最新快照）。

### 文档 / 测试
- `docs/CONNECT-PREFLIGHT.md`：三步流程现状、可观测字段、版本兼容规则、错误处理与边界；
- `test/adapter-client.test.mjs` 新增 2 项（8 项）：version 信息/协议区间可观测、
  sessionId 不一致时记录 sessionMismatch 且 SSE 用 state 的 session。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 4 个补丁位。

## v2.7.3（2026-11-01）

**主题：重启结果事件化 —— Forker 发 `fork-restart-failed`，TaskHandle 终态 fail-fast。**

### 新增
- **事件 `fang/fork-restart-failed { forkId, error, terminal }`**（Forker）：
  - 自动重启尝试失败（`restartFork` spawn 失败）→ `terminal:false`（Forker 可能按
    supervise 计划再试）；
  - 放弃重启（`planRestart` give-up / `restart-no-cli`）→ `terminal:true`（不会再有自动重试）。
- **TaskHandle 订阅该事件**：
  - `terminal=true` → 立即 `failed`，不再等 `restartTimeoutMs`（60s）；
  - `terminal=false` → 只记日志、保持 `reconnecting`，由后续 `fork-started` 或
    `forker.status()` 轮询兜底推进（不把「还会重试」误判为终态）；
  - `taskId` 不匹配忽略；`stop()` 仍会立即打断等待（`restartSlot.finish`）。
- 既有 `waitForRestart` 的「事件优先 + 轮询兜底」保留；`fork-started` 仍是成功的完成信号。

### 说明
- 设计稿的 `fork-restarted` 对应仓库既有 `fang/fork-started`（不再新增重复事件）；
- TaskHandle 不自己挂 child `exit` handler，统一由 Forker 的 `fang/fork-crashed` 驱动，
  因此没有「attach 两次」的重复挂载问题；
- 非终态失败不 settle(false)：设计稿原方案会把「Forker 还会重试」误标成 failed，
  这里改为继续等待（见 `docs/TASK-HANDLE.md §3`）。

### 测试 / 文档
- `test/task-handle.test.mjs` 新增 3 项（20 项）：terminal fail-fast、非终态继续等、
  taskId 过滤；
- `test/forker.test.mjs` 新增 1 项（27 项）：supervise give-up 时 emit
  `fang/fork-restart-failed`（terminal=true）；
- `docs/TASK-HANDLE.md §3`：事件驱动重启流程与 terminal 语义。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 3 个补丁位。

## v2.7.2（2026-11-01）

**主题：Forker token 生命周期显式化 —— 补齐 TokenRegistry 公开面（getToken / onTokenRefresh）。**

### 说明
- token 生命周期本身自 v2.6.1 起已在 `forker.mjs` 内联实现（每次 spawn 生成、
  stop 作废、重启重生成、内存 only、env 注入）；本版本补齐设计稿 `TokenRegistry`
  的**公开 API** 并对齐命名。

### 新增
- `forker.getToken(forkId)`：`adapterToken(forkId)` 的别名；
- `forker.onTokenRefresh(handler) → disposer`：每次 `spawn()` 重新生成/刷新 token 时广播
  `(forkId, token)`；handler 异常隔离，disposer 幂等；
  - 首次派生（生成）与崩溃重启（刷新）都会触发；语义是「当前 token」，不是「进程就绪」。

### 测试 / 文档
- `test/forker.test.mjs` 新增 1 项（26 项）：onTokenRefresh 每次 spawn 广播、getToken 别名、
  异常隔离、disposer；既有 adapterToken 生命周期测试保持不变；
- `docs/FORKER-TOKEN.md`：现状、公开面、TS 形状映射、边界（含 adapterPort → webServer 复用）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 2 个补丁位。

## v2.7.1（2026-11-01）

**主题：修复归档不生效 + 新增「读档」存档管理（还原 / 删除）。**

### 修复
- **归档失败却显示成功**：旧实现 `archiveTask` 调 `service.reap()`（停进程 + 删 home），
  且 `reap` 失败时仍返回 `ok:true`。现在归档 = **停止进程 + 保留 home**：
  - 调 `forker.stop()` 后用 `forker.alive()`（真实 PID 存活）确认进程退出；
  - 超时/停不掉 → `{ok:false, error:'stop-failed'}`，任务保持原样，不再假装归档成功；
  - 只有确认退出后才写 `status:'archived'`、`archivedAt`、清空 url/port/token。
- `autoReapIdleMinutes` 的空闲回收改回 `reap()`（删 home），不再误用归档。

### 新增
- **读档 / 存档管理**：
  - `POST /api/tasks/archive`：归档（保留 home，url/port/token 清空）；
  - `POST /api/tasks/restore`：用原 home/profile 重新 spawn（新端口/新 token）+ 握手；
  - `POST /api/tasks/archive/delete`：reap 删除 home + 记录（forker 记录丢失时按 home 兜底）；
  - `GET /api/tasks` 的 archived 任务新增 `archivedAt` / `archiveRemote` 字段。
- **面板顶栏「读档 (N)」按钮**：切换存档视图；存档卡片支持「还原」「删除存档」，
  普通右栏只保留存档提示 +「打开读档」入口。
- `forker.alive(forkId)`：真实 PID 存活判断（归档确认用，不只看 `rec.running`）。
- `archiveStopTimeoutMs` 配置（100–30000，默认 3000）。

### 测试 / 文档
- `test/orchestrator.test.mjs` 新增 3 项：归档停进程且保留 home、stop-failed 不假装成功、
  还原重新 spawn、删除存档 reap 并移除记录（21 项）；
- `docs/ARCHIVE.md`：生命周期、接口、UI、配置、兼容与边界。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 1 个补丁位。

## v2.7.0（2026-11-01）

**主题：ForkSseClient（SSE 层）网络层模糊测试 —— 随机分块 + 随机断连的等价性。**

### 新增
- **`tools/fuzz/sse-client-mock.mjs`**：真实 `http.createServer` mock：
  - `/fang/adapter/version`、`/state`、`/events` 三个端点；
  - `/events` 按 `since` 过滤帧并记录 `{since, session}`；
  - plan 控制 200/401/409/410/503、`serve` 帧数、`ending`（hold/end/destroy）、心跳插入；
  - `destroy` 前等最后一个 write 回调 + 5ms，降低“数据未到 TCP 就断开”的 flake。
- **`tools/fuzz/sse-client-generators.mjs`**：事件序列（3–10 帧）、每帧 4 种切块模式、
  四类策略（无断/单断/多断/心跳）、`expectedSinceFor()`。
- **`tools/fuzz/sse-client-fuzz.mjs`**：
  - 性质：401 致命不重试；409/410 触发 `resetCursor=true` + 快照重置；心跳不产生事件；
    断连后 cursor 无重复/无空洞且 `since` 正确；
  - 随机：逐 case 配置 mock → 新 client → `connect()` → 等覆盖全部 cursor →
    比较**未去重**的 cursor 序列与请求 `since`；失败报告含 seed/iteration/strategy/
    expectedCursors/actualCursors/requests；
  - CLI `--iterations` / `--seed`。
- **`test/sse-client-fuzz.test.mjs`（3 项）**：性质测试全通过；120 次随机 fuzz 0 failures
  且四类策略均覆盖；同 seed 可复现。

### 文档
- `docs/FUZZ-SSE-CLIENT.md`：与 SseParser fuzz 的区别、MockSseServer 能力、I1–I7 不变量、
  生成器、性质测试、CLI、证据与边界。
- `docs/PROTOCOL-V3.md §11/§12`：测试与实现记录。

### 本机证据
- 200 次随机 fuzz（seed=20261110）：**0 failures**；
  noDisconnect 47 / singleDisconnect 51 / multiDisconnect 53 / withHeartbeats 49；
- 60 次：3.6s；200 次：10.8s（mock 无每 chunk 延迟，靠 write 回调保序）。

> 版本策略：`x.y.z` 每一位只能是 0–9；v2.6 的补丁位已到 9，本次进位为 **v2.7.0**。

## v2.6.9（2026-11-01）

**主题：SseParser 定向生成器 —— 为 9 个分支各构造“边界恰好命中”的最小输入。**

### 新增
- **`tools/fuzz/sse-directed.mjs`**：
  - 9 个分支、**61 条**定向用例：`cr-trimming`（8）/ `multi-line-data`（7）/
    `empty-data-dropped`（9）/ `comment-ignored`（9）/ `space-trimming`（7）/
    `field-override`（6）/ `retry-and-unknown`（6）/ `data-field-edge`（4）/ `buffer-boundary`（5）；
  - 40+ 条用例带 `expectedFrames`，锁定“只裁一个 CR / 只裁一个空格 / 空 data 帧丢弃 /
    无冒号 data 仍产帧”等精确语义；
  - `pickDirected(rng)` 均匀选分支与用例；`generateMixed(rng, { directedProb })` 按概率混合定向/随机；
  - `runDirectedSmokeTest()`：一次性解析 + expectedFrames + 6 种分块策略 × 3 种子等价性；
    支持注入 parse 函数用于 mutation 测试。
- **`tools/fuzz/sse-parser-fuzz.mjs`**：
  - `runSseParserFuzz({ directedProb, directed })` 支持混合策略，返回 `branchCounts` /
    `directedHits` / `randomHits`；失败记录带 `branch`；
  - CLI 先跑定向 smoke（61/61），再跑随机模糊，并打印分支覆盖率；
    `--directed-prob` / `--no-directed` 可调；`directedHits > 100` 时零命中分支告警。
- **`test/sse-directed.test.mjs`（8 项）**：用例完整性、smoke、expectedFrames 覆盖、
  mutation 检出（裁掉所有尾部 CR 会被抓到）、混合确定性、均匀抽样、fuzz 全定向/全随机/可复现。

### 文档
- `docs/FUZZ-SSE-DIRECTED.md`：分支表、用例设计、smoke 流程、混合策略、CLI、取舍与边界。
- `docs/PROTOCOL-V3.md §11/§12`：定向生成器测试与实现记录。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 9 个补丁位。

## v2.6.8（2026-11-01）

**主题：Adapter 命令入口的扩展面 —— 外部插件注册命令 + 413 body 上限。**

### 新增
- **`adapter.registerCommand(op, executor)`**（`src/plugins/adapter.mjs`）：
  - executor 签名 `(payload, { commandId, trackingId, emit, logger })`；
  - **同步/异步由 executor 的返回值决定**：普通对象 = 200；`{status:'completed',result}` = 200；
    `{status:'rejected',code,message}` = 失败信封；`{status:'accepted',trackingId}` = **202**，
    由 executor 异步执行并通过 `emit({kind:'command-done',…})` 推送结果；
  - `trackingId` 未显式给出时默认 `track_<commandId>`，同一 commandId 重试稳定；
  - 内置 op 不可覆盖（抛错），避免协议语义被第三方替换；disposer 后该 op 回到 `unknown-op`；
  - 仍由 `CommandCache.run(commandId, …)` 包裹：accepted 也缓存，重试不会启动第二个异步任务。

### 修复
- **body 超限 → 413**：`POST /adapter/commands`（以及 `/adapter/command`）请求体超过 1 MB 时，
  之前返回 400 `bad-request`；现在按 `ADAPTER_ERROR_STATUS` 返回 **413 `body-too-large`**，
  且 executor 不会被调用。

### 文档 / 测试
- `docs/ADAPTER-COMMANDS.md`：设计稿（CommandHttpHandler / EventLog / CommandHandler /
  AdapterServer）与本仓库已有实现的映射；为什么复用 DSH webServer 而不是独立端口；
  HTTP 状态表、SSE cursor/session 语义、命令注册示例、边界。
- `docs/PROTOCOL-V3.md §6.2/§6.4/§11/§12`：扩展命令约定与 413。
- `test/adapter.test.mjs` 新增 4 项：registerCommand 同步幂等 + disposer、异步 202 + command-done +
  重试同 trackingId、拒绝覆盖内置 op / rejected 映射、1 MB body → 413。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 8 个补丁位。

## v2.6.7（2026-11-01）

**主题：TaskHandle —— 把 fork 启动、Adapter 连接、命令代理、崩溃重建连接收进一个生命周期对象。**

### 新增
- **`src/lib/task-handle.mjs`**：`TaskHandle` 组合 Forker（进程层）+ ForkClient（传输/命令层）。
  - 状态机：`idle / starting / running / reconnecting / stopping / stopped / failed`；
  - `start()`：fork 未运行则 `forker.spawn()`（可选 spawnOptions），用 `forker.adapterToken()`
    建 ForkClient 并 connect；重复调用幂等；
  - **崩溃重建连接**：监听 `fang/fork-crashed` → `reconnecting` → 等 `fang/fork-started`
    （事件优先 + `forker.status()` 轮询兜底）→ 用**新 url + 新 token** 重建 client；
    token 由 Forker 在每次 spawn 时重新生成（内存 only），重启后不会 401；
  - **命令代理**：`command(op, payload)` + dsh-Fang 9 个便捷方法；重连窗口内最多等
    `commandWaitMs`（默认 5s），超时 reject `task-unavailable`；idle/stopped/failed fail-closed；
  - 生命周期：`stop()`（断开 client + forker.stop，保留 home）、`recycle()`（stop + reap）、
    `dispose()`（只释放本地资源，不杀 fork）；stop/recycle 幂等；
  - 事件聚合：`onEvent()` 转发 SSE 事件；`onTaskEvent()` 输出
    `status-changed / crashed / restarting / reconnected / failed`。
- **文档** `docs/TASK-HANDLE.md`：状态机、崩溃恢复流程、与 Forker 的接口约定、
  TS 形状映射、测试清单、边界（supervise 默认关闭、命令不缓冲、未接线 Orchestrator）。

### 变更
- `docs/PROTOCOL-V3.md §9/§11/§12` 增加 TaskHandle 的职责与测试列。

### 测试
- 新增 `test/task-handle.test.mjs`（17 项）；全量门禁见 `docs/AUDIT-v2.6.7.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 7 个补丁位。

## v2.6.6（2026-11-01）

**主题：分身 Web UI 模式 —— 不再把「母体 API 在分身里不存在」渲染成插件故障。**

### 修复
- **分身 Web UI 面板 404**：分身的 profile 也包含 `@local/dsh-fang` 的 client 半，所以分身页面
  侧栏会出现「瓮城」；但 orchestrator 是 mother-only，`/fang/api/status|tasks|sessions` 在分身里
  全部 404。v2.6.6 先探测宿主角色（`/fang/api/status` 200 = 母体；否则 `/fang/adapter/hello`
  200/401 = 分身），分身里只渲染一段说明卡，不再请求母体 API、不再显示「不可读」错误块。
- **分身里隐藏 dock 徽标**：不再对 `/fang/api/status` 轮询，也不显示「瓮城离线」假故障。
- **母体行为保持不变**：只有探测为 mother 后才开始刷新 `/fang/api/*`，避免启动时先打一轮 404。

### 说明
- 分身里 Adapter 路由存在但 v2.6.1+ 要求 Bearer（浏览器拿不到 token），所以角色探测把 401 也
  视为「这是分身」，不展示 Adapter 详情（避免把 401 当适配器故障）。
- 侧栏注册项无法按角色摘除，点击仍会打开说明卡；这是宿主 slot 能力的限制。

### 文档
- `docs/UI-FORK-MODE.md`：404 原因、探测规则、分身/母体行为差异、验证步骤、限制。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 6 个补丁位。

## v2.6.5（2026-11-01）

**主题：SSE 解析器独立成类 + 模糊测试（随机输入 / 分块等价 / 参考实现 / 帧边界）。**

### 新增
- **`src/lib/sse-parser.mjs`**：`SseParser` 类（行式增量解析，`push()`/`flush()`）。
  只按 `\n` 切行、行尾裁一个 `\r`（CRLF 支持）；空行切帧、无 data 帧丢弃、注释/`retry`/未知字段忽略；
  多行 data 用 `\n` 拼接；`flush()` 按 SSE 规范丢弃未完成残帧。
- **模糊测试工具** `tools/fuzz/`：可复现种子 RNG（SplitMix32 + XorShift128）、9 种输入模式、
  独立参考实现 oracle、6 种字符串分块 + 字节级切分、roundtrip、flush 不变量、失败报告（seed/hex/chunks）。
- **CI 档位** `test/sse-parser-fuzz.test.mjs`（7 项）：性质断言 + 固定种子 × 6 × 25 iterations +
  随机 seed smoke + 可复现性 + 已知 CRLF/多行/字节切分边界。
- CLI：`node tools/fuzz/sse-parser-fuzz.mjs --iterations 5000 --seed <seed>`；失败时打印可复现命令。
- 文档 `docs/FUZZ-SSE-PARSER.md`：不变量 I1–I6、结构、分块策略、复现方式、已知边界。

### 修复 / 行为变化
- **CRLF 帧边界**：旧 `createSseParser` 用 `indexOf('\n\n')` 找块边界，`\r\n\r\n` 不含 `\n\n`，
  CRLF 流会延迟到 flush 且把 `\r` 混进 data；新 `SseParser` 逐行处理，CRLF 正常切帧。
- `flush()` 不再解析残帧（SSE 规范：EOF 丢弃未完成事件）；解析器也不再把无 `event:` 的帧
  默认成 `event:'message'`（字段缺失即省略）。
- `adapter-protocol.mjs` 的 `createSseParser()` 改为 re-export `SseParser`（单一实现）。

### 测试
- 新增 `test/sse-parser-fuzz.test.mjs`（7 项）；CLI 额外跑过 5000 iterations，0 failure。
  全量门禁见 `docs/AUDIT-v2.6.5.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 5 个补丁位。

## v2.6.4（2026-11-01）

**主题：ForkClient 完整实现 —— inflight 追踪、command-done 匹配、超时兜底。**

### 新增
- **`src/lib/fork-client.mjs`**：`ForkClient` 组合 AdapterClient（传输 + SSE）与 `CommandCache`（幂等）。
  - **同步命令**：POST 返回 completed → 直接返回；同 commandId 命中缓存不重复 POST；
  - **异步命令**：202 accepted + trackingId → `inflight` Map 等待 SSE `command-done`，
    拿到终态后才写入缓存（不缓存 accepted）；
  - **command-done 匹配**：按 trackingId 匹配（trackingId 与 commandId 是两个键）；
    超时/断开后迟到的 command-done 静默忽略（debug）；
  - **超时兜底**：同步 POST 走传输层 AbortController（`synchronousTimeoutMs`）；
    异步命令用 `asynchronousTimeoutMs`（默认 120s）timer，超时 reject → 缓存移除 → 可重试；
  - **SSE 生命周期**：断开保留 inflight（cursor 补发）；`resetCursor=true`（分身重启）/
    `disconnect()`（用户主动）→ 全部 inflight reject；
  - **事件扇出**：`onEvent/onReconnect/onDisconnect`，handler 异常隔离；`state-changed` 更新快照；
  - **fail-closed**：未 connect 或已 disconnect 时命令直接 reject（`not-connected` / `disconnected`）；
  - dsh-Fang 的 9 个 Adapter op 便捷方法：ping/status/flush-buffer/score-plugin/read-plugin/
    route-confirm/approvals/approval-decide/archive。
- **文档** `docs/FORK-CLIENT.md`：TS 接口形状与 `.mjs` 映射、命令生命周期、inflight 语义、
  超时矩阵、SSE 处置规则、错误码、测试清单、边界（无 tsc、node:http 传输待实现、尚未接线）。

### 变更
- `docs/PROTOCOL-V3.md §9/§11/§12` 同步 ForkClient 实现与测试清单。

### 测试
- 新增 `test/fork-client.test.mjs`（13 项）；全量门禁见 `docs/AUDIT-v2.6.4.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 4 个补丁位。

## v2.6.3（2026-11-01）

**主题：CommandCache LRU + 幂等语义 —— in-flight 合并、失败契约、只淘汰已完成项。**

### 新增
- **`src/lib/command-cache.mjs`**：`CommandCache.run(commandId, fn)` 幂等执行。
  - 两态：`running`（value 是同一个 promise）/ `completed`（value 是结果）；
  - **并发合并**：同一 `commandId` 并发提交 → 第二次等待同一个 promise，不重复执行副作用；
  - **失败契约**：业务失败（`fn` 返回 `status:'rejected'`）与 async accepted 都缓存；
    `fn` 抛错（传输/编程错误，命令可能没执行）不缓存并移除，允许重试重新执行；
  - **LRU**：Map 插入顺序即使用顺序；`run()` 命中 touch，纯 `get()` 不 touch；
    超容量时从头部淘汰第一个 completed，跳过 running；全是 running 时允许临时超限，
    in-flight 完成后自动收敛；
  - `invalidate()` 只对 completed 生效、`clear()` 保留 running、`stats()` 暴露容量/命中/去重/淘汰/丢弃计数；
  - 容量必须 ≥1（否则 `RangeError`）；`onEvict` 回调异常被隔离；缓存不实现超时（超时属于命令层）。
- **Adapter 接线**：`commands()` 改为 `commandCache.run()`；并发同 commandId 只执行一次、
  第二个请求返回 `deduplicated:true`；只有真正执行的那一次发 `command` / `command-done` 事件；
  无 commandId 的请求仍不缓存（v2 兼容）。
- **文档** `docs/COMMAND-CACHE.md`：决策表、API、并发时序、失败契约、LRU 细节、Adapter 接线、
  测试清单、边界（单进程/不持久化/accepted 缓存）。

### 变更
- `adapter-protocol.mjs` 不再自带命令缓存实现，改为 re-export `command-cache.mjs`（避免两份幂等语义）；
- `docs/PROTOCOL-V3.md §6.2/§12` 补充 in-flight 合并与失败契约，并指向 `docs/COMMAND-CACHE.md`。

### 测试
- 新增 `test/command-cache.test.mjs`（16 项）与 Adapter 并发幂等用例（1 项）；全量门禁见 `docs/AUDIT-v2.6.3.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 3 个补丁位。

## v2.6.2（2026-11-01）

**主题：控制面板分类折叠 —— 进行中 / 已归档 / 临时 三组，进行中只先显示 7 条会话。**

### 新增
- **左栏（母体 项目 & 对话）三组折叠**：
  - **进行中**（默认展开）：只先渲染 7 条会话，其余折叠为「展开剩余 N 个」；展开后可「收起多余会话」；
  - **已归档**（默认折叠）：`session.archived = true` 的对话，按工作区分组；
  - **临时**（默认折叠）：`session.empty = true` 的空会话（没有用户消息、无法继续开发）。
- **右栏（分身 任务 & 项目）三组折叠**：
  - **进行中**（默认展开）：普通任务卡片；
  - **已归档**（默认折叠）：`status = archived` 的任务（沿用原分组，改为统一分区标题）；
  - **临时**（默认折叠）：快速派生任务（标题为 快速派生 / 双击快速派生 / 徽标快速派生 / 重试快速派生，
    空白且未继承会话）。
- **「隐藏/显示临时内容」顶栏开关**：整组隐藏或恢复临时内容；偏好写入
  `localStorage["fang.panel.showTemporary"]`（storage 不可用时只影响本次面板会话）。
- 分类判定**只用宿主已返回的事实**（`archived` / `empty` / 任务标题），不改协议、不新增接口；
  分区标题的 tooltip 写明「临时」的定义。

### 变更
- 左栏/右栏标题栏的计数补充分类明细（进行中 / 已归档 / 临时，临时隐藏时标注「已隐藏」）。
- 同一工作区同时存在进行中/已归档/临时会话时，会在对应分区各出现一次，折叠状态按分区独立记忆。
- 临时全部隐藏且没有其它内容时，给出「当前只有 N 条临时内容（已隐藏）」的空态 + 一键恢复按钮。

### 测试
- UI 层改动，无新增单元测试；`node --check client.js` 通过；全量测试与 e2e 门禁见
  `docs/AUDIT-v2.6.2.md`。视觉验收需重启宿主加载新 client 后人工确认（本机后台宿主未重启）。

> 版本策略：`x.y.z` 每一位只能是 0–9（一个次版本含 10 个小版本）；本次是 v2.6 的第 2 个补丁位。

## v2.6.1（2026-11-01）

**主题：Adapter v3 协议化 —— 版本协商 / 状态快照 / SSE 事件流 / 幂等命令 / Bearer 认证。**

> 版本策略：`x.y.z`，每一位只能是 0–9（一个次版本含 10 个小版本）。
> 本次是 v2.6 的第 1 个补丁位（`2.6.0` → `2.6.1`）；v2.6.9 之后才进 `2.7.0`。

### 新增
- **协议词汇**：`ADAPTER_PROTOCOL_VERSION=3`、v3 五条路由常量、`ADAPTER_EVENT`、`ADAPTER_ERROR_STATUS`
  （错误码 → HTTP 状态码的唯一来源）。
- **共享协议库** `src/lib/adapter-protocol.mjs`：cursor 编解码（uint64 十进制字符串）、环形缓冲 `EventLog`、
  LRU `CommandCache`、版本协商、Bearer 解析、命令信封校验、SSE 帧编解码。
- **分身侧 Adapter v3**：`GET version/health/state`、`GET events`（SSE：回放/心跳/410 cursor-expired/409 session-changed）、
  `POST commands`（`commandId` 幂等 + `async:true` → 202 + `trackingId` → `command-done` 事件）；
  审批 diff 生成 `approval-requested/approval-resolved`；进程级 `sessionId`。
- **母体侧**：`remote.mjs` 增加 `version/health/state/commands/eventsUrl` 与 Bearer 头；新增
  `src/lib/adapter-client.mjs`（`connect()` 协商→快照→SSE、断线指数退避、409/410 自动重拉快照、
  同 `commandId` 网络重试一次）。
- **Forker token 生命周期**：每次 spawn 生成 48 hex Adapter token，经 `DSH_ADAPTER_TOKEN` 注入分身；
  `adapterToken(forkId)` 只读母体内存；`stop` 即作废；不写 `forks.json` / `fang-meta.json` / `status()` / URL。
- **Orchestrator**：握手后调用 `/version` 协商并记录 `task.adapter.protocol`；`remoteFor()` 自动带 Bearer；
  协议过新时 fail-closed（不假装 READY）。
- **文档** `docs/PROTOCOL-V3.md`：接口粒度协议（定位/选型/认证/协商/状态模型/cursor/错误码/时序/测试/遗留决策）。

### 变更
- 版本 2.6.1；Adapter 路由 5 → 10（v2 五条全部保留，向后兼容）；`hello()`/`status()` 增补
  `protocol/sessionId/lastCursor` 等字段（旧客户端忽略未知字段）。
- 旧分身（无 `/version`）按 legacy 协议继续可用；旧母体（不注入 token）下 Adapter 退化为 v2 语义，不加认证层。

### 测试
- 新增 25 项：协议库 11、Adapter v3 5、AdapterClient 6、Remote v3 2、Forker token 1。
- 全量 **331 项（330 pass / 1 skip）**；门禁证据见 `docs/AUDIT-v2.6.1.md`。

## v2.6.0（2026-11-01）

**主题：Forker 完整化 —— 端口池/健康探测/崩溃退避/孤儿恢复/每分身 meta。**

### 新增
- **每分身 `fang-meta.json`**（原子写、0600）：status/pid/port/url/profile/crashCount/restartCount/lastError/时间戳；
  reap 前写入，删除 home 后不会复活目录（修复了"meta 写晚导致 home 重建"的回归）。
- **崩溃退避**：`supervise=true` 时，已就绪分身崩溃按指数退避（默认 1s/2s/4s，上限 30s、±20% 抖动）自动重启，
  最多 3 次；只重启 **ready 过** 的分身（首启失败直接如实报错，避免 loop-spawn）。
- **孤儿恢复**：`recover()` 对账持久化记录：pid 已死 → 标 crashed + 归还端口；pid 存活 → 保留（绝不 kill 别的实例）。
- **健康探测**：`health(forkId)` = 进程状态 + 回环 HTTP 探测（任何响应都算活着）；
  `probeHttpAlive` 作为纯函数可测。
- **纯函数库**：`src/lib/fork-supervisor.mjs`（backoff / planRestart / reconcileOrphans / meta 读写 / HTTP 探测）。
- 配置：`supervise/maxRestarts/backoffBaseMs/backoffMaxMs/backoffJitter/healthPath`；默认 **opt-in**（patch 行 `supervise: false`），
  因为自动重启会与 Orchestrator 的 archive/reap 生命周期竞争；需要时显式打开。

### 测试
- 新增 `test/fork-supervisor.test.mjs`（5 项）：退避边界/抖动、重启策略、孤儿对账、meta 原子读写、HTTP 探测。
- forker 服务契约新增 `health/recover`；全量 306 项（305 pass / 1 skip），e2e 45/45。

## v2.5.0（2026-11-01）

**主题：同步 / 桥接 / 混合路由三个子插件（P0 契约版，API + 纯函数 + 测试）。**

### 新增
- **角色**：`consumer`（PC 消费端）成为一等形式；矩阵 15 个插件。
- **`fang-session-bridge`（桥接）**：mother 侧只读 façade，复用 PC 宿主 `desktop-bridge.json`
  （127.0.0.1 + Bearer，端口/token 每次重读，拒绝非回环 descriptor）；
  暴露 list / events / send(1–4096B) / create，路由 `/fang/api/bridge/*`；PC 不可达时 `bridge-unavailable`。
- **`fang-session-sync`（同步）**：勾选会话导出到 staging bundle（manifest + 每文件 sha256，源只读），
  导入按工作区路径/名称精确匹配，**永不覆盖**：冲突保留 `.fork-<ts>` 副本；未匹配进 `pendingMatch`。
  路由 `/fang/api/sync/{status,export,import}`。
- **`fang-session-router`（混合路由）**：纯函数 `chooseMode`：
  跨机+实时 → `deny`；一次性迁移 → `sync`；同机+宿主在跑+bridge+实时 → `bridge`；其余 `sync`。
  路由 `/fang/api/route` 返回决策与理由。
- 历史隔离说明：PC 与 Web 的会话数据不会自动双向流动；sync 是"文件搬运"（可离线/跨机），
  bridge 是"驱动活进程"（仅同机回环）。派生 fork 的默认回退仍是文件导入（v2.4.0 的 importSession）。

### 验证
- 新增 7 个测试：descriptor 校验与 token 不泄漏、四个 bridge 调用、bundle 导出只读/冲突保留/待匹配、
  路由真值表；全量 301 项（300 pass / 1 skip）；e2e 45/45；新增 allow-list 自检门禁（29 路由、0 findings）。

## v2.4.0（2026-11-01）

**主题：母体会话数据修正 + 派生时真正继承历史 + 「瓮城」控制面板重设计。**

### 修复（母体 · 项目 & 会话）
- **创建时间**：列表此前只回传文件 mtime（并当成时间展示），现在从会话日志 header 读取真实 `createdAt`，
  API 同时返回 `createdAt/createdAtIso/updatedAt`；UI 分别显示「创建」与「更新」。
- **空会话**：没有 `user/message` 的会话标记 `empty:true`，UI 显示「空会话」标签并禁止「继续开发」，
  派生时返回 `session-empty`，不再生成只有 header 的假交接。
- **历史会话继承**：派生前构建真正的交接种子（有界多帧读取 + 对话摘录，默认 48KiB），
  并把母体会话日志**复制进分身自己的 `$DSH_HOME`**（`sessions/<workspaceKey>/<sessionId>`），
  同步写入分身的 `storages/workspace.json`，让分身原生 UI 能看到这段历史；
  日志超过 `importMaxBytes`（默认 32 MiB）时如实标记「仅交接摘要」。
- 之前 `fang-seeds/*.md` 只写不读（注释称"fork reads it"，实际无消费方），现改为种子+历史导入双轨，
  派生响应返回 `importedSession` 供 UI 如实展示。

### UI（控制面板重设计）
- 3:7 分屏保留；新增品牌/状态/主操作分层、会话搜索、分组折叠、两栏回顶、选中条两段式。
- 会话标题来源感知：`session/title` → 原生标题；`preview` → 首条消息；缺失 → 「未命名会话 + 短 ID」，
  绝不拿工作区名冒充标题。
- 任务健康拆成生命周期/适配器两枚徽章；`running + adapter 失败` 标记异常（僵尸分身），
  错误带 code/中文原因/诊断/就地重试；分身会话读取失败只影响该卡。
- 响应式 ≤980px 单列堆叠、键盘可达、对比度 ≥ WCAG AA（详见 `docs/UI-瓮城入口.md`）。

### 测试
- 新增：真实 `createdAt`（非 mtime）、空会话拒绝、`seed()` 对话摘录、派生导入会话日志与 workspace 索引。
- 全量 294 项（293 pass / 0 fail / 1 skip；skip 为手动容器探针）。

## v2.3.1（2026-11-01）

**主题：npm 包名改为 `@twinsearth/dsh-fang` + 修复 CI 上的 watchdog 取消。**

### 变更
- npm 发布包名：`@twinsearth/dsh-fang`（scoped、公开、AGPL-3.0-or-later）；构建时
  `@local/dsh-fang` 统一改写为 `@twinsearth/dsh-fang`，tarball 仍为 `dsh-fang-<ver>.tgz`。
- 注册表 PUT 路径/tarball URL 按 scoped 规则编码（`@twinsearth%2Fdsh-fang`）；healthz 远端检查同步。

### 修复
- restart-guard 的审批 watchdog 定时器不再 `unref()`：挂起审批时事件循环必须保持存活，
  否则 Node 测试调度器会在 1s 定时器触发前判定事件循环已结束并 `cancelledByParent`
  （CI Windows node 22 实测 8 个用例被取消，本地 node 24 偶发不复现）。
- release workflow 修复：`secrets` 不能用于 job 级 `if`，改为 step 级检查 + `workflow_dispatch`。

## v2.3.0（2026-11-01）

**主题：8 步发布流水线落地 —— 以 npm 与 GitHub Release 为主，验收门禁可执行。**

### 新增
- **验收门禁** `tools/release/preflight.mjs`：版本三处一致（package/FANG_VERSION/CHANGELOG）、许可矩阵、
  全量测试、可选 `--e2e`；结果写 `dist/preflight.json`，GREEN 才能继续。
- **构建** `tools/release/build.mjs`：零依赖、用系统 tar 产出 `dist/dsh-fang-<ver>.tgz` + `dist/manifest.json`
  （sha256/大小/条目/包清单）；staged 包名统一为 `dsh-fang`，`@local/dsh-fang` 自动改写。
- **healthz** `tools/release/healthz.mjs`：解包校验 + kernel/plugin 可加载；`--remote` 核对 npm 与 GitHub Release；
  `--serve` 暴露 `/healthz`。
- **npm 发布** `tools/release/publish-npm.mjs`：本机无 npm CLI 也走 registry REST API 发布（token 只从 env/文件读取，不打印）。
- **Docker**：`docker/Dockerfile` + `docker/healthz-server.mjs`，发布健康镜像（`/healthz`，含 HEALTHCHECK）。
- **工作流**：`release.yml`（tag → test → build → npm → GitHub Release → docker → healthz）、`compat.yml`（Node 22/24 导入兼容）。
- **验收文档** `docs/ACCEPTANCE.md`（8 道门禁与已知边界）。

### 修复
- GitHub Actions 功能测试改为 **windows-latest**（本产品依赖 junction/taskkill/AppContainer），许可门禁留在 ubuntu；
  清掉最后几处本地绝对路径字符串。

### 发布
- npm 包名：`dsh-fang`（unscoped，公开发布，AGPL-3.0-or-later）；
- GitHub：`TwinsEarth/dsh-fang`（public）、`TwinsEarth/dsh-fang-private`（private），tag `v2.3.0` 起由 `release.yml` 自动发布。

## v2.2.0（2026-11-01）

**主题：控制面板 3:7 水平分屏 —— 左「母体项目 & 会话」，右「分身项目 & 会话」。**

### 新增
- 控制面板改为 **3:7 网格**：左栏母体（按 workspace 分组的项目 + 会话），右栏分身
  （每个任务一个项目，展开即该分身自己的会话列表）；两栏各自独立纵向滚动
  （`overflowY:auto` + 视口高度上限），条目多时不再撑长页面。
- 新增母体 API `GET /fang/api/tasks/sessions?taskId=` + orchestrator `listForkSessions()`：
  只读分身自己的 `<forkHome>/sessions`，有界解帧（≤32 帧 / 1MiB）提取会话标题，失败如实降级。
- 左栏会话点选 → 两段式「继续开发 →」（派生新分身 + lineage 种子）；
  右栏分身会话点选 → 「打开分身 →」；右栏每个项目保留 打开/归档。
- 右栏默认展开全部项目，可逐个折叠；会话标题沿用 v2.1.1 的原生标题 + 来源标注。

### 测试
- orchestrator：`listForkSessions` 读取分身会话日志与工作区索引、标题/来源/preview、未知任务。
- e2e：创建任务后写入一份分身侧多帧会话日志，断言
  `GET /fang/api/tasks/sessions` 返回原生标题。

## v2.1.1（2026-11-01）

**主题：会话可辨认 + 分身不再"派生出僵尸"。**

### 新增
- 会话标题：从会话日志的有界多帧读（`session/title` 事件）提取原生标题；
  无原生标题时退化为"首条用户消息预览"，再退化才用工作区名。API 返回 `title/titleSource/preview`
  （来源如实标注：`session/title` / `first-user` / `workspace`）。
- 控制面板会话行显示真实会话名（长标题截断 + 完整 title 提示），下方标注来源与工作区。

### 修复
- **分身僵尸**：orchestrator 的模板解析改为"只选一个真的装了本 bundle 的 profile"，
  并在 provision 后校验 `<forkHome>/profiles/<p>/node_modules/@local/dsh-fang`；
  解析不到 bundle 时直接回收（`fork-bundle-unavailable`）而不是派生出一个
  `/fang` 全部 404、adapter 永远 `http-404` 的僵尸分身。
- `cordis.patch.yml` 移除了遗留的 `motherProfile: web`（它把分身模板指向了没有 Fang 的 web profile，
  正是上面僵尸分身的根因）。
- 标题提取有界：最多 64 帧 / 2MiB 压缩预算，超出如实 `frame-limit` 降级，绝不整文件解压；
  标题按 `mtime+size` 缓存，列表刷新不重复解帧。

## 协议分层（2026-11-01，不改变运行时行为）

**主题：AGPL 核心 + MIT 生态 + 商业闭源的许可分层，以及"不赌解释"的边界文档。**

### 新增
- `LICENSE-CORE`（AGPL-3.0 全文，gnu.org 原文 34,523 bytes）、`LICENSE-SDK`（MIT）、
  `LICENSE-COMMERCIAL`（商业许可草案：评估/生产/OEM 三档 + 占位价格）。
- `CLA.md`：贡献者许可协议，含**永久不可撤销的再许可/双许可授权**（商业双许可路径的法律前提）。
- `NOTICE`：逐目录/逐文件许可地图 + 第三方归属；`LICENSES/cordis-MIT.txt`。
- `docs/LICENSING.md`：决策（为什么 AGPL 而非 BUSL/SSPL）、Open Core 与双许可、收入结构、
  **AGPL 与 MIT 的 DSH 兼容边界分析**（推荐 fangd 独立进程 + MIT bridge 的迁移路径）。
- `sdk/`（MIT）：插件模板 + 调用 `/fang/api/status` 的示例插件；`relay-server/`、`enterprise/` 商业占位。
- 全仓源码 `SPDX-License-Identifier` 头（核心 64 个 AGPL、生态 MIT、vendored cordis MIT）。
- `test/licensing.test.mjs`：许可文件/分层标注/package.json 许可/第三方归属的回归测试。

### 注意
- 版本仍为 2.1.0（许可证变更不改变运行时行为）。
- 发布前必须替换 `NOTICE`/`LICENSE-COMMERCIAL`/`CLA.md` 中的主体、邮箱、价格占位，
  并由律师审阅；这不是法律意见。

## v2.1.0（2026-11-01）

**主题：把「瓮城」做进 Harness Web UI，并让门户能"选中已有会话 & 任务继续开发"。**

### 新增
- **左侧导航「瓮城」**（`sidebar.panellist` id=fang order=90）：图标 = 红色城门组件
  （瓮圈红色 `--fang-gate-accent` + 门洞 currentColor + 门基），单击由外壳切到面板。
- **双击快速派生**：图标 / dock 徽标双击（400ms 窗口、6px 容差、2s 冷却、单飞）→
  POST /fang/api/derive → 打开带 token 的分身标签页；弹窗被拦时面板内给「打开分身 ↗」。
- **中列面板 `main` key='fang'**：任务 + 母体已有会话的「选中 → 确认 → 继续开发」两段式；
  状态/离线/空态/加载态显式呈现。
- **母体只读会话目录**：新插件 `fang-session-catalog`（mother-only，只读 fs）+
  `src/lib/session-format.mjs`（多帧 zstd 有界头读、脱敏、digest ≤32KiB、id 不透传路径）；
  路由 `GET /fang/api/sessions`、`/sessions/item`、`/sessions/head`。
- **lineage 种子**：`orchestrator.derive({sessionId})` → catalog.digest → 写入分身
  `<forkHome>/fang-seeds/<seedId>.md` → createTask；`taskView.seed` 暴露来源与大小。
- `POST /fang/api/derive`（标题 + 可选 sessionId）；`normalizeSeed()` 64KiB 上限、超限抛错。

### 变更
- 版本 2.1.0（package / kernel FANG_VERSION / e2e 断言）。
- 角色矩阵新增 `sessionCatalog: ['mother']`（12 行）。
- 客户端半重构：三个槽位登记（导航/面板/徽标）共用一份 client.js，颜色改用 `--dsw-alias-*` 回退链。

### 已知边界
- 导航行点击归外壳，双击热区只能是 18px 图标本身（dock 徽标是更大的目标）。
- 会话继续是 lineage + 有界摘要，不复制 transcript、不挂载母体会话目录（母体不可变）。
- v2.1 需母体重启 + 页面刷新才生效（ESM/客户端 bundle 缓存）。

## v2.0.0（2026-11-01）

**主题：从「1 编排器 + 9 子插件」升级为「母体大脑 + 分身器官 + 容器兜底」三层部署。**

### 新增
- **Adapter 插件（第 11 行，`fang-adapter`，仅分身）**：跨进程桥。HTTP 端点
  `/fang/adapter/{hello,status,approvals,audit,command}`；命令 ping/status/flush-buffer/
  score-plugin/read-plugin/route-confirm/approvals/approval-decide/archive。
- **Remote 客户端（`src/lib/remote.mjs`）**：母体侧调用分身的纯模块，统一 `{ok,kind,error}`，永不抛。
- **角色矩阵与 `roleGate`（`src/kernel/role.mjs`）**：11 个插件按 mother/fork 激活；
  同一 bundle 同时装进母体与分身，运行时决定。
- **任务语义**：`createTask / listTasks / getTaskStatus / promoteTask / archiveTask`，
  HTTP `/fang/api/tasks*`；v1 的 fork/reap/listForks/promote 保留为兼容别名。
- **端口池（18000–18100）**：Forker 确定性分配并校验 URL 端口；占用表持久化、启动回收。
- **干净分身模板**：`ensureTemplate()` 生成 base+web-app+bundle 的最小 profile，不再继承母体脏 profile。
- **Router 双阶段**：`decide`（母体初判）/ `confirm`（分身复核，只升不降，deny 不可推翻）。
- **Scorer 环境阈值**：`thresholds.{mother,fork}` + `basis{environment,thresholds,note}`。
- **Auditor 汇总**：`aggregate({limit,sources})`；分身独立落盘、母体按需拉取。
- **Approver 双侧语义**：`scope`、`requestPromotion/requestRestart`、`summary({remotes})`。
- **容器兜底**：`src/lib/container`（AppContainer 执行器 + 申报写代理 + NDJSON 帧）；
  BufferKeeper 追加 proxyState/setDeclared/proxyWrite/proxyLog。
- **商用钩子**：`src/kernel/extensions.mjs`（collaboration/git/backup/tokenApi/teams），默认关闭、无 provider 即 no-op。
- **e2e 脚本 `tools/e2e.mjs`**：临时 `$DSH_HOME` + 真实 dsh 母体 + 真分身全链路验收。

### 变更
- `FANG_VERSION` 与 `package.json` 版本 → `2.0.0`。
- 所有插件 apply 首行 `roleGate()`：未部署角色不注册服务/定时器/路由。
- 旧测试按新矩阵固定角色（fork-only 插件测试置 `DSH_FANG_ROLE=fork`）。
- `orchestrator` 模板默认 = 当前 profile；fork 的 role 由 `DSH_FANG_ROLE` 注入，防止分身自升为母体。

### 修复（v1 遗留）
- 宿主 `approval` 行被误禁用 → 恢复，permission-presets/auto-review/gpw 的 pending 告警清零。
- `node --test test/` 在 node v24 不可用 → 统一为 `node --test --test-concurrency=1 "test/*.test.mjs"`。
- 客户端半注册根因（loader 行必须是裸包名）已固化在 patch 与预检测试里。

## v1.0.0（2026-11-01）
- 首次整合：单包 `@local/dsh-fang`、10 个插件行、共享 kernel、141 项测试、门户与 dock 徽标、
  真实 fork/reap 机制验收、审计链与 A/B 审批。
