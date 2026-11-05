# 审计报告 · dsh-Fang v2.9.3（Essence 原身覆盖层合并库）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z`；新增能力进 minor 位。

## 1. 交付范围

| 交付物 | 内容 |
|---|---|
| `src/lib/essence.mjs` | 零依赖合并库：`mergeProfiles` 纯函数（patch 按 id / package.json 依赖 / settings 深合并 / 锁定项 / 冲突分级）+ `EssenceManager`（覆盖层磁盘布局、物化 merged/profile、状态机、配额、两级原身）+ `VIP_QUOTAS` 与三个配额检查 |
| `test/essence.test.mjs` | 23 项：合并语义 12 + 配额 4 + Manager 集成 7 |
| `docs/ESSENCE.md` | 三层数据边界、合并语义、配额表、冲突状态机、未交付项 |

**未交付**（明确边界）：HTTP 路由、面板 UI、分身进程派生。

## 2. 与设计草案的差异（工程约束导致）

1. **TS → `.mjs` + JSDoc**：dsh-fang 是零依赖纯 JS 仓库，不引入 `yaml`/vitest；测试用 `node:test`。
2. **YAML 解析复用** `rule-registry` 的 `parseYamlSubset`（已验证支持 patch 的根列表/`insert:`/嵌套 config/flow map），未新增依赖。
3. **写出用 JSON**（JSON 是合法 YAML），避免手写 YAML emitter；加载端先 JSON 后 YAML 兜底。
4. **锁定项来源**：构造参数或 `<mirrorRoot>/mirror-locked.json`（数组或 `{locked:[]}`），不污染 patch 文件。
5. **物理布局**：`merged/profile/` 是物化 profile（可直接作为 `--profile`），`merged/fingerprint.json` 记录镜像版本/指纹/时间。
6. **凭据边界**：物化先剔除镜像带入的 `credentials/`，再复制原身凭据（测试有断言）。

## 3. 门禁结果（v2.9.3）

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.9.3** |
| 测试 | **536 pass / 0 fail / 1 skip**（新增 essence 23 项） |
| e2e | **58/58** |
| allow-list | **38 路由 / 0 findings**（178 文件扫描；75 包文件） |
| 构建 | `dist/dsh-fang-2.9.3.tgz`（298,769 B / 92 entries / sha256 `cb4931b265ebfa2e35fefa1ae325a317a9956eede571890c5c74c4d2961a8206`） |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.9.3`（16 模块） |

## 4. 语义不变量（有测试）

- 锁定插件：禁用/改配置 → fatal 且镜像配置保留；同值"覆盖"不算冲突。
- fatal 时**不重建** `merged/profile`，`status=conflicted`，旧物化结果保留（原身仍可启动）；修复后恢复 ready 并删除 conflicts.json。
- 依赖主版本不同 → fatal 且保留镜像版本；主版本相同 → 原身 pin 胜。
- 配额：free 5 个原身上限，第 6 个拒绝；子原身独立配额；只允许两级；父原身有子原身时删除被拒绝。
- `recomputeAll` 在镜像指纹变化后批量重算并更新 `lastMergedFingerprint`。

## 5. 已知缺口

1. `mirror-locked.json` 目前由镜像侧放置，尚未接入镜像升级流程（升级后需自动 `recomputeAll`）——P2 接线时处理。
2. `parsePatchEntries` 复用 rule-registry 的 YAML 子集解析器：不支持锚点/多文档/`!!js` 标签；镜像 patch 若使用这些特性会被判为解析错误（fatal，fail-closed）。
3. 会话配额（`checkActiveSessionQuota`）已提供函数但尚无调用方——P3 分身派生时接入。

## 6. 提交状态

- 分支：`feat/essence-overlay`（stacked 在 `feat/mother-link-fix` / v2.9.1+v2.9.2 之上）
- 发布物：`dist/dsh-fang-2.9.3.tgz` + manifest/preflight/allowlist
- 未合并 main；Release/tag 与私有镜像同步留待 PR 合并后执行
