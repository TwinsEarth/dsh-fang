# Fang v3.10.1 审计记录

日期：2026-11-29
基线：v3.10.0
范围：客户端分阶段加载注入、Job 内存阈值、每页独立 renderer 与页关闭回收、关闭原因分类与进程表解析修复。

## 1. 现场

- 源码基线：`v3.10.0` 发布树；本轮在 `release/v3.10.1` 分支收口。
- 当前工作树同时包含 `client.js`、`browser-close-reason.mjs`、`memory-guard.mjs` 及其回归修改；这些是本轮发布前已有的行为修复，纳入本版。
- `docs/RELEASE-v3.9.2.md` 的历史发布记录修改与未跟踪 `archive/` 不纳入本版提交，避免把旧版发布噪声混入 v3.10.1。

## 2. 改动

### 2.1 客户端分阶段加载

- `forker.mjs` 新增 `STAGED_LOADING_BUNDLES`：30 秒为 Fang 内置插件，60 秒为官方实验插件，100 秒为第三方插件。
- `buildStagedLoadingConfig()` 从每个 bundle 的 `cordis.patch.yml` 读取包名，并只保留声明 `dsh.client.platform === 'web'` 的客户端包；服务端行与子路径行不进入配置。
- 同时生成 `@twinsearth` / `@deepseek-ai` 双 scope 变体，匹配 stock 与 accelerated 安装。
- `applyForkStagedLoadingSurface()` 把阶段写入 profile `cordis.patch.yml` 的 `modules.stagedLoading`；已有 `modules` 配置的 `keep` 等字段保留，不覆盖。
- 调用点放在实验性 surface 之后，避免实验性 patch 重写时丢掉 `modules` 配置。
- 当前 fork profile dry-run 分组：30 秒 12 个包名、去重后 6 个客户端包；60 秒 16 个包名、去重后 8 个；100 秒 14 个包名、去重后 10 个。

### 2.2 Job 内存阈值

- `forker.mjs`：`jobProcessMemoryMB` 默认 `2048 → 3000`，schema 与运行时 fallback 同步。
- `orchestrator.mjs`：`browserJobTotalMemoryMB` 默认 `2048 → 6666`，schema 与浏览器 Job 参数同步。
- 保持不变：`browserJobProcessMemoryMB=2048`、`jobTotalMemoryMB=4096`。

### 2.3 每页独立 renderer 与页关闭回收

- `browser-guard.mjs` 删除 `--renderer-process-limit=1`。
- 新增 `--process-per-tab`，顶层页面不再共用一个 renderer。
- 新增 `--disable-background-mode`；浏览器不再因后台模式常驻。
- 抽出 `buildManagedBrowserArgs()`，启动参数可单测。
- orchestrator watchdog 增加 `BROWSER_PAGE_RECLAIM_GRACE_MS = 5000`：页面 target 数连续 5 秒为 0 时调用 `closeTaskBrowser(task, 'page-closed')`，由 Job Object 回收整棵树。
- `cdpTargets()` 在 CDP 不可用时返回 `null`；`enforceSinglePageTarget()` 返回 `{ ok:false, error:'browser-cdp-unavailable', count:null }`，避免采样失败被误判为“0 页”而误杀浏览器。
- 单页模式保留：额外页面仍由 `enforceSinglePageTarget` 关闭；`browserSingleAppWindow=false` 时只统计页面数，不主动关闭额外页面。

### 2.4 关闭原因与进程表解析

- `browser-close-reason.mjs` 新增 `host-memory`、`browser-heap` 分类；`host-commit-low-*` 不再被 `memory-limit` 误归为 `browser-oom`。
- `client.js` 按原始 taxonomy 展示关闭原因，任务卡不再把所有关闭折叠成“内存保护关闭”。
- `memory-guard.mjs` 的 `parsePowerShellJson()` 同时尝试数组与对象形状；PowerShell warning 出现在 JSON 前时不再导致 `process-table-parse-failed`。

## 3. 验证

- 全量测试：pass=1587 / fail=0 / skip=13。
- e2e：125/125。
- 路由契约：129；插件行数：16。
- 构建：`node tools/release/build.mjs`，preflight GREEN；tarball `dsh-fang-3.10.1.tgz` 的 bytes、entries 与 SHA-256 见 `dist/manifest.json`、`dist/dsh-fang-3.10.1.tgz.sha256`。
- 分阶段加载：Fang `test/staged-loading.test.mjs` 1 pass；DSH client modules 226 pass；web boot 11 pass；`tsc` 通过。
- 内存阈值：相关回归 27 pass / 0 fail；解析默认配置实测 `forkProcess=3000`、`browserTotal=6666`。
- renderer/回收：相关回归 23 pass / 0 fail；真实托管 Edge 命令行确认 `--process-per-tab` 存在、`--renderer-process-limit=1` 不存在；关闭唯一 app 页面后返回 `count: 0`，随后 `pidAlive: false`。

## 4. 风险与边界

- 分阶段加载依赖 DSH 侧 `@twinsearth/dsh-client-modules` 解析 `stagedLoading`；当前运行态若仍是 3.5.0 原版，配置写入但不会生效。本版不发布 DSH 侧代码。
- 当前真实 fork profile 仍存在 `@deepseek-ai` scope 与安装态 `@twinsearth` 不匹配、im2a / w2m engines 与 3.5.0 不兼容的问题；本版不修复该阻塞，不能把“配置写入”当作“真实分身已分阶段加载”。
- `browserSingleAppWindow` 仍默认单页；多页面并行常驻需要单独调整策略。
- headless Edge 内部页面、跨站子帧仍可能产生额外 renderer，这是 site isolation 的正常结果，不是旧的单 renderer 上限。
- 关闭原因分类修复只覆盖任务卡与原始 reason 归一；历史已写入的记录仍保留原字段，UI 会按原始 reason 重新归一显示。

## 5. 回滚

- 版本回滚锚点：升级前 `active-v3.10.1-pre`（母体）、`merged-v3.10.1-pre`（原身）、`plugin-snapshot-<ts>`（插件层）。
- 已发布标签不移动；若本版需要回退，发布下一个补丁版本并记录替代关系。
- 分阶段加载配置在 profile `cordis.patch.yml`，删除 `modules.stagedLoading` 即可回到不分阶段；renderer 参数回退需恢复 `--renderer-process-limit=1` 并移除 `--process-per-tab`。
