# 审计报告 · dsh-Fang v2.7.8（动作规则表声明化）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 8 个补丁位（`2.7.7` → `2.7.8`）。

## 1. 本次交付

把动作评分从「硬编码 `if` 链」改成**与 AST 规则表同粒度的声明式规则表**：每条规则有独立的
`match(evidence, context)` 谓词与 `evidence(evidence, context)` 证据提取器，可单独喂证据、单独断言。

| 交付物 | 内容 |
|---|---|
| `DEFAULT_ACTION_RULES` | 15 条规则对象：`{ id, category, light, reason, tags[], match, evidence }`，数组顺序即优先级、首个命中胜出 |
| `buildActionContext()` | 一次解析 `mode` / `commandText` / `targetPath` / `url{raw,host,hostPort}` / `targetPid` / `writeTargets[]` / `readTargets[]`，15 条规则共享 |
| `parseShellRedirects()` | `>` `>>`、`tee`、`dd of=`、`Set-Content`/`Out-File` 写目标；`cat/less/head/tail/more/Get-Content/type` 读目标；只取字面量，动态构造跳过 |
| `parseUrlParts()` | 不依赖 `URL` 全局对象，带默认端口（http 80 / https 443） |
| `createActionRuleSet()` + `assertActionRule()` | `register(rule, {before\|after})` / `override` / `remove` / `reset`；注册必须显式给位置 |
| `baseLight()` | 改为表驱动，返回 `category` / `tags` / 结构化 `evidence`（`matchedPattern` 等） |
| 插件面 | `fangUmbrella` 新增 `explain()` / `rules` / `ruleIds()` / `registerRule` / `overrideRule` / `removeRule` / `resetRules` |
| 审计 | `umbrella-decision` 记录新增 `category` 与 `evidence`，回答「为什么是这个灯色」 |
| TS 参考实现 | 同步声明式规则表与规则集；编译产物上 76 项行为断言 |

**行为不变**：15 条规则 id、灯色、优先级与 v2.7.6/2.7.7 完全一致；既有 35 项测试原样通过。

## 2. 与 AST 规则表的对齐点

| 维度 | AST 规则表（S1–S7 / C2–C5） | 动作规则表（15 条） |
|---|---|---|
| 规则形态 | `{ id, nodeType, match, evidence, weight }` | `{ id, category, light, tags, match, evidence }` |
| 匹配单元 | AST 节点 | `ActionEvidence` + 解析后的 `ActionContext` |
| 命中语义 | 信号求和、可多条同时命中 | **首个命中胜出**（灯色排他；顺序即优先级） |
| 证据 | `evidence(node, path)` 结构化片段 | `evidence(ev, ctx)` → `{ matchedPattern, targets[], paths[], host, url, commandSnippet, … }` |
| 可测试性 | 每条规则可喂 AST 片段 | 每条规则可喂 `ActionEvidence`，逐条断言 id/类别/灯色/证据 |
| 扩展 | 追加信号 | 必须插到正确优先级位置（`before`/`after`） |

差异写进了 `docs/UMBRELLA.md §2` 与 `docs/CONTRACTS-V2.md §5.9`：AST 是「求和」，动作是「排他 + 短路」。

## 3. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.7.8**（版本一致性 / CHANGELOG 段 / 许可证 / client 可解析 / 全量测试 / e2e） |
| 测试 | **456 项：455 pass / 0 fail / 1 skip（25.8s）**（保护伞 35 → 45 项） |
| e2e | **58/58（18.3s）**（真实母体 + 分身，含分身 `umbrella` 器官检查） |
| allow-list | **36 路由 / 0 findings / 159 文件扫描 / 包内 71 文件** |
| 构建 | `dist/dsh-fang-2.7.8.tgz`（**265,813 B，87 entries**）<br>sha256 `1d88022d2aaef62e1289937d8fc2784908479f12054dc8fd367f2eb74044fb1d` |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.7.8`（16 个模块可 import） |
| TypeScript 参考 | `tsc 5.9.2` 严格编译 **0 error**；编译产物行为断言 **76/76** |

## 4. 刻意的取舍

1. **注册必须给位置**：`register(rule, {before|after})` 缺位置直接抛错。理由：追加到表尾等于永不命中
   （前面有 `unknown-tool` 兜底），「位置」是规则语义的一部分，不能靠默认值猜。
2. **形状校验在注册时失败**：缺 `match`/`evidence`、未知 `category`/灯色、重复 id 一律抛 `TypeError`，
   而不是在评分路径上静默漏判（漏判 = 静默放行，比多问一次更危险）。
3. **动态构造的路径不猜**：`$VAR` / `$(...)` / 通配的写目标静态不可知 → 不解析，落到 `write-outside-buffer` /
   `unknown-tool` 判黄。保守解析 + 兜底判黄让「漏判」退化为「多问一次」。
4. **规则表对评分只读**：`baseLight` 不修改规则对象；`umbrella.rules` 返回副本，外部 `push` 不影响内部。
5. **证据只记结构化片段**：`commandSnippet` 截断 200 字符，路径只记解析后的绝对路径，不写文件内容。

## 5. 边界

- `parseShellRedirects` 仍是**保守**解析：管道内的动态命令替换、变量拼接、别名、`eval` 构造的写目标都抓不到；
  这类动作落兜底判黄，不会漏放。
- `firstPattern`/`firstPatternSource` 每调用一次编译一次正则（策略只存源码字符串）；单次 ≈ 微秒级，
  在动作评分 2ms 预算内（`test/umbrella.test.mjs` 的延迟用例守着）。
- 规则证据进审计会让单条记录变大（`targets[]` 可能多条）；已截断命令文本，路径数量受单命令重定向个数限制。

## 6. 提交状态

- 分支：`feat/umbrella-rules`（stacked 在 PR #27 的 `feat/umbrella-types` 之上）；
- 发布物：`dist/dsh-fang-2.7.8.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
