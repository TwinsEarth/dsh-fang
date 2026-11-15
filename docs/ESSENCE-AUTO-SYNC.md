# 默认元主自动同步

生效版本：`v3.3.8`

## 解决的问题

升级后默认元主仍固定在上一个版本（例如 3.3.7 的 merged profile），
继续派生就会得到旧 bundle 的 fork：Adapter 404，Healer/HotReloader/Buffer 不挂载。

## 启动行为

1. 读取 `default-essence.json`；
2. 读默认元主的 merged/profile/package.json；
3. 若 bundle 是旧包，或同名但版本 != 当前 `FANG_VERSION`：
   - `captureFromProfile` 当前母体 profile；
   - `setDefault` 到新元主；
   - 写审计 `essence-auto-refreshed`；
4. 失败只记 `essence-auto-refresh-failed`，不阻塞启动。

## 兜底

- 旧 legacy bundle 仍走 `fork-template-stale` → clean template 回退；
- 单个派生请求仍会在 `createTask` 检查模板，避免自动同步完成前的竞态。

## 手动触发

`service.refreshDefaultEssence()`，或重启宿主后等待约 1.5s。

## 验证

- `profileUsesCurrentFangBundle`：旧包 / 同名旧版本均 false；当前版本 true；
- `status.essenceAutoRefresh` 暴露最近一次结果。
