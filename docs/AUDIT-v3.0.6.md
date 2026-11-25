# 审计报告 · dsh-Fang v3.0.6（元主 CRUD + 分身列表契约）

> 本机真实输出（2026-11-03）。版本线：… v3.0.4 → v3.0.5 → v3.0.6。

## 1. 交付

| 模块 | 内容 |
|---|---|
| `EssenceManager` | `rename`（1–80、locked 拒绝）、`archive`（只改元数据）、`setDefault/getDefault`（官方兜底）、`copy`（overlay 配置，不含 credentials）、`pluginCount`、`downloadBundle`（JSON 附件，不含 credentials，>32MB 拒绝） |
| orchestrator | 10 条新路由：essence create/rename/archive/delete/copy/default/download；tasks rename/copy/download |
| 列表契约 | `essence/list` 增 `defaultId/defaultEssence/capacity` 与 `locked/official/archived/pluginCount`；任务增 `phase/health/sessionTitle/startedAt/updatedAt/projectBytes/essenceId` |
| 文档 | `docs/API-v3.0.6.md`（接口/字段/未交付边界） |
| 测试 | `test/essence-crud.test.mjs` 5 项 + orchestrator create→rename→list 契约链路 + 62 路由断言 |

## 2. 安全边界

- 复制/导出**永不包含 credentials**（延续 v3.0.5 B8）；
- locked 官方元主拒绝 rename/archive（B6）；
- tasks/copy 只返回去 token 的访问信息；打开仍走 `tasks/open-url`（B4）；
- 所有路由沿用 v3.0.5 B1 鉴权与 CSRF/Host 校验。

## 3. 门禁（待本次运行确认）

- preflight 3.0.6：测试/e2e/allow-list（预计 62 路由）；
- build/healthz 本次提交后重建记录。

## 4. 未交付（明确）

- 配额准入执行（reserve/commit/tombstone）与 7/5 槽位强制；
- 元主 pause/restart（无路由，UI 不出现）；
- 分身完整项目/会话归档（download 目前仅元数据清单；完整打包留 v3.0.7）；
- 分支模型/单会话租约（v3.0.7+）。
