# 错误本（ERROR-BOOK）— 瓮城 dsh-fang

> 目的：同一个错误不许犯第二次。
> 规则：**接手任务前先读本文件；每修完一个错误必须当场登记一条**（不许事后补、不许删旧条目）。
> 本文件是 `AGENTS.md` 的强制配套；与代码同等重要。条目只增不改，修正写在「后续」里。

## 0. 开工前自检（30 秒，必须做）

| # | 检查 | 命令 / 位置 |
|---|---|---|
| 1 | 读 `Fang/AGENTS.md` + 本文件 | — |
| 2 | 确认项目边界：只做瓮城，`dsh-master` 冻结 | `AGENTS.md §1.2` |
| 3 | 涉及分身（fork）操作前，先看有没有会话被搬走 | `forks/<task>/quarantine-sessions/`、`storages/workspace.json` |
| 4 | 涉及 UI 前，先确认 `sidebar.panellist` 里 `fang` 还在 | 见 EB-02 的核查命令 |
| 5 | 涉及部署/安装前，先确认宿主是否在跑 | `Get-Process 'DeepSeek Harness'`；宿主在跑 → **禁止**替换 profile |
| 6 | 报「已修好」前，必须给出一条**真机/真实数据**的验证证据，不接受「代码看起来对」 | — |

---

## EB-01 · 2026-11-22 · 重开分身时把会话静默搬进隔离区（用户会话「丢失」）

**现象**：用户的分身（`task_mwram4u9ylki`，DSH：瓮城Plus）重开后，侧栏里只剩 3 个会话；
被置顶的 `session-65beee95`（DSH：瓮城Plus）等 4 个会话消失，用户完全不知情。

**根因**：`src/plugins/orchestrator.mjs` 的 `restoreTask()` 每次重开都调用
`applyForkSessionGuard(task)`；该函数把按 mtime 排序后第 4 个起的会话
**rename 到 `quarantine-sessions/<stamp>/…`**。这是「分身最多 3 个会话」规格的实现，
但规格说的是「上限」，不是「重开时静默清场」。

**防线（已落地/待落地）**：
1. 立刻：把隔离区会话复制回 `sessions/<workspaceKey>/`，并用
   `tools/session/workspace.mjs` 的 `attachSessionsToWorkspace()` 重新登记 `workspace.json`
   （脚本：`scratch/attach-fork-sessions.mjs`）。
2. 代码：`restoreTask()` 不得再做会话搬移；超额只在面板显示 `violation` 警告，
   搬移只能由用户显式动作（`enforceSingleSession` / 归档）触发。
3. 回归：任何改动后跑 `node --test test/*fork*session*.test.mjs`，并断言
   「restore 前后 `sessions/` 目录数量不变」。
4. 内容取证/交付：`scratch/export-transcript.mjs` 把任意会话逐帧解压成
   `session.v4.jsonl`（官方明文）+ `*-转录.md`（可读，用户/助手正文逐字保留、工具输出折叠）。
   2026-11-22 用它救回「DSH：瓮城Plus」：40,859 事件 / 1,934 条用户消息 / 11-16 → 11-22 18:32。

**教训**：任何「自动整理用户数据」的逻辑，默认都是错的；要么只警告，要么必须可撤销且有日志。

---

## EB-02 · 2026-11-22 · 左侧栏「瓮城」入口消失（复发项）

**现象**：DSH Web 左侧导航看不到「瓮城」图标，点不进控制面板。

**历史根因（已发生过一次）**：v3.0.10 发布包把 `package.json` 的 `dsh.client` 字段删掉了，
client half 不加载，侧栏与主面板整体不出现（见 `docs/CHANGELOG.md` v3.0.10 条）。

**排查顺序（照做，别猜）**：
1. 活体槽位：`cordis_inspect_query platform=client provider=Slots method=listSubTree root=sidebar.panellist`
   → 期望 `registrant` 有 `fang`、`active: true`。有 → 前端已注册，问题在渲染/窗口；没有 → client half 没加载。
2. 装的是哪一版：`profiles/<profile>/node_modules/@twinsearth/fang-dsh-plugin/package.json`
   → 必须有 `dsh.client`（`platform: web`），且 `client.js` 存在、与预期版本一致（比对 sha256）。
3. 哪个窗口：母体 Desktop 窗口 vs 分身 Web（`http://127.0.0.1:<fork port>`）——两者是**不同页面**，
   排查前先确认用户看的是哪一个。
4. 构建缓存：分身/母体 profile 的 `cordis.patch.yml` 是否被「每次打开同步元主插件状态」改写。

**防线**：
- 发布门禁必须断言 `dsh.client` 存在且 `client.js` 打进包（`tools/release/build.mjs` 已有断言，别绕过）。
- 任何部署/发布后，必须用第 1 步的活体槽位查询验证一次「fang 在且 active」，再报完成。

**状态**：本次待定位（2026-11-22 19:20 活体查询显示 `fang` 已注册且 active，需确认用户看到的是哪个窗口）。

---

## EB-03 · 2026-11-22 · 宿主运行中替换母体 profile → fs.watch EPERM → 宿主崩溃

**现象**：DSH Desktop 弹出「DeepSeek Harness 无法使用」，host exit 1，日志
`fatal uncaught exception: EPERM: operation not permitted, watch`。

**根因**：部署时在宿主运行中对 `profiles/desktop/node_modules/@twinsearth/fang-dsh-plugin`
做 `Remove-Item` + `Robocopy`，watcher 在目录消失窗口报 EPERM，DSH 未捕获 → 进程退出。
完整报告：`docs/INCIDENT-2026-11-22-FORK-HOST-CRASH.md`。

**防线**：
1. 宿主运行中**禁止**写母体 profile；只用 `tools/release/deploy-profile.mjs`（宿主活着返回 409）。
2. 部署必须「临时目录落盘 → 校验 → 原子 rename」，并保留上一版备份。
3. 报「已部署」前，验证 `/fang/api/status` 的 version 与新版本一致、宿主 PID 未变。

**教训**：安装态是共享层，不是隔离层；对它的任何写操作都按「可能杀死宿主」对待。

---

## EB-04 · 2026-11-22 · `restore-session.mjs --attach-only` 实际不可用

**现象**：`node tools/session/restore-session.mjs --attach-only --session-id … --workspace …`
只打印 usage，不执行。

**根因**：`main()` 第 96 行的 `if (args.help || (!args.fromDsh && !args.snapshot))` 在
`--attach-only` 分支之前就 return 了。

**防线**：修 `main()` 的判定顺序（`--attach-only` 优先级最高），补一条 CLI 回归；
在修好之前用 `scratch/attach-fork-sessions.mjs` 直接调 `attachSessionsToWorkspace()`。

---

## EB-05 · 反复 · 不读 AGENTS.md 就动手 / 越界碰 dsh-master

**现象**：历史上出现过把范围写成「本会话只做房主 dsh-master」的错误版本文件，以及未确认就改 master。

**防线**：任何涉及 `dsh-master` 的请求 → 立即停止 + 提醒 + 要二次确认；
只有用户明确回复「确认在本会话继续 dsh-master」才可继续，且仅限该项。

---

## 登记模板（复制用）

```md
## EB-XX · YYYY-MM-DD · 一句话标题
**现象**：
**根因**：
**证据**（命令/日志/文件行号）：
**防线**（代码/测试/流程，写明谁来验证）：
**教训**：
```

---

## EB-06 · 2026-11-22 · node-compat 选了 bundle 但包被 profile 剪掉 → inspector 仍报错

**现象**：profile 的 `dsh.profile.bundles[0]` 已是 `@twinsearth/dsh-fang-node-compat`，但 `node_modules/@twinsearth/dsh-fang-node-compat` 不存在；DSH 启动时跳过该 bundle，`experimental-inspector` 仍报 `fetch is an accessor`。

**根因**：只把包名写进 `bundles`，没有同时写进 profile `package.json` 的 `dependencies`；DSH 启动时按依赖树清理 extraneous 包，node-compat 被剪掉。

**防线**：
- 代码：`repairOfficialEssence` / forker / orchestrator 写 bundle 时必须同时写 `dependencies['@twinsearth/dsh-fang-node-compat']='^0.1.0'`。
- 本地：`tools/repair-profile-node-compat.mjs` 在宿主**退出后**补依赖 + 包 + 首 bundle + client.js；宿主活着会拒绝（EB-03）。
- 回归：`preflight --e2e` 125/125；重启后检查 profile `node_modules` 包存在且 `/fang/api/status` 3.7.3。

**教训**：profile 里“选中 bundle”不等于“包已安装”；两者必须同一事务写入。

## EB-07 · 2026-11-22 · restoreTask 仍自动搬移用户会话（EB-01 未真正修复）

**现象**：`restoreTask()` 仍调用 `applyForkSessionGuard(task)`；重开分身时第 4 个起会话被 rename 到 `quarantine-sessions/`，用户不知情。

**根因**：EB-01 防线要求 restore 不再搬会话，但代码只改了一部分；restore 路径仍执行 guard。

**防线**：restore 改为 `{ skipped:'restore-never-moves-sessions', violation }`，只告警不移动；移动仅由显式 `enforceSingleSession`/归档触发。`orchestrator` 79 tests 通过。

**教训**：用户数据整理默认是错的；同类错误第二次必须变成回归测试。

## EB-08 · 2026-11-22 · `restore-session.mjs --attach-only` 只打印 usage

**现象**：`--attach-only` 被 `main()` 的 `!args.fromDsh && !args.snapshot` 判定提前 return。

**根因**：usage 门禁在 attach-only 分支之前。

**防线**：条件改为 `!args.attachOnly && !args.fromDsh && !args.snapshot`；真机命令已能进入 attach 分支。

**教训**：CLI 新分支必须放在 usage 门禁之前并加回归。

## EB-09 · 2026-11-22 · 热替换 client.js 触发 duplicate factory / 标签回退

**现象**：宿主运行时替换 profile `client.js`，页面报 `client-modules: duplicate factory registration for "@local/dsh-fang"`；重启后旧标签又回来。

**根因**：HMR 重复执行 client bundle；且 profile 包由安装态覆盖，手工 client.js 不持久。

**防线**：client 标签必须走源码 + 版本发布/部署；宿主运行中不热改 profile；完整重启后再验收。

**教训**：UI 修复不能靠热替换 profile 文件，必须按 EB-03 的部署路径。
