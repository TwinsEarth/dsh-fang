# v3.8.5 发布记录（闭环子集）

> 基线 v3.8.4。本版只做可验证的闭环子集，不把 v3.8.0 的十项审计表说成“全部做完”。

## 本版闭环

| 项 | 实现 | 验证 |
|---|---|---|
| CDP 精确采样 | 默认 `browserCdpSampleIntervalMs=15000`；已有 `Performance.getMetrics` / `Memory.getDOMCounters` / `Runtime.getHeapUsage`；`browserHeapLimitMB=1536` 超限走 `quarantineTask` | `test/v385-closures.test.mjs`、`test/memory-watch-sampling.test.mjs` |
| 母体面板懒渲染 | 只对 `S.activeTaskId` 渲染完整卡；其他任务只渲染标题/状态摘要；切换才 `loadForkSessions(active)`，不再对所有任务 N+1 预热 | `test/client-layout-dom.test.mjs` 新增用例 |
| 统一缓存上限 | 任务 200、母体会话 200、fork session 缓存 16 个任务/每任务 80 条、日志 64KB；归档/永久删除立即 `releaseTaskCache()` | `test/v385-closures.test.mjs` |
| 隐藏暂停实验开关 | `pauseHiddenTab=false` 默认关闭；开启时 hidden→`Page.setWebLifecycleState=frozen`，visible→`active`，失败冷却 60s 重试 | `test/v385-closures.test.mjs`；真机恢复可见仍待验证 |
| Job Object 内存兜底 | helper 新增 `--job-process-memory-mb` / `--job-memory-mb`，设 `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`；forker 默认 2048MB/4096MB | `test/v385-closures.test.mjs` + `test/job-object*.test.mjs` |

## 门禁

| 项 | 结果 |
|---|---|
| 版本一致 | `package.json` / `package-lock.json` / `FANG_VERSION` / README / CHANGELOG 均为 3.8.5 |
| 新增闭环测试 | `test/v385-closures.test.mjs`：**13 pass / 0 fail** |
| 客户端 DOM | `client-layout-dom` + `client-inbox-dom`：**24 pass / 0 fail**（含新增懒渲染 + 200 行缓存上限用例） |
| 全量测试（Mac） | **1510 tests / 1487 pass / 0 fail / 13 skipped / 10 todo**；耗时 183,496 ms；`node --test --test-concurrency=1 "test/*.test.mjs"`，不带 `--test-force-exit` |
| 文档审计门禁 | main-gate A 级通过；`docs/RELEASE-v3.8.5.md` / `docs/AUDIT-v3.8.5.md` 已入索引 |

## 产物

- tarball：`dist/dsh-fang-3.8.5.tgz`，871,481 bytes，225 entries
- SHA-256：`cd812208b1a88bcb52f9db485527845199dd47f03032684b867f8dc8a2f8058f`
- 构建：`node tools/release/build.mjs --skip-preflight`；package smoke / crash-safety / allow-list / main-city package gate 均 PASS。
- 完整 preflight（带 e2e）未 GREEN：本机 macOS 没有真实 DSH 母体，`--e2e` 返回 `-1/-1`；这不是本版代码失败，但发布流水线仍需 Windows 自托管环境复跑。
- 未 publish / 未 tag / 未创建 GitHub Release。

## 明确未闭环

1. **官方 DSH Web client 的 session 事件内存本身**没有改：`session-bridge` 只有 `limit`，不能替代官方客户端的分页/懒加载；4 万条 session 页面仍可能把 renderer 撑爆。Fang 现在能在爆之前监控/关闭/隔离，但没有消除根因。
2. 第 6 项隐藏暂停只做了实验开关，未在真实 Windows Edge/Chrome + DSH fork 页面完成“隐藏→恢复可见→可输入”的真机验证，因此没有默认开启。
3. Job Object 的 C 源码与参数已改，但本机是 macOS，没有 MinGW/Windows SDK，不能重编译 `native/win32/fang-job-host*.exe`。现有 exe 仍是旧二进制；需在 Windows CI 或 Windows 真机执行 `build` 后，内存上限才真正生效。
4. 第 5 项“session 事件限流/懒加载”仍只有后端 `limit` 与母体面板懒渲染，不等同于官方 DSH Web client 的 session 分页。
5. `/fang/api/panic` 路由、`maxForks` 仍为 8、母体 RSS/Private 连续采样不在本版范围。
6. **真实 Windows DSH 宿主的 `/fang/adapter/flush-session` 3s 端到端落盘、`browser-health.jsonl` 真机采样未执行**：目前只有单测/静态门禁，仍需在 Windows 自托管环境运行 `preflight` / `e2e`。
7. **无 pagefile 且 Commit 低于 `hostCriticalFreeMB` 时仍进入 Safe Mode**：这是避免第一个分身把 Commit 打爆的安全兜底，不视为本版回归，也不放宽。
8. **`dist/manifest.json` 的 `preflight` 仍是旧 3.8.5 红色结果（`pass=-1` / `fail=-1`）**：本次构建使用 `--skip-preflight`，不能据此宣称发布门禁通过；Release 文案不得写“preflight GREEN”。

## 结论

v3.8.5 能闭环的是“Fang 自己可控的监控、懒渲染、缓存、实验开关、Job Object 参数/源码”。不能把这张表说成十项全做完；最大内存根因仍在官方 Web client 的 session 事件。
