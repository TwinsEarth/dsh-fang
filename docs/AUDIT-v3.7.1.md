# v3.7.1 审计（2026-11-22）

> 用户确认发布 3.7.1 修复补丁。基线 v3.7.0（`c22c43e`）。

## 范围

- 官方推荐清单行与镜像/母体同名行去重：避免 `dsh-context` 等“安装不开启”被镜像行重新启用。
- 3.7.0 既有修复保持不变。

## 验证

- 全量 `npm test`：1318 pass / 0 fail / 2 skip（本地）。
- preflight --e2e：**GREEN 10/10**；tests 1318/0/2；e2e 125/125；routes 111 / allowlist 0。
- 发布 PR CI（#149）：**8/8 绿**。
- `verify-release --remote`：**GREEN**；`healthz --remote`：**HEALTHY @3.7.1**。

## 风险与边界

- 只改 patch 合并行为；不安装新包、不改数据布局。
- 镜像行若被锁定（mirror-locked）则不强行删除，保持冲突可见。
