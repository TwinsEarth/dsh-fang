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

## EB-10 · 2026-11-22 · open-url GET 有副作用，点「打开」会 stop/rebuild 分身

**现象**：GET `/fang/api/tasks/open-url` 触发 `syncTaskOnOpen`，12s 超时；分身 failed→ready、端口 18000→18002，客户端只看到失败。
**根因**：把同步/重建塞进 GET；客户端超时后服务端仍在执行。
**防线**：GET 只读返回 URL；新增 `POST /fang/api/tasks/open` 执行显式同步；客户端打开改 POST。e2e 125/125，routes 无重复。
**教训**：GET 永远不能产生重启/写盘副作用。

## EB-11 · 2026-11-22 · fork 内复制 node-compat 包破坏 derive（fork-bundle-unavailable）

**现象**：在 forker spawn 前把 node-compat 复制到 fork profile node_modules，e2e derive 报 `fork-bundle-unavailable`，121/122。
**根因**：fork 的 `node_modules/@twinsearth` 是指向母体的 symlink；复制写穿/扰乱解析，`forkBundlePath()` 找不到 fang。关闭复制后 e2e 125/125。
**防线**：复制默认关闭（仅 `DSH_FANG_NODE_COMPAT_COPY=1` 显式开启）；node-compat 通过 profile `dependencies` + `tools/repair-profile-node-compat.mjs` 安装；不再在 spawn 热复制。
**教训**：symlink 共享层禁止 copyTree 写入；安装态由依赖/部署工具负责。

## EB-12 · 2026-11-22 · 存量分身没有 fingerprint → 永远不同步

**现象**：18000/18001 无 `essenceId/syncSourceId/configSourceFingerprint`，`changed=false`，每次打开只取 URL。
**根因**：`syncTaskOnOpen` 要求旧 fingerprint 存在；`normalizeTask` 没补默认同步源。
**防线**：`normalizeTask` 补 `syncSourceId=OFFICIAL_ESSENCE_ID`；无旧 fingerprint 视为 changed，首次打开重建并写入新指纹。`orchestrator` 73/73。
**教训**：旧数据迁移必须显式，不要用“字段为空=不变”。

## EB-13 · 2026-11-22 · 失败任务僵尸端口/PID，面板「进行中」把 failed 算进去，超额会话无提示

**现象**：failed 任务保留 port 18000/pid 6276（已死），与运行中的 18000 撞车；面板进行中=3（实际 running=2）；10/3 会话无警告。
**根因**：taskView 无 running 判定；active 统计只排除 archived；client 不读 `sessions.violation`。
**防线**：非 running 的 pid/port/url 置 null；进行中只数非 failed/stopped/archived；卡片显示 `会话 N/M 超限` warn chip。orchestrator 73/73。
**教训**：状态投影必须服从真实进程，不服从持久化字段。

## EB-14 · 2026-11-22 · 来源插件面默认关闭导致“已同步”假阳性

**现象**：`applySourcePluginSurface` 因 derive 回归被 env 默认关闭，存量分身打开仍只补 15 实验性，不复制元主 bundles/dependencies；标记 fingerprint 却显示已同步。
**根因**：把 node-compat 复制与来源面复制混为一谈；关闭前者后 derive 已恢复，来源面不必关闭。
**防线**：来源面默认开启（`DSH_FANG_SOURCE_SURFACE=0` 才跳过）；e2e 125/125、orchestrator 73/73。
**教训**：回归隔离要精确到被测因子，不要因一个 copy 失败关掉整条同步链。

## EB-15 · 2026-11-22 · 装母体/profile 必须宿主停止（热替换 = 红线）

**红线**：宿主进程存活时，禁止写 `C:\Users\<user>\.dsh\profiles\desktop`、`node_modules/@twinsearth/fang-dsh-plugin`、`client.js`、任何 profile；热替换 100% 触发 fs.watch EPERM 崩溃（EB-03）。
**强制**：
- `tools/release/deploy-profile.mjs` 宿主存活返回 409；
- `tools/repair-profile-node-compat.mjs` 用 `tasklist` 检测 `DeepSeek Harness.exe`，存活直接 REFUSED；
- 任何手工验收都先 `Get-Process 'DeepSeek Harness'`，确认无进程才写。
**教训**：安装态是共享层；只允许「停宿主 → 部署 → 启动」。

## EB-16 · 2026-11-22 · 加速核 team/mode 修复被“header-frame-changed”静默中止

**现象**：切到“分身 Core 加速引擎”后历史加载失败：`team/mode (seq 9220) unknown ... not marked ignorable`；会话看似丢失。
**根因**：加速核 3.5.0 不识别 stock DSH 的 `team/mode`；旧 sanitizer 把**所有** unknown（包括 header 帧里的 `session`）都标 `ignorable`，随后 header 校验失败返回 `header-frame-changed`，整个修复被放弃，日志保持未标记。
**证据**：`accelerated-fork.mjs` sanitize 结果 `changedEvents:0, files:[...error:header-frame-changed]`；原始日志 2 条 `team/mode` 未带 ignorable。
**修复**：
- 只标记明确的新事件类型（`team/mode`、`team/task`、`team/status`、`deliverables/presented`），绝不改 header/已知事件；
- 修复后对现有会话执行：2 条 `team/mode` → `ignorable:true`，header 字节不变，备份 `.bak-catalogv3-*`；
- 回归测试把 header 类型从 known 集合移除，仍必须 `ok:true` 且只标 1 条 team/mode。
**教训**：修复“未知事件”不能碰 header 帧；sanitize 的 header 校验失败必须升级为错误，而不是静默返回。

## EB-17 · 2026-11-24 · 用 write 覆盖 CHANGELOG 导致 3000 行历史丢失

**现象**：写 v3.8.0 变更时直接用 `write` 覆盖 `docs/CHANGELOG.md`，文件从 3142 行缩成 30 行。
**根因**：把“新增一节”误当成“替换全文”；写前没有先读目标文件。
**修复**：用 `git show HEAD:docs/CHANGELOG.md` 取回字节，与新的 v3.8.0 节拼接恢复；已核对 3190 行。
**防线**：改任何历史文档前必须先 `read`；只允许 `edit`/定点插入，禁止整文件 `write`，除非确认是新建文件或用户明确要求重建。
**教训**：文档不是草稿；覆盖前先证明目标内容。

## EB-18 · 2026-11-24 · 看门狗 sidecar 被测试/预检反复拉起，泄漏 178 个 node 进程

**现象**：`npm test`/preflight/e2e 后残留 178 个 `node.exe watchdog-sidecar.mjs`，每个约 50MB；共享同一个 `watchdog.json`，旧 sidecar 一直看到“新宿主还活着”，永不退出。
**根因**：sidecar 在每次插件 apply 时无条件 spawn；测试/预检每个进程都 apply，且所有 sidecar 共用一个 hostPid 文件，互相覆盖导致无法判定宿主死亡。
**修复**：
- sidecar 文件名改为 `watchdog-<hostPid>.json`，每个宿主独立；
- 测试/预检环境（`NODE_TEST_CONTEXT`、`DSH_FANG_E2E=1`、argv 含 test/e2e）不 spawn；
- `globalThis.__fangWatchdogSidecar` 单例，防同进程重载重复 spawn；
- 已清理 178 个泄漏进程，e2e 后 sidecars=0。
**防线**：任何后台守护进程必须有单例锁 + 每宿主唯一状态文件 + 测试门禁；每次 e2e 后检查残留进程数。
**教训**：防崩溃进程本身不能变成崩溃源。

## EB-19 · 2026-11-24 · v3.8.0 sidecar 用 process.execPath 拉起第二个 DSH 宿主

**现象**：安装 v3.8.0 后母体 `Failed to load plugins`，全部客户端服务 pending waiting theme/layout；分身打开报 `handler-threw`。
**根因**：独立看门狗用 `spawn(process.execPath, [watchdog-sidecar.mjs], { ELECTRON_RUN_AS_NODE:1 })`。打包后的 `process.execPath` 是 `DeepSeek Harness.exe`，RunAsNode 被 fuse 关闭时会启动**第二个 DSH 宿主**，同时读写同一 profile，导致插件加载/路由崩溃。
**修复**：
- 只允许用 DSH 自带 Node：`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`；
- 找不到 Node 时**不启动 sidecar**，写 `watchdog-sidecar-unavailable`，绝不回退到 `process.execPath`；
- `/fang/api/tasks/open` 的托管浏览器调用加 try/catch，任何浏览器异常返回 JSON，不再让路由抛出 `handler-threw`；
- 回归测试断言源码不得出现 `spawn(process.execPath`，必须保留 bundled-node 检测。
**防线**：后台 helper 只能用明确的 runtime 可执行文件；禁止把宿主 Electron 当成 Node。
**教训**：守护进程如果自己启动第二个宿主，比没有守护更危险。

## EB-20 · 2026-11-25 · DSH 客户端启动崩溃：keep-alive 连接被重置后复用（红色）

**错误等级**：红（客户端无法启动，主进程 / web-boot 崩溃；属于启动不可用级故障）

**现象**：安装 DSH `0.2.2-rc.5` 后客户端启动崩溃；日志先出现 `fetch failed` / `read ECONNRESET`，随后插件 bundle 加载失败并触发 web-boot 崩溃。测试实例可启动，但不作为验收依据。

**根因**：启动时的遥测请求和欢迎页请求共用同一条到本地 Host 的 keep-alive 连接；1 秒超时取消响应后，这条连接被重置，后续请求仍复用该连接，于是出现 `ECONNRESET`，再引发插件 bundle 加载失败和 web-boot 崩溃。

**修复**：
- 只修改本地 Host 请求的三处逻辑：认证、欢迎页 RPC、插件及页面转发请求统一加 `Connection: close`；
- 每次请求使用独立连接，不再复用被超时取消重置的连接；
- 没有跳过遥测，没有改动用户配置。

**验证**：
- 从开始菜单正式入口启动成功，显示 DSH 欢迎/登录界面；
- 主进程 PID `10856`，窗口标题正常；
- 启动后没有生成新的 `main` 或 `web-boot` 崩溃日志；
- 启动日志无 `ECONNRESET`，stderr 为空；
- 安装包已恢复为原始大小 `209,083,008` 字节；当前安装仍为 `0.2.2-rc.5`。

**文件与回滚**：
- 已安装：`D:\DSH\resources\app.asar`
- SHA-256：`43B2298D91F1C0A7D1A8C2ED6F65CABBEF4F603CA84520057F2E14CA3FF3960E`
- 原始备份：`C:\Users\AU\AppData\Local\Temp\dsh-rc5-fix\app-original.asar`，可随时回滚。

**未执行 / 数据保留**：
- 未执行删除 `.dsh`、AppData、updater 目录的脚本；
- `.credentials.yaml`、profile、插件配置、崩溃日志均保留；
- 系统无可用 `dsh` CLI，因此没有创建 `safe` profile；
- 临时构建文件未自动清理，避免误删证据或用户数据。

**防线**：
1. 启动故障禁止先用“删用户目录 / AppData / updater”止损；任何删除必须显式确认，并先保留证据。
2. 可取消的本地 Host 请求不得复用可能被重置的 keep-alive 连接；对认证、欢迎页、插件/页面转发使用 `Connection: close` 或独立连接，并补一条“超时取消后下一次请求不报 ECONNRESET”的回归测试。
3. 验收必须从正式开始菜单入口跑，不以测试实例代替；保留原始 `app.asar`、记录 SHA-256 与回滚路径后再报“已修复”。

**教训**：连接池复用不是免费的；一次超时取消可能污染共享连接。启动链路宁可每请求独立连接，也不要让一个被重置的连接拖垮整个 web-boot。

---

## EB-21 · 2026-11-25 · Host 运行期退出：1 / 0xFFFFFFFF / 0xE0000008（红色，未定论）

**错误等级**：红（Host 已正常运行后退出，属于运行期不可用级故障；根因尚未定论，不能按“已修复”关闭）

**现象**：
- 三份新增 Host 日志属于一个**独立于 EB-20 启动崩溃**的新问题组；
- 版本均为 `0.2.2-rc.5`，阶段均为 `running`，退出码分别为 `1`、`0xFFFFFFFF`、`0xE0000008`；
- 三份日志都伴随 Crashpad 管道错误 `0xEA`；
- 没有 JS 异常，也没有插件调用栈；
- 三份日志未出现在现有 HSD 和附件机的日志目录中，因此没有强行绑定到某一台安装实例。

**关键判断（未定论）**：
- 这不是 EB-20 的 `ECONNRESET` 连接复用问题。EB-20 发生在 `startup` / `web-boot` 阶段；这三次发生时 Host 已正常运行。
- Crashpad `0xEA` 表示命名管道读取的数据超过当前缓冲区，属于崩溃上报链路的异常信息；出现时间早于父进程记录的退出时间，**不能直接当作死因**。
- `0xE0000008` 可以作为 native 崩溃或内存分配失败的排查线索，但公开案例中的解释并不唯一，必须靠 dump、WER 记录和内存曲线确认。
- `0xFFFFFFFF` 和 `1` 目前不足以单独定位；缺少 JS/插件栈时，不能把三条退出码直接归为同一个根因。可以按“同一现象组”管理，但不能假定同一故障机制。

**合并报告**：
- 用户提供的报告已合并前面 5 份 Host 日志和主进程记录；
- 报告区分了：YAML 配置错误、W2M API 不兼容、连接复用 `ECONNRESET`、以及这组尚未定论的 Host `running` 退出问题；
- 该报告给出了取证和排查优先级；本条目只登记事实与待证项，不把推测写成结论。

**取证优先级（待执行）**：
1. **先保留现场**：保留三份 Host 日志原文、Crashpad 日志、WER 记录/队列、`%LOCALAPPDATA%\CrashDumps` 与 DSH 崩溃目录中的 dump；记录文件哈希、采集时间和来源路径。
2. **补内存证据**：采集 Host 及子进程的 Private/Commit、系统 CommitLimit/CommitFree、页面文件使用曲线；重点核对退出前是否出现内存分配失败或 Commit 耗尽。`0xE0000008` 不能只凭退出码解释。
3. **对齐时间线**：把 Crashpad `0xEA` 的时间戳、Host 父进程退出时间、WER/Event Log 记录放在同一时间轴上；`0xEA` 早于退出记录，只能作为上报链路异常，不作为死因。
4. **确认安装身份**：用安装路径、profile、`app.asar` SHA-256、版本号绑定日志与实例；在拿到证据前，不把日志强行归到 HSD、TOFUTURE 或某一台机器。
5. **隔离复现**：用干净 profile / 禁用第三方插件做对照，分别记录“有无 W2M/YAML 配置”的退出码；不要用删除 `.dsh`、AppData、updater 或崩溃日志的方式“止损”。

**防线（待落地）**：
1. Host `running` 阶段退出必须保留 dump/WER/退出码/内存曲线，禁止只记录一句“崩溃了”就关闭。
2. 报告“已修复”前必须给出 native 崩溃或内存分配失败的直接证据；仅有 Crashpad `0xEA` 或 `0xE0000008` 不足以结案。
3. 该条保持**红色未定论**；在拿到 dump/WER 和内存证据前，不并入 EB-20，也不标记为已解决。

**教训**：启动崩溃修好，不等于运行期崩溃修好；`0xEA` 是上报链路的噪声，不是死因。退出码相同的现象可以分组，根因必须分开证明。





---

## EB-22 · 2026-11-25 · 元主运行态 web boot 失败：`ui-theme` 被显式禁用（已定位，代码已修，真机待重启）

**错误等级**：红（元主 Web 完全不可用；不是插件崩溃、不是 OOM）

**现象**：
- 打开元主运行态（`--profile essence-runtime --port 18000`）后，页面显示
  `HARNESS / Failed to load plugins / web boot: 3 required entries did not activate`；
- 列表里大量插件显示 `pending (waiting for service: theme)`；
- 派生/打开分身随之走不干净的状态链路。

**根因**：
- 实际 profile 的 `cordis.patch.yml` 保留了
  `@deepseek-ai/dsh-client-ui-theme` 的 `disabled: true`（字号配置仍在）；
- theme 服务因此不启动 → `ui-layout` 等 theme → `ui-sidebar`/`ui-chat` 等 layout；
- 这三项是 required entries，全部 pending，web boot 必然失败；
- 来源是官方元主/插件面同步时保留了非官方行，没有过滤核心 UI 必需插件的禁用行。

**修复**：
- 新增 `src/lib/core-ui-plugins.mjs`：识别 `dsh-client-ui-theme/layout/sidebar/chat`，
  `enforceCoreUiEntries()` 只把 `disabled: true` 翻成 `false`，保留 config；
- `EssenceManager.repairOfficialEssence()`：官方 overlay 合并后统一强制启用核心 UI 行，
  即使旧行 id 是 `official-*` 也保留其字号配置；返回/审计 `coreUiForced`；
- `applySourcePluginSurface()`：来源元主 patch 拷进分身之前强制启用核心 UI 行，
  防止把 `ui-theme disabled: true` 复制给新分身；
- `startEssenceRuntime()`：provision 克隆出运行态 `cordis.patch.yml` 后再自愈一次，
  直接修正在盘上的旧运行态 profile；审计 `runtime-core-ui-enabled` /
  `runtime-core-ui-repair-failed`。

**回归**：
- `test/core-ui-plugins.test.mjs`：3/3；
- `test/official-essence.test.mjs`：7/7（含 `official-ui-theme disabled:true` 保留配置后强制启用）；
- 组合 27/27 通过（含 accelerated alias）。
- 修复工具：`tools/repair-core-ui-profile.mjs --profile <dir> [--apply]`（默认 dry-run，apply 先写 `.bak-<ts>`）；
- 待：TOFUTURE 在线后停 13100、重启元主运行态，确认页面加载；再打开分身。

**防线**：
1. `dsh-client-ui-*` 的 `disabled: true` 不得作为“用户偏好”保留在任何官方/分身/运行态 patch；
2. 任何 profile merge 路径都要经过 `enforceCoreUiEntries`；
3. 验收不能只看“进程起来了”，必须看到 theme 服务启动、required entries 全激活。


## EB-23：打开分身后 `handler-threw`（task / fang-meta / 18000 三方状态冲突）

**现象**：
- `task_mwram4u9ylki` 是 `failed`、`pid=null`、`port=null`，`adapter.error=auto-paused-memory`；
- 同时 `fang-meta.json` 仍写 `status=running`、`pid=19444`（已死）、`port=18000`；
- 18000 实际属于元主运行态（PID 13100，`--profile essence-runtime`）；
- 点“打开分身”只看到 `500 { error:'handler-threw', code:'handler-threw' }`。

**根因**：
- `syncTaskOnOpen()` 检测官方 fingerprint 变化后先置 failed，再 `restoreTask()`；
- `restoreTask()` 的 `f.spawn` / `handshake` / `applySourcePluginSurface` / `syncForkCoreMode`
  等步骤没有逐段兜底，异常被路由统一 catch 成 `handler-threw`；
- task、`fang-meta`、端口所有权三份状态没有先归位，UI 可能继续拿旧 pid/18000 操作。

**修复**：
- `reconcileOpenState()`：打开/还原前检查 task pid 是否存活、旧 port 是否已归别人；
  只清理 stale 状态（task/fang-meta pid/port/url），关闭旧托管窗口，绝不杀 forker 仍认为活着的进程；
- `syncTaskOnOpen()` / `restoreTask()` 每个关键步骤返回 `{ok:false, step, error, detail}`，
  审计 `fork-open-step-failed` / `fork-restore-step-failed`；HTTP 路由不再统一吞成 `handler-threw`；
- `forker.stop()` / 子进程退出 / recover 时把 `fang-meta` 的 pid/port/url 清空；
  `syncTaskMeta()` 在 task 状态变化时补写/清除旧身份；
- 回归 `test/open-fork-preflight.test.mjs`：构造“task 旧 port 被别的进程占用 + fang-meta 残留 running”，
  断言 open 返回 `spawn-threw` + `step=spawn`，task/fang-meta 不再保留旧 pid/port，且 restore 不显式请求旧端口。

**回归**：
- `test/open-fork-preflight.test.mjs`：1/1；Windows HSD 组合 **57/57**；
- `test/forker.test.mjs`：29/29（含 stop 后 `fang-meta` pid/port/url 清空）；
- 待真机：TOFUTURE 上线后按 open-fork 链路复测。

**v3.8.11 补强**：
- `taskView()` 每次读任务同时对账 task 与 `fang-meta`：task 留死 pid/port，或 meta 仍写 running，都会清成 failed/null；
- `reconcileOpenState()` 把 meta 端口也纳入占用探测，18000 被元主运行态占用时标 `stale-port-conflict`；
- `route` / `routeMethods` 的 catch 返回 `route`、`method`、`requestId`，并审计 `http-handler-threw` + stack；UI 的 `detail` 不再只有通用 code；
- `pauseOtherForks()` await `f.stop()`，关浏览器与停进程分别兜底，`fork-auto-paused` 记录 `browserCloseOk/stopOk/metaSynced`。
- 真机 TOFUTURE 现状：`tasks.json` 该 task 仍留 `pid=20800, port=18000`，而 `fang-meta.json` 已是 `stopped/null`；v3.8.11 的 taskView 对账会在下次列表/打开时清掉这两个残留。

**防线**：
1. 打开分身前先做状态归位；被别的进程占用的端口不得复用；
2. 任何 open/restore 的异常都必须带 `step` 和 `detail`，不允许只剩 `handler-threw`；
3. task 状态变化必须同步 `fang-meta`，旧 pid/port 不能留给 UI；
4. 500 必须能在审计链按 `requestId` 找到 route 与 stack。

---

## EB-24 · 2026-11-25 · 页面文件缺失打穿 Host 启动链；迁移报告按钮 `openMigrationReport` 独立 TypeError（红色）

**错误等级**：红（Host/客户端启动不可用；本条目包含两条**独立**故障，禁止合并归因）

**现场时间线（用户核对版）**：
- `13:12:47–55` Host 连续启动失败 → profile patch 被清空/重建；
- `13:20:16–53` 插件管理器重新启用 include/bundle → `13:21:48` 记录一次 `unclean-shutdown`；
- `13:41:19` Renderer 报 `app.openMigrationReport is not a function`；触发条件是页面文件缺失使 migration/pagefile banner 出现，点击“查看迁移报告”调用未定义函数；
- `13:41` 左右 Safe Mode 显示 `commit-free-critical` → Host 内存守卫把上一宿主标为紧急熔断；
- `13:45:56` 新 Host 启动 → `13:45:58 safe-mode.json` 重置为 `false` → `13:46:02` 记录 `pagefile-missing`，Commit 余量 `25,310 MB`。

**故障 A：Host 启动阶段被 Commit 打穿（不是 Fang 看门狗没防住）**
- 现象：DSH 启动时对几乎所有核心插件行报
  `dsh: disabling profile plugin row "tool-bash": its declared dsh requirements cannot be validated: UNKNOWN: unknown error, read`；
  随后核心插件逐行被禁用，renderer 崩溃；下一次启动才由 Safe Mode 检测到 `commit-free-critical`。
- 根因：系统没有页面文件（`Win32_PageFileUsage` 为空，`AutomaticManagedPagefile=False`，`SizeStoredInPagingFiles=0`），Commit 上限等于物理内存约 `31.7 GB`（`TotalVirtualMemorySize=33,255,604 KB`）。Windows 在 Commit 压力下连 profile 文件都读不出来，DSH 只能把插件逐行禁用。
- 关键边界：崩溃发生在 DSH 自己加载 profile/插件阶段，**Fang 插件尚未获得执行机会**；3.8.3 的看门狗不可能事前阻止，Safe Mode 是事后检测，不是事前拦截。
- 现场证据：当前 `/fang/api/memory/probe` 返回 `commitLimitMB=32476`、`commitFreeMB=20735`、`physicalFreeMB=19855`、`hasPageFile=false`；用户只读核对 `FreeVirtualMemory=22,820,836 KB`，页面文件为空。
- 真正修复：启用页面文件，或持续释放 Commit 压力；任何“内存阈值/杀进程”只能降低概率，不能替代页面文件。

**故障 B：Renderer 点击“查看迁移报告”报 `app.openMigrationReport is not a function`**
- 现象：`Uncaught TypeError: app.openMigrationReport is not a function`；页面文件缺失使 migration/pagefile banner 出现，点击按钮时触发。
- 根因（Fang 3.8.3）：`client.js` 第 2077 行定义了 `function openMigrationReport()`，第 3576 行 `const app = {...}` 未挂载该函数，第 4098 行按钮调用 `app.openMigrationReport()`；安装版路径 `<profile>\node_modules\@twinsearth\fang-dsh-plugin\client.js`。
- 归属核对：在 TOFUTURE 整个 profile `node_modules` 执行 `findstr /S /M /C:"openMigrationReport" *.js`，**只有** `@twinsearth\fang-dsh-plugin\client.js` 命中；`@deepseek-ai` 及其他 DSH 插件没有该函数。`3.8.2` 没有该功能，`3.8.3` 新增后漏挂。因此这条是 **Fang 3.8.3 的客户端 API 漏挂**，不是 DSH 0.2.2-rc.5 自带 API；用户此前按 3.8.2 搜索得出“不属于 Fang”的结论，在 3.8.3 上不成立。
- 与故障 A 的边界：Renderer TypeError 只影响迁移报告按钮/面板，不是 Host `commit-free-critical` 的根因；两者都出现在 13:41，但一个是 renderer 点击异常，一个是 Host 内存守卫，必须分开修、分开验收。

**修复（本次已写代码，TOFUTURE 尚未部署）**：
- `client.js` 的 `app` 对象补挂 `openMigrationReport`；`test/client-migration-report.test.mjs` 断言 `probeMemory, openPagefileHelp, openMigrationReport, openDiskHygiene`，3/3 pass。
- Safe Mode 解除改为**硬门**：
  - `src/plugins/orchestrator.mjs` 的 `resetSafeMode` 改为 async，每次强制 `readSystemMemory({ force: true })`，不再依赖缓存；
  - 探测异常 → `memory-probe-threw`；`memory.ok !== true` → `memory-probe-unavailable`；`hasPageFile !== true` → `pagefile-missing`；`commitFreeMB < cfg.memoryMinFreeMB` → `commit-low`；全部 409 拒绝，且不修改 `safeMode`；
  - `POST /fang/api/safe-mode/reset` 改为 `await service.resetSafeMode()`，`ok ? 200 : 409`；
  - 客户端 `reviewSafeMode()` 识别 `pagefileMissing`，`confirmSafeModeReset()` 直接拒绝；弹窗在页面文件缺失时禁用 checkbox 并显示“页面文件缺失/被禁用，不能解除”，按钮 title 同步；
  - `test/client-safe-mode.test.mjs` 增加 pagefile-missing 客户端/服务端硬门断言；组合 8/8 pass。
- 构建：`node tools/release/build.mjs --skip-preflight` 通过 package smoke / crash-safety / allow-list / main-city gate；产物 `dist/dsh-fang-3.8.3.tgz`，835,527 bytes，SHA-256 `38549f08a3b3d3d1e39b136e251200bb9b0aec72e00e0c10570c696daff49d1b`。
- 未执行：未安装/未重启 TOFUTURE；未改系统页面文件；未 commit/push/tag/publish。

**防线**：
1. Safe Mode 解除必须有服务端硬校验：页面文件不存在或 Commit 余量低于启动阈值时，客户端勾选不能绕过，HTTP 必须 409；
2. 看到 `disabling profile plugin row ... UNKNOWN: unknown error, read` 先查 `Win32_PageFileUsage`、`SizeStoredInPagingFiles`、Commit 余量，禁止先归因“插件声明错误”；
3. 页面文件缺失属于系统级前置条件，Fang 看门狗无法覆盖 DSH 启动加载阶段；不得再报“3.8.3 已防住本次 Host 崩溃”；
4. renderer 的 `openMigrationReport` TypeError 与 Host `commit-free-critical` 必须各自建回归、各自验收，不允许因为同一分钟出现就合并成一条根因；
5. 页面文件变更按 G2 处理，必须有用户明确授权、回滚方案和重启验证；不得静默改系统配置。

**教训**：没有页面文件时，Windows 的 Commit 上限就是物理内存；内存压力首先表现为“文件读不出来”，不是漂亮的 OOM 提示。看门狗只能在插件加载后生效，救不了加载前的 Host；客户端按钮报错也不能拿来解释 Host 崩溃。
