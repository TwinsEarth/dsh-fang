# 审计报告 · dsh-Fang v2.7.1（归档修复 + 读档 / 存档管理）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 1 个补丁位（`2.7.0` → `2.7.1`）。

## 1. 用户问题与根因

1. **点击归档并确认后，归档不成功（该分身还在）**。
   - 旧实现：`archiveTask()` 先标记 archived → `service.reap()`（停进程 + 删除 home + 删记录）。
   - `reap` 失败时，接口仍返回 `{ok:true, archived:true, reaped:false}`；面板只检查 `body.ok`，
     仍显示「已归档」。实际可能：
     - 进程没被杀死（fork 仍存活/端口仍占用）——用户看到“分身还在”；
     - 或 home 被删、任务从列表消失，但进程仍活着（无法再归档/读档）。
   - 真实验证：本机 e2e 旧断言是「归档后 registry 空、home 被删」（v2.6.x 语义）；
     v2.7.1 起改为「归档后任务 archived、home 保留」，这样才可读档。

2. **缺少读档 UI**：旧面板没有存档视图，只有已归档折叠列表（且 open 无 URL）。

## 2. 修复 / 新语义（v2.7.1）

**归档 = 停止进程 + 保留 home**：

1. Adapter 可用时先发 `archive`（flush + 审计），失败仅记录 `remote` 警告；
2. `forker.stop(taskId)` 杀进程树；
3. 轮询 `forker.alive(taskId)`（真实 PID 存活，`process.kill(pid,0)`），上限
   `archiveStopTimeoutMs`（默认 3000ms）；
4. 确认退出后才写 `status:'archived'`、`archivedAt`、`archiveRemote`，清空 url/port/token；
5. 停不掉 → `{ok:false, error:'stop-failed'}`，任务保持原状，**不假装成功**。

**读档 / 还原 / 删除**：

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `${prefix}/api/tasks/archive` | 停进程、保留 home、标记 archived |
| POST | `${prefix}/api/tasks/restore` | 用原 home/profile 重新 spawn（新端口/新 token）+ 握手 |
| POST | `${prefix}/api/tasks/archive/delete` | `forker.reap` 删除 home + 记录（记录丢失时按 home 兜底） |

**面板 UI**：

- 顶栏新增「读档 (N)」按钮，切换到存档视图；存档卡片支持 **还原** / **删除存档**；
- 普通右栏不再渲染旧的「已归档」列表，改为提示 +「打开读档」；
- 归档确认文案改为“停止进程、保留存档，可读档还原”。

**其他修复**：

- `forker.alive(forkId)`：真实 PID 存活判断（用于归档确认）；
- `autoReapIdleMinutes` 的空闲回收改回 `reap()`（避免把 home 全部保留成存档）；
- `archiveStopTimeoutMs` 配置（100–30000，默认 3000）。

## 3. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.7.1** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **402 pass / 0 fail / 1 skip（403 项，23.6s）** |
| e2e 实机验收 | 同上 | **57/57（15.2s）**：归档停进程 + 保留 home → 还原 ready → 再归档 → 删除存档 → registry 空 + home 删除 |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：36 路由、0 findings、144 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.7.1.tgz`（**246,997 B，85 entries**）<br>sha256 `ff78da96cef7fae25d976b13faf25fad9f5e1d3dc46ec7813c1c3d72334142f8` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.7.1`（15 个模块可 import） |

## 4. 新增 / 调整测试

`test/orchestrator.test.mjs`（21 项，新增 3 项 + 重写 archive 断言）：

1. 归档：adapter 收到 archive；`forker.stop` 被调用；**不 reap**；任务保留 archived +
   archivedAt；url 清空；
2. `stop-failed`：`forker.stop` 成功但 `alive()` 一直 true → 返回 `stop-failed`，
   任务不标 archived、不消失；
3. 还原：归档后 `restoreTask` 重新 spawn（同 home/profile），url/token 更新，archivedAt 清空；
4. 删除存档：`reap` 被调用，任务从列表移除。

e2e 从 45 项增加到 **57 项**：归档 → home 保留 → 还原 ready → 再归档 → 删除存档 →
registry 空 + home 删除，并保留原有 audit/hash-chain/会话读取检查。

## 5. 边界 / 兼容

- 旧版本归档过的任务（已被旧 reap 删除 home）：存档列表可 **删除记录**；点 **还原** 会返回
  `archive-home-missing`（UI 禁用还原按钮）。
- 归档失败不会把任务移出列表，也不会清空 url/token，便于重试。
- 删除存档是唯一删除 home 的路径；归档本身不删文件。
- `alive()` 使用 PID 探测；Windows `taskkill /T /F` 通常同步，等待上限 3s。
- 还原复用原 home/profile，但 fork 是**新进程/新端口/新 token**；旧 token 已随归档 stop 作废。

## 6. 提交状态

- 分支：`feat/archive-ui`（stacked 在 PR #19 的 `feat/fork-sse-fuzz` 之上）；
- 发布物：`dist/dsh-fang-2.7.1.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
