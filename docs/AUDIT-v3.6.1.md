# v3.6.1 审计（2026-11-22）

> 用户指令（2026-11-22）：**三方发布，v3.6.1**。基线 v3.6.0；本版 = 加速分身会话兼容 + 还原强制 reprovision。

## 1. 范围（逐项可核对）

| # | 项 | 变更 | 证据 |
|---|---|---|---|
| 1 | catalog v3 兼容 | 加速 spawn/provision/import 时把 `subagent/catalog` v3→v1（帧保留、备份） | `src/lib/accelerated-fork.mjs`、`src/plugins/forker.mjs`、`test/accelerated-fork.test.mjs` |
| 2 | v1 严格 schema | 删除 v1 不允许的 `name` 字段（v3 引入） | 同上 |
| 3 | 未知事件 | 读取加速核 `KNOWN_SESSION_EVENT_TYPES`；未知类型（如 `team/mode`）标 `ignorable: true` | 同上 |
| 5 | 启动按钮文案/流程 | 非归档分身「启动」直接拉起；仅 archived 走「还原存档」确认 | client.js、	est/client-fork-status.test.mjs |
| 4 | 还原 timeout | `resetForkConfig` 后强制 reprovision，避免 stock 配置 + 加速 CLI 混搭 | `src/plugins/orchestrator.mjs`、`test/fork-core-settings.test.mjs` |

真机验证：`task_mwqedbzich9m` 的会话副本经兼容后，用加速核自带 `validateStoredEvents` 校验通过（34,029 事件）；该分身以加速档 `ready`（pid/port 正常，adapter 3.6.0）。

## 2. 验证（真实数字，发布前实测）

- preflight --e2e：**GREEN**；全量 tests **1314 pass / 0 fail / 2 skip**（1326 tests）；e2e **125/125**；main-city A；allow-list 0；artifact sha256 match。
- 发布 PR CI（#143）：**8/8 绿**（gate required / test node22+24 / compat node22+24 / hygiene / license）。
- `release-order`：pre-tag / post-publish 均 **10/10 GREEN**。
- `verify-release --remote`：**GREEN 16/16**；`healthz --remote`：**HEALTHY @3.6.1**。

## 3. 风险与边界

- 兼容垫片只做「加速核可读」；未知事件在加速视图被跳过（team 等不渲染）。
- 只改分身会话副本并备份；母体会话不动。
- stock 档完全不变；要彻底支持新事件需升级加速核（npm 最新 3.5.0）。

## 4. 回滚演练

- 触发方式：插件层 `npm i @twinsearth/fang-dsh-plugin@3.6.0`；仓库层按需 reset 到 v3.6.0 发布提交。
- 恢复耗时：分钟级（无数据格式迁移；兼容改写只影响副本）。
- 证据：`dist/preflight.json`、`dist/release-verify.json`、`dist/dsh-fang-3.6.1.tgz.sha256`。
