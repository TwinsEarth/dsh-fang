# v3.8.7 审计（2026-11-25）

对象：`fang-dsh-plugin` v3.8.7（在 v3.8.6 基础上按用户纠偏收口）。
结论：**P0/P1 中可落代码的子集已闭环到源码与单测；真实 Windows DSH 宿主的 flush 落盘、health 采样与 preflight 未闭环。**

## 逐项证据

| 项 | 实现 | 测试/证据 | 结论 |
|---|---|---|---|
| 健康检查阈值 | `Config.forkHealthMaxSessionMB=20`、`forkHealthMaxEvents=20000`；`FORK_HEALTH_DEFAULTS` 同步；本地与远端 health 都检查 `largestBytes`、`events`、`truncated` | `test/v387-crash-prevention.test.mjs` 默认与远端阈值用例；`test/v386-crash-closures.test.mjs` | 通过 |
| 端口响应时间 | `fetchJson()` 计算 `latencyMs`；`probeForkHealth` 透传；`browser-health.jsonl` 记录 | v3.8.7 测试起本地 HTTP 服务断言 `typeof latencyMs === 'number'` | 通过 |
| `browser-health.jsonl` | `inspectTaskOpenHealth()` 在 gate 后追加记录；含 session/http/adapter/flush | 源码断言 + 真实 probe 测试 | 通过（文件写入路径未在真实 Windows 宿主采样） |
| pagefile 字段 | `/fang/api/status` 顶层 `pageFileMB/hasPageFile`；`pagefilePolicy` 同步 | `test/v387-crash-prevention.test.mjs` 源码断言；`test/memory-policy-wiring.test.mjs` | 通过 |
| 红色 banner | `client.js` 标题“未启用页面文件，已强制单分身”，正文“最多只保留 1 个活跃分身” | `test/client-pagefile-banner.test.mjs` | 通过 |
| 无 pagefile 单活跃 | `decidePagefileBootPolicy()`：缺失 + Commit 正常 → `safeMode:false, singleForkOnly:true`；缺失 + Commit 低于 `hostCriticalFreeMB` → Safe Mode | v3.8.7 纯函数测试；pagefile 安全测试 68/68 | 通过（Commit 低时的 Safe Mode 是安全兜底，非全停正常态） |
| `maxOpenForkBrowsers` 硬限 | `pagefileMissing || hasPageFile===false` → `max=1` | 源码断言 | 通过 |
| flush 真实 API | 已核实 `src/plugins/adapter.mjs` `flushSessions()` 调用宿主内 `ctx.sessions.flush`；路由 `POST /fang/adapter/flush-session`；`ADAPTER_ROUTE.FLUSH_SESSION` 真实存在。v3.8.7 `flushForkSession()` 不再写死 5s，改为 3s 总预算实测候选路径，全部未命中返回 `flush-unsupported` | `test/adapter.test.mjs` 已有 flush 路由用例；`test/v387-crash-prevention.test.mjs` 静态断言；`test/fork-flush.test.mjs` | 通过（单测层；真机 3s 端到端未跑） |
| 浏览器崩溃 | `recordBrowserExit()` 记录 `rawCode/unsignedCode/hex/signal/at/kind/oom/lastMetrics/pids`；写 `browser-crashes.jsonl`；`evaluateCrashLoop()` 10min/2 次 → `browser-crash-loop` | v3.8.7 测试；v3.8.6 exit 分类/闩锁测试 | 通过 |
| 单标签 | 启动 + watchdog 调用 `enforceSinglePageTarget(...,{maxPages:1})`；无 pagefile 时强制 | `test/v386-crash-closures.test.mjs` | 通过 |
| 关闭原因 | `classifyCloseReason()` 归一 6 类；`closeReason` / `browserClosed.reasonKind` / `memoryGuard.reasonKind` | v3.8.7 测试 | 通过 |
| 下次打开显示上次崩溃 | `task.browserCrash` 持久化；卡片与摘要卡展示 | v3.8.7 源码/UI 断言 | 通过（真机视觉未验收） |

## 失败与修复记录

- 初次全量：1526 tests / 1501 pass / **2 fail**。
  - `main-gate: real source tree` 因 `docs/CHANGELOG.md` 缺 v3.8.7 section、`docs/AUDIT-v3.8.7.md` 缺文件。
  - `memory-policy-wiring` 的源码正则要求 `memory: memorySnapshot,\n        memoryPolicy` 紧邻；新增 `pageFileMB` 后失配。
- 修复：补 `docs/CHANGELOG.md` v3.8.7、`docs/RELEASE-v3.8.7.md`、`docs/AUDIT-v3.8.7.md`；放宽该正则允许 `pageFileMB` 插在两者之间；README 版本断言更新到 3.8.7。
- 最终全量：**1526 tests / 1503 pass / 0 fail / 13 skipped / 10 todo**（183,186ms）。

## 构建审计

- tarball：`dist/dsh-fang-3.8.7.tgz`，883,961 bytes，227 entries；SHA-256 `4977ca366313902cdb93d84df015b104486b81145a6cb7f861f60efe873357db`
- build smoke `package / crash-safety / allow-list / main-city gate` 全 PASS；`--skip-preflight`
- `dist/manifest.json` preflight 仍为旧 3.8.5 红（`pass=-1 fail=-1`，e2e `-1/-1`），不据此宣称发布门禁通过

## 审计边界

- `browser-health.jsonl` / `browser-crashes.jsonl` 只在真实打开/崩溃路径写入；本次 macOS 环境无 Windows 托管浏览器，未做端到端文件落盘采样。
- flush 的“真实 API”已核实到代码和路由层，但未在 Windows 真机调用 `ctx.sessions.flush` 验证磁盘 checkpoint。
- `dist/manifest.json` 仍是 preflight 红，`--skip-preflight` 构建不代表发布门禁通过。
- 未 commit/push/tag/publish；本地 DSH 安装未升级。
