# Fang v3.9.4 发布说明

- 版本：`3.9.4`
- 包名：`@twinsearth/fang-dsh-plugin`
- 基线：`3.9.3` 发布 commit + 七项运行时口径调整
- 类型：配额/安全门/提示系统口径重定 + 元主第三方 bundle 解析修复

## 七项调整

### 1. 元主配额 3 / 硬上限 6

`ESSENCE_QUOTA_DEFAULT=3`、`ESSENCE_HARD_MAX=6`。free 配额 3；vip10–vip100 的元主与分身配额都不得超过 6。客户端元主槽位按 `min(6, max(3, used))` 投影。

### 2. 分身槽位 8 / 硬上限 62

`DEFAULT_MAX_FORKS=8`、`HARD_MAX_FORKS=62`。forker 与 orchestrator 的 `maxForks` schema 都硬夹到 62；`status.capacity` 返回 `slots/hardMax/defaultLimit/limit/used`。客户端不再固定 7 槽，容量条最多显示 62。

### 3. Commit ≥2345 MB 自动解除 SafeMode

`safeModeStatus()` 每次轮询读取当前 Commit 余量；≥2345 MB 时自动清除内存类 Safe Mode 闩锁并写审计 `host-safe-mode-auto-clear`，不需要手动操作。`manual-panic` 与 `crash-loop-*` 仍必须人工确认。用户也可以 `resetSafeMode({force:true})` 强制解除。

### 4. Commit <999 MB 硬禁止派生与启动

`FORK_COMMIT_HARD_MIN_MB=999`。`memoryGate()` 在 Commit 余量 <999 MB 时返回 `commit-critical`，`createTask`、`restoreTask`、`openTask`、`startEssence` 全部拒绝；客户端弹 7 秒可关闭提醒，不落成持久横幅。

### 5. 页面文件只提醒、不强制

`decidePagefileBootPolicy().singleForkOnly` 固定 `false`；`evaluatePagefileSingleFork().limited` 固定 `false`。取消“未启用页面文件，已强制单分身”，托管浏览器并发只由 `maxOpenForkBrowsers` 决定。页面文件缺失只保留可关闭提醒，文案明确“仅提醒，不限制分身”，不要求用户设置虚拟缓存。

### 6. 所有弹窗/提醒/消息可关闭并 30 秒收入收件箱

- toast：关闭按钮；旧 toast 被替换时立即归档；30 秒后归档。
- 页面文件、SafeMode、宿主压力、磁盘卫生、迁移报告横幅：关闭按钮 + 30 秒归档。
- 表单/确认/详情弹窗：新增 `armModalArchive()`，打开 30 秒后自动关闭并归档，等同取消，不替用户执行操作；消息收件箱自身除外。
- 顶部“消息 (n)”打开收件箱，可逐条删除或清空；localStorage 上限 100 条。

### 7. 修复元主 `@twinsearth/dsh-2xray` bundle 无法解析

运行态 profile 的 `node_modules` 从母体复制后缺少 `.modules.yaml`，pnpm 会把依赖移到 `.ignored`，导致：

```text
dsh: cannot resolve profile bundle "@twinsearth/dsh-2xray" from ... profiles/essence-runtime
```

本版在 profile `node_modules` 已存在但 manifest 缺失时，从母体 manifest 复制或生成最小合法 manifest，并按 profile 所在盘对齐 `storeDir/virtualStoreDir`；同时把 `.ignored` 中的缺失包回填到顶层。

## 验证

- `node --check client.js`：PASS
- `test/v394-adjustments.test.mjs`：6/6 PASS
- 定向回归 32/32 + 47/47 PASS（配额、SafeMode、pagefile、消息收件箱、旧红线）
- `node tools/gate/main-city.mjs --target source --json`：grade A，blockers 0，version `3.9.4`
- 构建 `node tools/release/build.mjs --skip-preflight`：
  - package smoke（tarball 可安装性）：PASS
  - crash-safety（打包产物）：PASS
  - allow-list（package）：PASS
  - main-city gate（package）：PASS
- 全量测试：1563 tests / 1507 pass / 33 fail / 13 skipped / 10 todo；33 条中 1 条为当时 `docs/AUDIT-v3.9.4.md` 尚未创建，创建后 main gate 10/10 PASS；其余 32 条为既有 forker 临时目录回收与 orchestrator 无 bundle 夹具问题，与本版修改无关。发布仍走 `--skip-preflight`，不宣称全绿。

## 发布渠道

- npm：`@twinsearth/fang-dsh-plugin@3.9.4`，`latest`
- GitHub tag：`v3.9.4`
- GitHub Release：https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.9.4
- 项目目录：`E:\DBH\Fang-v3.9.4`
- tarball：`dist/dsh-fang-3.9.4.tgz`（929,504 B，208 entries）
- SHA-256：`da42596be45f69382f3f84106bf751e571cb5428641d98aa424503a6759faf0c`

## 不改变

- 3.9.3 的迁移报告 app surface 修复。
- 15s 心跳/轮询与 UI 日志上限。
- AppleDouble 清理与 8 分身容量语义。
