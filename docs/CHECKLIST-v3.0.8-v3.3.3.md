# 六方发布前检查单（v3.0.8 → v3.3.3）

> 用法：**每次发布前 30 分钟**，由维护者按顺序逐项勾选；任何一项不通过即停止发布。
> 勾选必须附证据（命令输出/文件路径），不接受“我记得跑过了”。
> 签发即代表：六方均无否决项 → 才执行 `git push origin v<版本>`。

发布版本：`v3.__.__`　日期：`____-__-__`　执行人：`________`　风险级：`L0 / L1 / L2 / L3`

---

## 0. 前置（5 分钟，任何版本都先做）

- [ ] 主干对齐：`git fetch origin --prune && git switch main && git pull --ff-only`
- [ ] 本地 main 未漂移：`node tools/git/guard-main.mjs audit`
      期望：`main == origin/main  yes`；`behind=0 ahead=0`
- [ ] 目标版本分支已合并且已删除：`git branch -a | Select-String "v3\.X"` 无输出
- [ ] main 上只有一个新提交（本版本）：`git log --oneline -3`
- [ ] 版本号四处一致：`node tools/git/version-cut.mjs --check --version 3.__.__`
      期望：4 项 PASS；`last tag v<上一版>`
- [ ] 发布门禁 GREEN（在 **main** 上跑，不是在分支上）：
      `node tools/release/preflight.mjs --e2e`
      期望：末行 `GREEN preflight <版本>`；并确认 `dist/preflight.json` 的 `green=true`
- [ ] 证据已归档：`dist/preflight.json` 存在且 `at` 是今天

---

## 1. 代码库（Repo / Git）

- [ ] tag 尚未存在：`git rev-parse --verify refs/tags/v3.__.__` 报错（不存在）
- [ ] 版本标签只在 main 尖端打：`git rev-list --count "v3.__.__..origin/main"` → 打 tag 后应为 `0`
- [ ] 本版提交即 main 尖端：`git log --oneline -1` 的提交主题为 `type(v3.__.__): …`
- [ ] 无 merge 提交进入 main：`git log --merges --oneline -5` 为空（squash 合并）
- [ ] 历史无重复补丁：`node tools/git/history-audit.mjs --no-patch`
      期望：本版分支不在 `duplicate/stale` 列表里
- [ ] 工作区干净：`git status --porcelain` 为空
- [ ] 分支已回收：`git branch -r --no-merged origin/main` 无本版分支
- [ ] 发布完整性断言（打 tag 后立即）：`node tools/git/verify-release.mjs --tag v3.__.__ --no-artifact`
      期望：GREEN（含 `tag: 在 main 的 first-parent 上`）

**否决项**：tag 不在 main 上 / main 有 merge 提交 / 工作区不干净。

---

## 2. 母体（Mirror）

- [ ] 当前代际可读：`current` 指针指向的目录存在且含 `package.json`
      命令（Windows）：`Get-Item <dataRoot>\mirror\current | Select-Object LinkTarget,Target`
- [ ] 新代目录已完整落地：`active-v<新版>` 存在，文件数与 `active-v<旧版>` 同量级
- [ ] 升级前快照存在：`backup/pre-upgrade-v<旧版>-*`（v3.0.10 规则：保留 24h）
- [ ] 指针切换是原子操作：切换前后 `current` 指向可解析（不出现指向不存在目录）
- [ ] 切换后进程已用新代启动：`node tools/fangctl.mjs status` 中 mirror/version 为新版
- [ ] 健康检查通过：`node tools/release/healthz.mjs`
- [ ] 旧代**未删除**（回滚锚点）：`active-v<旧版>` 仍在，且在 24h 内不清理
- [ ] 失败注入演练（L2 必做）：故意让健康检查失败一次，确认自动切回旧代
      证据：AUDIT 的「回滚演练」段（触发方式 + 恢复耗时）

**否决项**：无快照 / 旧代被删 / 健康检查未跑。

---

## 3. 原身（Essence）

- [ ] 新旧合并目录并存：`merged-v<新版>` 与 `merged-v<旧版>` 同时存在
- [ ] recompute 是写新目录、不原地改：旧目录 mtime 未变
- [ ] 新实例已启动且 `phase=running`：`node tools/fangctl.mjs status`
- [ ] 实例健康：`health.adapter = ok`（失败时保留旧实例，不允许“先停后起”）
- [ ] 原身级插件与登录状态保留（升级不应清空 profile）
- [ ] 并发安全：同时触发两个原身 recompute，不出现交叉写同一目录
- [ ] 回滚点明确：AUDIT 写明“回滚 = 指针回 `merged-v<旧版>` + 重启实例”

**否决项**：旧目录被覆盖 / 实例启动失败仍标记完成。

---

## 4. 分身（Derived / Forker）

- [ ] 真分身 e2e 通过：`node tools/e2e.mjs` → `N/N checks passed`（N ≥ 63）
- [ ] 分身列表字段完整：`phase / health / sessionTitle / startedAt / updatedAt / projectBytes / essenceId`
- [ ] token 不落盘：`<dataDir>/tasks.json`、`forks.json` 中无 token 字符串
      命令：`Select-String -Path <dataDir>\*.json -Pattern "token" -SimpleMatch`
- [ ] 崩溃恢复：杀掉 forker 后自动拉起（backoff），分身 `phase` 不丢
- [ ] 配额/容量未被突破：`essence/list` 的 `capacity{slots:7,defaultLimit:5,used}` 合理
- [ ] 派生产物可回收（归档不删 home）——本版若未实现，在 AUDIT「边界」中写明
- [ ] 分身端口/适配器无泄漏：`netstat -ano | findstr <adapterPort>` 无残留监听

**否决项**：e2e 未跑或未过 / token 出现在落盘文件。

---

## 5. 插件与供应链（Plugins）

- [ ] 插件行数 = 16：`node tools/release/allowlist.mjs --json` 与 `--dump-config` 结果一致
- [ ] 路由契约计数已更新：`routes=<N>`（v3.0.7 基线 62，新增路由必须同步计数）
- [ ] 许可分层通过：`node test/licensing.test.mjs`
- [ ] 新文件 SPDX 齐全：`node tools/git/pr-gate.mjs` 的 `license: 新增代码文件带 SPDX` PASS
- [ ] 包清单无 `dist/`、`node_modules/`：`node tools/release/package-smoke.mjs`
- [ ] 依赖变更已锁：本版若动依赖，`package-lock.json` 或快照哈希随版本提交
- [ ] 插件更新前快照存在：`plugin-snapshot-<ts>`（L3）
- [ ] smoke 通过：`node tools/release/healthz.mjs` + `dsh doctor`（在快照后、发布前）

**否决项**：许可分层红 / 无快照 / 插件行数与契约计数不一致。

---

## 6. 发布与回滚（Release / Ops）

- [ ] 构建成功（自建 runner）：`gh run list --workflow release` 中 `build` 绿
- [ ] 产物齐全：`dist/dsh-fang-3.__.__.tgz`、`.tgz.sha256`、`manifest.json`、`preflight.json`
- [ ] sha256 一致：`Get-FileHash dist\dsh-fang-3.__.__.tgz -Algorithm SHA256` 与 sidecar 相同
- [ ] npm 已发布：`npm view @twinsearth/dsh-fang@3.__.__ version`（或 Release 说明记录“跳过”）
- [ ] GitHub Release 含四个附件：tgz / sha256 / manifest / preflight
- [ ] Docker（若配置）：`docker pull <user>/dsh-fang:v3.__.__` 成功
- [ ] 远端健康：`node tools/git/verify-release.mjs --tag v3.__.__ --remote`
- [ ] 私有镜像 verify：`node tools/release/sync-private.mjs verify --tag v3.__.__ --json`
      （`MIRROR_REQUIRED=0` 时必须在 Release 说明中写明跳过的理由）
- [ ] 回滚演练记录：L2/L3 必填（触发方式 / 恢复耗时 / 证据路径）
- [ ] 公告与迁移说明：破坏性变更写进 Release 说明与 CHANGELOG「边界」

**否决项**：sha256 不一致 / 私有镜像未 verify / 回滚演练缺失（L2+）。

---

## 7. 签核表（每版一行，六方各一列）

> 勾 = 通过；× = 否决（禁止发布）；N/A = 本版不涉及（需在备注写理由）。

| 版本 | 代码库 | 母体 | 原身 | 分身 | 插件 | 发布/回滚 | 维护者签发 | 备注 |
|---|---|---|---|---|---|---|---|---|
| v3.0.8 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| v3.0.9 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| v3.0.10 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | L2 回滚演练必做 |
| v3.0.11 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | L2 回滚演练必做 |
| v3.0.12 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | L3 快照/restore 必做 |
| v3.1.0 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | GA：兼容矩阵冻结 |
| v3.1.1 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 断网续传演练 |
| v3.1.2 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 三类故障注入 |
| v3.1.3 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 并发压测 |
| v3.2.0 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 配额边界 |
| v3.2.1 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 网关故障矩阵 |
| v3.2.2 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 冲突矩阵 |
| v3.2.3 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 脱敏审计 |
| v3.3.0 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 签名流程审查 |
| v3.3.1 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 灰度回滚 |
| v3.3.2 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | 基准对比 |
| v3.3.3 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | LTS 检查单 |

---

## 8. 一票否决清单（出现即停，不允许“先发再补”）

1. tag 不在 `main` 的 first-parent 上。
2. `preflight` 非 GREEN，或 `e2e` 未真跑（`e2e.total = 0`）。
3. 版本号四处不一致（package / FANG_VERSION / CHANGELOG / tag）。
4. 产物 sha256 与 sidecar 不一致。
5. 许可分层红，或新增文件缺 SPDX。
6. L2/L3 版本没有可用的回滚锚点（快照/旧代目录被删）。
7. `tasks.json`/`forks.json` 中出现 token。
8. 有人绕过 PR 直推 main（先恢复，再重新走流程）。
9. 私有镜像未 verify 且未按 `MIRROR_REQUIRED=0` 书面豁免。
10. 六方中任一方未签核。

---

## 9. 发布后 72 小时观察窗

- [ ] T+1h：`node tools/git/verify-release.mjs --tag v3.__.__ --remote` 仍 GREEN
- [ ] T+1h：npm/GitHub 下载计数与健康检查无异常
- [ ] T+24h：母体旧代与插件快照仍在（未提前清理）
- [ ] T+24h：无新增 P0/P1 issue；若有，判断是否触发 §5 回滚
- [ ] T+72h：写 `docs/AUDIT-v3.__.__.md` 的「观察窗」结论（继续 / 回滚 / 发补丁）
- [ ] T+72h：清理旧代（仅当观察窗通过），保留最近 2 代

> 观察窗内**不删除**任何回滚锚点，是这套流程里最便宜的一条保险。
