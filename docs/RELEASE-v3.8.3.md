# v3.8.3 发布记录（P0 加固，准备中）

> 基线 v3.8.2。本版只有 P0 加固 + 已完成的 P1/P2 接线，不改变数据根默认值。
> **发布动作未执行**：未 commit / push / tag / npm publish / GitHub Release。

## 门禁

| 项 | 结果 |
|---|---|
| P0 定向测试（VM） | 52 pass / 1 skip（job 集成在 Linux skip；其余 52 全绿） |
| P0 + open-fork + 核心 UI 组合（VM） | **81 tests / 80 pass / 1 skip**（job 集成在 Linux skip） |
| P0 定向测试（Windows 真机） | **53/53 pass** |
| Job 真实 Windows 集成（HSD） | **1/1 pass**：只杀 helper，fork 子/孙进程均死 |
| Workspace 映射 Windows 真机（HSD） | **6/6 pass** |
| Forker Windows 真机（HSD） | **29/29 pass** |
| 核心 UI 回归（VM） | **27/27 pass**（core-ui 3、official-essence 7、core-ui-profile 3、accelerated-alias 等） |
| 打开分身状态归位回归（VM / Windows HSD） | **1/1 / 57/57 pass**：旧 port 被占 + fang-meta 残留 running → `spawn-threw`/`step=spawn`，非 `handler-threw` |
| 迁移报告按钮回归（VM） | **3/3 pass**：`app.openMigrationReport` 已挂回 `app` 面，点击不再 TypeError |
| 全量 npm test（Linux） | 4 条既有跨平台路径断言失败（adapter/buffer-keeper/data-isolation），其余通过；未作为本版门禁 |
| 真实 DSH 宿主 fork / 浏览器端到端 | 待 TOFUTURE 在线复测 |
| preflight / e2e / release-order | 未跑（发布动作未启动） |

## 变更

- **P0-1**：Windows Job Object helper；`KILL_ON_JOB_CLOSE`；宿主冻结/helper 死亡都杀整棵 fork 树；缺 helper fail-closed。
- **P0-2**：旧 `E:\DSH\DS` 等 workspace 映射到 fork home；启动扫描已有 fork home；session header 重写、事件帧保留、可回滚。
- **P0-3**：托管浏览器不可用时 HTTP 503 + 客户端拒绝打开；清除所有 `window.open` 外部回退；essence runtime Web 纳入托管/panic/watchdog；显式 browserPath 失效 fail-closed。
- **打开分身状态归位**：打开前清理死 pid/被占端口，`fang-meta` 随 task 状态同步，open/restore 返回步骤级错误。
- **P1**：flush 端点、idle-close 活动判定、sidecar identity/log rotation/Safe Mode UX 已完成并有测试。
- **P2**：session compaction、disk hygiene、memory policy、CDP trends、pagefile banner 已接线并有测试。
- **核心 UI 自愈**：`ui-theme`/`ui-layout`/`ui-sidebar`/`ui-chat` 的 `disabled: true` 不再被官方/来源/运行态 profile 保留；修复 `required entries did not activate` 的 boot 失败。
- 版本号：`3.8.2` → `3.8.3`。

## 未完成 / 风险

1. 真实 DSH 宿主上的 fork/浏览器端到端未跑；TOFUTURE 上的 13100 元主运行态重启与 `ui-theme` 页面验证也未执行（环境离线）。HSD 的 Edge 被策略挡住 CDP，`launchManagedBrowser` 返回 `browser-cdp-timeout`，调用方 503 拒绝（符合 fail-closed，但不是可用态）。
2. 旧 workspace 只 redirect，不复制 `E:\DSH\DS` 下文件；用户未确认是否要镜像。
3. 全量 Linux 测试的 4 条失败是路径语义差异，非本版引入；发版前应单独修或标注平台 skip。
4. 未做 git 提交/标签/发布；helper 二进制已随包但未在新 tag 中固化 sha256。
