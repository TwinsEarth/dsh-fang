# v3.8.4 发布记录（页面文件硬门禁，发布进行中）

> 基线 v3.8.3（未单独发布，内容并入本版）。本版只做安全门禁与回归，不改 DSH 安装、不改系统页面文件、不改数据根。

## 门禁

| 项 | 结果 |
|---|---|
| 版本一致 | package.json / `FANG_VERSION` / `CHANGELOG ## v3.8.4` 均为 3.8.4 |
| 定向测试（VM） | pagefile-safety + client-safe-mode + client-migration-report + client-pagefile-banner + kernel + memory-guard + plugins-shape + role-extensions：**56 pass / 0 fail** |
| orchestrator + open-fork（VM） | **75 pass / 0 fail / 0 cancelled**（不带 `--test-force-exit`） |
| 全量测试（VM） | 见下方回填 |
| e2e（真实 DSH） | 见下方回填；需 Windows + DSH CLI |
| 构建 / package smoke / crash-safety / main-city | 见下方回填 |
| npm publish / GitHub Release / tag | 见下方回填 |

## 变更

- Safe Mode 解除必须重新读取 `Win32_PageFileUsage`：`pageFileMB > 0` 且 `commitFreeMB >= hostCriticalFreeMB`；页面文件缺失时按钮禁用并显示原因，不能只信复选框。
- Fang `apply()` 启动前检测页面文件；缺失直接进入 Safe Mode（`reason=pagefile-missing`），`createTask`/`restoreTask`/`syncTaskOnOpen`/`autostartForks` 不拉起分身/浏览器。
- `openMigrationReport` 在 Fang 可控调用点做 `typeof` 防护；缺失时提示并单独归为 DSH 客户端 API 问题。
- 新增 `test/pagefile-safety.test.mjs`；定向组合与 Safe Mode autostart 集成回归。
- 收录 v3.8.3 未发布内容：Job Object、旧 workspace 映射、拒绝外部浏览器回退、P1/P2 接线、元主 Web boot 修复、打开分身状态归位、service 面修复、迁移报告漏挂修复。
- 版本号：`3.8.3` → `3.8.4`。

## 产物

- tarball：待构建
- SHA-256：待构建
- 上传 URL：待构建
- npm：待发布
- GitHub Release：待发布
- tag：待创建

## 未完成 / 风险

1. 页面文件仍是系统级前置条件；Fang 只能检测并进入 Safe Mode。页面文件修好前，不能保证 Host 在加载阶段不崩。
2. 真实 Windows 宿主上的 pagefile 缺失场景需部署后复测；本版代码/单测在 VM 完成。
3. 不自动安装/更新 DSH 插件；部署、重启、启用页面文件均需用户手动二次确认。
4. `openMigrationReport` 归属仍按 Fang 侧防护处理，未改 DSH core；如确认是 DSH 客户端问题，单独上报。
