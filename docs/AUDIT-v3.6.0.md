# v3.6.0 Stable 审计（2026-11-22）

> 用户指令（2026-11-22）：**三方发布：tag/GitHub Releases/NPM，v3.6.0 Stable 稳定版**。
> 基线 v3.5.9；本版 = 分身状态栏（4 态 + 2 操作）+ 核心切回 stock 的别名清理 + 还原不再强制归档。

## 1. 范围（逐项可核对）

| # | 项 | 变更 | 证据 |
|---|---|---|---|
| 1 | 分身状态栏 | 每张卡显示 运行中/等待启动/已停止/故障；折叠可见；状态栏内「启动」「一键修复」 | `client.js`（`forkStateOf` / `.fork-status`）、`test/client-fork-status.test.mjs` |
| 2 | 一键修复 | `POST /fang/api/tasks/repair`：停残留 → 清别名桩 → 重置 profile → 修 mirror → 拉起；返回 `steps[]`；不删 home/会话 | `src/plugins/orchestrator.mjs`（`repairTask` + route）、`test/orchestrator.test.mjs` |
| 3 | 核心切回 stock 清理别名 | stock spawn/provision 前 `pruneAliasStubs()`；只删 `version=0.0.0-fang-alias` 的 `@deepseek-ai/*` 桩 | `src/lib/accelerated-fork.mjs`、`src/plugins/forker.mjs`、`test/accelerated-fork.test.mjs` |
| 4 | 还原不再强制归档 | `restoreTask` 接受 failed/archived；客户端删除“先 archive 再 restore”的 fallback | `src/plugins/orchestrator.mjs`、`client.js`、`test/accelerated-fork.test.mjs` 源守卫 |
| 5 | 路由契约 | 86 → 87（新增 tasks/repair），compat 常量同步 | `src/lib/compat.mjs`、`test/accelerated-fork.test.mjs` |

真机核对：本机 v3.5.9→v3.6.0 修复后，损坏的 `task_mwqedbzich9m` profile 清掉 24 个别名桩后，用 stock CLI 实测可启动（拿到 Web URL 后探针退出）；一键修复把同样步骤收敛为单接口。

## 2. 验证（真实数字，发布前实测）

- preflight --e2e：**GREEN**；全量 tests **1311 pass / 0 fail / 2 skip**（1322 tests）；e2e **125/125**；main-city source grade A；allow-list **0 findings**（111 routes）；artifact sha256 match。
- 发布 PR CI：待回填。
- release-order：待回填。
- verify-release --remote / healthz --remote：待回填。

## 3. 风险与边界

- 一键修复会重启目标分身（显式确认），不删除 home/会话/存档；不改变核心选择。
- 别名清理只删 fang 生成的加速桩；真实 `@deepseek-ai/*` 包不动。
- 归档会话仍不能作为派生导入源（服务端校验不变）。

## 4. 回滚演练

- 触发方式：插件层 `npm i @twinsearth/fang-dsh-plugin@3.5.9`；仓库层按需 reset 到 v3.5.9 发布提交。
- 恢复耗时：分钟级（无数据格式迁移）。
- 证据：`dist/preflight.json`、`dist/release-verify.json`、`dist/dsh-fang-3.6.0.tgz.sha256`。
