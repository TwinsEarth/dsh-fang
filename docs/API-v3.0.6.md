# API 契约 · v3.0.6（元主 CRUD + 分身列表字段 + 任务动作）

> 状态：已实现（orchestrator 路由 + EssenceManager 方法）；鉴权沿用 v3.0.5 B1（`x-fang-auth`）。
> 所有 POST 请求 `content-type: application/json`；错误统一 `{ ok:false, error }`，HTTP 400/404/409。

## 1. 元主（Essence）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/fang/api/essence/list` | — | `{ officialId, official, defaultId, defaultEssence, essences[], capacity:{slots:7,defaultLimit:5,used} }` |
| POST | `/fang/api/essence/create` | `{ name, tier?, parentId? }` | `{ ok, essence }` |
| POST | `/fang/api/essence/rename` | `{ essenceId, name }` | `{ ok, essence }`（locked 400） |
| POST | `/fang/api/essence/archive` | `{ essenceId, archived? }` | `{ ok, essence }`（只改元数据，不删目录） |
| POST | `/fang/api/essence/delete` | `{ essenceId }` | `{ ok, removed }`（有子元主/locked 拒绝） |
| POST | `/fang/api/essence/copy` | `{ essenceId, name? }` | `{ ok, essence }`（复制 overlay/settings，**不复制 credentials**） |
| POST | `/fang/api/essence/default` | `{ essenceId }` | `{ ok, default:{essenceId,name} }` |
| GET | `/fang/api/essence/download?essenceId=` | — | JSON 附件 `{ ok, essenceId, meta, files:[{path,base64}], bytes }`（不含 credentials；>32MB 拒绝） |

`essence` 对象新增字段：`locked/official/archived/archivedAt/pluginCount/createdAt/updatedAt`。
配额：默认 5、物理槽位 7（`capacity` 为契约值，配额执行将在 v3.0.6 后续提交接入）。

## 2. 分身（Derived / Task）

`GET /fang/api/tasks` 的每个任务新增字段：

| 字段 | 说明 |
|---|---|
| `phase` | `provisioning | starting | running | stopped | failed | archived` |
| `health` | `{ adapter: 'ok' | 'pending' | 'error', error }` |
| `sessionTitle` | 导入会话/种子的标题（无则空串） |
| `startedAt / updatedAt` | 毫秒时间戳（未知为 null） |
| `projectBytes` | 项目体积（v3.0.6 默认 0，后续接磁盘统计） |
| `essenceId` | 来源元主（尚未绑定派生链时为 null） |

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/fang/api/tasks/rename` | `{ taskId, title }` | `{ ok, task }`（archived 409） |
| POST | `/fang/api/tasks/copy` | `{ taskId }` | `{ ok, taskId, title, url, port }`（复制访问信息，不含 token） |
| GET | `/fang/api/tasks/download?taskId=` | — | `{ ok, manifest }`（v3.0.6 元数据清单；完整项目/会话归档留 v3.0.7） |
| GET | `/fang/api/tasks/open-url?taskId=` | — | `{ ok, url }`（内存中带 token URL，v3.0.5 B4） |

## 3. 兼容性与迁移

- 旧字段 `status/title/taskTitle/url/pid/port/adapter` 保留；
- `phase` 是新增投影，旧客户端忽略即可；
- `essence/list` 旧字段 `officialId/official/essences` 保留，新增 `defaultId/defaultEssence/capacity`；
- token/凭据仍遵守 v3.0.5：不进 URL、不落 tasks.json、不复制到 merged/profile。

## 4. 未交付（明确）

- 配额准入执行（reserve/commit/tombstone）与 7/5 槽位强制；
- 元主 pause/restart（无路由，UI 不出现）；
- 分身完整项目归档（download 目前仅元数据）；
- 分支模型/单会话租约（v3.0.7+）。
