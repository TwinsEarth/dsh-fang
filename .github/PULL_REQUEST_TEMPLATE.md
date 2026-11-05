<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
## 这个 PR 做了什么

<!-- 1–3 行；关联 issue 用 #123 -->

**目标版本**：`v3.__.__`（必须等于 package.json / FANG_VERSION / CHANGELOG 段的版本）
**风险级**：L0 只读 / L1 增量 API / L2 状态变更（指针·实例·写盘） / L3 依赖与插件变更
**回滚锚点**：<!-- 上一代目录 / merged-v* / plugin snapshot 名称；L2/L3 必填 -->

## 检查清单（勾选前请真的跑过）

- [ ] `node --test --test-concurrency=1 "test/*.test.mjs"` 全绿（贴 `pass/fail/skip`）
- [ ] `node tools/git/pr-gate.mjs` 全绿（版本阶梯 / 线性 / 路径 / 提交信息 / SPDX）
- [ ] 新文件带 `SPDX-License-Identifier`（核心层 AGPL-3.0-or-later / 生态层 MIT）
- [ ] 没有提交 `dist/`、`*.jsonl` 审计/注册表等运行数据
- [ ] 改动不涉及 `relay-server/`、`enterprise/`（商业层不接受外部 PR）
- [ ] 分支已 `git rebase origin/main`（无 `Merge branch 'main' into feat/...` 提交）
- [ ] 本次改动只有一个提交主题：`<type>(v3.__.__): <一句话>`
- [ ] **CLA**：我已在下方声明签署

## 门禁证据（L2/L3 必填）

| 项 | 值 |
|---|---|
| 全量测试 | pass=__ fail=0 skip=__ |
| e2e（`node tools/e2e.mjs`） | __/__ |
| 路由契约 / 插件行数 | __ / 16 |
| 回滚演练（L2/L3） | 触发方式：__ 恢复耗时：__ |
| `dist/preflight.json` | GREEN / RED |

## 影响面

<!-- 涉及插件/角色矩阵/协议/许可分层时说明；破坏性变更写迁移方式 -->

> `I have read the CLA and I sign it.`
> GitHub 用户名：
> 真实姓名 / 主体：
