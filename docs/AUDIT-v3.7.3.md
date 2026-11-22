# v3.7.3 审计（2026-11-22）

> 用户要求：元主 Web 插件状态自动同步到派生分身，分身每次打开主动同步（安装/卸载/更新/开启/关闭 + 配置参数/列表/状态）。版本 3.7.3（用户确认）。

## 根因

1. `open-url` 只取 URL，不捕获/比较来源元主状态；只有 create/restore 才同步，运行中的分身打开不会更新。
2. forker 的 clean template/reprovision 会把 profile 重置为 7 个基础 bundle；orchestrator 的 post-provision 实验性步骤在 repair/restore 路径可能被后续 provision 覆盖。
3. `restoreTask` 对 ready 但进程已死的任务返回 `not-archived`，导致反复“启动失败”。

## 修复

- `syncTaskOnOpen`：open-url 捕获运行态 → repair official → ensureFresh → fingerprint 比较 → 变化则 stop + reset + reprovision + spawn。
- forker spawn 前 `applyForkExperimentalSurface`：15 个官方实验性 bundle + enabled patch 行，任何路径都生效。
- restoreTask 接受 stale ready/running；所有 task 默认 `syncSourceId=essence-official-dev`。
- 同时收口 P1/P2-A 隔离加固（部署 409、watcher 降级、安装快照、私有 TEMP）。

## 验证

- 全量 tests：**1325 pass / 0 fail / 2 skip**。
- preflight --e2e：**GREEN，125/125**。
- 真机：已发布 3.7.3；部署后验证每次打开同步。
