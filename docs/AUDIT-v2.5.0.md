# 审计报告 · dsh-Fang v2.5.0

> 生成时间：2026-11-01T09:33:39.364Z ｜ 版本：**2.5.0** ｜ 分支：`feat/session-sync-bridge-router`（PR #8，堆叠在 #7 之上）
> 本报告由发布门禁实际输出生成（`dist/preflight.json` / `dist/allowlist.json` / `dist/manifest.json`），不是手写结论。

## 1. 本轮修复的问题

| # | 问题 | 修复 | 证据 |
|---|---|---|---|
| 1 | `bridge-client` 默认只读 `%USERPROFILE%\.dsh`，忽略 `DSH_HOME` | 新增 `defaultDshHome()`，优先 `DSH_HOME` | bridge-client 测试 |
| 2 | `session-sync` 自定义 `sessionsRoot` 时仍从 `DSH_HOME/storages` 读 workspace 索引 | 新增 `storagesRoot` 并与 `sessionsRoot` 解耦 | session-bundle 导出/匹配测试 |
| 3 | 新三插件没有 e2e 覆盖（只有单元测试） | e2e 增加 4 条真实 HTTP 断言：`/fang/api/route`、`/fang/api/sync/status`、`/fang/api/bridge/status`（fail-closed） | e2e **45/45** |
| 4 | 没有 allow-list 自检门禁（路由/包文件/密钥/本地路径） | 新增 `tools/release/allowlist.mjs`，接入 preflight 与 build | **PASS**（29 路由 / 105 文件 / findings=0） |
| 5 | CHANGELOG 测试数字与实际不符 | 按真实门禁输出修正 | 第 2 节 |

> bridge 关键事实按 0.1.0 源码核对：`POST /messages` 返回 `{accepted, requestId}`，**不是流式**；事件需 `GET /events?limit=1..100` 轮询（500ms–1s）。本版没有伪造流式能力。

## 2. 门禁结果（全部真实执行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs` | package / `FANG_VERSION` / `CHANGELOG ## v2.5.0` **一致** |
| 许可矩阵 | preflight + licensing | AGPL 核心 / MIT 生态 / 商业占位 / NOTICE / CLA **在位**；licensing 8/8 |
| allow-list | `node tools/release/allowlist.mjs` | **PASS**：29 路由全部在 `${prefix}/api/`（adapter 常量路由与 portal 为显式例外）；105 文件无密钥/本地绝对路径 |
| 全量测试 | `node --test --test-concurrency=1 "test/*.test.mjs"` | **300 pass / 0 fail / 1 skip**（skip=手动容器探针） |
| 实机 e2e | `node tools/e2e.mjs` | **45/45**（临时 `$DSH_HOME` + 真 dsh 母体 + 真分身 + 三新路由） |
| 构建 | `node tools/release/build.mjs` | `dsh-fang-2.5.0.tgz`（206917 B，78 entries）；**allow-list (package) PASS** |
| 产物健康 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.5.0`（kernel/12 插件可加载，包内无 dist/node_modules） |
| preflight 总结 | `node tools/release/preflight.mjs --e2e` | **GREEN**（11 项） |

证据文件（本地、不入库）：`dist/preflight.json`、`dist/allowlist.json`、`dist/manifest.json`、`dist/e2e-v250b.log`、`dist/build-v250.log`、`dist/healthz-v250.log`。

```text
@twinsearth/dsh-fang@2.5.0  tarball=dsh-fang-2.5.0.tgz  size=206917  sha256=a2e55d2c357882c3fc81a503986595b800de6cd30364f906690f3715aba7ecf4
healthz: HEALTHY (kernel FANG_VERSION=2.5.0, 12 plugins, no dist/node_modules in package)
```

## 3. 路由 allow-list（自动从源码提取，共 29 条）

| 方法 | 路径（前缀变量已省略） | 文件 |
|---|---|---|
| `GET` | `${ADAPTER_ROUTE.HELLO}` | adapter.mjs |
| `GET` | `${ADAPTER_ROUTE.STATUS}` | adapter.mjs |
| `GET` | `${ADAPTER_ROUTE.APPROVALS}` | adapter.mjs |
| `GET` | `${ADAPTER_ROUTE.AUDIT}` | adapter.mjs |
| `POST` | `${ADAPTER_ROUTE.COMMAND}` | adapter.mjs |
| `GET` | `/panel` | orchestrator.mjs |
| `GET` | `/api/status` | orchestrator.mjs |
| `GET` | `/api/tasks` | orchestrator.mjs |
| `POST` | `/api/tasks/create` | orchestrator.mjs |
| `GET` | `/api/tasks/status` | orchestrator.mjs |
| `POST` | `/api/tasks/archive` | orchestrator.mjs |
| `POST` | `/api/tasks/promote` | orchestrator.mjs |
| `POST` | `/api/derive` | orchestrator.mjs |
| `GET` | `/api/tasks/sessions` | orchestrator.mjs |
| `GET` | `/api/forks` | orchestrator.mjs |
| `POST` | `/api/forks/create` | orchestrator.mjs |
| `POST` | `/api/reap` | orchestrator.mjs |
| `POST` | `/api/promote` | orchestrator.mjs |
| `GET` | `/api/bridge/status` | session-bridge.mjs |
| `GET` | `/api/bridge/sessions` | session-bridge.mjs |
| `GET` | `/api/bridge/sessions/events` | session-bridge.mjs |
| `POST` | `/api/bridge/sessions/prompt` | session-bridge.mjs |
| `POST` | `/api/bridge/sessions` | session-bridge.mjs |
| `GET` | `/api/sessions` | session-catalog.mjs |
| `GET` | `/api/sessions/item` | session-catalog.mjs |
| `GET` | `/api/sessions/head` | session-catalog.mjs |
| `GET` | `/api/sync/status` | session-sync.mjs |
| `POST` | `/api/sync/export` | session-sync.mjs |
| `POST` | `/api/sync/import` | session-sync.mjs |

## 4. 变更面

- 修复：`src/lib/bridge-client.mjs`、`src/plugins/session-sync.mjs`、`tools/e2e.mjs`
- 新增门禁：`tools/release/allowlist.mjs`，接入 preflight + build
- 三子插件：`src/plugins/session-{bridge,sync,router}.mjs`、`src/lib/{bridge-client,session-bundle}.mjs`
- 内核：`consumer` 角色、矩阵 15 项、SERVICE/ROW、compose、patch 行、package exports
- 文档：`docs/ARCHITECTURE-SYNC-BRIDGE.md`、本报告、CHANGELOG v2.5.0

## 5. 已知问题与阻塞（不掩盖）

1. README 仍是 v2.3.1 文案（维护者网页编辑，PR-only；合并 #7/#8 后单独 PR 更新）。
2. npm 未发布：`@twinsearth` 组织不存在（404），scoped 发布 402；需先创建免费组织。
3. bridge 模式未启用：PC 的 DSH Desktop 尚未安装 `@ignotuss/dsh-desktop-bridge`（Electron 独占 profile，需人工批准）；未安装时路由如实走 sync / `bridge-unavailable`。
4. 本版是 P0 契约版：三插件提供 service + HTTP API + 纯函数，**尚未接入** Orchestrator `derive(mode)` 与面板 UI（P1）。
5. PR 堆叠：本分支基于 `fix/session-history-ui`（#7）；#7 合并后需把 #8 的 base 改为 `main`。
6. 现场宿主仍 v2.1.0：合并后需重启母体才能加载 v2.4/v2.5 宿主模块。
7. 凭据卫生：本轮使用的 GitHub/npm token 曾出现在聊天中，收尾后应全部轮换。

## 6. 复现命令

```powershell
cd <repo>
node tools/release/allowlist.mjs                 # 路由/包/密钥自检
node tools/release/preflight.mjs --e2e           # 版本+许可+allow-list+测试+e2e
node tools/release/build.mjs --skip-preflight    # tarball + manifest + package allow-list
node tools/release/healthz.mjs                   # 产物健康
```
