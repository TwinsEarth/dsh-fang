# 推荐基线配置与分层规则（v2.8.1）

> 基线文件：`defaults/umbrella-rules.yaml`（随包分发）。
> 实现：`src/lib/rule-registry.mjs`（分层 + 硬规则锁定）、`src/plugins/umbrella.mjs`（三层加载与状态）。
> 契约：`docs/CONTRACTS-V2.md §5.9`；YAML 能力总览：`docs/UMBRELLA.md §2.4`。

## 1. 设计原则

基线**不替用户做所有决策**，只做三件事：

1. **把红线钉死**：`dsh-lifecycle` / `destructive-command` / `credential-access` 显式 `enabled: true`，
   带 `hard-deny + non-negotiable` 标签，项目层**不能关闭、不能降低灯色**。
2. **把可调规则留给项目**：基线只写一行注释表列出推荐默认值；未列出的规则 = 内置默认，
   项目在自己的叠加层里按需覆盖。
3. **把接入点留出来**：三层加载顺序（基线 → 项目 → 环境）与 fail-safe 语义写进文档与代码。

## 2. 基线内容（`defaults/umbrella-rules.yaml`）

基线只显式锁定 4 条规则：

| id | 灯色 | 优先级 | 标签 | 说明 |
|---|---|---|---|---|
| `dsh-lifecycle` | red | 10 | hard-deny, non-negotiable, delegate-to-restart-guard | 宿主动作 → restart-guard |
| `destructive-command` | red | 20 | hard-deny, non-negotiable | 破坏性命令 |
| `credential-access` | red | 30 | hard-deny, non-negotiable | 凭据访问（唯一硬拒绝） |
| `unknown-tool` | yellow | 9999 | conservative, non-negotiable | 兜底安全网，永远最后 |

设置：`failOnUnknownRule: false`（基线可能领先于代码）、`failOnInvalidPattern: true`（正则/声明式规则
编译失败整层拒绝）、`rejectUnsafeRegex: true`。

可调规则（`network-allowlisted` blue/40 … `read-outside-buffer` blue/140 等 11 条）**不写在基线里**，
只在注释中给出推荐值——这样升级内置默认值时不会与基线里的旧副本打架。

## 3. 分层与合并

```
defaults/umbrella-rules.yaml（随包基线，默认自动加载）
        ↓ 按 id 覆盖
<project>/.dsh/umbrella-rules.yaml（插件配置 rulesFile）
        ↓ 按 id 覆盖
$UMBRELLA_RULES_PATH（环境级，CI/部署注入；插件配置 envRulesFile 可覆盖该路径）
```

- 每层独立校验；**层内规则**按 id 覆盖前层结果，未提及的规则保持前层值；
- 声明式新规则（带 `match`）插入到优先级对应位置；同优先级按内置顺序稳定排序；
- 优先级基线 `DEFAULT_RULE_PRIORITIES`，层内 `priority` 可覆盖。

## 4. 锁定语义（不可协商）

`NON_NEGOTIABLE_TAGS = ['hard-deny', 'non-negotiable']`。判定依据是**当前生效规则**的标签：

| 操作 | 结果 |
|---|---|
| `enabled: false` | ❌ 拒绝：`rule "X" is non-negotiable and cannot be disabled` |
| 降低灯色（red→yellow/blue/green） | ❌ 拒绝：`light cannot be lowered from red to yellow` |
| 提升灯色（yellow→red）、改 `reason`、追加 `pathPatterns`/`commandPatterns` | ✅ 允许 |
| 改 `priority` | ✅ 允许（顺序可用，但硬规则一般不该被挪到兜底之后） |

**锁定违规一律 fatal**（不受 `failOnInvalidPattern` 影响）：被拒绝的层会**从层栈弹出**，
effective 恢复到不含它的上一次有效规则，并返回 `applied: false` + 错误列表。
否则一个坏层会污染后续所有层的 rebuild。

## 5. 部署位置与加载顺序

| 层 | 路径 | 谁维护 | 缺失时 |
|---|---|---|---|
| baseline | 包内 `defaults/umbrella-rules.yaml`（`baselineFile` 可覆盖；`:none:` 关闭） | 包作者 | 跳过基线（不报错） |
| project | 插件配置 `rulesFile` | 项目团队 | 跳过（不报错） |
| env | `UMBRELLA_RULES_PATH` 或插件配置 `envRulesFile` | CI/部署 | 跳过（不报错） |

插件启动时按序 `applyLayer`；`ruleConfigStatus()` 返回 `layers[]`（每层 `name/file/applied/found/errors`）
与总 `ruleCount/applied/warnings/errors`。热加载监听「项目文件优先，其次环境文件，最后基线」中的第一个，
变化后重读全部层（整份重新应用，不是增量）；`reloadRules()` 是手动兜底入口。

## 6. 覆盖率边界（如实说明）

1. **`light: blue` 不能把 `network-egress` 变成"内网放行"**：该规则谓词看 allowlist；
   要放行内网域请把它们加进 `policy.networkAllowlist`，而不是只改灯色。
2. **追加 pattern 是「或」语义**：追加让规则更容易命中。基线只允许通过项目层追加，
   且对硬规则是"扩大覆盖面"，不会造成漏判；但把大范围正则加到 `destructive-command` 上会提高误报，
   属于项目自己的取舍（`reason` 应写清）。
3. **兜底双保险**：`unknown-tool` 既有 `non-negotiable` 标签，又是规则表最后一项（priority 9999）。
   即使锁定逻辑失效，排序仍让它兜底。

## 7. 已知缺口

- `types/` 的 TypeScript 参考实现**尚未镜像** v2.8.0/v2.8.1 的 YAML 配置层（基线/分层/锁定），
  仍停留在 v2.7.9 语义（声明式规则表 + AST-lite 解析）。已在 `docs/AUDIT-v2.8.0.md §6` 与
  `docs/AUDIT-v2.8.1.md` 登记，计划后续补丁补齐。
- 热加载依赖 `fs.watch`：Windows 正常；网络盘/容器挂载可能不触发，用 `reloadRules()` 兜底。
