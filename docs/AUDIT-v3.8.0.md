# v3.8.0 审计（2026-11-24）

> 用户指令：**“修改并三方发布，v3.8.0”**，并要求托管浏览器、宿主熔断、独立看门狗、隔离闩锁、Safe Mode、无 pagefile 检测、浏览器监控等 P0/P1 能力。

## 范围

1. 托管浏览器：独立 Edge/Chrome profile、CDP、PID 树、crash dump/log。
2. 宿主看门狗：CommitFree 8GB/4GB/2GB 三级；4GB 先关浏览器再隔离 fork；2GB 进入 Safe Mode。
3. 隔离闩锁：token 吊销、URL 清空、端口关闭、open 返回 423；显式 restore 才清除。
4. 宿主崩溃闩锁：`host-state.json` + `safe-mode.json`；非正常退出后禁止自动恢复。
5. 浏览器看门狗：Commit 2GB、DOM 20 万节点、隐藏 10 分钟自动关闭。
6. 独立 sidecar：宿主被强杀后清理 watchdog.json 中登记的 PID 树。

## 验证（待回填）

- 全量 tests：
- preflight --e2e：
- 发布 PR CI：
- release-order：
- 真机托管浏览器：Edge 启动、CDP 采样、force close（已本地实测，发布前再复验）

## 边界 / 未完成

- 官方 DSH Web client 的会话事件限流/懒加载未改；当前用 DOM/Commit 上限 + 关闭/隔离兜底。
- Job Object 原生 `KILL_ON_JOB_CLOSE` 未启用；当前由 detached sidecar + taskkill 树强杀替代。
- 托管浏览器首次打开是独立 profile，不继承日常浏览器登录态。
