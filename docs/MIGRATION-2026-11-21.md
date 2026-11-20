# 迁移记录：dsh-fang → E:\DSH\DS\Fang（2026-11-21）

## 1. 结论

`E:\DSH\DS\Fang` 现在是本项目的**唯一根目录**：完整 git 历史（**68 个 tag**；`main` =
`origin/main`（`4c1df5d`，v3.5.5 发布记录 PR #134 合并后）+ **1 个本地迁移提交**，未推送）、
全部源码/测试/文档/构建产物、历史发布物、Fang 会话快照与官方格式 ZIP、契约子仓库、会话工具
都在其中；整个文件夹可复制到另一台机器继续开发。

> 迁移按旧仓库当时的检出（`docs/v3.5.5-release-record`，HEAD `f1f0506`，内容与 `origin/main`
> 的 `4c1df5d` 完全一致）复制；随后**只在新仓库**执行了远端同步（见 §4.1）。旧仓库未 fetch、未改动。

旧仓库 `E:/GPT/dsh-fang` **保留且未改动**（只读参照）。

## 2. 迁移清单

| # | 来源 | 去向 | 说明 |
|---|---|---|---|
| 1 | `E:/GPT/dsh-fang`（工作区，排除 `.git`、`.tmp`） | `E:\DSH\DS\Fang\` | 含 `node_modules/`（离线可跑）与 `dist/`（构建产物/历史 tarball） |
| 2 | `E:/GPT/dsh-fang/.git` | `E:\DSH\DS\Fang\.git` | 单独复制，保留全部分支/tag/双远端配置 |
| 3 | `E:/ToFuture/release/`（除 `stage-v3.0.9/`） | `archive\releases\` | v3.0.9 / v3.0.10 / v3.1.0 发布 ZIP、SIX-CHANNELS、SHA256、awesome-submission |
| 4 | `E:/GPT/reports/fang-plugin-evaluation-2026-11-19*`（3 个文件） | `archive\reports\` | 插件评估报告（含 HTML/全文/Markdown） |
| 5 | `E:/GPT/session-recovery/` 中 Fang 相关转录与重建大纲（10 个文件，7.96 MB） | `sessions\transcripts\` | 瓮城 / 瓮城Plus 的转录、大纲、重建与交接书 |
| 6 | `E:/GPT/dsh-recovery/` 的脚本与 README（7 个文件） | `archive\session-recovery-tools\` | DSH 会话恢复工具；排除 334 MB 扫描数据 |
| 7 | `E:/GPT/dsh-fang-contract`（含 `.git`） | `contract\`（本地目录，不入外层 git） | `@twinsearth/dsh-fang-contract` 1.2.0 子仓库，`src/contract/VENDOR.json` 与之一致 |
| 8 | `2Xray/share/SESSION-MIGRATION-KIT/session-tools/` | `tools\session\`（本地目录） | 会话恢复 / 官方 ZIP 导入（零依赖） |
| 9 | DSH 会话存储中的 Fang 会话 | `sessions\migrated-2026-11-21\` + 新工作区副本 | 见 §5 |

### 未迁移（有意排除）

- **旧仓库与其它项目**：`E:/GPT` 下 dsh-master / w2m / dsh-2xray / IM2A / deepseek-harness / Test /
  `.tmp`（约 10.5 GB 的临时脚本与日志）等一律不动、不复制；
- **旧仓库内的 `.tmp/`**（0.59 MB 临时脚本）不迁移；
- **`E:/GPT/dsh-fang-main`**：无 `.git` 的旧工作副本（3.1.x 时代），与 git 历史重复，不迁移；
- **`E:/GPT/dsh-recovery` 的扫描大数据**：`plan-one.json`（134.6 MB）、`provenance.json`（0.75 MB）、
  `staging-nov19/` 属于可重算的扫描产物，不迁移；
- **`E:/ToFuture/release/stage-v3.0.9/`**：发布 staging 副本（7.28 MB，可由 git tag 重建），不迁移；
- **FANG_HOME 运行数据**：`D:\ToFuture`（约 3.5 GB：`forks/ essence/ accel/ sessions/ mirror/ .tmp/`）
  是本机运行态数据，不属于项目目录；迁移不复制、不改动。`FANG_HOME` 默认值保持 `D:\ToFuture`，
  需要归口时再用 `npm run install:accel` / `tools/migrate-to-fang-home.mjs` 处理（见 §8）；
- **其它工作区会话**：只复制 Fang 相关会话（见 §5），其它项目/工作区的会话一律未动；
- **凭据**：`E:/GPT/.secrets` 的 token 不复制。发布前把凭据放到本仓库 `.secrets/`、用户目录
  `.secrets/` 或环境变量（`tools/release/lib.mjs` 按此顺序读取）。

## 3. 本地目录（不入库）

`.git/info/exclude` 已追加（不改 `.gitignore`，避免污染仓库历史）：

```
/sessions/  /scratch/  /runtime/  /archive/  /.secrets/  /tools/session/  /contract/
```

## 4. 完整性校验（迁移后实测）

| 检查 | 结果 |
|---|---|
| HEAD（迁移时点） | 旧 `f1f0506` = 复制后 `f1f0506` |
| `HEAD^{tree}` | 旧 `d6709442…` = 新 `d6709442…`（`4c1df5d` 的树也相同） |
| tracked 文件 | 631 = 631（Compare-Object = 0 diff） |
| tag 数 | 旧 67；新仓库同步远端并重建 v3.5.5 后为 **68** |
| `git fsck --no-progress --no-dangling` | 无输出（0 问题） |
| 工作树 | clean（本地目录已排除） |
| 文件量 | 3487 文件 / 47.6 MB（迁移前规模，含 `.git`、`node_modules`、`dist`） |

> 说明：`node_modules/` 一并保留（约 18 MB，保证换机未联网也能先跑）；换机后建议 `npm ci` 刷新。

### 4.1 远端同步（迁移后只在新仓库执行）

旧仓库本地缺两样远端已有状态：`v3.5.5` 的 annotated tag（当时通过 GitHub API 创建，从未 fetch）
与 `origin/main` 的合并提交 `4c1df5d`（PR #134 squash 合并）。新仓库已完成：

| 动作 | 结果 |
|---|---|
| `git fetch origin --prune --tags` | 成功；`origin/main` = `4c1df5d`；tag 全部就位 |
| 重建 v3.5.5 annotated tag | `git rev-parse v3.5.5` = `392c8470421abc59de81e26dfbdc45fd89327c82`（与远端标签对象 sha 完全一致）；指向 `20cfe3b`（v3.5.5 发布提交） |
| 分支 | 新仓库 `main` fast-forward 到 `4c1df5d`；迁移动作作为 **1 个本地提交**落在 `main`（领先 `origin/main` 1 个提交，未推送） |
| 旧仓库 | 未 fetch、未改（仍是 `docs/v3.5.5-release-record` @ `f1f0506`，67 tag） |

## 5. 会话恢复与官方 ZIP（详见 docs/SESSIONS.md）

| 项 | 值 |
|---|---|
| 源会话（当前 Fang 开发会话，旧工作区 `E:\GPT`） | `session-a6b0ed16-c58c-430d-a911-e4fe9577fc56`（检查时 14.9 MB，31164 events；会话仍在运行） |
| 新会话（本工作区） | `session-5460c1e7-523f-40d3-b35c-dcbfa7813dbf` |
| 第二个 Fang 会话（瓮城重建版） | 源 `session-0c36661d-…` → 新 `session-c0a6a6e0-47fd-4324-bea5-ecf9155b5848`（8925 events） |
| 新工作区 | `E:\DSH\DS\Fang`，workspaceId `c4b73d36-a36a-4c7c-bf40-6da944c6b0c5`，标题 `Fang`，成员 2 条 |
| 注册表备份 | `%USERPROFILE%\.dsh\storages\workspace.json.bak-preimport-20261120230147/.154` |
| 项目内快照 | `sessions\migrated-2026-11-21\current\`（新会话）、`...\legacy\`（瓮城 0c36661d 与原始 瓮城 fb8e6ae8 含 64 个后代） |
| 官方格式 ZIP | `sessions\dsh-session-5460c1e7.zip`（9,358,555 B；`session.v4.jsonl` 48,767,105 B / 31,164 events） |
| ZIP 导入验证 | 真实导入临时工作区成功（新 id `session-11bdf42e-…`，header `cwd` 重写正确），测试产物已清理 |

原始会话（含 77.1 MB 的 `session-fb8e6ae8-…`）仍留在原工作区，未移动、未删除。

## 6. 代码/工具适配（迁移随附）

| 文件 | 改动 |
|---|---|
| `tools/release/allowlist.mjs` | 本地目录（sessions/scratch/runtime/archive/.secrets/contract）不参与密钥与本地路径扫描 |
| `tools/release/release-order.mjs` | 契约仓库默认路径改为 `<repo>/contract`（可用 `--contract-repo` 覆盖） |
| `tools/release/lib.mjs` | 凭据读取顺序：环境变量 → `<repo>/.secrets/` → 用户 `.secrets/` → 旧路径兜底 |
| `tools/release/lsp-mother-check.mjs` | 提示里的 lsp-provider 路径改为仓库相对推导（不再硬编码旧根） |
| `tools/e2e.mjs`、`tools/release/lsp-live-setup.mjs` | LSP staging 默认目录改为本项目 `scratch/e2e-lsp-stage`（仍可用 `FANG_E2E_LSP_STAGE` 覆盖） |

## 7. 质量门（迁移后在新目录实测）

`node tools/release/preflight.mjs --e2e --json` → **GREEN**（16/16 项）：

| 项 | 结果 |
|---|---|
| 全量单测 | **1300 pass / 0 fail / 2 skip**（230.8 s） |
| 真实母体 + 分身 e2e | **125/125**（27.9 s） |
| 主城门禁（source） | **grade=A，blockers=0** |
| allow-list 自检 | routes=110，**findings=0** |
| crash-safety 不变量 | 10 项全过 |
| 产物 sha256 sidecar | match（`dist/dsh-fang-3.5.5.tgz` 未变） |

首次运行时只有 1 项红：licence-layering 测试扫到了本地目录 `tools/session/`（迁移工具包，未入库）。
已在 `test/licensing.test.mjs` 中排除该本地目录，重跑全绿。原始输出见
`docs/AUDIT-migration-2026-11-21.json`（含首轮红/修因/复跑结果、会话与 ZIP 证据）。

> `npm run release:check` 会报一条 `artifact … STALE`：这是已发布版本（`dist/dsh-fang-3.5.5.tgz`
> 构建自 `20cfe3b`）在发布后的正常状态，不是迁移损坏；如要再发布需重新构建并走发布指令。

## 8. 遗留事项

1. **旧仓库保留**：`E:/GPT/dsh-fang` 未删除、未修改；确认新目录可正常开发后可自行处理。
2. **FANG_HOME 未归口**：运行数据仍在 `D:\ToFuture`；若要把运行数据也收敛进本目录，需要显式指令
   （涉及正在运行的母体/分身，不能顺手做）。
3. **profile 未改**：本机 desktop profile 仍安装 npm 版插件（`^3.5.4`）；迁移不改变 profile。
4. **发布记录分支已被 squash 合并**：`docs/v3.5.5-release-record` 的内容已经过 PR #134 进入
   `origin/main`（`4c1df5d`）；分支本身仍在本地/远端，可自行删除或保留（迁移不改分支策略）。
5. **`release-order` 的 stale 检查**：迁移工作提交落在 `4c1df5d` 之上，`dist/dsh-fang-3.5.5.tgz`
   仍是已发布的 `20cfe3b` 构建品，因此 `npm run release:check` 会报 `artifact … STALE`（发布后
   的正常状态，不是迁移损坏；如要再发布需重新构建并走发布指令）。
5. **`node_modules` 建议换机后 `npm ci` 刷新**；本机保持迁移时状态。
