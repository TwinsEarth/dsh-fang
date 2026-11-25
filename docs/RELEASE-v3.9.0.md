# v3.9.0 发布记录：Host JS heap / session 体量 / 全盘 pagefile 正式发布

- 版本：3.9.0
- 日期：2026-11-26
- 基线：v3.8.14 本地提交 `98a8b83`
- 发布形式：GitHub `v3.9.0` tag / Release + npm `@twinsearth/fang-dsh-plugin@3.9.0` + 项目目录报告
- 发布边界：本版只把 v3.8.14 的宿主守卫提升为正式版本，不并入未选择的 B/C/D/E 审计项

## 一、本版包含什么

v3.8.14 的主题是“宿主守卫改看 Host JS heap 与 session 文件体量，并修正 pagefile/commit 探针只覆盖 C 盘的误判”。v3.9.0 完整承接这套代码：

- **Host JS heap**：默认 1024 / 1536 / 2048 MB 三级阈值，并按 V8 `heap_size_limit` 的 65% / 80% / 90% 收紧；连续 3 次紧急采样才走宿主紧急处置。
- **session 文件体量**：只 `stat` 精确文件名 `session.v4.jsonl.zstd`，不读、不解压；单文件默认 16 / 32 / 48 MB，合计默认 512 / 1024 / 2048 MB；只有单文件 emergency 置 `gate:true`，合计 emergency 只置 `totalGate:true` 并审计/横幅，避免很多小文件误封新任务。
- **pagefile/commit 全盘**：读取 `Win32_PageFileUsage`、`Win32_PageFileSetting`、`Win32_LogicalDisk` 与注册表 `PagingFiles`，输出 `pageFileDrives`、`pageFileOffSystemDrive`、`pageFileDetails`、`volumes`；Commit 上限取 `max(OS TotalVirtualMemorySize, 物理内存 + 所有活动分页文件)`。
- **压力门**：create / restore / open / launchTaskBrowser 先过 `currentPressureGate()`；审计事件包括 `host-js-heap-*`、`session-footprint-*`、`host-pressure-admission-refused`。
- **客户端横幅**：显示 heap used/limit/百分比、session 合计/最大单文件/路径/阈值；gate 时明确提示“不是重装客户端或替换 asar 能解决”。

## 二、本版不包含什么

以下均为用户未选择的审计项，v3.9.0 不包含、也不得在发布文案中写成已修：

- **B**：session 60.91 MB 压力门现场处置（归档/调阈值/保持 gate/暂停）；
- **C**：`lastHostMetrics` 15s 刷新、`host-crashes` UI 10min、`allTasks` ARCHIVED、`allowMultiFork` confirm、Idle 优先级、`openMigrationReport`；
- **D**：Windows orchestrator 全链 E2E、arm64 真机验证；
- **E**：GitHub 凭据吊销/轮换/OAuth/SSH。

`openMigrationReport` 仍是独立客户端 API 问题，未修；不得写成“已修”或“已被本版覆盖”。

## 三、测试

- 定向守卫测试 `test/v3814-host-guard.test.mjs`：6 / 6 PASS。
- 全量回归：`1585 tests / 1562 pass / 0 fail / 13 skipped / 10 todo`，`duration_ms=200145.04`（2026-11-26，Mac，`npm test`）。
- 历史证据：TOFUTURE 页面文件在 D:、`CommitLimitOSMB=44821`、Host session 206 个合计 222.56 MB、最大单文件 60.91 MB；按本版默认 48 MB 单文件紧急线会置 `sessionFootprintGate`，属预期行为，见 `docs/evidence/memory-probe-all-drives-2026-11-26.md`。

## 四、构建与门禁

- `dist/dsh-fang-3.9.0.tgz`：206 entries，944022 bytes，sha256 `3790ec291f4355299c09d3200317215e315f42fe8c490592844098cfd4376e60`；package smoke / crash-safety / allow-list / main-city gate 均 PASS。
- 发布工具修正：`tools/release/build.mjs` 原先 `tar -czf ... package` 会把目录条目写进 tarball，npm registry 以 HTTP 415 `invalid path: package/` 拒收；本版改为显式文件清单打包，tarball 只含文件条目。
- `dist/manifest.json` 的 `preflight` 为 `skipped:true / green:false`，本版不宣称“preflight GREEN / 发布门禁通过”。
- 真实 Windows DSH 宿主内的 heap/session 实时读数、pagefile 全盘显示与 orchestrator 拉起 browser/fork 全链 E2E 仍未跑；本版只验证纯逻辑、静态接线、Windows PowerShell 探针和本地全量测试。

## 五、三方发布

- GitHub：`v3.9.0` tag 指向本版发布提交，Release 附件为 `dsh-fang-3.9.0.tgz`、`.sha256`、`RELEASE.md`。
- npm：`@twinsearth/fang-dsh-plugin@3.9.0`，`latest` 指向本版。
- 项目目录：发布包、校验和、Release/AUDIT 副本与三方发布报告交付到当前项目目录。

发布状态以 `docs/AUDIT-v3.9.0.md` 和项目目录报告为准；本文件不提前宣称未完成的发布动作。
