# 审计报告 · dsh-Fang v2.8.1（推荐基线 + 三层叠加 + 硬规则锁定）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 1 个补丁位（`2.8.0` → `2.8.1`）。

## 1. 本次交付

| 交付物 | 内容 |
|---|---|
| `defaults/umbrella-rules.yaml` | 随包**推荐基线**：显式锁定 `dsh-lifecycle` / `destructive-command` / `credential-access`（red，hard-deny + non-negotiable）与兜底 `unknown-tool`（yellow，9999）；11 条可调规则**留空 = 内置默认**（注释给推荐值） |
| `registry.applyLayer` | 分层：基线 → 项目 `rulesFile` → 环境 `UMBRELLA_RULES_PATH`（`envRulesFile` 覆盖路径）；后层按 id 覆盖前层 |
| 层回退 | 被拒绝的层**从层栈弹出**，effective 恢复到不含它的上一次有效规则（否则坏层污染后续 rebuild） |
| 硬规则锁定 | `non-negotiable`/`hard-deny` 不可 `enabled:false`、不可降低灯色；允许提升灯色/追加 pattern/改 reason/priority；违规一律 fatal |
| 插件配置 | `baselineFile`（空 = 随包基线；`:none:` 关闭）、`envRulesFile`；`ruleConfigStatus()` 返回每层 `name/file/applied/found/errors` |
| 文档 | `docs/RULES-BASELINE.md`（基线/分层/锁定/部署/边界）；`UMBRELLA.md §2.4`、`CONTRACTS-V2.md §5.9` 同步 |

## 2. 基线与锁定语义

基线只做三件事：把红线钉死、把可调规则的推荐值写清楚、把项目覆盖的接入点留出来。

| 操作 | 结果 |
|---|---|
| `enabled: false` 对锁定规则 | ❌ `rule "X" is non-negotiable and cannot be disabled` |
| 降低灯色（red→yellow） | ❌ `light cannot be lowered from red to yellow` |
| 提升灯色、追加 `pathPatterns`/`commandPatterns`、改 reason/priority | ✅ |
| 项目层违规 | 该层 fatal → 从层栈弹出，保留基线+已生效层（`applied:false` + 错误列表） |

锁定的判定依据是**当前生效规则**的标签，因此基线层先建立锁定、项目层再被约束；没有基线时
（`baselineFile: ':none:'`）内置规则里的 `hard-deny` 标签同样生效。

## 3. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.8.1** |
| 测试 | **487 项：486 pass / 0 fail / 1 skip（24.4s）**；`rule-config` 18 → 23 项 |
| e2e | **58/58（15.0s）** |
| allow-list | **36 路由 / 0 findings / 167 文件扫描 / 包内 73 文件** |
| 构建 | `dist/dsh-fang-2.8.1.tgz`（**283,636 B，90 entries**）<br>sha256 `7371b803ec79265d15a10710e102e47de775e7e068f57d7462417daf04297c1d` |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.8.1`（16 个模块可 import） |

## 4. 刻意的取舍

1. **可调规则不写进基线**：只给注释推荐值。写死副本会在升级内置默认时打架（两份真相）。
2. **锁定违规无视 `failOnInvalidPattern`**：它是策略违规，不是"正则写错"，必须 fatal。
3. **被拒绝的层弹出而不是保留**：否则一个坏层会让后续每次 rebuild 都失败，热加载再也救不回来。
4. **基线缺失不报错**：基线是推荐值，允许被删除（`baselineFile: ':none:'` 或包内文件缺失）。
5. **`package.json files` 新增 `defaults/**`**：基线要随包分发；`docs/` 依然不进包。

## 5. 边界（如实声明）

- `light: blue` 不能把 `network-egress` 变成"内网放行"——该规则谓词看 allowlist；
  放行内网域请改 `policy.networkAllowlist`。
- 追加 pattern 是**「或」语义**（扩大命中面）：对 `destructive-command` 追加过宽正则会提高误报，
  由项目自己承担；`reason` 应写清。
- 热加载依赖 `fs.watch`；网络盘/容器挂载可能不触发 → `reloadRules()` 兜底。
- **TS 参考实现仍未镜像 v2.8.x 规则配置层**（基线/分层/锁定）；`types/` 停留在 v2.7.9 语义。
  已在 `docs/AUDIT-v2.8.0.md §6` 与本报告登记，计划后续补丁补齐。

## 6. 提交状态

- 分支：`feat/umbrella-baseline`（stacked 在 PR #30 的 `feat/umbrella-yaml-rules` 之上）；
- 发布物：`dist/dsh-fang-2.8.1.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行；未合并 main：本 PR 只推送分支与 PR。
