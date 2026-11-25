# 审计报告 · dsh-Fang v2.8.2（`inherit: false` 严格模式）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 2 个补丁位（`2.8.1` → `2.8.2`）。

## 1. 本次交付

`inherit: false` = **严格模式**：丢弃此层之前所有可调规则，只保留硬规则 + 兜底，再从该层开始叠加。
安全边界（硬规则 / fallback）不能被任何配置拆掉。

| 交付物 | 内容 |
|---|---|
| YAML schema | 顶层 `inherit: boolean`（默认 `true`）；非布尔报错 |
| `registry.rebuild` | 以**最后一个** `inherit:false` 层为起点；它之前的层全部丢弃；起点层与之后层正常叠加 |
| 严格模式保护 | 初始表 = 内置规则中 `isLockedRule()` 或 `category === 'fallback'` 的规则；优先级表随之收窄 |
| 规则复活 | 严格模式之后的层可按 id 引用被丢弃的内置规则（用内置定义复活并覆盖），不必重写谓词 |
| 安全网 | rebuild 结果若无 fallback → 视为 bug，拒绝应用 |
| 返回值 | `source: 'strict-replaced'` + `strictMode: { layerIndex, preservedHardRules, preservedFallback, discardedRuleCount }` |
| 插件 | `ruleConfigStatus().strictMode`；激活时写 `AUDIT.UMBRELLA_STRICT_MODE`（kernel 新审计类型）+ info 日志 |
| 文档 | `docs/RULES-BASELINE.md §8`（语义矩阵/示例）、`CONTRACTS-V2.md §5.9` |

## 2. 语义矩阵（有测试）

| 场景 | `inherit: true` | `inherit: false` |
|---|---|---|
| 未列出的可调规则 | 保持上一层/内置 | **从表中删除** |
| 未列出的硬规则 | 保持 | **强制保留** |
| 兜底 `unknown-tool` | 保持 | **强制保留**（缺失即拒绝应用） |
| 关闭/降级硬规则 | 拒绝 | 拒绝（锁定违规 fatal） |
| 追加 pattern / 提升灯色 | 允许 | 允许 |
| 后续 `inherit: true` 层 | 叠加 | 叠加到严格结果；不恢复被丢弃规则（除非按 id 显式引用） |
| 多个 `inherit: false` | — | 最后一个生效，之前的层全部丢弃 |

## 3. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.8.2** |
| 测试 | **494 项：493 pass / 0 fail / 1 skip（24.6s）**；`rule-config` 23 → 30 项 |
| e2e | **58/58（15.5s）** |
| allow-list | **36 路由 / 0 findings / 167 文件扫描 / 包内 73 文件** |
| 构建 | `dist/dsh-fang-2.8.2.tgz`（**284,690 B，90 entries**）<br>sha256 `b28e5e9eb8a186102689f1e46b69b2f591d069f12ccb12171e6f16f7bba23861` |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.8.2`（16 个模块可 import） |

## 4. 刻意的决策

1. **严格模式不拆安全边界**：硬规则与 fallback 强制保留。想彻底关掉安全规则 = 不在 YAML 层提供该能力。
2. **锁定违规一律 fatal**：不受 `failOnInvalidPattern` 影响（它是策略违规，不是正则笔误）。
3. **优先级重置**：严格模式只保留硬规则+fallback 的优先级；用户新增规则未写 `priority` 用默认 500
   （文档已提示「严格模式建议显式写 priority」）。
4. **复活语义**：严格模式后按 id 引用被丢规则时用内置定义复活——否则严格模式会逼用户重写内置谓词，
   等于把安全逻辑抄一遍，必然漂移。
5. **审计必写**：严格模式是"项目主动放弃内置可调规则"的重大行为，必须可事后追溯（层号/保留项/丢弃数）。

## 5. 边界与已知缺口

- 严格模式下若用户**不写**某条可调规则，它就不存在：相关动作会落到 fallback 判黄（更保守，不漏放）。
- 严格模式的"保留硬规则"来自**内置规则自身标签**；基线层在此之前加的标签会随层被丢弃（可预期）。
- `types/` 的 TypeScript 参考实现**仍未镜像 v2.8.x 规则配置层**（含严格模式）；`types/` 停在 v2.7.9 语义。
  连续三个版本登记同一缺口，计划在后续补丁集中补齐。
- 热加载依赖 `fs.watch`；网络盘/容器可能不触发，`reloadRules()` 兜底。

## 6. 提交状态

- 分支：`feat/umbrella-strict-mode`（stacked 在 PR #31 的 `feat/umbrella-baseline` 之上）；
- 发布物：`dist/dsh-fang-2.8.2.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行；未合并 main：本 PR 只推送分支与 PR。
