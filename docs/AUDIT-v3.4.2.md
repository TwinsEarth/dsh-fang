# AUDIT v3.4.2

范围：加速 Web sidecar 与母体面板加速模式。

## 架构

| 项 | 值 |
|---|---|
| 原厂进程 | 保留，不替换 core |
| 加速进程 | 独立 `@twinsearth/dsh` Web sidecar |
| 切换方式 | 面板启动/打开新窗口；浏览器刷新 |
| 分身 | `coreMode` 选择 stock/accelerated |

## 验证

| 项 | 结果 |
|---|---|
| forker/compat | 40 pass |
| orchestrator | 68 pass |
| sidecar start/status/stop | 通过 |
| 原厂模式 | 不受影响 |
