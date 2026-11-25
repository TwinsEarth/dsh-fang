# v3.8.13 发布记录

**日期**：2026-11-25  
**主题**：三条宿主红线收口 + 页面文件语义纠正  
**基线**：v3.8.12  
**发布状态**：源码构建完成；GitHub tag/Release 待执行；NPM 暂缓。

## 一、本版修复

### 1. maxForks 配置层硬拒 >1

- `Config.maxForks` 从 `max(64)` 收为 `max(HARD_MAX_FORKS)`，默认 1；`HARD_MAX_FORKS = 1`。
- `apply()` 对直接传入的 `{ maxForks: 8, allowMultiFork: true }` 也强制回落为 1；生产路径不再有“显式二次确认”旁路。
- 第二次 `createTask()` 返回 `quota-exceeded`，不会进入 spawn。
- `allowMultiFork` 仅保留兼容字段，不再改变上限。
- 旧测试的多任务记账通过 `NODE_TEST_CONTEXT` + `__testOnlyAllowMultiFork` 保留覆盖；生产进程不生效。

### 2. fork 总 Commit 的 4 GB 宿主余量

新增 `src/lib/commit-budget.mjs`：

- 有效上限 = `min(commitLimitMB × forkCommitShareLimit, commitLimitMB - forkCommitHostReserveMB)`。
- 默认 share 0.4、reserve 4096 MB；8 GB 宿主仍是 40% 先绑（约 3277 MB），32 GB 宿主也是 40% 先绑（约 13107 MB）；小于约 6.8 GB 的宿主由 4 GB 余量先绑。
- `fork.txt`/browser 进程树的聚合 Commit 走同一纯函数，避免 5s 门与 15s 看门狗各算一套。
- spawn 前 `create-fork` fail-closed；宿主 5s tick 与 memory watchdog 都执行；超过有效上限触发 `hostEmergency('fork-commit-share')`。
- 状态 `lastHostMetrics` 增加 `forkCommitLimitMB`、`forkCommitHostReserveMB`、`forkCommitReserveLimitMB`、`forkCommitShareLimitMB`。

### 3. sidecar spawn 当刻登记 PID

- `createTask`、`restoreTask`、`autostartForks` 三处 spawn 成功后立即写 `pidStartedAt = nowMs()`、`pidStartedAtSource = 'spawn-provisional'`。
- CIM `CreationDate` 捕获成功后再覆盖为精确值，`source='cim'`，并保留 `provisionalStartedAt` 供审计。
- CIM 失败/超时不再把 `pidStartedAt` 清空；sidecar 在 spawn 当刻就能用“进程启动时间晚于任务创建时间”的窗口识别 PID 复用。
- autostart 路径补 `writeWatchdog()`，避免只 persist 不刷新 watchdog。

### 4. 页面文件语义纠正（用户明确要求）

- **不再因为“没有 pagefile”强制 Safe Mode 或拒绝第一个分身。** v3.8.4 的硬门禁在 v3.8.13 改为 advisory。
- 启动策略看可用内存：`decidePagefileBootPolicy()` 返回 `safeMode:false`，仅标记 `pagefile-missing-advisory` / `pagefile-missing-low-free`；UI 提示“建议设置页面文件”，不阻止解除或启动。
- `evaluateSafeModeReset()` 不再要求 pagefile；Safe Mode 解除只看 `CommitFree >= hostCriticalFreeMB` 与内存探测是否可用。
- `evaluatePagefileSingleFork()` 改为 advisory，不再以 pagefile 缺失拒绝第二个；真正的单分身由 `maxForks=1` 负责。
- `memoryMinFreeMB` 默认从 6144 下调为 3000，按用户给定的“空闲 >3000 MB”口径。
- 客户端 Safe Mode 弹窗：页面文件缺失从红色“不能解除”改为黄色提示；复选框可勾选，确认按钮不再因 pagefile 单独禁用。

## 二、验证

- 新增 `test/commit-budget-v3813.test.mjs`：7/7。
- `orchestrator` 74/74。
- `v388-redlines` 10/10。
- `v385-closures + memory-watch-sampling + job-object` 12/12。
- `pagefile-safety + v387-crash-prevention + v386-crash-closures + client-safe-mode` 全部通过。
- 全量：1579 tests / 1556 pass / 0 fail / 13 skipped / 10 todo。

## 三、构建与发布门禁

- `dist/dsh-fang-3.8.13.tgz` 由 `node tools/release/build.mjs --skip-preflight` 生成。
- `dist/manifest.json` 的 `preflight` 记录为 `{ green:false, skipped:true, reason:'--skip-preflight' }`，**不是 GREEN**。
- 当前没有可用的 Windows 真机 preflight/e2e；Release 文案不得写“发布门禁通过”。

## 四、未闭环 / 边界（必须如实保留）

1. **真实 Windows DSH 宿主 E2E 未跑**：健康预检、单 app 窗口、崩溃闩锁目前只有单测/静态覆盖，尚未做真机端到端。
2. **`native/win32/fang-job-host.exe` / `fang-job-host-arm64.exe` 仍是旧二进制**：C 源码已含 `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`，但本机 macOS 无 MinGW/Windows SDK；Job 内存上限需 Windows CI/真机重编后才生效。当前 browser/fork 的 kill-on-close 仍依赖旧 helper。
3. browser Job Object 没有 Windows 真机启动测试；只有 helper 缺失 fail-closed 与静态/纯函数测试。
4. `lastHostMetrics` 最多滞后 15 秒；硬杀时 JSONL 记录最后一次 heartbeat 快照，不是精确死亡瞬间。
5. `host-crashes.json` 只保留 10 分钟；更早历史只在 JSONL。
6. `allTasks` 跳过 `ARCHIVED`；归档任务不会被重新标记。
7. `allowMultiFork=true` 已不再生效；没有 UI/HTTP confirm 参数，也不需要。
8. 进程优先级仍主要写 `BelowNormal`，`Idle` 未作为可配置档位落地。

## 五、升级说明

- 从 v3.8.12 升级不需要迁移数据根。
- 若此前因为“无 pagefile”被 Safe Mode 拦住，升级后不会再因该条件阻止启动；仍建议设置页面文件，避免 Commit 峰值时系统级失败。
- 单分身是硬上限；请归档旧任务后再创建下一个。


## 六、版本提交（本地重建）

仓库是 shallow clone，v3.8.5–v3.8.12 没有各自 commit；本次按版本 tarball 重建了每版源码 tag，并让它们全部位于 `main` 线性祖先链上。v3.8.5–v3.8.12 的 tag 是 npm 发布包源码快照（不含 `test/`、`.github/` 与 release tooling），v3.8.13 是完整开发树。

| tag | commit | 源码口径 |
|---|---|---|
| v3.8.5 | `0564668` | `dsh-fang-3.8.5.tgz` 快照 |
| v3.8.6 | `f3dd22d` | `dsh-fang-3.8.6.tgz` 快照 |
| v3.8.7 | `d1c4298` | `dsh-fang-3.8.7.tgz` 快照 |
| v3.8.8 | `4ba9356` | `dsh-fang-3.8.8.tgz` 快照 |
| v3.8.9 | `bdd6a93` | `dsh-fang-3.8.9.tgz` 快照 |
| v3.8.10 | `640ec6f` | `dsh-fang-3.8.10.tgz` 快照 |
| v3.8.11 | `58b7c9a` | `dsh-fang-3.8.11.tgz` 快照 |
| v3.8.12 | `0f46989` | `dsh-fang-3.8.12.tgz` 快照 |
| v3.8.13 | `ee51ef8` | 完整开发树（806 files） |

每个 tag 对应唯一 commit，不再使用“九个 tag 指向同一个汇总提交”的方案。
