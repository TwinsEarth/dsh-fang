# AUDIT v3.1.5

> 版本：3.1.5（2026-11-09）
> 主题：排队消息列表恢复 + 分身 UI/插件设置入口修复。

## 1. 本版变更

| 项 | 状态 |
|---|---|
| queue-journal 0.1.4 扫描 DSH `[data-queue-dock]` 列表 | ✅ |
| 分身 Web 不再渲染母体 404 错误横幅/母体控件 | ✅ |
| fork 隐藏插件设置入口（ui-plugin-manager / ui-settings-plugin-inventory） | ✅ |
| essence-runtime spawn 不再重新上锁 | ✅ |

## 2. 门禁证据

```text
preflight --e2e : GREEN
tests           : 1031 total / 1020 pass / 0 fail / 1 skip / 10 todo (185.0s)
e2e             : 81/81 (23.3s)
install drill   : GREEN 10/10
reinstall drill : GREEN 7/7
artifact        : 512,662 B / 135 entries
sha256          : 4fd2db4babe8920e693b4c92ca3f2f2d0891bd3dde4d1918d0a916ffc5c947ee
```

## 3. 发布

| 方 | 状态 |
|---|---|
| GitHub Release | 待执行 |
| npm | 待执行 |
| CI | 待执行 |
