# AUDIT v3.1.6

> 版本：3.1.6（2026-11-10）
> 主题：回滚 v3.1.5 回归（元宝运行态启动、分身 client pending）。

## 1. 本版修复

| 问题 | 修复 |
|---|---|
| `runtime-spawn-failed: exited`（元宝运行态） | forker.spawn 恢复对 essence-runtime 写生产盘锁；不再清锁/解除只读 |
| 分身 `pluginNavigation` pending | 不再禁用 `ui-plugin-manager`（该行提供 pluginNavigation）；只禁用 `ui-settings-plugin-inventory` |
| 历史 profile 遗留 `ui-plugin-manager disabled:true` | `applyForkConfigLock` 自动调用 clear 移除 |
| queue-journal 排队列表 | 0.1.4 修复保持不变 |

## 2. 门禁证据

```text
preflight --e2e : GREEN
tests           : 1032 total / 1021 pass / 0 fail / 1 skip / 10 todo (177.1s)
e2e             : 81/81 (19.0s)
install drill   : GREEN 10/10
reinstall drill : GREEN 7/7
artifact        : 512,660 B / 135 entries
sha256          : 66e150f73f15d4772ae6c7c4da15f6b310357f653b04fb13c6500f44bbffaec3
```

## 3. 发布

| 方 | 状态 |
|---|---|
| GitHub Release | 待执行 |
| npm | 待执行 |
| CI | 待执行 |
