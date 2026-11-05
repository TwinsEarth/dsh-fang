# 审计报告 · dsh-Fang v3.0.5（安全止血完整包）

> 本机真实输出（2026-11-03）。版本线：… v3.0.3 → v3.0.4 → v3.0.5。

## 1. 交付（B1/B2/B3/B4/B5/B6/B8）

| 编号 | 修复 | 关键点 |
|---|---|---|
| B1 | 路由鉴权/CSRF/Host | `http-auth.mjs`（0600 token、loopback Host、Origin/Sec-Fetch-Site、写请求 JSON）；`/fang/api/auth-token` 同源 bootstrap；client.js 自动携带 header |
| B2 | Adapter fail-closed | fork 无 token 默认 401；仅显式 `allowLegacyNoToken` 允许 v2 兼容 |
| B3 | 路径穿越 + 大小上限 | bundle 源/目标双侧 containment；bundleId 安全段；targetHome 白名单；导入单文件 64MB/总量 512MB/2000 文件；请求体 1MB → 413 |
| B4 | token 去 URL/不落盘 | remote 仅 Authorization；forker/list/forks.json 去 token；tasks.json 不落 token；`GET /tasks/open-url` 内存临时下发带 token URL |
| B5 | 派生 env 白名单 | `buildForkChildEnv` 仅继承运行时/代理变量 |
| B6 | 官方原身 create-only | 已存在 id 拒绝；locked/official 仅内部 seed 可设；篡改后修复 |
| B8 | 凭据不复制 | `merged/profile` 永不包含 `credentials/` |

## 2. 门禁（本机）

- preflight **GREEN 3.0.5**：636 tests / 0 fail / 1 skip、e2e **59/59**、**52 路由 / 0 findings**；
- build `dsh-fang-3.0.5.tgz` 待本提交后重建并记录；
- healthz **HEALTHY**。

## 3. 已知例外与后续

- SSE `eventsUrl` 仍以 query 携带 token（EventSource 无法设 header）；改造 fetch streaming 后消除。
- session-sync 路由尚未接入 B1 token 校验（其数据入口已有 B3 containment）；列入 v3.0.6。
- B7/B9/B10（permissions 接线、compat 强制执行、junction 只读）留给 v3.0.6。
- 严格发布序列仍从 v3.0.0 起按序补发，不跳号。

