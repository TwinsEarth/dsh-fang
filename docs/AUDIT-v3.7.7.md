# v3.7.7 审计（2026-11-23）

> 用户指令：**“三方发布，v3.7.7”**。基线 v3.7.6。

## 范围

1. 修复 Vault 导入/导出按钮无反应：Electron 不支持 `window.prompt`，改为应用内对话框。
2. GitHub 仓库改名为 `TwinsEarth/fang-dsh-plugin`，更新 canonical URL 与发布工具元数据。
3. 插件市场目录新条目/旧条目移除（外部 PR，另行审核）。

## 验证（待回填）

- 全量 tests：**1331 pass / 0 fail / 2 skip**；
- preflight --e2e：**GREEN；e2e 125/125**；
- 发布 PR CI：
- release-order：

## 边界

- 运行中的 3.7.6 不含本修复；需停宿主部署 3.7.7。
- GitHub 旧仓库名自动重定向；npm 包元数据中的旧 repository 在下次发版前仍指向旧名，但可重定向。
