# 审计报告 · dsh-Fang v3.0.5（安全止血第一批）

> 本机真实输出（2026-11-03）。版本线：… v3.0.3 → v3.0.4 → v3.0.5。

## 1. 交付（B2/B3/B5/B6/B8）

| 编号 | 修复 | 关键点 |
|---|---|---|
| B2 | Adapter fail-closed | fork 无 token 默认 401；仅显式 `allowLegacyNoToken` 允许 v2 兼容 |
| B3 | 路径穿越 + 大小上限 | bundle 源/目标双侧 containment；bundleId 安全段；targetHome 白名单；导入单文件 64MB/总量 512MB/2000 文件；请求体 1MB → 413 |
| B5 | 派生 env 白名单 | `buildForkChildEnv` 仅继承运行时/代理变量；云密钥/自定义 token 不进入 fork |
| B6 | 官方原身 create-only | 已存在 id 拒绝；locked/official 仅内部 seed 可设；篡改后 seed 修复 |
| B8 | 凭据不复制 | `merged/profile` 永不包含 `credentials/` |

## 2. 测试

- 新增 `test/security-hardening.test.mjs` 5 项（create-only / seed 修复 / env 白名单 / bundle 穿越 / 大小上限）；
- 更新 `essence` 凭据断言与 `adapter` legacy auth 断言；
- 定向套件：security-hardening + essence + adapter + session-sync + forker = **91 pass / 0 fail**。

## 3. 仍未完成（同版本后续提交，tag 前置）

- **B1**：路由鉴权 / CSRF / Host 校验（所有 `/fang/api/*` 敏感路由）；
- **B4**：token 去 URL、去磁盘持久化（`tasks.json`）、Adapter token 管道交付；
- B7/B9/B10（官方原身 CRUD 授权、permissions 接线、compat 强制执行）。

## 4. 说明

- 本版本暂不 tag/Release：B1/B4 完成后才满足“安全止血包”退出条件；
- 严格发布序列仍从 v3.0.0 起按序补发。
