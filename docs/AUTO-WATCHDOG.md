# 自动看护（auto-watchdog）

生效版本：`v3.3.7`

## 目标

用户两次确认重启后，若没有外部 supervisor，RestartGuard 自动启动一个独立 watchdog，
由 watchdog 在宿主退出后按原命令拉起新宿主。**不是**无确认直接 exit。

## 链路

```text
二次确认请求
→ Approver 红色审批
→ restart-guard 发现 supervisorPresent=false
→ 启动 tools/restart-watchdog.mjs --execute
→ watchdog 写 <dataDir>/restart/supervisor.present
→ guard 重新计算 executionArmed
→ 写授权清单 → exit(75)
→ watchdog 校验清单/pid/回执 → 用原命令 relaunch
```

## 必要条件

- bundle：`mode: enforce`、`allowProcessRestart: true`、`autoWatchdog: true`；
- 用户确认：`forkChecked=true` + `finalConfirm=true`；
- 当前母体进程有 `<dataDir>/fang.pid`，watchdog 可读；
- relaunch 命令：`process.execPath + process.argv.slice(1)`（由宿主自己给出，不猜 shell 字符串）。

## 失败行为

- watchdog 工具缺失 / 起不来 / 4 秒内未写 marker：`auto-watchdog-failed`，**不写授权清单、不退出**；
- 崩溃循环 / 安全模式：即使 watchdog 在位也 `executionArmed=false`；
- 无回执：`execution.executed=false`，不把“已批准”说成“已重启”。

## 角色边界

本版本自动看护只接在 **mother** 的 restart-guard 上。
fork/元主运行态的重启属于 Forker / EssenceRuntime 监督面，不能直接复用母体 exit(75)。

## 验证

```bash
node --test test/restart-guard.test.mjs
node tools/gate/main-city.mjs --target source --root .
```
