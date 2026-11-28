# Fang v3.10.1 — 客户端加载与浏览器回收版

版本：`@twinsearth/fang-dsh-plugin@3.10.1`
日期：2026-11-29

## 主题

把分身页面的首屏负担和浏览器资源回收拆开处理：Fang 派生时写入 DSH 分阶段加载配置，托管浏览器改为每页独立 renderer，最后一个页面关闭后回收整棵浏览器树；同时把分身 Job 单进程和浏览器 Job 总上限调整到 3000 MB / 6666 MB。

## 改动

- **客户端分阶段加载**：`forker.mjs` 新增 `STAGED_LOADING_BUNDLES`、`buildStagedLoadingConfig()` 与 `applyForkStagedLoadingSurface()`。派生 fork 后按 30s / 60s / 100s 三阶段写入 profile 的 `modules.stagedLoading`，只纳入声明 `dsh.client.platform === 'web'` 的客户端包，过滤纯服务端行；同时生成 `@twinsearth` / `@deepseek-ai` 双 scope 变体。
- **Job 内存阈值**：分身 Job 单进程 `jobProcessMemoryMB` 默认 `2048 → 3000`；浏览器 Job 总上限 `browserJobTotalMemoryMB` 默认 `2048 → 6666`。浏览器单进程 `browserJobProcessMemoryMB=2048` 与分身 Job 总上限 `jobTotalMemoryMB=4096` 保持不变。
- **每页独立 renderer**：`browser-guard.mjs` 删除 `--renderer-process-limit=1`，新增 `--process-per-tab` 与 `--disable-background-mode`；启动参数抽成 `buildManagedBrowserArgs()` 以便单测。
- **页关闭回收**：orchestrator watchdog 在 page target 数连续 5 秒为 0 时调用 `closeTaskBrowser(task, 'page-closed')`，由 Job Object 回收整棵树。CDP 不可用时返回 `browser-cdp-unavailable`，不会把采样失败误判为“0 页”。
- **关闭原因语义修复**：区分 `host-memory` / `host-panic` / `browser-oom` / `browser-heap` / `dom-limit` / `capacity` / `idle`，任务卡不再把所有关闭折叠成“内存保护关闭”。
- **进程表解析修复**：PowerShell 在 JSON 前输出 warning 时，`memory-guard` 能正确解析数组或对象，不再把进程表误判为不可用。

## 兼容性与边界

- 分阶段加载写入的是 profile 配置；当前运行态 DSH 侧 `@twinsearth/dsh-client-modules` 若仍是 3.5.0 原版，不认识 `stagedLoading`，配置不会生效。需要 DSH 侧同步升级后才能看到实际分阶段加载。
- 当前真实 fork profile 的 `@deepseek-ai` / `@twinsearth` scope 解析与 im2a / w2m engines 兼容问题仍是独立阻塞项，本版不修复；本版不把“配置已写入”表述为“真实分身已分阶段加载”。
- `browserSingleAppWindow` 仍默认单页；额外页面继续由 `enforceSinglePageTarget` 关闭并回收。若需要多页面并行常驻，需要另行调整该策略。
- headless Edge 的内部页面、跨站子帧仍可能产生额外 renderer，这是 site isolation 的正常结果，不是旧的单 renderer 上限。
- 本版不改变 npm 包名、安装入口、DSH 插件契约或公开 API。

## 验证

- 全量测试：pass=1587 / fail=0 / skip=13。
- e2e：125/125。
- 路由契约：129；插件行数：16。
- `node tools/release/build.mjs`：preflight GREEN，package smoke、crash-safety、allow-list、main-city 全部 PASS。
- 分阶段加载专项：Fang `test/staged-loading.test.mjs` 1 pass；DSH client modules 226 pass、web boot 11 pass。
- renderer/回收专项：`test/browser-renderer-policy.test.mjs` 与相关回归 23 pass / 0 fail；真实托管 Edge 命令行确认包含 `--process-per-tab`、不包含 `--renderer-process-limit=1`。
- 内存阈值专项：相关回归 27 pass / 0 fail；解析默认配置实测 `forkProcess=3000`、`browserTotal=6666`。

细节见 `AUDIT-v3.10.1.md`。产物 `dist/dsh-fang-3.10.1.tgz`，SHA-256 见同目录 `.sha256` 与交付目录 `SHA256SUMS-3.10.1.txt`。

## 资产

- npm：`@twinsearth/fang-dsh-plugin@3.10.1`
  https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.10.1
- GitHub Release：`v3.10.1`
  https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.10.1
- GitHub Package：`@twinsearth/fang-dsh-plugin@3.10.1`（`https://npm.pkg.github.com`）
- 交付目录：`Fang-v3.10.1/`
- tarball：`dsh-fang-3.10.1.tgz`；SHA-256 见交付目录 `SHA256SUMS-3.10.1.txt`
