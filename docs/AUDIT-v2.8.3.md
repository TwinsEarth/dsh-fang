# 审计报告 · dsh-Fang v2.8.3（严格模式 + 语法错误的回退语义）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 3 个补丁位（`2.8.2` → `2.8.3`）。

## 1. 本次交付

扩展组 4 测试，覆盖「严格模式 × 编译/语法错误」组合；测试暴露了一个真实设计缺陷并已修复：

| 变更 | 内容 |
|---|---|
| 事务化 rebuild | `rebuild` → 纯计算 `computeRebuild(layerList)`，返回 `{ applied, effective, status }`；`applyLayer`/`applyConfig`/`clearLayers` 仅在 `applied` 时提交。失败时 `layers`/`effective`/`status`/`strictMode` 全部保持旧值 |
| 失败层隔离 | 失败层不进入 `layers`，后续层看到的层栈与「失败层从未尝试过」完全一致 |
| 回退目标可见 | 失败结果新增 `revertedToLayerIndex`（`-1` = 内置全集）；`ruleConfigStatus()` 每层记录该字段 |
| YAML 解析修正 | 支持 flow 映射 `{ k: v }` 与嵌套 flow 列表 `[{ re: "..." }]`（深度感知、尊重引号） |

## 2. 测试暴露的真 bug（重要）

`settings: { failOnInvalidPattern: true }` 这类 **flow 映射**在旧解析器里被当成**标量字符串**：

- `validateRuleConfig` 看到 `settings` 不是对象 → 全部回落默认值（`failOnInvalidPattern:false`）；
- 结果：**用户写了严格设置却被静默忽略**，非法正则只产生 warning 而不是整层拒绝；
- 这类「配置看起来生效、实际没有」比报错危险得多，属于必须修的静默降级。

修复后 flow 映射/嵌套 flow 列表均按结构解析；解析失败会给明确错误，不再静默。

## 3. 失败回退语义（组 4A–4E，全部有测试）

| 场景 | layers | effective | strictMode | 返回 |
|---|---|---|---|---|
| 严格层成功 | 追加 | 严格结果 | 新值 | `applied:true, source:'strict-replaced'` |
| 严格层失败 | **不追加** | 上一个成功层 | 上一个成功层 | `applied:false, revertedToLayerIndex:N` |
| 失败后 `inherit:true` 层 | 追加到旧栈 | 叠加到上一个成功层 | 保持 | `applied:true` |
| 首个层就失败 | 空 | 内置 15 条 | `null` | `applied:false, revertedToLayerIndex:-1` |

对应测试：4A（回退到 default）、4B（回退到第一个严格层，不是内置全集）、4C（失败层对后续层不可见）、
4D（layers/effective/strictMode 状态隔离）、4E（插件层状态报告）。

## 4. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.8.3** |
| 测试 | **499 项：498 pass / 0 fail / 1 skip（25.8s）**；`rule-config` 30 → 35 项 |
| e2e | **58/58（17.0s）** |
| allow-list | **36 路由 / 0 findings / 168 文件扫描 / 包内 73 文件** |
| 构建 | `dist/dsh-fang-2.8.3.tgz`（**285,267 B，90 entries**）<br>sha256 `1c4f4eb8a5e582e731344a077e95037b912e8322f24990c9fe693acc7dbb03ac` |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.8.3`（16 个模块可 import） |

## 5. 发布状态（GitHub Release）

- 已创建 **GitHub Release `v2.8.3`**（见仓库 Releases），资产：
  `dsh-fang-2.8.3.tgz`（285,267 B，sha256 `1c4f4eb8…`）+ `dsh-fang-2.8.3.tgz.sha256`；
- **发布基线（如实声明）**：`main` 目前不含 v2.8.x 代码（PR #27–#33 仍为 stacked、未合并），
  因此 tag `v2.8.3` 指向 **PR #33 的 head commit**，Release 标记为 `prerelease`。
  维护者合并 PR 链后可把 tag 指向 main 的 merge commit 并取消 prerelease（命令见发布说明）。
- 分支：`feat/umbrella-strict-errors`（stacked 在 PR #32 的 `feat/umbrella-strict-mode` 之上）；
- npm 发布未执行（沿用既有约定：等待合并与维护者确认）。

## 6. 已知缺口

- `types/` 的 TypeScript 参考实现仍未镜像 v2.8.x 规则配置层（含严格模式/事务回退）；连续第四个版本登记，
  建议下个补丁专门补齐，不再拖延。
- 热加载依赖 `fs.watch`；网络盘/容器挂载可能不触发，`reloadRules()` 兜底。
