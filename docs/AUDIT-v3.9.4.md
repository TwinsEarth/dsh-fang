# v3.9.4 审计记录

- 日期：2026-11-26
- 版本：`3.9.4`
- 包名：`@twinsearth/fang-dsh-plugin`
- 基线：`3.9.3` 发布 commit + 七项运行时口径调整

## 范围

本次只处理用户指定的七项：

1. 元主配额默认 3、硬上限 6。
2. 分身容量槽位默认 8、硬上限 62。
3. Commit 余量 ≥2345 MB 自动解除 SafeMode；用户也可强制解除。
4. Commit 余量 <999 MB 禁止派生新分身、禁止启动已有分身，并弹 7 秒可关闭提醒。
5. 页面文件只提醒、不强制；取消“未启用页面文件，已强制单分身”。
6. 所有弹窗/提醒/消息可关闭，30 秒后收入消息收件箱。
7. 修复元主第三方插件 `@twinsearth/dsh-2xray` profile bundle 无法解析。

不改变 3.9.3 的迁移报告 app surface、15s 心跳、UI 日志上限与 AppleDouble 清理。

## 实现

### 配额

- `src/lib/essence.mjs`：`ESSENCE_QUOTA_DEFAULT=3`、`ESSENCE_HARD_MAX=6`；free 为 3，所有 VIP tier 的 `maxEssences/maxSubEssences` 为 6。
- `src/plugins/orchestrator.mjs`：`DEFAULT_MAX_FORKS=8`、`HARD_MAX_FORKS=62`；`maxForks` schema `.min(1).max(62).default(8)`；运行时 clamp 62；`status.capacity` 暴露 `slots/hardMax/defaultLimit/limit/used`。
- `src/plugins/forker.mjs`：schema 同样 `.max(62)`，spawn 前 clamp。
- `client.js`：删除硬编码 7 槽；分身槽位按 `min(62, max(8, used))` 投影，元主槽位按 `min(6, max(3, used))` 投影。

### SafeMode 与 Commit 硬门

- `SAFE_MODE_AUTO_CLEAR_COMMIT_MB=2345`：`safeModeStatus()` 每次轮询时，若 Commit 余量 ≥2345，自动清除内存类闩锁并写审计 `host-safe-mode-auto-clear`；`manual-panic` 与 `crash-loop-*` 不自动清除。
- `resetSafeMode({force:true})` 可在低 Commit 下强制解除；强制解除不会自动拉起分身。
- `FORK_COMMIT_HARD_MIN_MB=999`：`memoryGate()` 在 Commit <999 时返回 `commit-critical`；`createTask`、`restoreTask`、`openTask`、`startEssence` 全部拒绝，并在客户端弹 7 秒可关闭提醒。
- `hostCriticalFreeMB` 默认 2345；`memoryMinFreeMB` 默认 999。

### 页面文件

- `decidePagefileBootPolicy().singleForkOnly` 固定 `false`。
- `evaluatePagefileSingleFork().limited` 固定 `false`，只保留 `advisory: 'pagefile-missing'`。
- 删除 boot 阶段的 pagefile 强制单分身分支；`openForkBrowser` 不再因页面文件缺失把并发压到 1。
- 客户端横幅改为“未启用页面文件 · 仅提醒，不限制分身”，带关闭按钮和 30 秒归档；删除“已强制单分身”文案。

### 弹窗/提醒/消息收件箱

- `NOTICE_INBOX_DELAY_MS=30000`、`MESSAGE_INBOX_KEY='fang.messageInbox.v1'`、上限 100 条。
- toast 支持关闭按钮，旧 toast 被替换时立即归档，30 秒后归档。
- `setNotice`、页面文件/SafeMode/宿主压力/磁盘卫生/迁移报告横幅都带关闭按钮并 30 秒归档。
- `armModalArchive()`：所有表单/确认/详情弹窗打开 30 秒后自动关闭并归档，等同取消，不替用户执行操作；消息收件箱自身不重复归档。
- 顶部“消息 (n)”打开收件箱，可逐条删除或清空。

### 元主 bundle

- 根因：运行态 profile 的 `node_modules` 从母体复制后缺少 `.modules.yaml`；pnpm 视为不同包管理器安装并把依赖移入 `.ignored`，导致 `@twinsearth/dsh-2xray` 无法解析。
- `ensureModulesManifest()` 在目标 `node_modules` 已存在但 manifest 缺失时，复制母体 manifest 或生成最小合法 manifest，并按 profile 所在盘对齐 `storeDir/virtualStoreDir`。
- `ensureEssenceRuntimePnpmConfig()` 新增 `manifestSourceDir`，读取前先补 manifest；`orchestrator` 传入模板 `node_modules`。
- `syncProfileModulesFromMother()` 增加 `.ignored` 回填。

## 验证

- `node --check client.js`：PASS。
- `test/v394-adjustments.test.mjs`：6/6 PASS。
- 定向回归一：`v394-adjustments + commit-budget-v3813 + v387 + v386 + client-pagefile-banner`：32/32 PASS。
- 定向回归二：`essence + client-safe-mode + v3810-host-redline`：47/47 PASS。
- 定向回归三（旧断言同步后）：`pnpm-store + pagefile-safety + v388 + v390 + plugins-shape + role-extensions + kernel + install-docs + package-metadata + client-migration-report + v394`：除 forker 的 2 个真实目录回收夹具外全部 PASS。
- `node tools/release/build.mjs --skip-preflight`：PASS；tarball 929,504 B，208 entries，SHA-256 `da42596be45f69382f3f84106bf751e571cb5428641d98aa424503a6759faf0c`；manifest 记录 `green:false / skipped:true`。
- 实际运行态 profile `D:\ToFuture\FangData\sessions\essence-official-dev\home\profiles\essence-runtime`：已生成 `.modules.yaml`、`pnpm-workspace.yaml`，`storeDir` 对齐到 `D:\.pnpm-store\v11`，`@twinsearth/dsh-2xray` 顶层包存在，`bundleExists=true`、`ignoredExists=true`。

## 全量测试（RED）

- tests 1563 / pass 1507 / fail 33 / skipped 13 / todo 10，约 264s（`test-394-full3.log`）。
- 33 条失败分布：
  - 30 条 `orchestrator.test.mjs`：临时夹具 profile 不含真实 bundle，`createTask` 返回 `fork-bundle-unavailable`；与 3.9.4 修改无关。
  - 2 条 `forker.test.mjs` 的 reap 真实目录回收断言：Windows 临时目录 junction 删除存在间歇性 `exists=true`；与 3.9.4 修改无关。
  - 1 条 `main-gate.test.mjs`：运行时 `docs/AUDIT-v3.9.4.md` 尚未创建；创建后单独复跑 main gate 通过。
- 因此发布仍走 `--skip-preflight`，`dist/manifest.json` 必须记录 `green:false / skipped:true`，不得写成门禁 GREEN。

## 残余风险

- “内存 Commit”按 `commitFreeMB` 解释；若用户实际指 `commitLimitMB`，2345/999 的语义需要重定。
- SafeMode 自动解除只排除 `manual-panic` 与 `crash-loop-*`；若要求任何 SafeMode 都自动解除，需要再改。
- 表单弹窗自动关闭等同取消，避免无人值守时替用户执行删除/发布等操作；若希望自动执行需单独设计。
- 真实 DSH 启动复验仍需在安装 3.9.4 后重启宿主再跑一次；当前只验证了 bundle 文件与 manifest 解析前置条件。
