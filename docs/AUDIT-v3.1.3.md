# AUDIT v3.1.3

> 版本：3.1.3（2026-11-09）
> 主题：新机器迁移修复 + 排队消息列表恢复。

## 1. 本版修复

| 问题 | 修复 |
|---|---|
| v3.1.2 队列只能恢复单草稿 | 根 `optionalDependencies` 的 queue-journal 从 0.1.2 升到 **0.1.3**（含 `queueRestore`/恢复列表） |
| npm 安装后分身 `fork-bundle-unavailable` | 分身 bundle 检查同时接受 `@local/dsh-fang` 与 `@twinsearth/dsh-fang` |
| 元宝运行时 `cannot resolve profile bundle` | runtime profile broken `node_modules` junction 自动删除并重指到 `essenceModules` |
| 迁移数据旧机器路径 | 记录并继续清理 `file:`/`link:`/绝对路径依赖 |

## 2. 门禁证据

```text
preflight --e2e : GREEN
tests           : 1027 total / 1016 pass / 0 fail / 1 skip / 10 todo (176.3s)
e2e             : 81/81 (16.9s)
allow-list      : routes=104 findings=0
install drill   : GREEN 10/10
reinstall drill : GREEN 7/7
artifact        : 511,133 B / 135 entries
sha256          : be6fa090b4499f64312f11cf7f3b3c65a063fee68097a9d489b6422a20c56cda
```

## 3. 发布

| 方 | 状态 |
|---|---|
| GitHub Release | 待执行 |
| npm | 待执行 |
| CI | 待执行 |
