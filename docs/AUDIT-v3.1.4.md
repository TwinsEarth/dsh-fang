# AUDIT v3.1.4

> 版本：3.1.4（2026-11-09）
> 主题：元宝工作区卡片 UI + 元宝运行态插件管理修复 + 发布流水线幂等。

## 1. 本版变更

| 项 | 状态 |
|---|---|
| 元宝卡片：独立方框、两行信息、雅黑 16px 名称、生成/同步时间 | ✅ |
| `essence-runtime` 跳过生产盘锁 + 清理历史 `tool-plugin-manager disabled` | ✅ |
| npm publish 幂等（202 / 403 previously published） | ✅ |
| final verify checkout `fetch-tags: true` | ✅ |
| queue-journal 0.1.3 | ✅ |

## 2. 门禁证据

```text
preflight --e2e : GREEN
tests           : 1029 total / 1018 pass / 0 fail / 1 skip / 10 todo (235.5s)
e2e             : 81/81 (62.9s)
allow-list      : routes=104 findings=0
install drill   : GREEN 10/10
reinstall drill : GREEN 7/7
artifact        : 512,302 B / 135 entries
sha256          : 416b4330d58ad82f5135ae7acaa35dd9c6ad17d9c8bd1194a8cbf6b613c7e3b4
```

## 3. 发布

| 方 | 状态 |
|---|---|
| GitHub Release | 待执行 |
| npm | 待执行 |
| CI | 待执行 |
| Release workflow | 待执行 |
