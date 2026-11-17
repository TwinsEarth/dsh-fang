# 发布豁免：v3.5.2（跳号）

**豁免对象**：`@twinsearth/fang-dsh-plugin@3.5.2`（从 `3.5.0` 直接到 `3.5.2`，跳过 `3.5.1`）。

**理由（用户原话，2026-11-17）**：

> “三方发布：v3.5.2，统一走 PR → 门禁 → 合并 → 发布”

即版本号由用户在当次指令中**明确指定为 3.5.2**，属于发布纪律允许的「用户明确指定版本」情形；
`3.5.1` 从未发布、也不存在被占用的 tag/Release/npm 版本，因此该跳号不产生重号或覆盖风险。

**核查**：

- `git tag --list v3.5.1` → 空（无此 tag）；
- npm `@twinsearth/fang-dsh-plugin` 版本列表无 `3.5.1`（`latest` 仍为 `3.5.0`）；
- 本版内容 = v3.5.0 之后 4 个已推送分支（`feat/b8-pro-activation`、`feat/ui-client-half-map`、
  `feat/lsp-provider-a`、`fix/release-order-state`）的整合，无历史改写。
