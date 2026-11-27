# v3.8.6 发布记录（分身 Web 端防崩溃 8 项）

> 基线 v3.8.5。本版按用户最新 8 项措施表补齐代码；已有能力不重复算成“新做”，未验证项不写成“已完成”。

## 本版逐项

| # | 措施 | 实现 | 验证 |
|---|---|---|---|
| 1 | 启动前 CommitFree 检查 | `memoryMinFreeMB=6144`（6GB）；`hostWarnFreeMB=8192`、`hostCriticalFreeMB=4096`、`hostEmergencyFreeMB=2048`。本项为已有能力，本轮只核对 | `test/memory-guard.test.mjs`、`test/pagefile-safety.test.mjs` |
| 2 | 无 pagefile 检测 + 单分身 | `PagingFiles` / `AutomaticManagedPagefile` 证据；`pagingFilesEmpty`、`commitLimitNearRam`、`pagefileMissing`；`evaluatePagefileSingleFork()`；`memoryGate` 拒绝第二个 | `test/v386-crash-closures.test.mjs`；旧 `test/pagefile-safety.test.mjs` |
| 3 | 分身健康检查 | `fork-health.mjs`：流式 zstd 事件计数、session 大小/事件预算、adapter 状态、HTTP health 探测；`launchTaskBrowser()` 新开前预检，失败不打开；`GET /fang/api/health` | `test/v386-crash-closures.test.mjs` 7 项 |
| 4 | 浏览器崩溃日志 | `--enable-logging --log-file --enable-crash-reporter --crash-dumps-dir`；`launchManagedBrowser onExit`；exit 归一化 | `test/browser-guard.test.mjs`、`v386` |
| 5 | 崩溃退避 | `evaluateCrashLoop()` 10 分钟/2 次；forker 写 `quarantined={reason:'crash-loop'}`，不进自动重开；手动 restore 清隔离并重置 `crashTimes` | `test/v386-crash-closures.test.mjs`、`test/forker.test.mjs` |
| 6 | 浏览器单 app 窗口 | `selectExtraPageTargets()` / `enforceSinglePageTarget()`；启动后立即执行，watchdog 每轮再执行；关闭数量写审计 | `test/v386-crash-closures.test.mjs` |
| 7 | 自动保存后重启 | 沿用 `forkFlushPath=/fang/adapter/flush-session`、`gracefulBrowserCloseMs=3000`；flush 后 3s 强杀；本项为已有能力，本轮只核对 | `test/browser-guard.test.mjs`、`test/orchestrator.test.mjs` |
| 8 | 崩溃根因记录 | `recordBrowserExit()`：exit code/hex/kind/oom/signal/source/intentional、最后 CDP、PID 树；写 `browser-events.jsonl`，非主动退出另写 `memory-samples.jsonl`；`0xE0000008` 记 OOM | `test/v386-crash-closures.test.mjs`、`test/browser-guard.test.mjs` |

## 门禁

| 项 | 结果 |
|---|---|
| 版本一致 | `package.json` / `package-lock.json` / `FANG_VERSION` / README / CHANGELOG 均为 3.8.6 |
| 新增闭环测试 | `test/v386-crash-closures.test.mjs`：**7 pass / 0 fail** |
| 相关旧测试 | `pagefile-safety` / `browser-guard` / `memory-guard` / `forker` / `client-pagefile-banner`：**56 pass / 0 fail** |
| orchestrator | `test/orchestrator.test.mjs`：**74 pass / 0 fail** |
| 全量测试（Mac） | **1517 tests / 1494 pass / 0 fail / 13 skipped / 10 todo**；183,933 ms；`node --test --test-concurrency=1 "test/*.test.mjs"` |
| 文档审计门禁 | `docs/RELEASE-v3.8.6.md` / `docs/AUDIT-v3.8.6.md` 已入索引 |

## 产物

- tarball：`dist/dsh-fang-3.8.6.tgz`，880,584 bytes，226 entries
- SHA-256：`55f5b73c5866ea3c201e0c48584f2ef13c5170feccf9a6314487a2f441af0528`
- 构建：`node tools/release/build.mjs --skip-preflight`；package smoke / crash-safety / allow-list / main-city package gate 均 PASS。
- 完整 preflight（带 e2e）未 GREEN：本机 macOS 没有真实 DSH 母体，`--e2e` 返回 `-1/-1`；`--skip-preflight` 构建的 `dist/manifest.json` 仍带着旧 preflight（3.8.5、`pass=-1 fail=-1`），发布前需 Windows 自托管环境重跑 preflight 生成 GREEN manifest。
- 未 publish / 未 tag / 未创建 GitHub Release；发布动作需用户明确确认。

## 明确未闭环

1. **无 pagefile 与 Safe Mode 的语义差异**：启动预检仍沿用 v3.8.4 的 Safe Mode 硬门禁。Safe Mode 会阻止所有创建/打开/自动恢复，所以单分身 gate 在 Safe Mode 下不会实际放行第一个；“允许一个、禁止第二个”没有在无 pagefile 真机上端到端验证。
2. 分身健康预检、单 app 窗口、10 分钟崩溃闩锁、`/fang/api/health` 根别名均只有纯函数/单测覆盖，未在真实 Windows DSH 宿主做端到端验证。
3. 官方 DSH Web client 的 session 事件全量渲染未改；4 万条 session 的 renderer 内存根因仍在。
4. `native/win32/fang-job-host*.exe` 仍是旧二进制；Job Object 内存上限需 Windows CI/真机 rebuild 后生效。

## 结论

v3.8.6 把 8 项措施中能落代码的检测、gate、日志、退避、单窗口、根因落盘补齐；但不把“无 pagefile 允许一个分身”说成已在真机闭环，也不把官方 Web client 的 session 内存根因说成已解决。
