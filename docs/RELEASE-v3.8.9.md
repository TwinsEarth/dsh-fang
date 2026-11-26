# dsh-Fang v3.8.9 发布说明

**日期**：2026-11-25
**主题**：不惜关闭——托管浏览器强制关闭八条措施与硬阈值
**基线**：v3.8.8（1542 tests / 1519 pass / 0 fail）

## 一、结论

v3.8.9 把托管浏览器关闭从“多处零散逻辑”收敛为一条可审计链：

```
flush fork 会话 → CDP Browser.close（等 3s）→ taskkill /PID /T /F
→ 停 fork 后端 → 清端口/Token → 写 memoryGuard → 等用户手动重新打开
```

默认 `autoClose=true`，命中阈值不再二次确认；只清进程，**不删除 home、会话、存档**。

## 二、八条措施落点

| # | 措施 | v3.8.9 落点 | 结果 |
|---|---|---|---|
| 1 | 托管浏览器强制关闭 | `src/lib/browser-guard.mjs` `closeManagedBrowser()`：先 `Browser.close`，按 `gracefulBrowserCloseMs=3000` 等退出，超时 `taskkill /PID /T /F` | 已有，默认保持 3s |
| 2 | 关闭顺序 | `quarantineTask()`：`closeTaskBrowser()` → `forker.stop()` → `task.port=null` → `task.token=''` | 已有，审计断言覆盖 |
| 3 | 自动关闭条件 | 新 `src/lib/browser-auto-close.mjs`：树 Commit **2048 MB**、JS heap **1536 MB**、DOM **200000**、宿主 CommitFree **<4096 MB** 四条硬阈值 | 新增硬上限与宿主低余量触发 |
| 4 | 空闲关闭 | `browserWatchdogTick()`：页面 `hidden` 超过 `autoCloseIdleMinutes=10`，且 `taskIdleForClose()` 证明无运行 turn，才关浏览器 | 已有；v3.8.9 加 `autoClose` 总开关 |
| 5 | 关闭原因持久化 | `closeTaskBrowser()` 写 `task.memoryGuard={reason,reasonKind,at,pid,metrics,...}`；UI chip“内存保护关闭”，title 显示原因/PID/宿主余量 | 已有，v3.8.9 补宿主余量 |
| 6 | 关闭后不自动重开 | 无任何 watchdog 自动拉起路径；任务卡按钮在 `memoryGuard` 时显示“重新打开”，必须用户点击 | 已有语义，v3.8.9 明示 UI |
| 7 | 孤儿清理 | 启动时一次 + `orphanSweepMinutes=5` 周期；`matchesProcessIdentity()` 用 PID + 启动时间 + 命令行哈希，taskkill 前二次核对 | 已有 |
| 8 | 关闭前落盘 | `closeTaskBrowser()` 先 `flushForkSession()`；未确认保存则 `unsavedForceClose=true`，UI“未保存强杀” | 已有 |

## 三、阈值语义

- `browserMemoryLimitMB=2048`、`browserHeapLimitMB=1536` 现在是**硬上限**。
- `memoryPolicySnapshot()` 的自适应阈值可以更严，但 `effectiveBrowserAutoCloseLimits()` 取 `min(自适应, 硬上限)`，不会在 16/32 GB 机器上放宽到 4 GB。
- 宿主 CommitFree < 4096 MB 时只关浏览器，保留 fork 后端与 home；低于 2048 MB 才走既有 `hostEmergency` 停 fork。
- 浏览器自身超 2 GB / 1.5 GB heap / 20 万 DOM 时，按措施 2 关浏览器并停 fork、清端口/Token。
- `autoClose=false` 可关闭内存/空闲自动关；宿主 <2 GB 的紧急处置不受此开关影响。

## 四、测试

新增 `test/v389-browser-auto-close.test.mjs` **11/11**：

1. 自适应只能收紧 2048/1536/200000/4096，不能放宽。
2. 树 Commit 2048 触发，2047 不触发。
3. heap 1536 与 DOM 200000 触发；CDP 失败不伪造关闭。
4. 宿主 free 4095 触发且 scope=browser；4096 不触发；autoClose=false 不触发。
5. 空闲关闭要求 `turnRunning=false`，运行中/未满 10 分钟不关。
6. `Browser.close` 在 taskkill 前，3s 宽限在函数体内。
7. flush → close → stop → port/token 顺序。
8. `memoryGuard` 字段与 `unsavedForceClose` 持久化。
9. 关闭链不含 `removeTree`，UI 要求手动“重新打开”。
10. 启动 + 5 分钟孤儿扫描 + 两次 PID 身份核对。
11. 默认 `autoClose=true` 与四个默认阈值。

回归：见“六、全量结果”。

## 五、边界

- 浏览器 watchdog 与 `taskkill` 仍是 Windows 路径；macOS/Linux 只保留 CDP 与进程组 kill。
- 宿主 CommitFree 用的是最近一次 `readSystemMemory()` 快照（host watchdog 5s 一次），浏览器 tick 可能滞后最多一个采样周期。
- 空闲关闭依赖 fork 活动接口；活动接口不可用时只告警，不自动关。
- 同 OS 用户下的恶意进程仍不在隔离范围。
- `native/win32/fang-job-host*.exe` 仍是旧二进制，Job 内存上限需 Windows 编译器/CI 重编；kill-on-close 可用。

## 六、全量结果

- 全量：**1553 tests / 1530 pass / 0 fail / 13 skipped / 10 todo**（199.0s）。
- 定向：`test/v389-browser-auto-close.test.mjs` **11/11**；browser/client/memory-policy 回归 **45/45**；版本/门禁/文档 **49/49**。

## 七、构建

- `dist/dsh-fang-3.8.9.tgz`：892,009 bytes，229 entries
- `dist/dsh-fang-3.8.9.tgz.sha256`：`d13e3d5650f8b09a475b21375c065d5f6ee4c2071863b86f90dd76cc30bb0ea5`
- 构建命令：`node tools/release/build.mjs --skip-preflight`（本机 macOS 无真实 DSH 母体）；包内 `package smoke / crash-safety / allow-list / main-city gate` 四项均 PASS
