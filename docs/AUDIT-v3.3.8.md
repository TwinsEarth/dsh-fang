# AUDIT v3.3.8

范围：默认元主版本自动同步。

## 触发

- 宿主启动后 1.5s；
- 或 `service.refreshDefaultEssence()`。

## 判定

```text
无默认元主            → skipped
默认包是 legacy       → refresh
默认同名但版本过旧    → refresh
默认同名且版本一致    → skipped already-current
```

## 结果

- 新元主 ID 写入 `default-essence.json`；
- 旧元主保留（不删除）；
- `status.essenceAutoRefresh` 可查。
