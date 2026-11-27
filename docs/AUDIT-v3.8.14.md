# v3.8.14 审计：Host JS heap / session 体量 / 全盘 pagefile

- 日期：2026-11-26
- 范围：宿主 OOM 守卫信号源、pagefile/commit 探针、session 数据层可观测性
- 结论：守卫从“只看系统 CommitFree + 母体 Private/RSS”扩为“Host JS heap + session 文件体量 + 全盘 pagefile/commit”；`openMigrationReport` 仍独立处理

## 一、根因判断

这不是“客户端重装”或“改 asar”能解决的问题：

- DSH Host 的 V8 heap 由实际打开的会话内容驱动；`session.v4.jsonl.zstd` 压缩体量大时，解压后进入 heap 的字节远大于磁盘大小；
- 旧守卫的 `commitFreeMB` / `selfPrivateMB` 是 OS 层指标，可能直到 Host 已接近 OOM 才触发；
- 旧 pagefile 输出只有一个合计值，没有驱动盘维度；现场很容易被误读为“只查 C 盘”。

因此 v3.8.14 把可观测信号改成：

1. Host JS heap（`heapUsed` / `heap_size_limit`）；
2. Host 与所有任务 home 的 `session.v4.jsonl.zstd` 体量（合计 + 单文件 + top）；
3. 所有分页文件与所有卷的 pagefile/commit 明细。

## 二、代码证据

### Host JS heap

`src/lib/host-pressure.mjs`：

- `resolveHostHeapLimits()`：固定 1024/1536/2048 MB，并按 `heap_size_limit` 的 65%/80%/90% 收紧；
- `evaluateHostHeap()`：返回 `ok/warn/critical/emergency`，无 heap 指标时返回 `skipped:'no-heap-metric'`，不伪装健康。

`src/plugins/orchestrator.mjs`：

- `sampleHostHeap()` 读取 `process.memoryUsage()` + `v8.getHeapStatistics()`；
- `hostWatchdogTick` 在 `readSystemMemory()` 之前执行 heap 采样；
- `hostHeapPressureGate` 在 critical/emergency 时置位；
- `memoryGate` 和 `launchTaskBrowser` 首先调用 `currentPressureGate()`；
- emergency 连续计数达到 `hostJsHeapEmergencyStreak` 后走 `hostEmergency('host-js-heap-emergency')`。

### Session 体量

`src/lib/session-footprint.mjs`：

- `scanSessionFootprint(roots)` 对每个 home 调用既有 `listSessionLogs()`；
- `listSessionLogs()` 只匹配精确文件名 `session.v4.jsonl.zstd`，只 `stat`，不读内容；
- 返回 `bytes/files/largestBytes/largestFile/top` 与每个 root 的摘要。

`src/lib/host-pressure.mjs`：

- `evaluateSessionFootprint()` 分别判断合计与单文件；
- 单文件默认 16/32/48 MB；合计默认 512/1024/2048 MB；
- 只有单文件 emergency 置 `gate:true`；合计 emergency 置 `totalGate:true` 但只审计，避免很多小文件误封新任务；critical/warn 只审计。

`orchestrator`：

- `scanHostSessionFootprint()` 扫描 Host `$DSH_HOME` 与所有任务 `homeDir`；
- 60s 缓存；5s tick 不会重复扫目录；
- `sessionFootprintGate` 进入 `currentPressureGate()`；
- `host-js-heap-*` / `session-footprint-*` 写入 `audit.jsonl`；
- `lastHostMetrics` 带 `heapUsedMB`、`heapLevel`、`sessionFootprintMB`、`largestSessionMB`、`sessionPressure`、`pressureGate`；
- `host-crashes.jsonl` 新增 `hostJsHeapUsedMB`、`sessionFootprintMB`、`largestSessionMB`，用于下一次非正常退出复盘。

### pagefile/commit 全盘

`src/lib/memory-guard.mjs`：

- PowerShell 读取 `Win32_PageFileUsage`、`Win32_PageFileSetting`、`Win32_LogicalDisk` 和注册表 `PagingFiles`；
- `mapMemoryProbe()` 纯函数汇总每个活动分页文件；
- `pageFileMB` 是所有活动分页文件之和；
- `pageFileDrives` 覆盖活动 + 配置分页文件；
- `commitLimitDerivedMB = 物理内存 + 所有活动分页文件`；
- `commitLimitMB = max(OS, derived)`；当 derived 明显大于 OS 时标记 `commitLimitSource='physical-plus-all-pagefiles'`，不再可能只按 C 盘估算。

真机（TOFUTURE，2026-11-26）：

```text
CommitLimitOSMB=44821
CommitLimitDerivedMB=44821
CommitFreeMB=17311
PhysicalTotalMB=32476
PageFileMB=12345
PageFileUsageMB=58
PagingFiles=d:\pagefile.sys 12345 23456
PageFileDetails=[D:\pagefile.sys, alloc=12345, current=58, peak=69]
PageFileSettings=[d:\pagefile.sys, initial=12345, max=23456]
Volumes=C:203420/86559, D:716809/136221, E:1907712/618575
```

分页文件只在 D:，`pageFileOffSystemDrive=true`；这直接覆盖了“探针只看 C 盘”的现场问题。

## 三、现场 session 体量对照

2026-11-26 TOFUTURE：

- Host `%USERPROFILE%\.dsh\sessions`：206 个 `session.v4.jsonl.zstd`，合计 222.56 MB；
- 最大单文件 60.91 MB：`--E-DSH-DS--/session-ad7ddc1f-...`；
- 第二 40.30 MB、第三 25.01 MB；
- Fork home 另有一份 60.90 MB 副本（同一会话在不同 home）。

按 v3.8.14 默认单文件 48 MB 紧急线，该 Host 会在首次扫描后置 `sessionFootprintGate`，拒绝新分身/新浏览器；这是预期行为，不是 bug。必须先归档/压缩该会话（或把阈值调高后显式接受风险）。

## 四、测试

```text
test/v3814-host-guard.test.mjs
6 tests / 6 pass / 0 fail
```

覆盖：

1. heap 阈值按 V8 上限收紧；
2. heap 四级映射与缺失指标 skipped；
3. session 合计/单文件独立分级；
4. 临时 home 的 session 扫描（含 top/largest）；
5. C: + D: 双分页文件、全盘 commit 上限；
6. orchestrator/client/memory-guard 源码接线。

全量：`1585 tests / 1562 pass / 0 fail / 13 skipped / 10 todo`，`duration_ms=215773.20`（2026-11-26，Mac，`npm test`）。

## 五、未闭环 / 边界

- 未在真实 DSH 宿主内安装 v3.8.14 读取实时 `hostPressure`；本轮只验证纯逻辑、静态接线和 Windows PowerShell 真实探针。
- `hostEmergency('host-js-heap-emergency')` 只能关浏览器/停分身/隔离/Safe Mode；它不能强制 V8 GC，也不能压缩正在写的活动 session，不能承诺“绝不 OOM”。
- session 扫描覆盖所有任务 home，任务很多时仍有目录 stat 成本；60s 缓存是当前折中，尚未在 >1000 个 home 的现场压测。
- `openMigrationReport` 未改；它仍是独立客户端 API 问题。

## 六、发布门禁

- 本地源码、全量测试与打包完成：`dist/dsh-fang-3.8.14.tgz`，232 entries，949588 bytes，sha256 `8514ecb09a295ccd150e053ba2aeed15366cb75fed7ca0dc04ff7d60e2894757`；package smoke / crash-safety / allow-list / main-city gate 均 PASS。
- `manifest.json` 的 preflight 是 `skipped:true / green:false`，不能宣称门禁 GREEN。
- 未打 tag、未推送、未发布 npm。
- 真实 Windows DSH 宿主 E2E（heap 采样、session gate、pagefile 全盘显示）仍需安装后补跑。
