# v3.8.10 审计：宿主红线

## 审计结论

十条红线已全部以默认开启方式落到代码与测试；Job Object 的 kill-on-close 与进程/Job 内存上限已在 Windows x64 真机完成冒烟。

| # | 判定 | 证据 |
|---|---|---|
| 1 | 通过 | `hostWatchdogTick` 无活跃对象也采样；`memory-watch-sampling` 断言不再存在 `if (!active) return` |
| 2 | 通过 | `hostAdmissionClosed` 在 `hostEmergency` 开头置位；`v3810-host-redline` 动态调用 Panic 后 create 返回 409/`host-admission-closed`；open 路由 423 |
| 3 | 通过 | sidecar `heartbeatState` + `hostIsDead`；`watchdog-sidecar-stuck` 以 20s 超龄 heartbeat 触发 `host-heartbeat-stale`，以不存在 PID 触发 `host-exit` |
| 4 | 通过 | `buildJobHostArgs` 与 C 源码均含进程/Job 内存限制；新 x64/arm64 exe 已导入 `SetInformationJobObject`；x64 以 64/128 MB 限额启动成功，强杀 helper 后 Job 内子进程消失 |
| 5 | 通过 | `Config` 默认 `maxForks=1`、`allowMultiFork=false`；`v388-redlines` |
| 6 | 通过 | `lowerProcessPriority` 对 browser/fork 树设 `BelowNormal`；宿主不改 |
| 7 | 通过 | `safeModeReason='crash-loop-10m'`；Safe Mode 时 `hostAdmissionClosed=true` |
| 8 | 通过 | `autostart-refused`；无 boot 自动 restore |
| 9 | 通过 | `POST /fang/api/panic` 实测 200，`mode:'panic'`；随后 admission 关闭 |
| 10 | 通过 | 0.4 聚合份额；8192/4096/2048 三档；紧急 `allTasks:true` |

## 风险

- heartbeat 60s 阈值可能被超长同步任务误判为“卡死”，从而杀掉全部 fork/browser。该阈值可配置，最低 15s，最高 600s。
- sidecar 在清理后退出；若宿主随后恢复，新的 fork 仍受插件内 5s 看门狗保护，但独立 sidecar 不会自动重生。
- arm64 exe 只做了 PE/导入表静态核对，尚未在 ARM64 Windows 真机执行。

## 正式 flush

已删除三个虚构 `/api/session/*` 端点。只允许 `configured`、`health-capability`、`adapter-route` 三类确认来源，并把 `source` 写入审计视图。`test/v387-crash-prevention` 已改为反向断言旧端点不存在。
