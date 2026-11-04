# dsh-Fang 发布工作流：v3.0.8 → v3.3.3

> 适用范围：`TwinsEarth/dsh-fang` 的 Git 分支、PR、CI、发布与回滚。
> 判定口径：**能在这里失败的规则才算规则**。每条规则都对应一个命令或一个会红的检查。
> 日期基线：2026-11-05（仓库实测状态见 §0）。
>
> 配套文件（本次一并落地）：
> - `docs/CHECKLIST-v3.0.8-v3.3.3.md` —— 六方发布前检查单（可打印、逐项签核）
> - `docs/DUP-HISTORY-CLEANUP-v3.0.8.md` —— 重复历史清理 runbook
> - `tools/git/guard-main.mjs` `tools/git/pr-gate.mjs` `tools/git/version-cut.mjs`
>   `tools/git/verify-release.mjs` `tools/git/history-audit.mjs`
> - `.githooks/pre-push`、`.github/workflows/{ci,compat,release}.yml`

---

## 0. 现状体检（先看数字，再谈方案）

`node tools/git/history-audit.mjs --no-patch` 在 2026-11-05 的实测输出：

| 事实 | 数字 | 含义 |
|---|---|---|
| `origin/main` | `3e0fe5a`，是 `v3.0.7` 提交的祖先 | 主干停在 v3.0.7 **之前** |
| 工作分支 `feat/upgrade-coordinator` | 领先 `origin/main` **79** 个提交（含 v3.0.8/v3.0.9 产出） | 真实发布内容在分支上 |
| 标签 `v3.0.7` | 附注标签对象 `2e28d4c` → 提交 `3bf976d`，**不在** `origin/main` 上，领先 main **71** 个提交 | 发布物与主干各一份 |
| 不在 main 上的版本标签 | `v2.8.3 v2.9.0 v2.9.2 v2.9.3 v2.9.9 v3.0.7`（6 个） | 发布完整性缺口 |
| 本地 `main` | `14155e9`（v2.3.1），落后 `origin/main` **16** 个提交 | 本地产物/本地判断不可信 |
| 分支引用 | 73 个引用 / 71 个唯一 tip（35 本地 + 41 远端） | 一条版本线被切成几十条平行历史 |
| 陈旧但有独有提交的分支 | 65 个（每条 20–29 个提交，落后 main 5–16） | 同一批改动在多条分支上重复存在 |
| 分支上的 `Merge branch 'main' into feat/...` | 2 个 | 用合并“追主干”，制造重复提交 |
| v3.0.7 门禁证据 | 679 tests / 0 fail / e2e 63/63 / 62 路由 / 16 插件行 | 门禁本身是可信的，问题在流程 |

### 风险登记册

| ID | 风险 | 触发条件 | 后果 | 对应章节 |
|---|---|---|---|---|
| R1 | 版本标签打在特性分支 | 在 `feat/*` 上 `git tag` | 发布物与 main 永久分叉；回滚找不到锚点 | §2 §7 |
| R2 | 主干落后于已发布版本 | 只推分支、只打标签、不合 main | 新分支从旧 main 切出，重复实现旧功能 | §1 §6 |
| R3 | 平行分支重复劳动 | 一个版本开多条分支、合并 main 追进度 | 65 条陈旧分支、review 无法收敛 | §1 §6 |
| R4 | runner 排队/卡死 | self-hosted 离线、无 timeout、无 concurrency | 发布流水线挂数小时，最后靠人手补 | §4 |
| R5 | 门禁可被“跳过”放大成绿灯 | e2e 可选且 skipped 不算失败 | 未跑 e2e 的版本被发布 | §3 §4 |
| R6 | 直推 main 无技术约束 | 无 hooks / 无保护 / 无 CODEOWNERS | 一次误推即改写发布事实 | §7 |

> 结论：**先修主干与标签（§6 §7），再谈 17 个版本（§2）**。否则新流程只是给旧问题换了名字。

---

## 1. 分支模型：单干线 + 版本闸（Trunk + Version Gate）

### 1.1 为什么不是 Git Flow

- 团队规模：1 名维护者 + 若干 agent，`develop` 的“集成缓冲”没有第二个消费者。
- 发布节奏：**每个版本都必须独立发布**（见 `docs/RELEASE-WAIVER-v3.0.7.md` 第 1、2 条：不得跳号，逐版 bump/CHANGELOG/AUDIT/tag）。
  这意味着版本线天然串行，不需要长期存在的集成分支。
- 历史形态诉求：`main` 上**一个版本一个提交**，`git log --oneline` 就是发布日志；用 `git bisect` 能落到版本粒度。

### 1.2 分支类型

| 类型 | 命名 | 从哪来 | 生命周期 | 允许推送 | 合并方式 |
|---|---|---|---|---|---|
| 主干 | `main` | — | 永久 | **仅维护者显式授权**（§7） | 只接受 PR |
| 版本分支 | `feat/v3.0.8-branch-runtime`<br>`fix/v3.0.10-pointer-race` | `origin/main` | 一个版本一个；合并后即删 | agent 可推 | squash |
| 热修 | `hotfix/v3.1.2-smoke-timeout` | 出问题的 **tag** | < 24h | agent 可推 | squash + 立刻补丁版 |
| 维护线 | `release/v3.1` | `v3.1.0` tag | 仅当 v3.1.x 需要回补 | 维护者 | 只 cherry-pick 已合入 main 的修复 |
| 归档 | `archive/<旧分支名>`（tag） | 旧分支 tip | 永久只读 | 禁止 | — |

规则（每条都有工具兜底）：

1. **一个版本 = 一个活跃分支 = 一个 PR**。同时存在两个活跃版本分支，说明范围没切干净。
2. **禁止 `git merge origin/main` 进工作分支**；一律 `git rebase origin/main`。
   兜底：`pr-gate` 的 `history: 无 merge 提交` 会红。
3. **分支存活 ≤ 3 天 / ≤ 15 个提交**；超了就拆版本，而不是继续堆。
4. **合并即删分支**（本地 + 远端）；删除前 `git branch --merged` 必须能看到它。
5. `main` 永远可发布：任何时刻 `node tools/release/preflight.mjs --e2e` 在 `main` 上都应是 GREEN。

### 1.3 与现状的衔接：先把主干接回来（一次性，只做一次）

当前 `v3.0.7` 的发布内容在 `feat/upgrade-coordinator` 上，`origin/main` 落后 71 个提交。
**不要**改写 `main` 历史，**不要**移动已发布的 `v3.0.7` 标签。做法是把分支内容以一次 squash 合回主干：

```bash
# 0) 备份（任何“清理/回收”动作之前都先做这个）
New-Item -ItemType Directory -Force .tmp\backups | Out-Null
git bundle create ".tmp/backups/dsh-fang-$(Get-Date -Format yyyyMMdd-HHmm).bundle" --all

# 1) 拉平本地 main（本地 main 落后 16 个提交，先对齐远端）
git switch main
git fetch origin --prune
git reset --hard origin/main

# 2) 从最新 main 切“回收分支”，把 v3.0.7 的发布内容 rebase 上去（不要 merge）
git switch -c chore/v3.0.7-reconcile
git rebase origin/main feat/upgrade-coordinator   # 若冲突：逐个解决后 git rebase --continue

# 3) 只保留“v3.0.8 之前”的内容：确认 HEAD 的版本号仍是 3.0.7
node tools/git/version-cut.mjs --check --version 3.0.7

# 4) 推分支、开 PR（PR 标题：chore(v3.0.7): 主干回收 —— 把已发布的 v3.0.7 内容合回 main）
git push -u origin chore/v3.0.7-reconcile
```

PR 标题必须写成 `chore(v3.0.7): 主干回收 —— 把已发布的 v3.0.7 内容合回 main`。
`pr-gate` 识别这个标题后进入 **reconcile 模式**（唯一允许复用已发布版本号的例外）：
跳过“版本号尚未打标签”，并要求版本阶梯必须是 `same`（即回收的正是已发布版本，不夹带新内容）。

PR 合并后立刻做三件事：

```bash
git switch main && git pull --ff-only
node tools/git/guard-main.mjs audit                 # main == origin/main
node tools/release/preflight.mjs --e2e              # 主干必须 GREEN（679 tests / e2e 63/63 量级）
node tools/git/verify-release.mjs --tag v3.0.7 --no-artifact || true
#   ↑ 预期 FAIL：v3.0.7 标签仍在旧提交上。把它记进 docs/AUDIT-v3.0.8.md 的“历史遗留”一节，
#     不要移动标签、不要重打 —— 已发布标签是事实，只能记录，不能修饰。
```

> 回收完成后，`origin/main` 与 v3.0.7 的内容一致（提交 ID 不同）。从这一刻起，**所有版本标签只允许打在 main 尖端**（§7 的 hook 会拦）。

---

## 2. 版本阶梯 v3.0.8 → v3.3.3（每版的提交与 tag）

### 2.1 版本清单

**唯一真相是 `docs/PLAN-v3.0.8-v3.3.3.md` §6（17 个连续版本）**；本表只负责“怎么提交、怎么打 tag、额外门禁”。
两者若不一致，以产品计划为准，并在同一个 PR 里同步修改本表——不允许出现两个版本序列（否则“不跳号”有两个真相）。

风险级决定“额外门禁”（§3.4）：
**L0** 只读/文档/UI 文案 · **L1** 增量 API、只读探测 · **L2** 状态变更（写盘/指针/实例重启）· **L3** 依赖与插件变更。

| 版本 | 主题（来源：PLAN §6） | 风险 | 分支 | 主提交主题（squash 后即 main 上的提交） | tag | 额外门禁 |
|---|---|---|---|---|---|---|
| v3.0.8 | 分支运行时转正 + 回流契约 + MCP 政策面 | L1 | `feat/v3.0.8-branch-runtime` | `feat(v3.0.8): 分支运行时转正 + 回流契约 + MCP 政策面` | 附注 | e2e 必跑 |
| v3.0.9 | 只读升级状态面冻结（收口 + 不跳号机器校验） | L1 | `feat/v3.0.9-status-freeze` | `feat(v3.0.9): 只读升级状态面冻结 + 不跳号机器校验` | 附注 | 路由契约计数 |
| v3.0.10 | 母体代际 + 指针切换 + 秒级回滚 | **L2** | `feat/v3.0.10-mirror-generations` | `feat(v3.0.10): 母体代际 + 指针切换 + 秒级回滚` | 附注 | 回滚演练 + 断电/超时注入 |
| v3.0.11 | 原身重算 + 影子实例 + 健康检查 + 切换 | **L2** | `feat/v3.0.11-essence-shadow` | `feat(v3.0.11): 原身重算 + 影子实例 + 健康检查 + 切换` | 附注 | 失败保留旧实例 |
| v3.0.12 | 插件更新 + 快照/冒烟/回滚 | **L3** | `feat/v3.0.12-plugin-update` | `feat(v3.0.12): 插件更新 + 快照/冒烟/回滚` | 附注 | 依赖锁 + restore 演练 |
| v3.1.0 | MCP 接入（客户端 + 工具投影 + 禁止暴露） | L2 | `feat/v3.1.0-mcp` | `feat(v3.1.0): MCP 接入 + 工具投影 + 禁止暴露` | 附注 | 暴露面清单 + 权限矩阵 |
| v3.1.1 | 升级路径控制台 + IPC 桥 + 浏览器面清零 | L2 | `feat/v3.1.1-console-ipc` | `feat(v3.1.1): 升级路径控制台 + IPC 桥 + 浏览器面清零` | 附注 | 死链断言 + IPC 契约 |
| v3.1.2 | 状态同步单一真相（rev/ETag/六态/轮询统一） | L2 | `feat/v3.1.2-state-single-truth` | `feat(v3.1.2): 状态同步单一真相（rev/ETag/六态）` | 附注 | 轮询/事件一致性 |
| v3.1.3 | 三向合并回流（base / ours / theirs） | L2 | `feat/v3.1.3-three-way-merge` | `feat(v3.1.3): 三向合并回流（base/ours/theirs）` | 附注 | 冲突矩阵 + 幂等 ID |
| v3.2.0 | 三根 fail-closed 强制 + broker 唯一通道 | L2 | `feat/v3.2.0-roots-fail-closed` | `feat(v3.2.0): 三根 fail-closed 强制 + broker 唯一通道` | 附注 | 越权访问矩阵 |
| v3.2.1 | 配额账本 + 端口租约 + 派生幂等 | L2 | `feat/v3.2.1-quota-lease` | `feat(v3.2.1): 配额账本 + 端口租约 + 派生幂等` | 附注 | 并发/配额边界 |
| v3.2.2 | 备份封印（SEAL/MANIFEST）+ 崩溃注入 + 启动 GC | **L3** | `feat/v3.2.2-backup-seal` | `feat(v3.2.2): 备份封印 + 崩溃注入 + 启动 GC` | 附注 | 崩溃注入证据 |
| v3.2.3 | 官方插件清单版本化 + 兼容矩阵 | L1 | `feat/v3.2.3-plugin-manifest` | `feat(v3.2.3): 官方插件清单版本化 + 兼容矩阵` | 附注 | 兼容矩阵冻结 |
| v3.3.0 | 长稳与性能（REL 全量） | L1 | `feat/v3.3.0-longrun-perf` | `feat(v3.3.0): 长稳与性能（REL 全量）` | 附注 | 基准对比 + 长跑 |
| v3.3.1 | 安全复审（注入 / token / IPC / 审计覆盖） | L2 | `feat/v3.3.1-security-review` | `feat(v3.3.1): 安全复审（注入/token/IPC/审计）` | 附注 | 安全复审清单 |
| v3.3.2 | 六方发布事务化 + 确认闸 | L2 | `feat/v3.3.2-release-transaction` | `feat(v3.3.2): 六方发布事务化 + 确认闸` | 附注 | 半发布状态演练 |
| v3.3.3 | GA 收口 | L0 | `feat/v3.3.3-ga` | `feat(v3.3.3): GA 收口` | 附注 | LTS 检查单 |

> 早期草稿里曾出现 `v3.0.13`（升级链收口）：本工作流**不采用**该版本号，其内容并入 v3.0.12 的观察窗与
> v3.1.1 的控制台收口。一份序列、一个真相。

### 2.2 提交与标签规范

**提交**（一个版本一个 squash 提交进入 main）：

```
<type>(v<版本>): <一句话结果>

- 证据：tests pass=N fail=0；e2e N/N；routes=N；plugins=16
- 回滚：<锚点名称>
- 关联：docs/AUDIT-v<版本>.md
```

- `type ∈ {feat, fix, chore, docs, test, refactor, perf, build, ci, revert}`；`scope` 必须是本版版本号。
  兜底：`pr-gate` 的 `commits:` / `pr:` 两项。
- 分支内的中间提交用 `wip(v3.0.8): ...` 也可以（squash 后不进 main），但 `pr-gate` 会校验每条提交主题合法——
  因此中间提交也请写成 `test(v3.0.8): ...` / `refactor(v3.0.8): ...`。

**标签**（附注标签，消息即发布说明摘要）：

```bash
git tag -a v3.0.8 -m "v3.0.8 分支运行时转正 + 回流契约 + MCP 政策面" \
  -m "gate: tests=680/0/1 e2e=63/63 routes=62 plugins=16" \
  -m "artifact: dsh-fang-3.0.8.tgz sha256=<构建后回填>" \
  -m "rollback: active-v3.0.7-pre / merged-v3.0.7 / plugin-snapshot-<ts>"
```

- 标签必须落在 **main 尖端**：`v3.0.8..origin/main` 必须为 0 个提交。
  兜底：`release.yml` 的 `guard` job + `.githooks/pre-push`。
- **已发布标签不可移动**。发错了就发下一个补丁版本，并在 Release 说明里写清替代关系。

### 2.3 一个版本从开工到发布的完整命令（以 v3.0.8 为例）

```bash
# ── 1. 开工：永远从最新 main 切 ─────────────────────────────────────────────
git fetch origin --prune
git switch main && git pull --ff-only
git switch -c feat/v3.0.8-branch-runtime

# ── 2. 开发：小步提交；每天至少 rebase 一次 ───────────────────────────────
#    ... 改代码 ...
node --test --test-concurrency=1 "test/*.test.mjs"     # 局部反馈（约 50s）
git add -A && git commit -m "feat(v3.0.8): 分支多日志结构 + 单写者锁"
git fetch origin && git rebase origin/main              # 不用 merge，不用 pull --rebase 之外的方式

# ── 3. 版本收口：四处版本号一次改到位（package / FANG_VERSION / CHANGELOG / AUDIT）──
node tools/git/version-cut.mjs 3.0.8 --theme "分支运行时转正 + 回流契约 + MCP 政策面" --commit
#   产物：package.json、src/kernel/types.mjs、docs/CHANGELOG.md、docs/AUDIT-v3.0.8.md

# ── 4. 本地门禁（发布门禁的同一条命令）────────────────────────────────────
node tools/release/preflight.mjs --e2e                 # 必须 GREEN，报告落 dist/preflight.json
node tools/git/pr-gate.mjs --base origin/main          # 结构门禁：线性/版本阶梯/路径/SPDX
node tools/git/verify-release.mjs --tag v3.0.8 --no-artifact --no-write || true
#   ↑ 此时还没打 tag，预期“tag: 存在 = FAIL”，其余项应全 PASS；用于提前发现版本不一致

# ── 5. 推分支（agent 只推分支）───────────────────────────────────────────
git push -u origin feat/v3.0.8-branch-runtime

# ── 6. 开 PR（标题即最终 squash 提交主题）────────────────────────────────
#    PR 标题：feat(v3.0.8): 分支多日志 + 单写者 + 指针切换 spike
#    正文：按 .github/PULL_REQUEST_TEMPLATE.md 填“门禁证据”表
#    L2/L3 版本：加 run-e2e 标签（若 FORCE_E2E=1 则默认已开）

# ── 7. 门禁绿灯 → squash 合并（合并按钮只有维护者能点）─────────────────────
#    合并方式必须选 Squash and merge；提交信息用 PR 标题

# ── 8. 合并后：在 main 上复跑门禁，再打 tag ───────────────────────────────
git switch main && git pull --ff-only
node tools/release/preflight.mjs --e2e                 # 合并后的第二次证明（防止“分支绿、主干红”）
git tag -a v3.0.8 -m "v3.0.8 分支运行时转正 + 回流契约 + MCP 政策面" \
  -m "gate: tests=$(node -e "console.log(require('./dist/preflight.json').tests.pass)") e2e=$(node -e "const p=require('./dist/preflight.json');console.log(p.e2e.passed+'/'+p.e2e.total)")"
node tools/git/verify-release.mjs --tag v3.0.8 --no-artifact   # 本地断言：tag 在 main 尖端 + 证据齐全

# ── 9. 推 tag（触发 release.yml；hook 会校验 tag 在 main 上）───────────────
git push origin v3.0.8

# ── 10. 发布后：观察窗 + 六方签核 ────────────────────────────────────────
#     gh run watch（或 Web UI）等 release workflow 全绿
node tools/git/verify-release.mjs --tag v3.0.8 --remote   # npm/GitHub 远端复核
node tools/release/sync-private.mjs verify --tag v3.0.8 --json
#     72h 内保持上一代目录与插件快照不删（§5 的回滚锚点）
```

---

## 3. PR 门禁

### 3.1 必过检查（分支保护里只配这些）

| 检查名（GitHub 上显示） | 来自 | 跑什么 | 失败意味着 |
|---|---|---|---|
| `gate (required)` | `ci.yml` → `gate` | 聚合 hygiene / test / license / e2e | 任一子项红或“被要求却跳过” |
| `compat (node 22)` / `compat (node 24)` | `compat.yml` | `tools/release/compat.mjs` | 模块 import 或 engines 不兼容 |
| `hygiene (pr-gate)`（可选，已被 gate 覆盖） | `ci.yml` | `tools/git/pr-gate.mjs` | 版本阶梯/线性/路径/提交信息不合规 |
| `test (node 22)` / `test (node 24)`（可选） | `ci.yml` | 全量 `node --test` | 功能回归 |
| `e2e (self-hosted windows)`（按标签） | `ci.yml` | `tools/e2e.mjs` | 真实母体/分身链路断 |

**只把 `gate (required)` 与 `compat (node 22/24)` 设为 required**：矩阵扩容时不需要改保护配置，避免
“新增一个 job 忘了加 required，红灯也能合”。

### 3.2 `pr-gate` 具体判据（`tools/git/pr-gate.mjs`）

| 判据 | 通过条件 | 为什么 |
|---|---|---|
| 语义化版本 | `package.json` 是 `x.y.z` | 版本号是发布主语 |
| 三处一致 | `package.json` = `FANG_VERSION` = `CHANGELOG ## vX` | v3.0.7 前曾靠人肉同步 |
| 版本阶梯 | 上一 tag → 本版只允许 +1 patch/minor/major；跳号需 `docs/RELEASE-WAIVER-*.md` 提到该版本 | 落实“不跳号”规则 |
| 未打标签 | `refs/tags/vX` 不存在 | 防止复用已发布版本号 |
| 主干回收例外 | 标题形如 `chore(vX): 主干回收` 时进入 reconcile 模式：允许复用已发布版本号，但阶梯必须是 `same` | 让“把已发布内容接回主干”有唯一、可审计的通道 |
| 纯基础设施 | 改动全部落在 `.github/ docs/ tools/git/ .githooks/ test/` 时，允许版本号已打标签、阶梯为 `same` | 工作流/文档类 PR 不产生发布物，不应被发布规则卡死 |
| AUDIT 存在 | `docs/AUDIT-vX.md` | 发布证据不是口头承诺 |
| 禁止路径 | 不含 `dist/`、`node_modules/`、`relay-server/`、`enterprise/`、`*.jsonl` | 产物/商业层/运行数据不入库 |
| 线性历史 | `git log --merges origin/main..HEAD` 为空 | 禁止“合并主干追进度” |
| 提交规范 | 每条 `type(vX): 摘要` | 生成可读的发布日志 |
| PR 标题 | `type(vX): 摘要`，版本与 package 一致 | squash 后这条就是 main 的提交信息 |
| SPDX | 新增代码文件前 3 行含 `SPDX-License-Identifier` | 许可分层是发布条件 |

### 3.3 分支保护配置（一次性）

没有 `gh` CLI 时用 REST（把 `GITHUB_TOKEN` 设为有 `admin:repo` 权限的 PAT）：

```bash
curl -sS -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/TwinsEarth/dsh-fang/branches/main/protection \
  -d '{
    "required_status_checks": { "strict": true, "contexts": ["gate (required)", "compat (node 22)", "compat (node 24)"] },
    "enforce_admins": true,
    "required_pull_request_reviews": { "dismiss_stale_reviews": true, "required_approving_review_count": 0 },
    "restrictions": null,
    "required_linear_history": true,
    "allow_force_pushes": false,
    "allow_deletions": false,
    "required_conversation_resolution": true
  }'
```

标签保护（禁止移动/删除版本标签）：

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/TwinsEarth/dsh-fang/rulesets \
  -d '{
    "name": "protect-release-tags",
    "target": "tag",
    "enforcement": "active",
    "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
    "rules": [{ "type": "deletion" }, { "type": "update" }, { "type": "non_fast_forward" }]
  }'
```

校验：

```bash
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/TwinsEarth/dsh-fang/branches/main/protection | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);
  console.log('PR required:',!!r.required_pull_request_reviews);
  console.log('linear:',r.required_linear_history?.enabled);
  console.log('force push:',r.allow_force_pushes?.enabled);
  console.log('checks:',r.required_status_checks?.contexts?.join(', '))})"
```

> `required_approving_review_count: 0` 是单人维护仓库的现实选择：**PR 机制 + 保护 + 门禁**仍然生效，
> 但“必须有第二个人批准”在没有第二个人时只会被绕过。等有第二名维护者时改成 1。

### 3.4 风险级附加门禁

| 风险级 | 附加要求 | 证据落点 |
|---|---|---|
| L0 | 无 | 文档/变更说明 |
| L1 | 路由契约计数（`tools/release/allowlist.mjs --json`）；插件行数 = 16 | `dist/preflight.json` + AUDIT |
| L2 | e2e 必跑；**回滚演练**（制造一次失败，确认旧代仍在跑）；失败注入（超时/磁盘满/进程被杀） | AUDIT「回滚演练」段 + `dist/preflight.json` |
| L3 | 依赖锁定（`--frozen-lockfile` / 快照哈希）；smoke 通过；`vm_restore` 演练；插件清单 diff 审查 | AUDIT + Release 说明 |

---

## 4. Runner 稳定性

### 4.1 拓扑

| 用途 | Runner | 为什么 | 失败代价 |
|---|---|---|---|
| 全量测试 / 许可 / 兼容 | `windows-latest`、`ubuntu-latest`（GitHub 托管） | 无需维护，矩阵并行 | 分钟数消耗、偶发排队 |
| 真实 e2e（母体+分身） | `[self-hosted, windows, fang-e2e]` | 需要本机 DSH 客户端、AppContainer、junction | **自建 runner 离线 = 发布停摆** |
| 发布构建（tarball+manifest） | 同上 | 必须在有 e2e 能力的主机上产出 | 产物不可信 |

**明确不做的**：用“跳过 e2e”换发布速度。v3.0.7 的教训就是 `e2e: null` 也能绿。
runner 挂了就红，红就修 runner —— 这是唯一的分支。

### 4.2 六类抖动与对策（全部已落进 workflow）

| 症状 | 根因 | 对策（落点） |
|---|---|---|
| 同一 PR 连推 5 次，5 条流水线并行，最后一条排队 40 分钟 | 无 concurrency | `concurrency: ci-<workflow>-<head_ref>` + `cancel-in-progress: true`（`ci.yml`/`compat.yml`） |
| 某个 job 卡住，整条流水线挂几小时 | 无 timeout | 每个 job `timeout-minutes`：hygiene 10 / test 25 / license 5 / e2e 45 / build 45 / publish 15 |
| 自建 runner 离线，job 无限排队 | GitHub 排队无超时 | `guard` job 先跑（ubuntu，秒级）→ 自建 runner 的 job 排在后面；runner 侧自检步骤（node/dsh/磁盘）失败即明确报错；离线 > 2h 按 §4.4 处置 |
| 上一轮残留污染（旧 `DSH_HOME`、旧 `dist/`、旧快照） | 非临时工作区复用 | `git clean -ffdx -e dist` + 清理 `$env:TEMP\fang-e2e` + 构建前 `Remove-Item dist` |
| 测试偶发红，重跑就绿 | 并发/端口/时序 | 保持 `--test-concurrency=1`；**禁止自动重试测试**：标记 `{ skip: true }` + 开 issue + 在 AUDIT 记录隔离原因 |
| Node 版本漂移（22 vs 24 行为差异） | runner 自带 node 版本不同 | 显式 `actions/setup-node@v4` 指定 22/24；自建 runner 自检打印 `node -v` |
| 依赖安装/网络抖动 | 无第三方依赖，风险低 | 保持零依赖；不引入 npm install 步骤（这本身就是稳定性设计） |

### 4.3 自建 runner 的运维基线（Windows）

```powershell
# 一次性注册（临时 runner：每个 job 用全新工作区，跑完自动注销，天然免疫残留污染）
mkdir C:\actions-runner-fang
cd C:\actions-runner-fang
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/latest/download/actions-runner-win-x64.zip -OutFile runner.zip
Expand-Archive runner.zip -DestinationPath .
.\config.cmd --url https://github.com/TwinsEarth/dsh-fang --token <RUNNER_TOKEN> `
  --labels fang-e2e,x64 --name fang-e2e-1 --work _work --ephemeral --unattended

# 常驻：用计划任务守护“跑完即退”的 runner（每 5 分钟拉起一次，幂等）
schtasks /Create /TN "fang-runner" /SC MINUTE /MO 5 /F /TR "C:\actions-runner-fang\run.cmd"
schtasks /Run /TN "fang-runner"

# 健康检查（发布前手动跑一次）
& C:\actions-runner-fang\run.cmd --check
```

> 关键参数：`--ephemeral`（一次性）+ `--labels fang-e2e`（与 workflow 的 `runs-on` 对齐）+ 计划任务守护（离线自愈）。
> 若使用持久 runner，必须加“作业前清理”步骤（`ci.yml`/`release.yml` 已有）。

### 4.4 Runner 故障处置（分级，写进发布检查单）

| 级别 | 判定 | 动作 | 允许发布？ |
|---|---|---|---|
| R-黄 | e2e 单次超时，重跑通过 | 记录到 AUDIT，继续 | 是（观察窗内加测一次） |
| R-橙 | runner 离线 < 2h | 修 runner（重启服务/计划任务）；PR 的 e2e 用 `run-e2e` 标签补跑 | 否（等 runner 恢复） |
| R-红 | runner 离线 ≥ 2h 或磁盘 < 10GB | 临时注册第二台 runner（同一 label）；**不降级门禁** | 否 |

---

## 5. 失败回滚（分层，逐层都有命令）

回滚的粒度必须与风险的粒度一致：**PR 的问题回 PR，版本的问题回版本，母体的问题回指针，插件的问题回快照。**

| 层 | 触发条件 | 回滚动作 | 验证 | 命令/接口 |
|---|---|---|---|---|
| L0 PR | PR 合并后发现问题，尚未打 tag | `git revert <squash-sha>` → 走 PR | `preflight` GREEN | `git revert <sha> --no-edit` → 推分支 → PR |
| L1 版本 | tag 已推，npm/GitHub 已发 | **不移动标签**；发下一个补丁版（`vX.Y.Z+1`），旧版 npm `deprecate` | `verify-release --tag 新标签` | `npm deprecate @twinsearth/dsh-fang@X.Y.Z "原因，改用 X.Y.Z+1"` |
| L2 母体 | 指针切换后健康检查失败 / 24h 内发现慢 Bug | 指针切回上一代（`current → active-vX.Y.Z-pre`）；保留旧代 24h | `healthz` + 冒烟 | 由 v3.0.10 的 `AtomicSwitcher` 执行：`switch(current, active-v<上一版>)`；文件系统层等价操作：`mklink /J current active-v3.0.9`（Windows）/ `ln -sfn active-v3.0.9 current`（POSIX） |
| L3 原身 | recompute 后新实例不健康 | 指针回到 `merged-v<上一版>/`，用旧合并结果重启实例 | 实例 `health{adapter:ok}` | v3.0.11 的 recompute 是 copy-on-write：新目录 `merged-v<新版>` 失败则**保留** `merged-v<旧版>`，只切换不删除 |
| L4 分身 | 分身运行异常 | `vm_restore` 到派生时快照 | 分身 `phase=running` + 命令通道可用 | 派生即快照，恢复是常数时间 |
| L5 插件 | 更新后 smoke 失败 | `vm_restore` 到更新前快照；UI 提示耗时与日志 | `dsh doctor` + `npm run smoke` | 更新前必 `vm_snapshot`；失败恢复后**不要**保留半更新的 node_modules |

### 5.1 发布事故的 5 步处置（写进 Release 说明模板）

```bash
# 1) 止血：把发布流水线停掉（取消正在跑的 release run；tag 不动）
#    GitHub UI → Actions → release → Cancel workflow

# 2) 定位：确认问题属于哪一层（L1..L5），拿到锚点
node tools/git/verify-release.mjs --tag v3.0.8 --remote --json   # 发布事实
node tools/git/history-audit.mjs --no-patch                      # 主干是否被污染

# 3) 回滚：按上表执行；母体/原身回滚后必须跑健康检查
#    母体：切回上一代 → healthz → 观察 10 分钟
#    插件：vm_restore → dsh doctor

# 4) 补丁：从 main 切 hotfix 分支，走完整 PR 门禁
git switch main && git pull --ff-only
git switch -c hotfix/v3.0.8-smoke-timeout
#    ... 修复 ...
node tools/release/preflight.mjs --e2e
git push -u origin hotfix/v3.0.8-smoke-timeout

# 5) 记录：docs/AUDIT-v<下一版>.md 写“事故 → 根因 → 回滚耗时 → 防复发”
```

### 5.2 标签与已发布产物的铁律

1. **已发布标签永不移动**（ruleset 已禁止 update/delete）。发错 → 下一个补丁版本。
2. **已发布 tarball 永不覆盖**（GitHub Release 资产 `fail_on_unmatched_files` + 版本号唯一）。
3. **回滚不等于删除历史**：`git revert` 产生新提交，而不是 `reset --hard` 后强推。
4. 只有在**从未推送**的情况下才允许 `git reset --hard` / 重建 tag。

---

## 6. 重复历史清理

详见 `docs/DUP-HISTORY-CLEANUP-v3.0.8.md`。本节给结论与命令入口。

**根因**（不是“分支太多”，而是三个动作的组合）：
1. 版本内容长期只存在于 `feat/*`，主干靠“合并分支”推进 → main 上出现 `Merge branch 'main' into feat/...`；
2. 标签打在分支上（6 个版本标签至今不在 main 上）→ 发布物与主干各一份；
3. 同一版本在多条分支上重复实现（65 条陈旧分支、每条 20–29 提交）→ review 与 bisect 都失去意义。

**清理原则**：
- **不改写已发布历史**（`main`、已发布 tag 是事实）。
- 用 **squash 合并 + 标签归位**实现“向前去重”，而不是 `filter-repo` 重写过去。
- 删除前先 `archive/<name>` 打标签，可恢复；删除与备份在同一小时内完成。

```bash
# 备份（强制）
git bundle create ".tmp/backups/pre-cleanup-$(Get-Date -Format yyyyMMdd-HHmm).bundle" --all

# 清点（只读，约 15s；加 --no-patch 跳过补丁比对）
node tools/git/history-audit.mjs --no-patch

# 可删（0 领先）→ 先本地删，再删远端
git branch -d <ref>; git push origin --delete <ref>

# 陈旧/重复 → 先归档再删
git tag archive/<ref> <ref> && git push origin archive/<ref>
git branch -D <ref> && git push origin --delete <ref>

# 清理后验证
git branch -a; git tag --list 'v*'; node tools/git/history-audit.mjs --no-patch
```

---

## 7. 绝不未经允许推送 main

四层防线，任一层单独失效都不会导致误推：

### 7.1 本地钩子（第一层，最快）

```bash
git config core.hooksPath .githooks      # 每个 clone 一次
git config --get core.hooksPath          # 校验
node tools/git/guard-main.mjs audit      # main 是否 == origin/main
```

- `refs/heads/main`、`refs/heads/release/*`、`refs/tags/v*` 的推送全部经过 `tools/git/guard-main.mjs`。
- 授权是**粘贴式**的：`FANG_ALLOW_PROTECTED_PUSH="refs/heads/main@<完整sha>"`，只对那一个提交生效。
- 版本标签必须指向 main 的 **first-parent** 提交，否则拒绝。
- 钩子调用 
ode：若某些 GUI 客户端的 PATH 里没有 node，main/tag 推送会失败（fail-closed，普通分支不受影响）；用装了 node 的终端推送即可。

### 7.2 远端保护（第二层，无法用 `--no-verify` 绕过）

见 §3.3：`enforce_admins: true`、`allow_force_pushes: false`、`required_linear_history: true`、
标签 ruleset（禁 update/delete/non-fast-forward）。

### 7.3 CI 审计（第三层，事后可见）

`ci.yml` 在 `push` 到 main 时执行 `guard-main.mjs audit` 并输出 notice；`release.yml` 的 `guard` job
断言 tag 正好等于 `origin/main` 尖端（`tag..main` 必须 0 个提交）。

### 7.4 Agent 契约（第四层，写进协作约定）

- agent 只推 `feat/*`、`fix/*`、`hotfix/*`；**永不**执行 `git push origin main`、`git push --force` 到 main。
- 需要直推 main 时，agent 只输出命令 + 理由，由维护者本人执行。
- 任何“为了让流水线变绿”的跳过（`--no-verify`、删除检查、改 required）都必须先获得维护者明确同意。

### 7.5 误推后的处置（不要强推覆盖）

```bash
# 1) 立刻停手：不要 push --force，不要删除远端 main
git fetch origin
git log --oneline -5 origin/main

# 2) 判断是否已发布：若已触发 release workflow，先取消该 run
#    GitHub UI → Actions → release → Cancel

# 3) 用 revert 恢复（走 PR，符合保护规则）
git switch main && git pull --ff-only
git switch -c revert/unauthorized-<sha>
git revert <sha> --no-edit
git push -u origin revert/unauthorized-<sha>
#    PR 标题：revert: 撤销未授权的 main 变更（<原提交主题>）

# 4) 若误推包含敏感信息：按 SECURITY.md 处置（轮换凭据优先于清理历史），
#    历史清理只在“从未被他人拉取”时用 filter-repo，且必须维护者批准。
```

---

## 8. 六方发布前检查单

完整版：`docs/CHECKLIST-v3.0.8-v3.3.3.md`（逐项可勾、可签核）。六方与职责：

| # | 方 | 关注点 | 一票否决项 |
|---|---|---|---|
| 1 | **代码库（Repo/Git）** | 主干线性、tag 在 main 尖端、版本三处一致、无残留分支 | tag 不在 main 上 / 版本不一致 |
| 2 | **母体（Mirror）** | 代际目录、指针、快照、24h 保留、healthz | 无回滚锚点 / 健康检查未跑 |
| 3 | **原身（Essence）** | recompute、`merged/` 新旧并存、实例健康、回滚点 | 旧代被删 / 实例不健康 |
| 4 | **分身（Derived/Forker）** | 派生化、token 不落盘、配额、崩溃恢复、真分身 e2e | e2e 未跑 / token 泄漏 |
| 5 | **插件与供应链** | 16 行插件、SPDX、许可分层、锁、smoke、snapshot | 许可分层红 / 无快照 |
| 6 | **发布与回滚（Release/Ops）** | 产物 sha256、npm/GH/Docker、私有镜像 verify、回滚演练、公告 | sha256 不一致 / 私有镜像未 verify |

**放行规则**：六方全部勾选 → 维护者签核 → 才允许 `git push origin v<版本>`。
任一方否决 → 停，不允许“先发再补”。

---

## 9. 逐版本 SOP（12 步，贴在 issue 里照做）

| # | 步骤 | 命令 | 完成判据 |
|---|---|---|---|
| 1 | 对齐主干 | `git fetch origin --prune && git switch main && git pull --ff-only` | `guard-main audit` 显示 main==origin/main |
| 2 | 切版本分支 | `git switch -c feat/v<X>-<slug>` | 分支名含版本号 |
| 3 | 开工前基线 | `node tools/release/preflight.mjs --e2e` | GREEN（若红，先修主干再开工） |
| 4 | 开发 | 小步提交，每日 `git rebase origin/main` | 无 merge 提交 |
| 5 | 版本收口 | `node tools/git/version-cut.mjs <X> --theme "…" --commit` | 四处版本号一致 |
| 6 | 本地门禁 | `preflight --e2e` + `pr-gate` | 两条都 GREEN |
| 7 | 推分支 | `git push -u origin feat/v<X>-<slug>` | 远端分支存在 |
| 8 | 开 PR | 标题 `type(v<X>): …`；填门禁证据；L2/L3 加 `run-e2e` | PR 模板齐全 |
| 9 | 过门禁 | 等 `gate (required)` + `compat` 绿 | 全绿，无 pending |
| 10 | squash 合并 | UI 选 Squash and merge | main 上恰好多 1 个提交 |
| 11 | 主干复证 + 打 tag | `preflight --e2e` → `verify-release --no-artifact` → `git tag -a` | `verify-release` GREEN |
| 12 | 推 tag + 观察窗 | `git push origin v<X>`；72h 内保留回滚锚点 | release workflow 全绿 + 六方签核 |

---

## 10. 附录

### 10.1 命令速查

| 目的 | 命令 |
|---|---|
| 体检仓库 | `node tools/git/history-audit.mjs --no-patch` |
| 检查 main 是否漂移 | `node tools/git/guard-main.mjs audit` |
| 结构门禁（本地） | `node tools/git/pr-gate.mjs --base origin/main` |
| 版本收口（预演/执行） | `node tools/git/version-cut.mjs 3.0.8 --dry-run` / `… 3.0.8 --commit` |
| 版本一致性校验 | `node tools/git/version-cut.mjs --check --version 3.0.8` |
| 发布完整性 | `node tools/git/verify-release.mjs --tag v3.0.8 --no-artifact` |
| 发布后复核 | `node tools/git/verify-release.mjs --tag v3.0.8 --remote --private` |
| 发布门禁 | `node tools/release/preflight.mjs --e2e` |
| 实机 e2e | `node tools/e2e.mjs` |
| 构建产物 | `node tools/release/build.mjs` |
| 产物健康 | `node tools/release/healthz.mjs [--remote]` |
| 私有镜像 | `node tools/release/sync-private.mjs verify --tag v3.0.8 --json` |
| 路由契约 | `node tools/release/allowlist.mjs --json` |

### 10.2 故障速查

| 症状 | 第一反应 |
|---|---|
| `preflight` 红在 `version: CHANGELOG has a section` | `version-cut.mjs --check --version <X>` 看哪一处没改 |
| `pr-gate` 红在 `history: 无 merge 提交` | `git rebase origin/main`（不要 merge） |
| `pr-gate` 红在 `版本阶梯 = skip` | 补 `docs/RELEASE-WAIVER-v<X>.md` 或改回下一版 |
| `verify-release` 红在 `tag: 在 main 的 first-parent 上` | 停止发布；按 §6 回收主干后重打（仅限未发布） |
| `release.yml` 的 `guard` 红在 `main 已超前 tag` | 先合并再打 tag；tag 落在合并前的提交上就会这样 |
| `release.yml` 的 `build` 一直 queued | runner 离线：按 §4.4 处置，不要改 `if` 跳过 |
| npm 发布失败但 GitHub Release 已发 | 不要再推 tag；手动补发 `npm publish`（同一 tarball），并在 Release 说明记录 |
| 母体升级后 UI 白屏 | 指针切回上一代（§5 L2）；保留现场（不要删 `active-v<新版>`） |
| 插件更新后启动失败 | `vm_restore` 到更新前快照；把 smoke 日志贴进 issue |

### 10.3 本次落地的文件

| 文件 | 作用 | 验证方式 |
|---|---|---|
| `tools/git/guard-main.mjs` | main/tag 推送闸门（供 hook 与 CI 调用） | `test/git-workflow-tools.test.mjs` |
| `.githooks/pre-push` | 本地拦截（含授权与提示） | 手动：`echo "refs/heads/main <sha> refs/heads/main <sha>" \| sh .githooks/pre-push` |
| `tools/git/pr-gate.mjs` | PR 结构门禁 | `node tools/git/pr-gate.mjs` |
| `tools/git/version-cut.mjs` | 版本收口 + 一致性校验 | `--dry-run` / `--check` |
| `tools/git/verify-release.mjs` | 发布完整性断言 | `--tag v3.0.7 --no-artifact`（预期红，复现历史问题） |
| `tools/git/history-audit.mjs` | 重复历史清点 | `--no-patch` / `--json` |
| `.github/workflows/ci.yml` | PR 聚合门禁 `gate (required)` | PR 上观察 |
| `.github/workflows/release.yml` | tag → 守卫 → 构建 → 发布 → 终检 | 下一个 tag |
| `.github/workflows/compat.yml` | 兼容性独立门禁（加 timeout/concurrency） | PR 上观察 |
| `test/git-workflow-tools.test.mjs` | 工具自证（12 项） | `node --test test/git-workflow-tools.test.mjs` |
| 全量回归 | 新增工具未破坏既有套件 | `node --test --test-concurrency=1 "test/*.test.mjs"` → **702 tests / 691 pass / 0 fail / 1 skip / 10 todo**（30.2s） |
