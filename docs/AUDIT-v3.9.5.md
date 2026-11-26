# v3.9.5 审计记录

日期：2026-11-26
主题：crash-loop Safe Mode 永久闩锁热修

## 1. 现场证据

真实数据根 `D:\ToFuture\FangData\mirror\desktop`：

- `safe-mode.json`：`reason=crash-loop-10m`，最后写入 2026-11-26 23:55:41。
- `host-crashes.json`：两条 `unclean-shutdown`，相隔约 274.8 秒：
  - `commitFreeMB=25785 / 25434`，`commitLimitMB=44821`；
  - `heapUsedMB=271.8 / 163.1`，`selfRssMB=566 / 454`；
  - `sessionFootprintMB=365`，`largestSessionMB=61`，`sessionPressure=critical`。
- UI 表现：`Safe Mode · 自动恢复已禁止`；启动分身返回 `host-admission-closed`，detail=`crash-loop-10m`。

结论：两次非正常退出发生在 Commit 余量 25 GB、heap 未到 critical 的健康宿主机上。它们不是资源型崩溃循环，却触发了全局封门，并把瓮城锁死。

## 2. 根因

1. `shouldAutoClearSafeMode()` 对 `crash-loop-*` 硬排除，即使 Commit 已恢复也不自动解除。
2. 启动时 `recent.length >= 2` 只看“两次 unclean-shutdown”，不看崩溃样本是否携带资源压力。
3. 自动解除后没有清空 `host-crashes.json` 的窗口计数；下一次正常重启会拿旧记录再次封门。
4. 准入路径只读 `hostAdmissionClosed`，没有先尝试按当前内存恢复 Safe Mode。

## 3. 修复

- `shouldAutoClearSafeMode()`：只保留 `manual-panic` 为人工闩锁；`crash-loop-*` 在 Commit ≥2345 MB 时自动解除。
- 新增 `hasHostCrashPressure(metrics, { criticalFreeMB })`：只有低 Commit、heap critical/emergency、session emergency 才算资源型崩溃循环；普通 unclean-shutdown 不再封门。
- 自动解除 `crash-loop-*` 时清空 `host-crashes.json` 的 `crashes` 窗口计数（JSONL 审计保留），避免旧记录复发。
- 非 SafeMode 的旧 `hostAdmissionClosed` 在内存恢复后自动重开；任务级 quarantine 仍独立拦截。
- 新增 `ensureHostAdmission()`：`createTask` / `restoreTask` / `syncTaskOnOpen` / `launchTaskBrowser` / `open-url` 在准入前先尝试恢复，避免“状态页还没轮询就点启动”继续吃到 423。
- 宿主压力横幅补全“单文件阈值 16 / 32 / 64 MB”，解释 60.9 MB 单会话为何被判 critical，不再让用户误以为 365 MB 已超过 512/1024/2048 合计阈值。

## 4. 验证

- `node --check client.js`：PASS。
- `node --check src/plugins/orchestrator.mjs`：PASS。
- `v394-adjustments + v3814-host-guard`：12/12 PASS。
- `client-safe-mode + commit-budget-v3813 + v387 + v386 + v3810 + essence`：70/70 PASS。
- `kernel + plugins-shape + role-extensions + package-metadata`：37/37 PASS。
- 全量 `node --test test/*.test.mjs`：1563 tests / 1509 pass / 31 fail / 13 skipped / 10 todo。31 条中 30 条是 orchestrator 临时夹具 profile 缺真实 bundle 导致 `fork-bundle-unavailable`，1 条是 forker 在 Windows 临时目录 junction 回收上间歇 `exists=true`。这是既有夹具问题，不在本热修范围，不写成 GREEN。

## 5. 残余风险

- `manual-panic` 仍必须人工确认或显式 `force:true`，不会被 Commit 恢复自动放行。
- 真正由插件 bug 导致的崩溃循环不再被 Safe Mode 永久封死；如果 bug 仍在，重复崩溃会继续产生 `host-crashes.jsonl`，需要按日志定位插件，而不是靠封门掩盖。
- 61 MB 单会话仍是 critical 级磁盘/heap 风险，但未到 64 MB emergency，不会封住新任务；建议归档或压缩该会话。
