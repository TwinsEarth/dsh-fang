# 审计报告 · dsh-Fang v3.0.4（三层权限契约 + 官方推荐原身）

> 本机真实输出（2026-11-02）。版本线：… → v3.0.2 → v3.0.3 → v3.0.4。

## 1. 交付范围

| 交付物 | 内容 |
|---|---|
| `src/lib/permissions.mjs` | 三层矩阵（mirror/essence/derived）、动作分组（installPlugins/openSessions）、`checkPermission`、`createEnvironmentGuard`（can/check/assert）、`PermissionDeniedError`、`describePermissions`；未知环境/动作 fail-closed |
| `EssenceManager` | `ensureOfficialEssence()` 幂等 seed（`essence-official-dev`、locked、official、默认插件条目）；locked 原身 `update/remove/setTier` 拒绝；`create()` 支持显式 id/locked/official/skipQuota/defaultPatchEntries |
| orchestrator | 启动 seed（失败仅 warn）；`GET /fang/api/essence/list`；compat 契约更新为 50 条 + 新必需路由 |
| 测试 | `permissions` 7 项、`official-essence` 5 项 + orchestrator 路由断言 |

## 2. 权限矩阵（fail-closed）

| 环境 | 安装/改插件 | 开会话/任务 |
|---|---|---|
| mirror 母体版 | ❌ | ❌ |
| essence 原身版 | ✅ | ❌ |
| derived 分身版 | ❌ | ✅ |

- 未知环境或未知动作 → 拒绝（`permission-denied`）；
- `assert()` 抛 `PermissionDeniedError`（带 envType/action/code），供 Adapter 第二道门使用；
- 第一道门仍是 profile 组合（不装对应插件即无能力），本库只做防御纵深与 UI 能力摘要。

## 3. 官方推荐原身

- id：`essence-official-dev`（符合原身 id 规则，列表可见）；
- `locked: true` + `official: true`；锁定后不可 update/remove/setTier；
- 默认插件条目：`official-dev-toolkit`、`official-dev-git`（可被镜像侧/调用方覆盖）；
- seed 失败不阻塞主插件启动（warn + 继续）。

## 4. 门禁

| 门禁 | 结果 |
|---|---|
| preflight --e2e | 见本次运行输出（GREEN 3.0.4） |
| tests | permissions/official/essence/orchestrator 全绿（全量见 preflight） |
| allow-list | 50 路由（所有路由在 `${prefix}/api/` 下） |
| healthz | HEALTHY `@twinsearth/dsh-fang@3.0.4` |

## 5. 未交付（后续版本）

- v3.0.5：`DerivedInstanceManager`（merged 复制 + 单会话 + 沙箱数据目录 + DSH_ENV_TYPE）；
- v3.0.6：双栏控制面板（原身/分身列表、行内派生/设置/打开等）；
- v3.0.7：三态 Web 视图路由（`/fang/mirror`、`/fang/essence?id=`、`/fang/derived?id=`）+ restricter profile 插件；
- 严格发布序列 v3.0.0/v3.0.1 tag 仍待按序补发。
