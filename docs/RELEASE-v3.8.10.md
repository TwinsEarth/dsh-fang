# v3.8.10 发布记录：严禁把宿主搞崩

- 日期：2026-11-25
- 基线：v3.8.9
- 主题：母体自我保护与独立兜底，防止 fork/browser 反噬 DSH 宿主
- 结论：十条红线的代码与单测完成；v3.8.10 产物已带 82KB/54KB 新 helper（C 源码含 Job/进程内存上限）。发布构建时未做 Windows 真机验证；后续 2026-11-26 已对同版本 helper 在 Windows 11 build 26300 真机验证 kill-on-close 与 Job/进程内存上限三例，browser/fork 完整编排链路仍未验。

## 十条红线的落地位置

| # | 红线 | 落地 | 默认 |
|---|---|---|---|
| 1 | 母体每 5s 采样自身 Private/RSS + 系统 CommitFree；8/4/2 GB 分级 | `hostWatchdogTick` 删除“无活跃 fork/browser 就 return”，每 5s 无条件 `readSystemMemory` + `rememberMemory`；`/fang/api/status.hostMetrics` 暴露 `selfRssMB`、`selfPrivateMB`、`commitFreeMB` | 开 |
| 2 | 紧急阈值先关所有 fork 浏览器，再停所有 fork 后端，关闭新准入，隔离 | `hostEmergency` 第一步 `hostAdmissionClosed=true`，随后逐任务 `closeTaskBrowser`，再 `quarantineTask`；fork-commit-share / commit-free-emergency / panic 均 `allTasks:true`（只跳过 ARCHIVED）；create 返回 409、restore 与 open-url/open 返回 423 `host-admission-closed` | 开（<2 GB） |
| 3 | 独立看门狗监控宿主 PID；卡死或退出时清理 fork/browser | `src/lib/watchdog-sidecar.mjs` 独立 Node 进程；新增 `heartbeatState()` 读 `host-state.json` mtime，超过 `watchdogHostStuckMs=60000` 判 `host-heartbeat-stale`；`host-exit` / `host-pid-reused` / `host-clean-stop` 分因记录后 `taskkill /T /F` | 开 |
| 4 | Windows Job Object：KILL_ON_JOB_CLOSE + 进程/Job 内存上限 | fork 与 browser 均经 `buildJobHostArgs` 进入 Job，传 `--job-process-memory-mb` / `--job-memory-mb`；C 源码设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、`PROCESS_MEMORY`、`JOB_MEMORY`；helper 缺失时 fail-closed | 开（源码 + 82KB/54KB helper）；发布时未真机验证，后续 2026-11-26 helper 三例真机 PASS |
| 5 | 硬上限 maxForks=1 | `maxForks=1`，`allowMultiFork=false`；多开必须显式配置 | 开 |
| 6 | fork/browser BelowNormal/Idle，宿主保持 Normal/High | `lowerProcessPriority()` 对 browser 与 fork 进程树设 `BelowNormal`；不修改宿主自身优先级 | 开 |
| 7 | 10 分钟内宿主崩溃 2 次，下次启动 Safe Mode | `host-crashes.json` 滑动窗口，`safeModeReason='crash-loop-10m'`；Safe Mode 下 `hostAdmissionClosed=true`，不自动恢复、不自动开分身 | 开 |
| 8 | 宿主崩溃后禁止自动拉起 fork | Safe Mode + `autostart-refused`；恢复必须用户点击 | 开 |
| 9 | 全局 Panic：关浏览器→停 fork→清 PID→隔离 | `POST /fang/api/panic` → `service.panic()` → `hostEmergency('manual-panic',{safe:true,allTasks:true})`；`quarantineTask` 清 `pid/port/url/token` | 开 |
| 10 | fork 总 commit ≤ 系统 commit 40%；宿主保留至少 4 GB | 聚合 `forkCommitShareLimit=0.4` → 紧急；`hostCriticalFreeMB=4096`、`hostEmergencyFreeMB=2048`、`hostWarnFreeMB=8192` | 开 |

“关闭监听”解释为**关闭新分身/浏览器准入**，不关闭宿主 HTTP 插件路由；否则 UI 无法读取状态或执行 Panic 恢复。`/fang/api/status` 与 `/fang/api/panic` 在紧急态保持可达。

## 正式 flush 只调用已确认的 fork API

`flushForkSession` 不再猜测 `/api/session/flush`、`/api/session/save`、`/api/sessions/flush`。候选仅保留三类，并在 `attempted` / `last` / `flushView` 记录 `source`：

1. `configured`：`forkFlushPath` 显式覆盖；
2. `health-capability`：fork health 返回的 `flush.method=POST` 路径；
3. `adapter-route`：本插件真实注册的 `/<prefix>/adapter/flush-session`，调用宿主 `ctx.sessions.flush(session)`，`saved` 仅在 `failed.length===0` 时为 true。

## 测试

- 全量：1568 tests / 1545 pass / 0 fail / 13 skipped / 10 todo
- 新增 `test/v3810-host-redline.test.mjs`：12/12，含真实 Panic 路由后 `admissionClosed=true` 与 create 返回 423 的动态验证
- 新增 `test/watchdog-sidecar-stuck.test.mjs`：3/3，含 heartbeat 超龄 `host-heartbeat-stale`、宿主退出 `host-exit`、干净停止
- 相关回归：63/63

## 产物

- `dist/dsh-fang-3.8.10.tgz`：937,707 bytes，229 entries
- SHA-256：`e571eccc15788898c295950a0ab11376d0465d44d7a3913c8f39dccdee46f5f8`
- `dist/dsh-fang-3.8.10.tgz.sha256`

## Windows helper 真机验证

- 2026-11-26 Windows 11 build 26300 / Node 22 真机：`node tools/job-object-windows-e2e.mjs --helper native/win32/fang-job-host.exe --memory`，kill-on-close、`--job-memory-mb 64`、`--job-process-memory-mb 64` 三例全部 PASS；证据 `docs/evidence/job-object-e2e-2026-11-26.md`。
- 新 exe：x64 82,944 bytes，arm64 54,784 bytes，PE32+ console；导入 `CreateJobObjectW`、`SetInformationJobObject`、`AssignProcessToJobObject`、`TerminateJobObject`。
- x64 冒烟 1：`--job-process-memory-mb 64 --job-memory-mb 128` 启动 `cmd /c exit 0`，helper 退出 0，ready 文件 `mode=kill-on-close`、`error=null`，证明 Job 限额设置成功。
- x64 冒烟 2：Job 内启动长驻子进程后强杀 helper，3 秒后子进程消失，`CHILD-KILLED-BY-JOB-CLOSE`。

## 已知边界

- arm64 exe 已生成并核对 PE 头/导入表，但未在 ARM64 Windows 真机执行。
- 未在 Windows 真机验证 5s 常驻采样开销、sidecar 卡死清理与 flush 新候选链。
- 宿主“保留 4GB”是 4GB 严重告警 + 2GB 紧急熔断，不是硬性内存预留。
