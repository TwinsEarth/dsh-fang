# dsh-Fang v3.8.9 审计记录

**审计对象**：v3.8.8 现有浏览器关闭链 vs 用户给定“不惜关闭”八条
**结论**：五条已成立，三条有缺口并已补：显式 `autoClose`、宿主 CommitFree <4 GB 触发、2 GB/1.5 GB 硬上限。

## 一、改前事实

| 措施 | 改前状态 | 证据 |
|---|---|---|
| 1 强制关闭 | 成立 | `closeManagedBrowser()` 已 `browserCloseCdp` → 3s → `taskkill /T /F` |
| 2 关闭顺序 | 成立 | `quarantineTask()` 先 `closeTaskBrowser`，再 `forker.stop`，再清 port/token |
| 3 阈值 | 部分 | 2 GB/1.5 GB/200k 仅在 `memoryPolicySnapshot()` 的自适应上限里；32 GB 机器可放宽到 4 GB/3 GB；宿主 <4 GB 只审计不关 |
| 4 空闲关闭 | 成立 | `hiddenSince` + `taskIdleForClose()` + `autoCloseIdleMinutes=10`，默认 `idleCloseOnlyWhenIdle=true` |
| 5 原因持久化 | 成立 | `task.memoryGuard` 已写 reason/at/pid/metrics；UI 已有“内存保护关闭” |
| 6 不自动重开 | 成立 | 关闭后 `task.browser=null`，无 watchdog 拉起；重开需 `openTask`/`restoreTask` |
| 7 孤儿清理 | 成立 | 启动 + 5 分钟；`matchesProcessIdentity` 两次核对 PID 身份 |
| 8 关闭前落盘 | 成立 | `flushForkSession` 先于浏览器关闭；失败写 `unsavedForceClose` |

## 二、代码修改

### 1. 新增纯策略模块

`src/lib/browser-auto-close.mjs`：

- `BROWSER_AUTO_CLOSE_DEFAULTS`：2048 / 1536 / 200000 / 4096 / 10 / 3000。
- `effectiveBrowserAutoCloseLimits()`：`min(自适应, 配置硬上限)`，自适应只能更严。
- `evaluateBrowserAutoClose()` 返回：
  - `scope:'task'`：浏览器树 Commit/heap/DOM 超限，关浏览器并停 fork；
  - `scope:'browser'`：宿主 CommitFree <4 GB，只关浏览器，保留 fork/home；
  - `autoClose=false` 时返回 `close:false`。
- `cdpOk=false` 时 heap/DOM 不参与判定，避免采样失败被当成 0 或误关。

### 2. orchestrator 接线

- Config 新增 `autoClose: default(true)`；`browserMemoryLimitMB`、`browserHeapLimitMB` 描述改为硬上限。
- `browserWatchdogTick()`：
  - `browser.last.hostCommitFreeMB` 记录宿主余量；
  - 调 `evaluateBrowserAutoClose()`；
  - `scope:'task'` 且 `quarantineOnGuard!==false` → `quarantineTask()`；
  - 否则 → `closeTaskBrowser()`（浏览器 only）；
  - 审计 `fork-browser-auto-close`，含 trigger、commit/heap/nodes、host free、四条硬阈值。
- 空闲关闭加 `cfg.autoClose===true` 总开关。
- `/fang/api/status` 增加 `browserAutoClose`：enabled、requiresConfirm=false、preservesHome=true、四条有效阈值。
- `closeTaskBrowser()` 原有 `memoryGuard` 保留；`browser.last` 的宿主余量随 metrics 落盘。

### 3. UI

- `task.memoryGuard` 时任务按钮文案从“打开”改为“重新打开”。
- chip title 增加宿主 Commit 余量，并明示“必须手动重新打开，不会自动重开”。

## 三、测试

`test/v389-browser-auto-close.test.mjs` **11/11 pass**，覆盖：

- 硬阈值不被自适应放宽；
- 2 GB / 1.5 GB / 200k 边界；
- 宿主 4095 vs 4096；
- `autoClose=false`；
- idle 需 `turnRunning=false`；
- Browser.close → taskkill 顺序与 3s 宽限；
- flush → close → fork stop → port/token；
- memoryGuard 持久化；
- 不删 home + 手动重开；
- 启动/5 分钟孤儿扫描与两次身份核对；
- 默认配置值。

定向回归 45/45（browser-guard、v387、v388、client layout/safe-mode/pagefile、memory-policy）；全量 1553 tests / 1530 pass / 0 fail / 13 skipped / 10 todo。

## 四、边界与未完成

- Windows 真机未跑浏览器阈值触发；需要 HSD 上启动托管浏览器并把阈值临时调低后验证 `taskkill` 与 `memoryGuard`。
- `native/win32/fang-job-host*.exe` 未重编；Job 内存上限仍不生效。
- 宿主余量来自最近一次 host watchdog 采样，非实时。
- 空闲关闭依赖 adapter 活动接口；接口失败只告警。
- 未执行 commit/push/tag/npm publish。
