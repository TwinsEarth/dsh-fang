# v3.5.5 审计（2026-11-21）

> 用户指令（2026-11-21）：**三方发布，v3.5.5**。发布内容 = v3.5.4 之后合并进 main 的安全与静默错误修复（R28/R23/R13/R14/R15）+ CI 稳定性修复。

## 1. 内容

| # | 项 | 修复 | 证据 |
|---|---|---|---|
| R28 | auth-token bootstrap 收紧 | 回环 peer + 同源 Origin（host:port 完全一致）+ `Sec-Fetch-Site: same-origin\|none`；`no-store` | `src/lib/http-auth.mjs`、`src/plugins/orchestrator.mjs`；`http-auth` +3 测试 |
| R23 | pro 审批票参数绑定 | 签票必须带 `params`（缺 → 400 `approval-params-required`）；摘要 = `proParamsDigest(params)`（排除 ticket 自身）；consume 强制校验（`params-unbound`/`params-mismatch`） | `src/lib/pro-delegation.mjs`、`orchestrator.mjs`、`tools/e2e.mjs`；`pro-delegation` +3 测试、e2e +2 |
| R13 | mirror Promise 修复 | `getStatus()` 只读同步缓存；`refreshOfficialLatest()` 60s 缓存/in-flight 去重/异常捕获/保留上次成功版本 | `src/lib/mirror.mjs`、`orchestrator.mjs`；`mirror` +3 组测试 |
| R14 | 会话目录脱敏/形状 | title/preview/digest/seed 统一 `redact()`；服务补 `.list`/`.get`；compose 补装载 session-catalog | `src/plugins/session-catalog.mjs`、`src/compose.mjs`；`session-catalog` +3、`plugins-shape` +1 |
| R15 | 审计静默失败 | `auditor.appendStrict()`/`status()`；失败累计+限频告警+事件；`/fang/api/status.audit.health`；pro 签票 auditStrict（503 拒绝） | `src/plugins/auditor.mjs`、`orchestrator.mjs`；`auditor` +2 测试 |
| CI | 决策计时器竞态 + e2e 路径 | 提前触发重排（已含 v3.5.4 后主干回收 234729f）；e2e CLI 支持新安装根 `D:\DSH` | `decision-center.mjs`、`tools/e2e.mjs`、`.github/workflows/ci.yml` |

## 2. 测试与门禁

- 本地 preflight `--e2e`：tests **1300 pass / 0 fail / 2 skip**；e2e **125/125**；main-city A；allow-list 0（110 路由）；artifact sha256 match；
- 发布 PR CI：8/8 绿（gate required / test node22+24 / compat / hygiene / license；`e2e (self-hosted windows)` skipped——runner 离线，与既有版本一致）；
- release-order：10/10 GREEN。

## 3. 诚实边界

- **R28 不是进程隔离**：同机同用户进程仍可读 0600 token 文件或伪造请求头；本层只收敛浏览器跨站攻击面；
- **R23 行为收紧**：`/pro/approval` 必须带 `params`，旧调用方会收到 400（有意 fail-closed）；
- R15 的 strict 只覆盖安全关键路径（pro 签票）；其余 `audit()` 保持不抛但失败可见；
- 母体正式 profile 的 LSP 仍未安装；fork-local 默认关闭；
- 三方发布手动执行（self-hosted runner 离线）。
