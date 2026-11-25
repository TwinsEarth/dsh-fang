# 审计报告 · dsh-Fang v2.8.4（公共仓 / 私有镜像仓发布管理）

> 证据来自本机真实输出（2026-11-02，Windows / Node 24.16.0）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 4 个补丁位（`2.8.3` → `2.8.4`）。

## 1. 本次交付

| 交付物 | 内容 |
|---|---|
| `tools/release/sync-private.mjs` | 零依赖 REST 同步/校验工具：`verify`（树 SHA + 资产自洽，退出码可进 CI）、`sync`（增量 blob + 断言 tree 相等 + fast-forward main + annotated tag + Release 资产）、`--dry-run`/`--json` |
| `docs/RELEASE-MIRROR.md` | 两仓定位、版本流转、同步语义、发布后三件核对、故障表、红线 |
| `test/sync-mirror.test.mjs` | 8 项纯函数测试：参数解析、增量 blob 计划、资产自洽判定、树比较、SHA-256 向量 |

## 2. v2.8.3 镜像结果（真实数据）

| 项 | 公共仓 `dsh-fang` | 私有仓 `dsh-fang-private` |
|---|---|---|
| tag `v2.8.3` → commit | `5e308ac…`（PR #33 head，已合并到 stacked base） | `582cd9f…`（内容同步 commit） |
| 内容树 SHA | `cd9e53f4…` | **`cd9e53f4…`（相同）** |
| 私有 main | — | 快进到 `582cd9f…`（fast-forward，无 force push） |
| Release 资产 | tarball **286,952 B** sha256 `8bc30c67…`、`manifest.json` 5,381 B、`.sha256` | tarball **286,944 B** sha256 `3c97748e…`、`manifest.json` 5,381 B、`.sha256` |
| prerelease | `true`（tag 未落到 main） | `false`（私有 main 已含该版本内容） |
| `verify --tag v2.8.3` | — | **通过（trees.ok=true、两仓资产均自洽，退出码 0）** |

### 两个真实的资产事故（已修复，记录在案）

1. **公共仓**：tag 推送触发仓库自带 `release` workflow，它在 ubuntu 上重新构建 tarball 并上传
   （286,952 B，替换了本地 Windows 构建的 285,267 B），导致我先前上传的 `.sha256` 过期。
   → 按 CI 产物重算并替换 `.sha256`，Release 说明里的体积/哈希同步校正，并加「资产说明」段落。
2. **私有仓**：同步创建 Release 后，私有仓**自己的** `release` workflow 又在 tag 推送时重建 tarball
   （286,944 B，与公共仓不同），`.sha256` 再次过期。
   → 按私有 CI 产物校正为 `3c97748e…`，说明里注明「两仓树一致、打包字节可不同」。

结论（已写进文档）：**同步后必须再跑 `verify`**；每个仓的 `.sha256` 只能按该仓自己的 `manifest.json` 校正。

## 3. 门禁结果

| 门禁 | 结果 |
|---|---|
| `preflight --e2e` | **GREEN 2.8.4** |
| 测试 | **507 项：506 pass / 0 fail / 1 skip**（新增 `sync-mirror` 8 项） |
| e2e | **58/58** |
| allow-list | **36 路由 / 0 findings / 172 文件扫描 / 包内 73 文件**（工具脚本不含本机绝对路径/凭据） |
| 构建 | `dist/dsh-fang-2.8.4.tgz`（见门禁输出） |
| 产物健康检查 | **HEALTHY** `@twinsearth/dsh-fang@2.8.4`（16 模块） |

## 4. 管理约定（v2.8.4 起生效）

- 公共仓是唯一事实来源：只走 PR；私有仓不再手工提交，所有内容由同步工具从公共 tag 写入；
- 私有仓内容树必须等于公共 tag 树（工具内置断言，不等则中止，不会写坏 main）；
- 私有 main 只允许 fast-forward；出现分叉必须人工核对，禁止 force push；
- 每个版本发布后执行 `verify`，结果记入该版本审计；
- 私有 Release 不标 prerelease；公共 Release 在 tag 未落到 main 前标 prerelease，合并后改指 merge commit。

## 5. 已知缺口

- **`types/` 的 TypeScript 参考实现仍未镜像 v2.8.x 规则配置层**（严格模式/事务回退已连续第五个版本登记）。
  这是当前唯一的实质性技术债，建议下个补丁专门补齐，而不是继续叠加功能。
- 同步工具依赖 GitHub REST API 权限（私有仓 `repo`）；发布机无法直连 `github.com:443`，故不能用 git push。
- tag 落点策略（未合并 PR head 也允许打 prerelease tag）是有意为之，但要求合并后及时改指 main。

## 6. 提交状态

- 分支：`feat/release-mirror`（stacked 在 `feat/umbrella-strict-errors` 之上）；
- 发布物：`dist/dsh-fang-2.8.4.tgz` + `manifest.json` + `preflight.json` + `allowlist.json`；
- 私有镜像：v2.8.3 已同步并通过 `verify`；v2.8.4 待该 PR 合并后按 `docs/RELEASE-MIRROR.md` 同步。
