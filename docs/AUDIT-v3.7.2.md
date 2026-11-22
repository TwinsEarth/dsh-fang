# v3.7.2 审计（2026-11-22）

> 用户指令：元主插件状态/配置自动同步到派生分身（每次打开）、官方实验性插件全部打开；版本 3.7.2（用户确认）。基线 v3.7.1。

## 根因

1. `ensureDefaultEssence` 在官方已是默认时提前 return，不再 repair；official merged profile 长期是 fang 3.6.2。
   分身派生 `profileUsesCurrentFangBundle` 判 stale → 静默回退 clean template → 实验性/第三方插件全部丢失。
2. 实验性列表按 `@deepseek-ai/dsh-experimental-*` 前缀过滤，漏掉 `dsh-personalized-recommendations`、`dsh-cua-bundle`、`dsh-deepseek-chat-import` 等。
3. `serializePatchEntries` 写 `{ insert: [...] }`，DSH app-boot 要求顶层数组，profile 加载失败。
4. runtime capture 未捕获 `settings/*` 配置参数。

## 修复

- 官方每次使用前 repair；版本化补齐 node_modules；实验性使用 DSH 完整 15 bundle 集合。
- patch 序列化统一顶层数组；fork patch 写入同格式。
- capture 增加 settings；创建/还原/修复前捕获运行态。
- 新增回归测试：官方派生/模板分身都带实验性 bundle+enabled 行；patch 顶层数组。

## 验证

- 全量 `npm test`：**1319 pass / 0 fail / 2 skip**（1331 tests）。
- preflight --e2e：待回填。
- CI：待回填。
- 真机：fork 18002 profile 已修复并重启，DSH 启动仅提示 cua darwin-only 跳过。

## 边界

- 运行中的旧分身需重启；未安装的推荐包不自动安装。
