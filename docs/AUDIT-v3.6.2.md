# v3.6.2 审计（2026-11-22）

> 用户指令（2026-11-22）：**三方发布，v3.6.2**。基线 v3.6.1。
> **本版为版本快照：v3.6.1 之后没有任何代码提交，功能与 v3.6.1 完全一致。**

## 1. 范围

| # | 项 | 说明 |
|---|---|---|
| 1 | 版本号 | `3.6.1 → 3.6.2`（patch），仅 package/FANG_VERSION/CHANGELOG/AUDIT/RELEASE |
| 2 | 代码 | **零变更**：`git diff v3.6.1..HEAD` 仅版本与文档 |
| 3 | 已含能力（来自 v3.6.1） | 加速分身会话兼容 shim、还原强制 reprovision、「启动」按钮修正 |

## 2. 验证（真实数字，发布前实测）

- preflight --e2e：**GREEN**；全量 tests **1314 pass / 0 fail / 2 skip**（1326 tests）；e2e **125/125**；allow-list 0（111 路由）；artifact sha256 match。
- 发布 PR CI：待回填。
- release-order：待回填。
- verify-release --remote / healthz --remote：待回填。

## 3. 风险与边界

- 无代码变更，不存在新行为风险；安装 v3.6.2 与 v3.6.1 等价。
- 不改变数据布局、不触碰用户会话/分身。

## 4. 回滚演练

- 触发方式：插件层 `npm i @twinsearth/fang-dsh-plugin@3.6.1`。
- 恢复耗时：分钟级。
- 证据：`dist/preflight.json`、`dist/release-verify.json`、`dist/dsh-fang-3.6.2.tgz.sha256`。
