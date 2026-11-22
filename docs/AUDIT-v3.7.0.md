# v3.7.0 审计（2026-11-22）

> 用户指令：修复 5 项问题并「随新版本发布」；版本号 **3.7.0**（用户确认）。
> 基线 v3.6.2（`32a496c`）。本版含行为变更，按 minor 发布。

## 1. 范围

| # | 项 | 说明 |
|---|---|---|
| 1 | 元主插件设置同步 | 分身创建/还原/换核前捕获 `essence-runtime` profile 到元宝 overlay，再重算 merged；内置/实验性/第三方开关下一次打开生效 |
| 2 | queue-journal 默认关闭 | 父 bundle + 子包 patch 均 `disabled: true`；queue-journal 0.1.8 |
| 3 | 默认元宝不重复 | 优先「开发者推荐（官方）」；官方存在时不再自动捕获快照；历史自动「默认元宝」归档 |
| 4 | 开发者推荐语义 | 推荐清单 install/enable 两组 + 已安装实验性插件默认开启；依赖跟随母体 |
| 5 | 2xray 缺包 | merged/runtime profile 缺失顶层依赖从母体补齐 |

## 2. 验证（真实数字，发布前实测）

- 全量 `npm test`：**1318 pass / 0 fail / 2 skip**（1330 tests）。
- preflight --e2e：待回填。
- 发布 PR CI：待回填。
- release-order：待回填。
- verify-release --remote：待回填。

## 3. 风险与边界

- 推荐清单里本机未安装的第三方包**不会自动 pnpm 安装**；只对已安装项写入启用/禁用行。
- 官方元主仍锁定；不复制凭据/会话。
- 运行时捕获发生在开分身/换核/停止元主时；元主 Web 内未落盘的瞬时编辑不在保证范围。

## 4. 回滚

- 触发方式：插件层 `npm i @twinsearth/fang-dsh-plugin@3.6.2`。
- 恢复耗时：分钟级。
- 证据：`dist/preflight.json`、`dist/release-verify.json`、`dist/dsh-fang-3.7.0.tgz.sha256`。
