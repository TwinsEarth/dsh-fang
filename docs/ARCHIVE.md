# 归档 / 读档（v2.7.1）

> 代码：`src/plugins/orchestrator.mjs`（archiveTask / restoreTask / deleteArchivedTask）、
> `src/plugins/forker.mjs`（`alive()`）、`client.js`（读档 UI）；
> 测试：`test/orchestrator.test.mjs`（21 项）。

## 1. 修复的问题

旧实现里「归档」= 调 Adapter `archive` → 标记 archived → `service.reap()`：

- `reap` 会 **删除 fork home 和 forker 记录**，归档后无法读档；
- `reap` 的 `stop` 失败（进程没死）时，接口仍返回 `ok:true`，面板显示「已归档」，
  但分身进程/端口还在——用户看到“归档不成功，该分身还在”。

v2.7.1 起：

- **归档 = 停止进程 + 保留 home**；
- 停止后必须确认进程真的退出（`forker.alive(taskId)`），否则返回
  `{ok:false, error:'stop-failed'}`，任务保持原样，**不假装成功**；
- 删除 home 只发生在「删除存档」，不再由归档隐式执行。

## 2. 生命周期

```
运行中 ──归档──▶ archived（进程停止，home 保留，url/port/token 清空）
                     ├──还原──▶ 重新 spawn（新端口/新 token，原 home/profile）→ ready
                     └──删除存档──▶ reap：删 home + 记录；任务从列表消失
```

归档时：

1. 若 Adapter 可用：先发 `archive` 命令（flush 缓冲 + 落审计），失败只记录 `remote` 警告；
2. `forker.stop(taskId)` 杀进程树；
3. 轮询 `forker.alive(taskId)`（真实 PID 存活），最多 `archiveStopTimeoutMs`（默认 3000ms）；
4. 确认退出后才写 `status:'archived'`、`archivedAt`、`archiveRemote`，清空 url/port/token；
5. 返回 `{ok:true, archived:true, stopped:true, homeKept:true}`。

还原时：

1. 必须是 archived，且 home 存在、profile 能解析本 bundle；
2. `forker.spawn({ forkId, homeDir, profile, env })`（forker 重新生成 Adapter token）；
3. 更新 url/port/token/pid，Adapter 握手；返回 `{ok:true, restored:true, url, port}`。

删除存档时：

1. 必须是 archived；
2. `forker.reap(taskId)`（stop + removeTree(home) + 删记录）；
3. forker 记录已丢失（宿主重启/旧归档）时，按 `task.homeDir` 兜底删除（限定在 forks 根内）；
4. 删除 tasks.json 记录。

## 3. HTTP 接口

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| POST | `${prefix}/api/tasks/archive` | `{taskId}` | `{ok:true, archived:true, stopped:true, homeKept:true, remote, archivedAt?}` |
| POST | `${prefix}/api/tasks/restore` | `{taskId}` | `{ok:true, restored:true, url, port, adapter}` |
| POST | `${prefix}/api/tasks/archive/delete` | `{taskId}` | `{ok:true, deleted:true}` |

失败：409 + `{ok:false, error}`（`unknown-task` / `not-archived` / `stop-failed` /
`archive-home-missing` / `fork-bundle-unavailable` / `reap-failed` / `forker-unavailable`）。

`GET /api/tasks` 的 archived 任务带 `archivedAt`、`archiveRemote` 字段，供读档 UI 显示。

## 4. 面板 UI

- 顶栏新增 **「读档 (N)」** 按钮：切换到存档视图，再点「返回面板」回到双栏；
- 存档视图列出所有 `status:'archived'` 的任务：标题、taskId、归档时间、远端确认状态；
- 每条存档：
  - **还原**：确认后用存档重新启动分身（新端口/token），成功后可「打开分身」；
  - **删除存档**：两次确认语义（确认框 + 按钮），永久删除 home 与记录；
- 普通右栏不再渲染旧的「已归档」折叠列表，只显示一行提示 +「打开读档」；
- 归档确认文案改为“停止进程、保留存档，可读档还原”，不再写“不可撤销”。

## 5. 配置

- `archiveStopTimeoutMs`（100–30000，默认 3000）：归档时等待进程退出的上限；
- `autoReapIdleMinutes`：空闲自动回收现在调用 `reap`（删除 home），不再调用归档
  （避免自动任务把 home 全部保留成存档）。

## 6. 兼容 / 边界

- 旧版本归档过的任务（已经被 reap、home 不存在）：在存档列表里可 **删除**，但 **还原**
  会返回 `archive-home-missing`（UI 禁用还原按钮）；
- Forker `alive()` 用 `process.kill(pid, 0)` 判断真实存活；Windows 上 `taskkill /T /F`
  通常同步完成，等待循环最多 3s；
- 归档失败时任务不会被移出列表，也不会被标记 archived，便于重试；
- 还原后是**新的进程/端口/token**，但 home（会话、文件、配置）沿用原存档；
- 删除存档是唯一会删除 home 的路径；归档本身不删任何文件。
