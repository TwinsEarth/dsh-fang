# Fang v3.9.9 — 安全收口版

版本：`@twinsearth/fang-dsh-plugin@3.9.9`
日期：2026-11-27
基线：v3.9.8（打开分身热修版）

## 主题

v3.9.9 把 v3.9.8 之后审计出的高风险链路接进生产，并给结构性残余加上可执行门禁。不是新功能版，重点是“不假装成功、不误杀、不把 202 当发布成功”。

## 变更

### 1. 权限第二道门接入生产

- `permissions.mjs` 新增 `host` 环境；`auto` 按运行时角色映射：母体 `host`、fork/consumer `derived`。
- orchestrator 在 `roleGate` 之后、路由 handler 之前对 POST/PUT/PATCH/DELETE 执行 `enforcePermission`。
- adapter 在 `command()` 执行前对 `fork-session` / `archive` 判定。
- 拒绝返回 `403 { code:'permission-denied', action, envType }`；未知环境/动作 fail-closed。
- 默认 `auto` 不改变既有行为；显式 `mirror/essence/derived` 才收紧。

### 2. 内存与身份回收 fail-closed

- `memoryKill` 身份不匹配时保留 `task.orphan`，面板显示“孤儿待回收”；新增 `POST /fang/api/tasks/reprobe` 与 `reclaimOrphan()`，根 PID 已复用则不杀无关进程。
- 托管浏览器关闭必须带 `startedAt`/`commandLineHash`/`tokens` 任一指纹；缺失直接 `identity-required`，不再裸 PID 关闭。
- `accelerated-web` 的 start/status/stop 全部先验进程身份；不匹配不 taskkill、不报 running。

### 3. 发布工具链

- `publish-npm.mjs` 不再把 HTTP 202 当 `PUBLISHED`：202 只打印 `SUBMITTED`，轮询 registry 读回同版本后才打印 `PUBLISHED`；超时 `UNCONFIRMED` 退出码 3。
- `verify-release --at-head` 断言 `tag^{commit} == HEAD`，并比较 tag 内 AUDIT/RELEASE/架构图与 HEAD；`release-order` 自动执行同类检查。
- 本版流程改为先提交最终 docs，再打 tag，避免重演 tag 早于 docs。

### 4. P3 结构门

- 新增 `p3-structural-smoke.test.mjs`：compose 嵌套 Config + 17 插件表、包根 re-export、watchdog-sidecar 真实拉起/写回。
- 新增 `empty-catch` 基线门：461 处按文件冻结（459 注释-only + 2 裸），不批量替换；新增/增加即失败。
- 14 个未引用模块逐个裁定为 10 保留 / 4 删除候选；本版不删除、不移动，删除前移入回收目录并单独确认。

## 兼容性

- 数据根、v3.9.7 宿主压力阈值、v3.9.6 多帧 zstd 修复、v3.9.5 SafeMode 闩锁、v3.9.4 元主/分身配额均未改变。
- `permissionEnv` 默认 `auto`；只有显式设置 `mirror/essence/derived` 才会收紧权限。

## 资产

- npm：`@twinsearth/fang-dsh-plugin@3.9.9`
  https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.9.9
- GitHub Release：`v3.9.9`
  https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.9.9
- 交付目录：`E:\DBH\Fang-v3.9.9\`
- tarball：`dsh-fang-3.9.9.tgz`；SHA-256 见交付目录 `SHA256SUMS-3.9.9.txt`

## 验收

- 全量 `test-399-final9.log`：**1599 tests / 1576 pass / 0 fail / 13 skipped / 10 todo**。
- P3 定向：`p3-structural-smoke` 3/3、`p3-empty-catch-gate` 3/3；compose/watchdog 相关 5 套件 26/26；13 个模块测试 79/79。
- 构建门禁：preflight（全量 + e2e）、package smoke、crash-safety、allowlist、main-city package gate。
- **真机未回归**：本版未部署到 `C:\Users\fangw\.dsh\profiles\desktop`，新版上的 `task_mwqenfnxpobe` 同类一键修复待安装后复测。
