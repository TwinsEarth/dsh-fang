# v3.8.8 审计（三条红线：Job Object / 聚合 commit 分级 / Panic 崩溃循环）

日期：2026-11-25
基线：v3.8.7
工作副本：`/Users/fang/Doubao/chats/2026-11-24/new-chat-7/fang-dsh-plugin`
状态：**源码与本地测试完成；未 commit / push / tag / publish。** 本地 DSH 安装仍为 3.8.2。

## 一、改代码前的只读结论

| 要求 | 改前事实 | 结论 |
|---|---|---|
| browser 走 Windows Job Object | `launchManagedBrowser()` 直接 `spawn(exe,args)`；只有 forker 走 Job helper | browser 没有内核级回收，宿主被强杀时 Chromium 子树可能存活 |
| `POST /fang/api/panic` | `hostEmergency()` 与 `service.panic()` 存在，前端按钮也调该路径；HTTP 路由未注册 | V3.8.4 的“Panic 失败”大概率是路由缺失/404 |
| 聚合 commit 30/35/40 | 只有 `forkCommitShareLimit=0.4` 单阈值；无 fork/browser 分项 | 30%/35% 无预警，40% 直接全停 |
| 母体 RSS/Private | 只有 Node `process.memoryUsage()`，且 Private 用 heap+external 近似 | 不是操作系统真实 Private |
| 8192/4096/2048 分级 | `hostEmergencyFreeMB=2048` 存在但未使用；<4096 直接 `hostEmergency` | 缺少 warning/severe 两级 |
| `maxForks` 默认 1 | 默认 8；无 `allowMultiFork` | 单机可一次开 8 个 fork |
| sidecar 启动即见 PID | forker 等 URL 解析后才写 PID；orchestrator 等 spawn 完成/30s tick | 早期崩溃时 sidecar 目标为空 |
| `host-crashes.jsonl` | 不存在；`host-crashes.json` 条目无 metrics | 崩溃只有计数，没有现场指标 |

## 二、本轮落点

### 1. browser Job Object

- `src/lib/browser-guard.mjs` 新增 `jobObject` 选项；Windows 且启用时先删除旧 `job-object.ready.json`，再以 `buildJobHostArgs()` 启动 helper，参数含 `--job-process-memory-mb` / `--job-memory-mb`、宿主 PID、heartbeat、ready file。
- helper 缺失或启动失败：`job-object-unavailable` / `job-object-launch-failed`，fail-closed，不退化裸 spawn。
- 最多等 10 秒读取 `job-object.json`；只有 `childPid>0` 才 ready，否则杀 helper 并返回错误。
- 返回真实 browser PID、`helperPid`、`jobObject` summary；`onExit` 绑定真实 browser PID。
- `src/plugins/orchestrator.mjs` 新增 `FANG_ROOT`，通过 `resolveJobHostPath()` 解析 helper；`launchManagedBrowser` 传入 `homeDir`、宿主 heartbeat、`browserJobProcessMemoryMB=2048`、`browserJobTotalMemoryMB=2048`。
- `task.browser` 与 taskView 暴露 `helperPid` / `jobObject`。

### 2. 聚合 commit 与母体内存

- 新增 `forkCommitWarnShare=0.3`、`forkCommitSevereShare=0.35`，保留 `forkCommitShareLimit=0.4`。
- `memoryWatchdogTick` 分项计算 `forkCommitMB`、`browserCommitMB`、`totalCommitMB`，采集 `selfRssMB`、`selfPrivateMB`、`processCount`、`forkShare`，写 `lastHostMetrics`。
- 超过 30% 写 `fork-commit-share-warning`；超过 35% 写 `fork-commit-share-severe`；超过 40% 走 `hostEmergency('fork-commit-share',{safe:true})`。warning/severe 有 60 秒节流。
- fork 统计包含非归档、非 FAILED、`pid>0` 的任务（含 PROVISIONING 已 spawn）。
- `hostWatchdogTick` 改为 CommitFree <8192 warning、<4096 severe、<2048 才 `hostEmergency('commit-free-emergency',{safe:true})`；`hostEmergencyFreeMB` 真正生效。
- `src/lib/memory-guard.mjs` PowerShell 探针新增 `SelfRssMB` / `SelfPrivateMB`，用 `Get-Process -Id <Node PID>` 的 `WorkingSet64` / `PrivateMemorySize64`，不再用 heap 猜测。
- `/fang/api/status` 新增 `hostMetrics` 与 `forkCommitPolicy`。

### 3. Panic 与崩溃循环

- 新增 `POST /fang/api/panic`：调用 `service.panic()`，成功返回 `{ok:true,mode:'panic',...}`，失败 409。mock handler 实测 200。
- `service.panic` → `hostEmergency('manual-panic',{safe:true,allTasks:true})`；`allTasks=true` 隔离所有非 ARCHIVED 任务，顺序为“先关所有 task browser → 关 runtime browser → clear → quarantine → safeMode”。
- `host-crashes.json` 只保留 10 分钟内 `recent`，写 `windowMinutes:10`；完整历史写 `host-crashes.jsonl`，字段含 `commitFreeMB/selfRssMB/selfPrivateMB/forkCommitMB/browserCommitMB/totalCommitMB/processCount`。
- `host-state.json` 每 15 秒 heartbeat 更新 `lastMetrics`；`hostCleanExit` 防止 clean 退出后 heartbeat 写回 `clean:false`。
- 10 分钟 2 次崩溃进入 `safeModeReason='crash-loop-10m'` 的逻辑保留。

### 4. maxForks 与 sidecar PID

- orchestrator `maxForks` 默认 1，新增 `allowMultiFork=false`；`effectiveMaxForks()` 在 `allowMultiFork!==true` 时强制 1，接入配额、status、`maxConcurrentForks`。
- forker DEFAULTS/Schema 同步 `maxForks=1`、`allowMultiFork=false`，spawn 前检查同一条件。
- `createTask` 在 `await f.spawn()` 期间每 200ms 轮询 `f.status`；拿到 PID 立即同步 `task.pid/task.port`、`syncTaskMeta`、`persist`、`writeWatchdog`、`lowerProcessPriority`。
- `writeWatchdog` 的 fork 目标放宽为“任何非 ARCHIVED 且 pid>0”。
- forker 在 `rec.pid=child.pid` 后立即 `writeForkMetaOf(rec)`；Job ready 更新真实 childPid 后再写一次。

### 5. 安装令牌 bootstrap 宿主属主准入（评审 #616 反馈）

- 新增 `src/lib/peer-owner.mjs`：从 HTTP socket 取 `localPort/remotePort`，映射对端 TCP 连接的 owning process，再比较其 OS 属主与 DSH 宿主属主。
- Windows：`Get-NetTCPConnection -LocalPort <peerPort> -RemotePort <hostPort>` 取客户端 PID（失败回退 `netstat -ano`），`Win32_Process.GetOwner` 比较 `DOMAIN\User`。
- macOS：`lsof -nP -iTCP:<hostPort> -sTCP:ESTABLISHED -Fpcun` 取反向连接的 PID/UID，与 `process.getuid()` 比较。
- Linux：`/proc/net/tcp` / `tcp6` 的 socket UID 与 `process.getuid()` 比较。
- `GET /fang/api/auth-token` 路由标记 `peerOwner:true`；映射不到、属主不同、平台不支持一律 403 `not-host-owner`（fail-closed）。
- 真实测试：Windows HSD（Node 宿主 + curl 对端）返回 `{ok:true,peerPid:844}`；macOS（Node 宿主 + 独立 curl 对端）返回 `{ok:true,peerPid:2553}`。
- 边界：这只能证明“同一 OS 用户”，不能隔离同一用户下的恶意进程；同用户进程本就可读 0600 token 文件。它关闭的是“任意回环进程/浏览器页面无需属主证明即可领取审批/重启 token”的缺口。

## 三、测试

新增 `test/v388-redlines.test.mjs` 10 项：Config 默认、helper 内存参数、browser helper 缺失 fail-closed、browser 接 Job helper、orchestrator 路由/阈值/崩溃日志/sidecar、`host-crashes.json` 10 分钟清理 + JSONL 指标、真实 `POST /fang/api/panic` 200、native 源码内存限制、母体 RSS/Private 来源。

定向结果：v3.8.8 10/10；`peer-owner` 6/6；`job-object` + `host-housekeeping*` 10/10；版本/主门禁/memory-policy wiring 34/34。
全量结果见 `docs/RELEASE-v3.8.8.md`。

## 四、V3.8.4 运行日志诊断

- `[18:04:45] bad · Panic 失败`：前端 `confirmPanic()` 调 `POST /fang/api/panic`；V3.8.4 旧源码只有 `service.panic` 方法，没有 HTTP 路由，按钮必然失败。v3.8.8 已补路由并实测 200。
- `[18:04:24] bad · 网络请求失败：/fang/api/decisions/ai Failed to fetch`：当前源码 exact path 只有 `GET /fang/api/decisions/ai`，另有 `POST .../test`、`.../config`、`.../advise`；客户端取状态也是 GET。`Failed to fetch` 是传输层错误，不是 404/503，通常是宿主/端口/网络链路已断。它与 21 秒后的 Panic 失败连在一起，较可能是宿主机已挂或请求链路已断；仅凭两条日志不能证明是少路由。需要在目标机确认宿主进程、端口与 `/fang/api/status` 是否可达。

## 五、未闭环 / 风险

1. `native/win32/fang-job-host.exe` / `fang-job-host-arm64.exe` 仍是旧二进制。C 源码已含 `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`，但本机 macOS 无 MinGW/Windows SDK；临时下载 xpack MinGW 275MB 在约 15KB/s 下超时后停止，未安装任何工具链。**因此 browser/fork 的 Job kill-on-close 使用旧 helper，Job 内存上限要 Windows 真机/CI 重编后才生效。**
2. browser Job Object 没有 Windows 真机启动测试；只有 macOS 上的 helper 缺失 fail-closed 与静态/纯函数测试。
3. `lastHostMetrics` 最多滞后 15 秒；硬杀时 JSONL 记录最后一次 heartbeat 快照，不是精确死亡瞬间。
4. `host-crashes.json` 只保留 10 分钟，超过 10 分钟历史只在 JSONL；这是按“启动时清理 >10 分钟记录”实现。
5. `allTasks` 仍跳过 ARCHIVED；归档任务不应被重新标记。
6. `allowMultiFork=true` 的“二次确认”目前只是显式配置；没有 UI/HTTP confirm 参数。
7. 进程优先级仍主要写 `BelowNormal`，`Idle` 未作为可配置档位落地。
8. 宿主属主准入只证明同一 OS 用户；不防同用户恶意进程。
9. 用户当前运行的是 V3.8.4（本地 DSH 安装 3.8.2），两者不一致；实际运行副本位置未确认。补丁需部署到那个副本后才对用户日志生效。
