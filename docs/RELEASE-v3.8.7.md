# v3.8.7 发布记录（防止分身 Web 端崩溃：P0/P1 收口）

日期：2026-11-25
基线：v3.8.6
工作副本：`/Users/fang/Doubao/chats/2026-11-24/new-chat-7/fang-dsh-plugin`
状态：**源码与测试完成；未 commit / push / tag / publish。** 本地 DSH 安装仍为 3.8.2。

## 版本一致

| 项 | 值 |
|---|---|
| `package.json` / `package-lock.json` | 3.8.7 |
| `src/kernel/types.mjs` `FANG_VERSION` | 3.8.7 |
| README / CHANGELOG / RELEASES | 已更新到 3.8.7 |
| 发布记录 / 审计 | `docs/RELEASE-v3.8.7.md` / `docs/AUDIT-v3.8.7.md` |

## P0 闭环

| # | 要求 | 实际落点 | 证据 |
|---|---|---|---|
| 1 | 打开前请求 fork `/api/health`，检查 adapter、session 事件数/文件大小、端口响应时间 | `inspectTaskOpenHealth()` + `probeForkHealth()`；阈值 20MB / 20000 事件；`http.latencyMs` 入 `browser-health.jsonl` | `test/v387-crash-prevention.test.mjs`；`forkOpenHealth` 拒绝审计 |
| 2 | `/fang/api/status` 返回 `pageFileMB/hasPageFile`；前端红色 banner；`hasPageFile=false` 硬限 1 | `status` 顶层与 `pagefilePolicy` 字段；`launchTaskBrowser()` 使用 `pagefileMissing || hasPageFile===false` 将 `maxOpenForkBrowsers` 硬限为 1；banner 文案“未启用页面文件，已强制单分身” | `test/client-pagefile-banner.test.mjs`、`test/v387-crash-prevention.test.mjs` |
| 3 | exit code/OOM 写 `browser-crashes.jsonl`；同 task 10 分钟 2 次隔离 | `recordBrowserExit()` 保留 `rawCode/unsignedCode/signal/at/kind/oom/lastMetrics/pids`；`evaluateCrashLoop()` 使用 `browserCrashWindowMs=600000`、`browserCrashThreshold=2`；命中写 `quarantined.reason='browser-crash-loop'` | `test/v387-crash-prevention.test.mjs` |
| 4 | 单 app 标签强制 | 启动后 + watchdog 调用 `enforceSinglePageTarget(port,{maxPages:1})`；无 pagefile 时即使 `browserSingleAppWindow=false` 也执行 | `test/v386-crash-closures.test.mjs`；`test/v387-crash-prevention.test.mjs` |
| 5 | flush 先核实真实 API，3s 等待，无端点不得假装保存 | `flushForkSession()` 在 3s 总预算内调用配置路径、健康通告路径、`/<prefix>/adapter/flush-session` 与常见别名；仅 `saved:true` 成功；全部 404/405/超时 → `flush-unsupported` + “未保存强杀”警告 | `test/v387-crash-prevention.test.mjs`；`src/plugins/adapter.mjs` 真实 `POST /fang/adapter/flush-session` → `ctx.sessions.flush` |

## P1

| # | 要求 | 实际落点 |
|---|---|---|
| 1 | 健康检查写 `browser-health.jsonl` | `inspectTaskOpenHealth()` 每次写入，含 session/http/adapter/flush 与 `latencyMs` |
| 2 | 崩溃后下次打开显示“上次崩溃于 OOM/exit code” | `task.browserCrash` 持久化；任务卡与摘要卡显示 `上次崩溃于 OOM` / `上次崩溃于 exit 0x…` |
| 3 | 关闭原因分类 | `src/lib/browser-close-reason.mjs` 归一为 `user / idle / browser-oom / dom-limit / host-panic / crash-loop`；`closeReason`、`browserClosed.reasonKind`、`memoryGuard.reasonKind` |

## 测试

```bash
node --test test/v387-crash-prevention.test.mjs
node --test test/v386-crash-closures.test.mjs test/pagefile-safety.test.mjs \
  test/browser-guard.test.mjs test/memory-guard.test.mjs test/forker.test.mjs \
  test/client-pagefile-banner.test.mjs test/fork-flush.test.mjs
node --test test/orchestrator.test.mjs
npm test
```

定向结果：v3.8.7 新测 9/9、v3.8.6+页面文件/浏览器/内存/forker/banner/flush 68/68、orchestrator 74/74。
全量结果：**1526 tests / 1503 pass / 0 fail / 13 skipped / 10 todo**（183,186ms）。

## 构建

- `dist/dsh-fang-3.8.7.tgz`：883,961 bytes，227 entries
- `dist/dsh-fang-3.8.7.tgz.sha256`：`4977ca366313902cdb93d84df015b104486b81145a6cb7f861f60efe873357db`
- `dist/manifest.json`：version 3.8.7；preflight 仍为旧 3.8.5 红色结果（`pass=-1 fail=-1`，e2e `-1/-1`），因本机 macOS 无真实 DSH 母体，构建使用 `--skip-preflight`

## 已知边界

- 缺失 pagefile 且 Commit 低于 `hostCriticalFreeMB` 时仍进入 Safe Mode（安全兜底，避免第一个分身打爆 Commit）；正常 Commit 下为“允许 1 个、拒绝第 2 个”。
- 真实 Windows DSH 宿主的 `/fang/adapter/flush-session` 3s 端到端落盘、`browser-health.jsonl` 真机采样仍需自托管 preflight/e2e。
- 官方 DSH Web client 的 session 全量渲染根因未改；`fang-job-host*.exe` 仍是旧二进制。
- `dist/manifest.json` 的 preflight 仍为红（本机 macOS 无真实 DSH 母体）；发布前需 Windows 自托管环境重跑。
