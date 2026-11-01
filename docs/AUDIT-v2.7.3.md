# 审计报告 · dsh-Fang v2.7.3（重启结果事件化）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 3 个补丁位（`2.7.2` → `2.7.3`）。

## 1. 背景：仓库已有「事件优先 + 轮询兜底」

设计稿要求把 TaskHandle 的 `waitForRestart` 从轮询改为事件驱动。仓库现状并非纯轮询：

- v2.6.7 起 `waitForRestart` 已经**优先由 `fang/fork-started` 事件唤醒**（`handleForkStarted`
  → `restartSlot.finish`），`forker.status()` 轮询只是事件丢失时的兜底；
- `stop()` 已调用 `restartSlot.finish(stopping)`，等待中的重启会被立即打断；
- TaskHandle 不自己挂 child `exit` handler，崩溃统一由 Forker 的 `fang/fork-crashed` 驱动，
  不存在「attach 两次」的问题。

**真正缺失的**是「重启失败」信号：重启 spawn 失败或 supervise 放弃时，Forker 不广播任何事件，
TaskHandle 只能等 `restartTimeoutMs`（默认 60s）超时。本版本补齐该事件。

## 2. 变更

### Forker（`src/plugins/forker.mjs`）
- 新增事件 `fang/fork-restart-failed { forkId, error, terminal }`：
  - `restartFork` spawn 失败 → `terminal:false`（Forker 可能按 supervise 计划再试）；
  - `planRestart action=give-up`（crash 超限）→ `terminal:true`；
  - `restart-no-cli` → `terminal:true`。
- 既有 `fang/fork-started`（每次 spawn）仍是**成功**完成信号，不新增重复的 `fork-restarted`。

### TaskHandle（`src/lib/task-handle.mjs`）
- `FORK_EVENT.RESTART_FAILED` + 订阅；`handleForkRestartFailed`：
  - `terminal=true` → `restartSlot.finish(error)`，立即 `failed`，不等超时；
  - `terminal=false` → 只记日志、保持 `reconnecting`，由后续 `fork-started` / 轮询兜底推进；
  - `taskId` 不匹配忽略。
- 保留「事件优先 + 轮询兜底」；`stop()` 打断逻辑不变。

### 与设计稿的刻意差异
- 设计稿的 `fork-restarted` 不新增：等价于既有 `fang/fork-started`；
- 设计稿说「非 terminal 也 settle(false)」，仓库改为**继续等待**：Forker 明确还会重试时，
  立即标 failed 是误判；终态才 fail-fast。

## 3. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.7.3** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **407 pass / 0 fail / 1 skip（408 项，24.1s）** |
| e2e 实机验收 | 同上 | **57/57（14.9s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：36 路由、0 findings、147 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.7.3.tgz`（**248,055 B，85 entries**）<br>sha256 `ce099593957b50f67b2cb0c9d00409d843b48876b5a17adbf60d2fc7a867546d` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.7.3`（15 个模块可 import） |

## 4. 新增测试

- `test/task-handle.test.mjs` 新增 3 项（20 项）：
  1. terminal `restart-failed` 立即 failed（restartTimeoutMs=5000，30ms 内失败）；
  2. 非 terminal `restart-failed` 保持 reconnecting，随后 `fork-started` 恢复 running；
  3. taskId 不匹配的 `restart-failed` 被忽略。
- `test/forker.test.mjs` 新增 1 项（27 项）：`supervise:true, maxRestarts:0` + crash CLI →
  emit `fang/fork-restart-failed`（terminal=true，error 含 restart-given-up）。

测试计数：404（v2.7.2）+ 4 = **408 项**（407 pass / 1 skip），与 preflight 输出一致。

## 5. 边界

- 重启成功仍以 `fang/fork-started` 为准；`restart-failed(terminal=false)` 只是「这次失败」，
  不代表进程已就绪或已终态。
- `restartTimeoutMs`（默认 60s）保留：Forker 卡死/事件丢失时 TaskHandle 仍会超时失败。
- 事件是 kernel bus 进程内的；跨进程（母体重启）不适用——新实例不会收到旧事件。
- 只用于 TaskHandle；其它订阅者按 `taskId` 过滤。

## 6. 提交状态

- 分支：`feat/restart-events`（stacked 在 PR #21 的 `feat/forker-token-registry` 之上）；
- 发布物：`dist/dsh-fang-2.7.3.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
