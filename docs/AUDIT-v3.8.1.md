# v3.8.1 审计（2026-11-24）

> 用户指令：**“三方发布，v3.8.1”**。这是 v3.8.0 严重回归的紧急修复版。

## 范围

1. 修复 v3.8.0 sidecar 用 `process.execPath` 拉起第二个 DSH 宿主。
2. 托管浏览器关闭链路：CDP Browser.close + 3s grace + taskkill。
3. 浏览器 heap 1.5GB / DOM 20万 / Commit 2GB 阈值；只关闭确认空闲页面。
4. `task.memoryGuard` 原因持久化 + UI chip。
5. 孤儿每 5 分钟清理。
6. 宿主自身 RSS 采样、10 分钟 2 次崩溃循环、Panic API/UI、BelowNormal、40% 聚合 commit。

## 验证

- 定向 tests：watchdog/browser/memory 7/7；orchestrator 73/73
- e2e：125/125
- 全量 preflight：**GREEN；tests 1338 pass / 0 fail / 2 skip；e2e 125/125**
- 真机：托管 Edge 启动/CDP（heap 30MB、DOM 1811）/graceful close 已实测

## 已知边界

- Windows Job Object 未实现。
- 官方 client 会话事件懒加载未做。
- `maxForks=8` 是容量；运行并发由 `singleActiveFork=1` 限制。

