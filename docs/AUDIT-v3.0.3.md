# 审计报告 · dsh-Fang v3.0.3（客户端升级 compat 门禁）

> 本机真实输出（2026-11-02）。版本线：v2.9.2 → v2.9.3 → v2.9.9 → v3.0.0 → v3.0.1 → v3.0.2 → v3.0.3。

## 1. 交付范围

| 交付物 | 内容 |
|---|---|
| `src/lib/compat.mjs` | 模块导入门禁（内核入口 + 全部子插件模块，当前 16 个并自动纳入后续模块）；导出 `apply` 校验；路由契约数量 + 必需路径；`compat-status.json` 状态读写 |
| `MirrorManager` | `compatGate` / `onCompatResult`：升级成功后先跑门禁；失败保留新版本但子插件关闭、跳过重算；抛出按失败处理；结果携带 `compat` |
| orchestrator | `GET /fang/api/mirror/recompute-status`、`GET /fang/api/compat`、`POST /fang/api/compat/check`；启动 1.5s 自动门禁；使用真实 webServer 路由列表（期望 49 条）+ 必需路径 |
| 测试 | `test/compat.test.mjs` 10 项 + orchestrator 路由断言 |

## 2. 安全默认（关键语义）

- 未检查 / 检查失败 → `subPluginsEnabled: false`（默认关闭子插件）；
- 门禁通过 → `subPluginsEnabled: true`，随升级继续触发原身重算；
- 门禁失败 → 客户端版本保留（不回滚），主插件继续服务，等开发者更新插件后 `POST /api/compat/check` 重检；
- 回滚仍可走镜像备份/还原盘（`restore`）。

## 3. 门禁检查项

1. `src/kernel/index.mjs` 可导入；
2. `src/plugins/*.mjs`（排除 `imports.mjs`）逐个动态导入成功；
3. 每个模块导出 `apply`（缺失为 error）、`name`（缺失为 warning）；
4. 路由数量 == 期望（当前 49），且必需路径齐全（panel/status/mirror-status/upgrade/recompute-status/compat）。

## 4. 门禁与升级联动（有测试）

- gate 失败：`ok:true, reason:'compat-gate-failed', compat.ok:false, postUpgradeTriggered:false`，重算钩子不执行，新版本已落地；
- gate 通过：`compat.ok:true, postUpgradeTriggered:true`，协调器重算触发；
- gate 抛错：按失败处理，不阻塞升级返回。

## 5. 提交状态

分支 `feat/upgrade-coordinator`（stacked 在 v3.0.2 `d16d6b3` 之上）；同时清理误提交的 `types/umbrella/*.ts` 参考文件。

## 6. 未交付 / 后续

- v3.0.0（架构聚合基线）与 v3.0.1（ETag）tag/Release 待按严格序列补发；
- 官方更新源（Release/自建镜像静态 feed + 签名校验 + tar 解包）尚未实现（下一步 v3.0.4）；
- client-half React 包与 UI 接线仍在独立包中。
