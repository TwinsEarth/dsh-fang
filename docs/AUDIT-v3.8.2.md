# v3.8.2 审计（2026-11-24）

> 用户指令：**“重大安全疏漏：三方发布，v3.8.2 修正”**。

## 问题

1. 默认数据根未固定到 `D:\ToFuture`；旧布局继续使用 `DSH_HOME/fang`。
2. 元宝/分身数据与母体/宿主/DSH 客户端共用目录，尤其 `E:\DSH\DS`。
3. 覆盖/混同风险。

## 修复

- `resolveFangHome()` 新默认 `D:\ToFuture\FangData`；显式 `FANG_HOME`、迁移指针优先。
- `resolveFangLayout()` 检测旧布局：目标无 tasks 且旧目录有 tasks 时继续读旧目录并标记 `legacyDataDetected`，绝不静默空面板。
- `enforceDataIsolation` + `forbiddenDataRoots`：禁止 `E:\DSH\DS` 等宿主/工程目录作为数据根或 fork home。
- 新空会话 workspace 默认 `<fork home>\workspace`；禁止默认使用客户端工程目录。
- `tools/migrate-fang-home.mjs`：停宿主、只复制、不删除、不覆盖、报告、指针。
- `deploy-profile.mjs` 优先新根。

## 验证

- data isolation 单测：3/3
- orchestrator：73/73
- e2e：125/125
- 全量 preflight：**GREEN；tests 1341 pass / 0 fail / 2 skip；e2e 125/125**
- 迁移工具：待停宿主真机执行

## 边界

- 迁移不自动执行；不删除旧数据。
- 旧 workspace 元数据不强制改写。
- Job Object / 官方 client 懒加载仍未做。
