# 重复历史清理 runbook（v3.0.8 起点，一次性 + 防复发）

> 目标：让 `git log --oneline main` 成为**发布日志**（一版一提交），让分支池回到个位数，
> 让每个 tag 都能在 main 上找到落点。**不删除任何已发布的事实。**
>
> 只读体检工具：`node tools/git/history-audit.mjs`（`--no-patch` 约 15s，全量约 35s）。

---

## 1. 现状（2026-11-05 实测）

| 指标 | 值 |
|---|---|
| 分支引用 / 唯一 tip | 73 / 71（本地 35 + 远端 41，含重复指向） |
| 0 领先（可安全删） | 5 个引用 |
| 重复补丁（内容已在 main，仅剩提交壳） | `fix/session-history-ui`（dup=1.0） |
| 陈旧（有独有提交、>2 天未动） | 65 个引用，每条 ahead 20–29 / behind 5–16 |
| 不在 main 上的版本标签 | 6 个（`v2.8.3 v2.9.0 v2.9.2 v2.9.3 v2.9.9 v3.0.7`） |
| 主干上 merge 提交（追主干造成） | `Merge branch 'main' into feat/...` ×2（在 `feat/upgrade-coordinator`） |

典型条目（`--no-patch` 输出摘录）：

```
feat/etag-status , origin/feat/etag-status       ahead= 29 behind= 5  dup=0
feat/mirror-settings , origin/feat/mirror-settings ahead= 28 behind= 5  dup=0
feat/release-mirror                              ahead= 28 behind=16  dup=0.07
feat/umbrella-strict-errors                      ahead= 27 behind=16  dup=0.07
fix/session-history-ui                           ahead=  1 behind=16  dup=1
origin/TwinsEarth-patch[-0/-3]                   ahead=  0（可删）
```

---

## 2. 根因（三个动作的组合，缺一不可）

1. **版本内容只长在分支上，主干靠“合并分支”推进**
   → `Merge branch 'main' into feat/...` 让同一批改动在分支与主干各留一份轨迹。
2. **标签打在分支上**（6 个版本标签至今不在 main 上）
   → 发布物与主干永久分叉，回滚时找不到“这一版到底对应哪段历史”。
3. **一个版本在多条分支上重复实现**（65 条陈旧分支、每条 20–29 提交）
   → review 无法收敛，`git bisect` 失去意义，AUDIT 数字对不上代码。

> 注意：这不是“分支太多”的问题，而是**主线只有一个、但发布走的是旁路**。
> 因此清理的重点不是删分支，而是**把发布动作搬回主线**，然后分支自然可删。

---

## 3. 禁区（违反会制造更大的历史问题）

| 禁止 | 原因 | 正确做法 |
|---|---|---|
| `git filter-repo` / `filter-branch` 重写 `main` | 已被多人/CI 拉取；重写后所有 SHA 变化，tag、Release、AUDIT 全部失效 | 用 revert 或“向前去重”（squash 合并 + 标签归位） |
| 移动/重打已发布标签（如 `v3.0.7`） | 发布物与标签的对应关系是事实 | 保留标签，记录映射；下一版起强制 tag-on-main |
| 在工作分支 `git rebase main` 后强推共享分支 | 其他人基于旧提交的工作全部失效 | 只对**自己的**分支 rebase；共享分支用合并或重开 PR |
| `git gc --prune=now` 之后才发现删错 | 不可恢复 | 先 `git bundle` 备份，再删；gc 放到验证之后 |
| 批量 `git branch -D` 脚本一把梭 | 删掉唯一副本 | 逐条 `archive/<name>` 打标签后再删 |

---

## 4. 五阶段 runbook

### 阶段 0：冻结与备份（15 分钟）

```powershell
# 0.1 公告：接下来 1 小时内不要推送（冻结窗口）
# 0.2 全量备份（含所有 refs、tag、远端跟踪分支）
New-Item -ItemType Directory -Force .tmp\backups | Out-Null
$stamp = Get-Date -Format yyyyMMdd-HHmm
git bundle create ".tmp/backups/dsh-fang-all-$stamp.bundle" --all
git bundle verify ".tmp/backups/dsh-fang-all-$stamp.bundle"      # 必须显示 ok
Copy-Item .git\packed-refs ".tmp\backups\packed-refs-$stamp.txt" -ErrorAction SilentlyContinue
```

> 恢复演练（可选但推荐）：`git clone .tmp/backups/dsh-fang-all-$stamp.bundle .tmp\restore-test`，
> 确认能 checkout 到 `v3.0.7` 与 `feat/upgrade-coordinator`。

### 阶段 1：清点（只读，30 分钟）

```powershell
node tools/git/history-audit.mjs --no-patch          # 快速分类
node tools/git/history-audit.mjs --json > .tmp\audit.json   # 全量（含重复补丁比例）
node tools/git/guard-main.mjs audit                  # main 是否漂移
git tag -l 'v*' | ForEach-Object {
  $inMain = (git merge-base --is-ancestor $_ origin/main; $LASTEXITCODE -eq 0)
  "{0,-10} {1}" -f $_, $(if ($inMain) {'IN-MAIN'} else {'NOT-IN-MAIN'})
}
```

把 `history-audit` 的四类结果抄进 §7 的决策表（每条分支一行）。

### 阶段 2：决策（每条分支一个结论，不留“待定”）

| 分类（工具给出） | 判据 | 动作 | 可恢复性 |
|---|---|---|---|
| `merged`（ahead=0） | 内容已在 main | `git branch -d` + `git push origin --delete` | main 上有 |
| `duplicate`（dup=1.0） | 每条补丁都能在 main 找到 | 抽查 2 条 `git show <sha>` 与 main 对应提交后删除 | main 上有 |
| `stale`（有独有提交，久未动） | 该版本已在 main 有对应实现 | `git tag archive/<name> <name>` → 推送标签 → 删分支 | archive 标签 |
| `stale` 且**内容未被 main 覆盖** | AUDIT/CHANGELOG 中查不到该版本 | 先补一个回收 PR（squash），再删 | main/archive |
| `active` | 当前版本正在用 | 保留；同时只允许 1 条 | — |

判断“内容是否已被 main 覆盖”的最小证据（不要靠记忆）：

```powershell
# 该分支的版本号
git show <ref>:package.json | Select-String '"version"'
# main 上是否有同一版本号的 CHANGELOG 段
git show origin/main:docs/CHANGELOG.md | Select-String "## v<该版本号>"
# 该分支独有的提交主题（最多 30 条）
git log --oneline --no-merges origin/main..<ref> | Select-Object -First 30
```

### 阶段 3：执行（按“可恢复性”从高到低）

```powershell
# 3.1 先删 0 领先（零风险）
$merged = git branch -r --merged origin/main --format='%(refname:short)' |
  Where-Object { $_ -notmatch 'HEAD|origin/main$|origin$' }
$merged | ForEach-Object { git push origin --delete ($_ -replace '^origin/','') }
git branch --merged main --format='%(refname:short)' |
  Where-Object { $_ -ne 'main' } | ForEach-Object { git branch -d $_ }

# 3.2 陈旧分支：先归档，再删（逐条执行，不要 for 循环一把梭）
git tag archive/feat-etag-status origin/feat/etag-status
git push origin archive/feat-etag-status
git push origin --delete feat/etag-status
git branch -D feat/etag-status 2>$null

# 3.3 重复补丁：抽查后再删
git show --stat fix/session-history-ui          # 确认内容已在 main
git tag archive/fix-session-history-ui fix/session-history-ui
git push origin archive/fix-session-history-ui
git branch -D fix/session-history-ui

# 3.4 v3.0.7 标签：保持不动（已发布）。只修“主干”，不修“事实”
```

**每删 10 条，跑一次验证**（见阶段 4），发现异常立刻 `git fetch` + bundle 恢复。

### 阶段 4：验证

```powershell
git fetch origin --prune
node tools/git/history-audit.mjs --no-patch
# 期望：merged=0、duplicate=0、stale 只剩“待回收”的白名单条目、active ≤ 1
node tools/git/guard-main.mjs audit        # main == origin/main
git log --oneline origin/main -15          # 一版一提交（或少量 chore/revert）
node tools/release/preflight.mjs --e2e     # 主干仍然 GREEN（这是最终验收）
```

验收判据（全部满足才算完成）：

1. `history-audit` 的 `merged` 与 `duplicate` 均为 0。
2. 分支引用数从 73 降到 ≤ 10（main + 1 个活跃版本分支 + 归档标签）。
3. 每个 `v*` 标签要么在 main 上，要么在 `docs/AUDIT-v3.0.8.md` 的“历史遗留”表里有解释。
4. `preflight --e2e` GREEN。
5. 「阶段 0」的 bundle 保存至少 30 天。

### 阶段 5：防复发（这一步不做，前面全白做）

| 机制 | 落点 | 拦截什么 |
|---|---|---|
| squash-only 合并 | 分支保护 `required_linear_history` + PR 只允许 Squash | `Merge branch 'main' into feat/...` |
| 禁止合并 main 进分支 | `pr-gate` 的 `history: 无 merge 提交` | 追主干式合并 |
| tag 必须在 main 尖端 | `release.yml` 的 `guard` + `.githooks/pre-push` | 6 个标签的历史问题 |
| 一版一分支 | SOP 第 2 步 + 每周 `history-audit` | 65 条并行分支 |
| 合并即删分支 | PR 合并后自动删（仓库设置 `Automatically delete head branches`） | 分支池回涨 |
| 每周体检 | 周一 `node tools/git/history-audit.mjs --no-patch`（约 15s） | 问题在 1 周内暴露 |

开启自动删分支：

```bash
curl -sS -X PATCH -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/TwinsEarth/dsh-fang \
  -d '{"delete_branch_on_merge": true}'
```

---

## 5. v3.0.7 标签的特殊处理（唯一需要“写说明”的地方）

`v3.0.7` 打在 `feat/upgrade-coordinator` 的 `2e28d4c` 上，不在 main。它是**已发布**的（`dist/` 中有
`dsh-fang-3.0.7.tgz` 与 sidecar，CHANGELOG 记录为首个 Release）。

处理方式（三选一，推荐 A）：

| 方案 | 动作 | 代价 | 结论 |
|---|---|---|---|
| **A（推荐）** | 标签不动；把分支内容 squash 回 main；在 `docs/AUDIT-v3.0.8.md` 写“v3.0.7 标签位于回收前分支，内容已等价合入 main” | 需要一次回收 PR | 事实可追溯，零破坏 |
| B | 在 main 上打 `v3.0.7-reconciled` 指向回收提交 | 多一个非标准标签，易混淆 | 可选，需在 AUDIT 说明 |
| C | 删除并重打 `v3.0.7` 到 main | 违反“已发布标签不可移动”，npm/GitHub 资产对应关系断裂 | **禁止** |

A 的验收：`node tools/git/verify-release.mjs --tag v3.0.7 --no-artifact` 仍会红在
`tag: 在 main 的 first-parent 上` —— 这是**预期的**，它证明检查有效；把该输出贴进 AUDIT 即可。
从 v3.0.8 起，所有版本这条检查必须 GREEN。

---

## 6. 回滚清理动作（万一删错）

```powershell
# 6.1 从备份 bundle 恢复单条分支
git fetch ".tmp\backups\dsh-fang-all-<stamp>.bundle" "refs/heads/<name>:refs/heads/<name>-restored"
git push origin <name>-restored:refs/heads/<name>

# 6.2 从 archive 标签恢复
git branch <name> archive/<name>
git push -u origin <name>

# 6.3 从 reflog 恢复（仅限本地刚删）
git reflog | Select-String "<name>"
git branch <name> <sha>

# 6.4 远端分支被删后 GitHub 仍保留一段时间：
#     Settings → Branches → Deleted branches → Restore（或在对应 PR 页点 Restore branch）
```

---

## 7. 决策表（填完再执行；本表即清理记录）

| # | 分支/标签 | ahead | behind | dup | 分类 | 决策（删/归档/保留/回收） | 证据（命令输出/链接） | 执行人/时间 |
|---|---|---|---|---|---|---|---|---|
| 1 | `origin/TwinsEarth-patch` | 0 | 11 | 0 | merged | 删 | `git log -1` | |
| 2 | `origin/TwinsEarth-patch-0` | 0 | 13 | 0 | merged | 删 | | |
| 3 | `origin/TwinsEarth-patch-3` | 0 | 15 | 0 | merged | 删 | | |
| 4 | `origin/docs/pr-only-main` | 0 | 9 | 0 | merged | 删 | | |
| 5 | `origin/feat/forker-supervisor` | 0 | 1 | 0 | merged | 删 | | |
| 6 | `fix/session-history-ui` | 1 | 16 | 1.0 | duplicate | 归档后删 | `git show --stat` | |
| 7 | `feat/etag-status` | 29 | 5 | 0 | stale | 待判定（§阶段 2） | | |
| 8 | `feat/mirror-settings` | 28 | 5 | 0 | stale | 待判定 | | |
| 9 | `feat/release-mirror` | 28 | 16 | 0.07 | stale | 待判定 | | |
| 10 | `feat/umbrella-strict-errors` | 27 | 16 | 0.07 | stale | 待判定 | | |
| … | （其余 60 条） | | | | | | | |
| T1 | `v2.8.3` | — | — | — | tag off-main | 保留 + AUDIT 记录 | `merge-base --is-ancestor` | |
| T2 | `v2.9.0 / v2.9.2 / v2.9.3 / v2.9.9` | — | — | — | tag off-main | 保留 + AUDIT 记录 | | |
| T3 | `v3.0.7` | — | — | — | tag off-main | 保留（已发布）+ 回收 PR | §5 方案 A | |

---

## 8. 验收签字

- [ ] 备份 bundle 已生成并 `git bundle verify` 通过
- [ ] `merged` / `duplicate` 归零
- [ ] 分支引用 ≤ 10
- [ ] 所有 `v*` 标签有归属说明（main 上 或 AUDIT 表）
- [ ] `preflight --e2e` 在 main 上 GREEN
- [ ] 自动删分支已开启
- [ ] 下周一的 `history-audit` 已排进日程

执行人：`________`　复核人：`________`　日期：`____-__-__`
