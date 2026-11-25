# 审计报告 · dsh-Fang v2.8.0（动作规则表 YAML 化）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；`2.7.9` 已满位，本次进位到 **v2.8.0**。

## 1. 本次交付

动作规则表从「代码里写死的 15 条」变成「内置注册表 + YAML 叠加层」：可以按需启用/禁用、覆盖灯色与优先级、
追加正则、或用内置声明式 matcher 新增简单规则，**不改代码**。

| 交付物 | 内容 |
|---|---|
| `src/lib/rule-registry.mjs` | YAML 子集解析 / schema 校验 / 正则安全启发式 / 声明式 matcher+evidence 编译器 / RuleRegistry（事务化）/ 文件加载 / `fs.watch` 热加载 |
| 插件配置 | `rulesFile` / `rulesWatch` / `rulesDebounceMs` |
| 插件服务面 | `ruleConfigStatus()` / `reloadRules()` / `applyRuleConfig(config)` / `ruleRegistry` |
| 门面 | `createUmbrella({ registry })`：动作评分使用注册表规则（不传则沿用原规则集） |
| 示例 | `docs/UMBRELLA-RULES.example.yaml`（开关 / 覆盖 / 追加正则 / 声明式新规则 + matcher 清单） |
| 文档 | `docs/UMBRELLA.md §2.4`、`docs/CONTRACTS-V2.md §5.9` |
| 测试 | `test/rule-config.test.mjs` 18 项 + `test/umbrella.test.mjs` 原有 53 项（registry 兼容） |

## 2. 语义

- **叠加层**：内置规则永远存在，YAML 未提及的规则保持原样；
- **开关**：`enabled: false` 移除该内置规则；
- **覆盖**：`light` / `priority` / `reason` / `tags` / `category`；
- **追加正则**：`commandPatterns` / `pathPatterns` 包装原谓词（`原 match || 新正则`）；
- **声明式新规则**：9 种 matcher（`command-pattern` `path-pattern` `path-outside` `url-host-in`
  `url-host-not-in` `tool-in` `pid-equal` `always` `never`）+ 3 种 evidence（`pattern-match` `list-match` `static`）；
- **优先级**：`DEFAULT_RULE_PRIORITIES`（10…9999）为基线，YAML 可覆盖；同优先级按内置顺序稳定排序；
- **不支持的**（刻意）：任意 JS 谓词、动态计算路径、修改内置规则内部逻辑（`parseFailed` 语义）——
  YAML 是配置不是脚本，否则规则表无法通过阅读 YAML 审计。

## 3. fail-safe 矩阵（有测试）

| 失效 | 行为 |
|---|---|
| 文件不存在 | 纯内置规则（`found:false`），不报错 |
| YAML 语法错误 / schema 校验失败 | **整份拒绝**，保留上一次有效规则（启动时 = 纯内置），`ruleConfigStatus().errors` 可读 |
| 未知 id | 默认警告并跳过；`failOnUnknownRule: true` 整份拒绝 |
| 正则编译失败 | `failOnInvalidPattern: false` 跳过该条；`true` 整份拒绝 |
| 明显灾难回溯正则（`(a+)+`、`(.*)*`、超长） | `rejectUnsafeRegex: true`（默认）拒绝该模式 |
| 热加载失败 | 保留旧 `effective`（先构造新数组、校验通过才替换） |

## 4. 零依赖与替代方案

本仓库零第三方运行时依赖（CI 与 profile 安装都依赖这点），因此**没有引入** `yaml` / `zod` / `safe-regex`：

- YAML 只实现**子集**（块映射 / 序列 / 引号标量 / 简单 flow 列表 / 注释）；锚点、别名、多文档、块标量
  （`|` `>`）**明确报错**而不是猜；
- schema 手写校验（逐条错误，不做部分接受）；
- 正则安全是**启发式**（嵌套量词形状 + 长度上限），不是完整 ReDoS 分析——文档如实标注。

## 5. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.8.0** |
| 测试 | **482 项：481 pass / 0 fail / 1 skip（25.7s）** |
| e2e | **58/58（16.9s）** |
| allow-list | **36 路由 / 0 findings / 164 文件扫描 / 包内 72 文件** |
| 构建 | `dist/dsh-fang-2.8.0.tgz`（**279,864 B，88 entries**）<br>sha256 `2c87ec01679bf9f90c9d1183eb850d30d392396318fc6a51d15971baa9c57434` |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.8.0`（16 个模块可 import） |

## 6. 已知缺口（如实登记）

1. **TS 参考实现未镜像本层**：`types/umbrella` 仍是 v2.7.9 语义（声明式规则表 + AST-lite 解析），
    **没有** `rule-registry` 的 YAML 配置层。计划在后续补丁补齐；在此之前 `types/README.md` 与
   `docs/UMBRELLA.md §2.4` 已明确标注该差异，避免读者误以为 TS 版等价。
2. **正则安全是启发式**：能挡住常见灾难回溯形状，但不是 safe-regex 级别的分析。
3. **热加载依赖 `fs.watch`**：跨平台事件语义有差异（Windows 正常；网络盘/容器挂载可能不触发），
   提供 `reloadRules()` 作为手动入口。
4. **YAML 子集**：块标量、锚点、多文档不支持（明确报错），复杂配置需要拆成多份或改用代码规则。

## 7. 提交状态

- 分支：`feat/umbrella-yaml-rules`（stacked 在 PR #29 的 `feat/umbrella-shell-ast` 之上）；
- 发布物：`dist/dsh-fang-2.8.0.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行；未合并 main：本 PR 只推送分支与 PR。
