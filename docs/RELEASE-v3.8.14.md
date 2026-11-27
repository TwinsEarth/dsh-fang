# v3.8.14 发布记录：宿主守卫改看 JS heap 与 session 体量

- 日期：2026-11-26
- 版本：3.8.14
- 状态：本地源码/测试/打包完成；未打 tag、未推送、未发布 npm
- 范围：`src/lib/host-pressure.mjs`、`src/lib/session-footprint.mjs`、`src/lib/memory-guard.mjs`、`src/plugins/orchestrator.mjs`、`client.js`

## 一、这版改了什么

### 1. Host JS heap 成为独立红线

旧守卫只看 Windows CommitFree、母体 Private/RSS 和 fork/browser commit。它能看见系统换页压力，却看不见 DSH 主进程 V8 heap 已经被大会话顶高。

v3.8.14 在 5s `hostWatchdogTick` 中独立采样：

- `process.memoryUsage().heapUsed` / `heapTotal` / `external` / `arrayBuffers`
- `v8.getHeapStatistics().heap_size_limit`

默认阈值 1024 / 1536 / 2048 MB；再按 V8 上限的 65% / 80% / 90% 收紧，避免小 heap 主机等到固定 2 GB 才报警。

动作分级：

- `warn`：审计 + 客户端横幅，不阻止已有任务。
- `critical`：置 `hostHeapPressureGate`，`create/restore/open/launchTaskBrowser` 拒绝新入口。
- `emergency`：连续 `hostJsHeapEmergencyStreak`（默认 3 次，约 15s）后调用 `hostEmergency('host-js-heap-emergency')`。

关键点：heap 采样在 `readSystemMemory()` 之前执行；PowerShell/CIM 探针失败时，heap 守卫仍然工作。

### 2. session 文件体量进入守卫，而不是只看 Commit

新增 `src/lib/session-footprint.mjs`，只 `stat` 精确文件名 `session.v4.jsonl.zstd`，不读、不解压：

- Host root：`$DSH_HOME/sessions` + `quarantine-sessions`
- 每个任务 home：`<task.homeDir>/sessions` + `quarantine-sessions`
- 60s 缓存，5s tick 复用上次结果

默认：

- 合计 512 MB 警告 / 1024 MB 严重 / 2048 MB 紧急
- 单文件 16 MB 警告 / 32 MB 严重 / 48 MB 紧急

单文件达到 48 MB 时置 `sessionFootprintGate`，拒绝新分身/新浏览器；合计达到 2048 MB 只置 `totalGate` 并审计/横幅提示，不因“很多小文件”误封新任务。不删除、不移动、不压缩活动会话。客户端显示总量、最大文件与 top 列表，提示先归档/压缩或重启宿主。

> 现场对照：2026-11-26 TOFUTURE 的 Host `%USERPROFILE%\.dsh\sessions` 最大单文件 60.91 MB（`session-ad7ddc1f-...`），合计 222.56 MB。按本版默认阈值，该文件已经超过 48 MB 紧急线；安装后需要先归档/压缩该会话，否则新任务会被 gate 拒入。Fork 侧另有 60.90 MB 副本，属于同一会话在不同 home 的副本。

### 3. pagefile/commit 探针改为全盘

旧脚本虽然对 `Win32_PageFileUsage` 做了 Sum，但只输出一个 `PageFileMB`，没有驱动盘维度；Commit 上限直接取 `Win32_OperatingSystem.TotalVirtualMemorySize`，无法解释“只看 C 盘”的现场判断。

新脚本同时读取：

- `Win32_PageFileUsage`：每个活动分页文件的 `Name/AllocatedBaseSize/CurrentUsage/PeakUsage`
- `Win32_PageFileSetting`：每个配置分页文件（可能未激活）
- `Win32_LogicalDisk`：所有固定/可移动卷的 `DeviceID/SizeMB/FreeMB/FileSystem`
- 注册表 `PagingFiles`

输出并参与判定：

- `pageFileDrives`、`pageFileDriveCount`、`pageFileOnSystemDrive`、`pageFileOffSystemDrive`
- `pageFileDetails`、`pageFileSettings`、`volumes`
- `commitLimitOSMB`、`commitLimitDerivedMB`、`commitLimitSource`
- `commitLimitMB = max(OS, 物理内存 + 所有活动分页文件)`

2026-11-26 TOFUTURE 真机：分页文件只在 `D:\pagefile.sys`（12345 MB，当前使用 58 MB），`Win32_PageFileSetting` 也是 D:；`CommitLimitOSMB=44821`，`CommitLimitDerivedMB=44821`，`pageFileOffSystemDrive=true`。证据见 `docs/evidence/memory-probe-all-drives-2026-11-26.md`。

## 二、明确没做的事

- **`openMigrationReport` 未改**：仍按独立客户端 API 问题处理；不把它并入 OOM 根因，也不建议重装客户端或改 asar。
- **不自动压缩活动 session**：活动 `session.v4.jsonl.zstd` 正在被 DSH 追加写；本版只监控和 gate，压缩仍只对归档/迁移会话执行既有 `sessionCompaction`。
- **不杀掉 Host 进程**：JS heap 紧急处置走既有 `hostEmergency`（关浏览器/停分身/隔离/Safe Mode），不是 `process.abort()`。
- **不替换 `E:\DB\Fang`**：那仍是独立 v3.8.3 脏工作树，本版不覆盖。

## 三、验证

```text
node --test --test-concurrency=1 test/v3814-host-guard.test.mjs
6 tests / 6 pass / 0 fail
```

全量结果见 `docs/AUDIT-v3.8.14.md`。真实 DSH 宿主内的 heap/session 实时读数尚未安装本版复测；本版只能声明“纯逻辑 + Windows PowerShell 探针 + 本地全量测试完成”，不能声明“真实宿主 E2E 通过”。

```text
npm run build -- --skip-preflight
PASS  package smoke (tarball installability)
PASS  crash-safety (packaged artifact)
PASS  allow-list (package)
PASS  main-city gate (package)
PASS  build @twinsearth/fang-dsh-plugin@3.8.14
      tarball : dist/dsh-fang-3.8.14.tgz (949588 bytes, 232 entries)
      sha256  : 8514ecb09a295ccd150e053ba2aeed15366cb75fed7ca0dc04ff7d60e2894757
```

## 四、发布边界

- 本地 tag 尚未创建；是否打 `v3.8.14`、是否推送 GitHub / npm，按用户确认后再做。
- 已构建 `dist/dsh-fang-3.8.14.tgz` 并跑通 package smoke / crash-safety / allow-list / main-city gate；`manifest.json` 的 `preflight` 仍记录 `skipped:true / green:false`，不得写成门禁 GREEN。
- 当前 GitHub 远端仍只读（403），npm 未发布；本记录不代表发布完成。
