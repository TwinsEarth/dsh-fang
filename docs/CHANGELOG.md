## v3.1.16（2026-11-11）
**主题：跨进程契约桥“零配置”——原身运行态注入 `DSH_FANG_MOTHER` + 契约 HTTP headers 同步。**

### 修复 / 新增
- **原身（essence-runtime）spawn 注入 `DSH_FANG_MOTHER: layout.dataDir`**：
  房主 dsh-Master 的 Router 在原身内可据此自动推导共享契约 outbox
  （`<motherDataDir>/contract-outbox`），无需再手工配置 `dispatch.contractFileDir`；
  普通分身（`DSH_FANG_ROLE=fork`）此前已有该注入（任务 spawn / 恢复 / 队列三处），本版只补齐原身运行态这一处；
- **契约 SDK HTTP 传输支持自定义 headers**：`createHttpTransport({ headers })` /
  `createContractClient({ config: { httpHeaders } })`；瓮城的契约 HTTP 端点同时需要
  Bearer contract token 与安装级 `x-fang-auth`，房主可一次带齐；
  该改动为**加性**扩展：不传 `headers` 时行为与 1.0.0 完全一致；
- 内嵌契约 SDK 与 npm 已发布 `@twinsearth/dsh-fang-contract@1.0.0` 的导出面/常量/方法表/
  错误码保持一致（房主侧有对应一致性测试保护）。

### 兼容性
- 不改变任何既有服务键、环境变量语义或 HTTP 路由；旧版房主（3.2.4 及以前）仍可用 `legacy` 传输；
- `DSH_FANG_MOTHER` 只是在原身 spawn 时多注入一个既有变量，未注入时房主行为不变（仍需显式配置）。

### 测试
- `test/contract.test.mjs` 2/2；全量 `npm test` **1034 pass / 0 fail**；
- release preflight（含 e2e）见发布记录。

## v3.1.15（2026-11-11）

**主题：与房主 dsh-Master 的独立互联契约（fang-master contract 1.0）+ 多级保底通讯。**

### 新增
- 内嵌 @twinsearth/dsh-fang-contract 1.0.x 同源 SDK（src/contract/）；
- mother 提供 angContract 服务：hello/health、ang.fork.spawn/stop/list、ang.decision.create/resolve、ang.session.list、ang.orchestrator.status；
- 可选 HTTP 契约端点 /fang/api/contract/{hello,invoke,health}（Bearer token，常量时间比较；token 留空禁用）；
- 可选 file outbox 兜底（contract.fileDir）；DSH_MASTER_* env 白名单；fork 角色不暴露契约服务；
- 文档 docs/CONTRACT-INTEROP.md、docs/RELEASE-3.1.15.md。

### 兼容性
- 原有服务键与旧版房主直连方式全部保留；新版房主按 local→http→file→legacy 自动降级；
- contract 1.x 只增不改；删除/改义需 2.0 + 双写一个 MINOR 周期。

### 测试
- 	est/contract.test.mjs 2/2；全量 preflight/e2e 见 release run。

## v3.1.14（2026-11-11）

**主题：修复元主/分身 Web 不显示身份徽标；徽标改为红/蓝/绿三色。**

### 修复
- **元主/分身 Web 没有徽标**：v3.1.13 的徽标识别调用 `/fang/adapter/hello`，但该路由要
  `Authorization: Bearer <adapterToken>`——浏览器拿不到 adapter token，分流后返回 401，
  客户端判定失败直接隐藏徽标。母体走 `/fang/api/status` 所以正常（红标可见）。
- 新增**公开只读**路由 `GET /fang/adapter/identity`：只返回 `{ role, kind, version, protocol }`
  （不含 taskId/sessionId/token），服务端仍只监听 loopback；`kind` 由
  `identityKind({role, taskId, essence})` 纯函数计算：`mother` / `essence` / `fork`
  （元宝运行态由 `DSH_FANG_ESSENCE=1` 或 `rt-` forkId 识别）。
- 客户端 `detectWebRole()` 顺序：`/fang/api/status`（母体）→ `/fang/adapter/identity`
  （元主/分身）→ 旧宿主 `hello` 兜底；失败仍隐藏，不显示错误身份。
- **颜色区分**：母体 **红**（`#C8102E`）、元主 **蓝**（`#0A6BE0`）、分身 **绿**（`#17803D`），
  通过 `.fang-web-role--mother|essence|fork` 变体实现。

### 测试
- `test/client-role-badge-dom.test.mjs`：母体红 / 元主蓝（identity）/ 旧宿主 rt- 前缀兜底 /
  分身绿（identity）/ 颜色 CSS 契约 / 接线断言，6/6；
- `test/adapter-identity.test.mjs`：`identityKind` 四类映射，1/1；
- 发布前 `preflight --e2e`（含 crash-safety + 打包后门禁）。

### 已知边界
- 需要升级到 3.1.14 并**重启元主/分身 Web 宿主**才会加载新的 identity 路由与客户端；
  已运行的旧实例仍为旧代码（不会热更新）。
- 公开 identity 路由只暴露角色/版本，不含任何 token 或任务标识。

## v3.1.13（2026-11-11）

**主题：决策中心深入每个会话 —— 右侧「待选」悬浮入口 + 从右向左的决策栏（选项/自定义输入）。**

### 新增
- **会话内决策中继**：母体 Web 中，当前会话存在 pending 决策时，右侧边缘出现红色
  「◈ 待选 N」悬浮按钮；点击从右向左滑出决策栏：
  - 只显示 `source.sessionId` 匹配当前会话的 ticket（其他会话/分身的票仍在收件箱）；
  - 预置选项按 **A/B/C/D**（超过 4 个续 E/F…）展示，点击即提交；
  - 也可直接**输入决定**（如「按 B 方案，先灰度 10%」），作为 custom decision 提交；
  - 无选项的绿票显示「确认收到（ACK）」；`Esc` / 遮罩关闭；无待决策时按钮隐藏。
- **总界面仍在母体**：收件箱（侧栏入口 + 右侧抽屉）不变，继续汇总所有来源的待决策。
- 服务端：`POST /fang/api/decisions/resolve` 新增 **仅显式** `custom` 字段
  （trim、≤2000 字符）；`resolvedOption = custom`、`customInput: true`、
  `resolutionNote = custom`；未传 custom 的未知 option 仍 fail-closed。
- Agent 侧：`request_human_decision` 的 `selectedValue` 即用户选择/输入，Agent 按此继续任务。
- 文档：`docs/DECISION-RELAY.md`（行为、协议语义、边界），随 tarball 发布。

### 测试/门禁
- `test/decision-relay-dom.test.mjs` 5/5：入口出现/隐藏、面板滑出、A/B 选项提交、
  自定义输入提交、其他会话过滤、fork 角色不挂载、socket 接线；
- `test/decision-center.test.mjs` 新增：custom 解析（resolvedOption/customInput/note）+
  未知 option 仍拒绝；
- 版本断言随 3.1.13 更新；发布走 `preflight --e2e`（含 crash-safety 与打包后门禁）。

### 发布说明
- v3.1.12 的产物（npm/GitHub Release）由上一轮发布流程已产出；按人类要求 **v3.1.12 不发布**：
  本版发布后会把 npm 3.1.12 标记 deprecated、删除其 GitHub Release 页面，正式版本以 3.1.13 为准。

## v3.1.12（2026-11-11）

**主题：Web 端身份徽标（母体 / 元主 / 分身）+ 派生分身默认第三方插件种子。**

### 新增
- **侧栏身份徽标**：在侧栏 HARNESS 词标右侧用红字显示当前 Web 端身份 ——
  `母体`（`/fang/api/status` 返回 role=mother）、`元主`（元宝运行态）、`分身`（任务）。
  不替换宿主 `sidebar.brand.name` 单槽（避免抹掉官方词标），而是在词标后追加只读徽标；
  宿主重渲染摘掉节点时自动补回；识别失败时隐藏，不显示错误身份。
- **adapter hello 增加 `kind`**：`mother` / `essence` / `fork`；元宝运行态由 orchestrator
  注入 `DSH_FANG_ESSENCE=1`，旧运行态按 `rt-` forkId 前缀兜底。客户端据此区分元主与分身。
- **派生分身默认插件种子**（新机器/新用户不再“裸奔”）：`forkSeed` 配置两组清单，
  默认值即用户给定列表：
  - 安装不激活：`@twinsearth/dsh-2xray`、`@michengai/dsh-agency-agents`、`dsh-better-sidebar`、
    `dsh-context`、`@liustack/modlens`、`@liustack/modsearch`；
  - 安装并激活：`dshmarket`、`@twinsearth/dsh-im2a-plugin`、`@openviking/dsh-memory-plugin`、
    `@twinsearth/w2m-dsh-plugin`。
  种子在独立 seed home 用 DSH 自带 pnpm 安装（按指纹缓存），模块 hardlink 合并进分身
  `node_modules`；install 只写 dependencies，activate 额外写入 `dsh.profile.bundles` 随分身启动加载。
  两种派生入口（开发者推荐 / 绿色“派生新分身”）都走同一 Forker.spawn，因此行为一致。
  失败不阻塞分身启动，结果保留在 spawn 返回值 `forkSeed` 与审计里。
- 配置项：`fang-forker` Config 的 `forkSeed.enabled/install/activate`；环境变量
  `DSH_FANG_FORK_SEED=0` 可全局关闭（e2e/CI 使用）。

### 测试/门禁
- `test/fork-seed.test.mjs` 6/6：默认清单、归一化、profile patch、scope 合并、装一次缓存、
  **每次 spawn 重放模板后重新打 patch 且不重复安装**、禁用 no-op；
- `test/client-role-badge-dom.test.mjs` 5/5：母体/元主/分身/前缀兜底/适配器字段；
- `test/forker.test.mjs` 29/29（单测禁用种子，避免联网）；
- 既有全量 + crash-safety + 打包后门禁由 `preflight --e2e` 复跑。

## v3.1.11（2026-11-11）

**主题：修复元宝运行态「更新/卸载插件」被 pnpm 供应链观察期拦截（ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION）。**

### 修复
- **现象**：元宝 web 端更新/卸载插件报
  `Lockfile failed supply-chain policy check`，点名 `@twinsearth/dsh-fang@3.1.10`、
  `@twinsearth/dsh-fang-queue-journal@0.1.4` 落在 pnpm 11 `minimumReleaseAge`（24h）观察期内。
  DSH 插件管理器只在**安装**成功时自动追加 `minimumReleaseAgeExclude`；更新/卸载或某些 profile 的
  lockfile 校验会先被策略拦下。
- **运行态修复**：`ensureEssenceRuntimePnpmConfig` 现在显式写
  `minimumReleaseAge: 0`（仅元宝运行态；母体 profile 的供应链策略不动），
  每次打开元宝运行态自动生效，更新/卸载自家刚发布插件不再被观察期拒绝。
- **回归保护**：`test/pnpm-store.test.mjs` 覆盖「缺省时必须补上 `minimumReleaseAge: 0`」
  与二次运行幂等（6/6）。
- **环境处置（不入代码）**：本机 desktop profile 的 `minimumReleaseAgeExclude` 增加
  `'@twinsearth/*'` 通配（备份 `pnpm-workspace.yaml.bak-policy-*`），元宝运行态 profile
  同时写 `minimumReleaseAge: 0`；已安装 3.1.10 做了等价热补丁（备份
  `pnpm-store.mjs.bak-releaseage-*`），本机可立即重试插件更新。
- **边界**：母体 profile 由 DSH 管理，Fang 不修改其策略；第三方包仍受 24h 观察期保护。

### 测试/门禁
- `node --test test/pnpm-store.test.mjs` 6/6；版本一致性测试随 3.1.11 更新。
- 发布走 `preflight --e2e`（含 crash-safety 与打包后门禁），证据见 `docs/AUDIT-v3.1.11.md`。

## v3.1.10（2026-11-10）

**主题：流程固化 + 把「瓮城防崩溃方案」变成可回归测试/打包/发布门禁。**

### 新增
- `docs/WORKFLOW-UI.md`：UI 改动与发版固定流程（先判定纯样式/结构、浏览器冒烟上限、合并前一次性验证、发版前置硬门禁、发布后不再移 tag、Token/时间预算、运行中 profile 升级安全规程、完成定义）。**发布必须由人类显式授权。**
- `docs/CRASH-SAFETY.md`：防崩溃防线清单（boot-guard / RestartGuard / 分身监督与孤儿回收 / role fail-closed / 待处理缓冲 / 未清洁启动检测）、强制点矩阵、运行手册与边界。
- `tools/release/crash-safety.mjs`：防崩溃门禁。源码模式校验防线文件/导出/插件闸门/client 半浏览器安全/文档与打包清单；打包模式在最终产物上校验必需防线文件、版本与 `dsh.client`、候选包 `apply()` 隔离冒烟、manifest sha256、tarball 内约束文档。
- `test/crash-safety.test.mjs`：门禁自身的回归（源码绿灯、坏包必须红、fail-safe 导出、门禁接线与文档约束）。
- 两篇约束文档进入 npm tarball（`files`），随产物一起发布、可审计。

### 接线
- `tools/release/preflight.mjs`：新增 `crash-safety: fail-safe invariants` 检查，发布前 RED 即阻断。
- `tools/release/build.mjs`：tarball 生成后再跑 `crash-safety --package --tarball`，未过不进 GitHub Release / npm。
- CI：全量测试包含 `crash-safety.test.mjs`；release build job 内置 preflight 与打包后门禁。

### 事故记录（环境，不入代码）
- 2026-11-10 21:33 在**运行中**的 desktop profile 上执行 `dsh plugin add @twinsearth/dsh-fang@3.1.9`，DSH 崩溃且用户层被重置（bundles 回退为 base+web-app、`cordis.patch.yml` 被模板覆盖）。已从 `.bak-*` 恢复 bundles 与 patch，3.1.9 安装校验通过（boot-guard dry-run: 19 rows, ok）。升级运行中 profile 的正确步骤已写入 `docs/WORKFLOW-UI.md` §5。

### 发布状态
- **已发布**：v3.1.10 → npm `latest` / GitHub Release / tag 三渠道完成（release run 42836350924 attempt 2，全绿）。

## v3.1.9（2026-11-10）

**主题：元主 / 分身工作区滚动（鼠标滚轮 + 可拖动滚动条），中间分隔条调节两栏宽度。**

### 修复
- **元主/分身变多后无法选中列表项**：控制台两栏原来没有可靠的高度约束——`.fang-console` 用 `min-height:100%`，`.panel` 用 `max-height:calc(100vh - 132px)`，而 DSH `main` 面板（`mainPanel` = `flex:1;min-height:0;overflow:hidden`）实际给的高度更小，整块内容被裁掉且没有滚动容器；同时左栏的元主卡片（`.essence-list`）在滚动区之外，卡片一多就把母体会话滚动区挤到几乎 0 高。现在：
  - `main` 槽的 DOM 挂载节点改为 `display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%`，高度链贯通到 DSH 主面板；
  - `.fang-console` = `height:100%;overflow:hidden`，`.fang-body` = `align-items:stretch;height:100%;overflow:hidden`，`.panel` = `height:100%`；
  - 左栏把「元主卡片 + 母体会话」收进同一个 `.panel-scroll[data-sk="left"]`，右栏保持单一 `.panel-scroll[data-sk="right"]`；
  - `.panel-scroll` 明确 `overflow-y:auto;scrollbar-gutter:stable`，滚动条 12px 宽、可拖动；鼠标滚轮 / 触控板滚动；
  - 窄屏（≤1100px）改为整页滚动 + 每栏 `max-height:62vh` 内部滚动，中间分隔条隐藏。
- **中间分隔条**：保持拖动调节两栏宽度（grid 列），左右两栏各自滚动、互不影响。

### 测试/门禁
- 新增 `test/client-layout-dom.test.mjs`（jsdom）：主槽高度链、两栏各一个滚动容器、元主卡片在左滚动区内、CSS 契约（overflow/滚动条/窄屏规则）、中间分隔条存在。
- 本地 headless Edge 实测（1440×900，30 元主 + 30 分身）：左栏 wheel 0→420（scrollHeight 3056 / clientHeight 342）、右栏 wheel 0→420（5777 / 445），拖动中间手柄列宽 692/692 → 850/534。
- 既有 client DOM/HTTP 套件 22/22 通过。

## v3.1.8（2026-11-10）
**主题：元宝运行态内 pnpm 插件更新/卸载修复（ERR_PNPM_UNEXPECTED_STORE）。**

### 修复
- **元宝运行态无法更新/升级/移除插件**：DSH 0.2.2-rc.1 自带 pnpm 11，pnpm 11 的 `.npmrc` 只读鉴权/网络键，`store-dir`、`package-import-method` 等非鉴权设置改为从 `pnpm-workspace.yaml`（camelCase）读取；Fang 旧逻辑只写 `.npmrc`，于是运行态 pnpm 选了“按盘符默认 store”（D: 项目 → `D:\.pnpm-store\v11`），而模块树记录的是母体 C: store → `[ERR_PNPM_UNEXPECTED_STORE]`。新增 `src/lib/pnpm-store.mjs`：写入 `pnpm-workspace.yaml` 的 `nodeLinker: hoisted` / `storeDir` / `packageImportMethod: copy`（保留原设置与注释），同步 `.npmrc` 兼容旧工具链，并把运行态 `node_modules/.modules.yaml` 的 `storeDir`/`virtualStoreDir` 对齐为“本项目自己的 `.pnpm`”（复制来的 manifest 仍写着母体 virtual store）。
- 每次打开元宝运行态（`startEssenceRuntime`）都会自动应用，返回体新增 `pnpmConfig` 诊断字段；失败不阻塞实例启动。
- **运行态插件变更持久化回元宝**：`stopEssenceRuntime` 与下次 `startEssenceRuntime` 会在重放前调用 `captureRuntimeProfileIntoEssence()`：把运行态 `package.json`（dependencies + `dsh.profile.bundles`）、有差异的 `cordis.patch.yml` 条目、`pnpm-lock.yaml`/`pnpm-workspace.yaml`/`.npmrc` 写回元宝 overlay，重算 merged（`materializeMerged` 现在保留既有模块树并投影 overlay 的 pnpm 文件），再把 pnpm 重新物化的包目录 hardlink 复制进元宝模块树、删掉已卸载的包；回归保护新增 `test/runtime-capture.test.mjs` 与 essence 的模块树保留测试。
- 回归保护：新增 `test/pnpm-store.test.mjs`（6 例：manifest 读取、settings upsert 保序、.npmrc 更新、manifest 对齐幂等、端到端 ensure）。
- **测试稳定性（buffer-keeper）**：`state()` 可能在 watch/poll 事件到达前先由 digest 兜底看到 pending，此时 `lastEventAt` 为 null，CI（Node 22 时序）偶发 `pending-high-risk` 但时间戳为 null 的断言失败；现在观察到 pending 时补记观察时间，并移除已无读者的 `startedAt`。

### 测试/门禁
- 发布前重跑 `preflight --e2e`；证据见 `docs/AUDIT-v3.1.8.md`。
- 现场证据：官方元宝运行态 profile 修复后 `pnpm store path` 返回 C: store；以相同依赖图/锁文件的隔离副本执行 `pnpm remove dsh-better-sidebar` 成功（13.7s，storeDir=C:、virtualStoreDir=副本路径，无 store/virtual-store 报错）。

### 已知边界
- 捕获时机是「停止运行态」与「下次打开运行态」——运行中的插件操作不会实时回流；宿主异常退出后，下次打开会先捕获再重放。
- 模块回流按「包名+版本」比较；同版本内容被就地替换（无版本号变化）的插件目录不会被 hardlink 覆盖（pnpm 正常安装/升级都会改版本号，命中该边界的是手工改包内容）。
- 运行态/元主模块树仍是镜像共享结构，捕获只 hardlink 被 pnpm 重新物化的条目。

## v3.1.7（2026-11-10）
**主题：分身/元主运行态的模块解析与无头 Web 目录选择修复。**

### 修复
- **分身内“下任务&指令失败”**：`Invalid schema for function 'w2m_report'`。根因是分身 profile 的 `node_modules` 是“整树 junction”到母体 profile 树，DSH 的 profile-scope 解析器只对 profile 树内或 linked-root（逐条目链接）下的 importer 供给安装包，导致插件里的 `import('@deepseek-ai/dsh-tools')` 落到插件自带离线 shim；w2m shim 把参数默认值写成 `required:false` 属性注解，供应商拒绝整次请求。forker 现在把 `node_modules` 物化为**逐条目 junction 镜像**（`mirrorModuleTree`），并在每次 spawn 就地修复历史 junction（`ensureModuleMirror`）；元主运行态同样处理。
- **分身/元主 Web“选择工作区失败”**：分身在 `dsh.cmd --no-open`（无 Electron 壳）下由 `directory-picker-auto` 解析为 `native`，原生目录对话框没有窗口可弹。spawn 现在写入 `fang-headless.patch.yml` 并以 `--patch` 传入，固定为 `directory-picker-browse`（浏览器对话框）+ 对应客户端面；安装缺 browse 包时保持 DSH 默认，可用 `DSH_FANG_HEADLESS_PICKER_PATCH=0` 关闭。
- **回归保护**：kernel 新增 `mirrorModuleTree` / `ensureModuleMirror` 单测；forker 新增 `--patch` argv、overlay 内容与安装门禁单测；provision/template 断言从“整树 junction”改为“逐条目镜像”。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.7.md`。
- 本地 live 验证明细：真实 `dsh.cmd` 子进程以逐条目镜像启动母体插件全集（含 w2m）无 `ERR_MODULE_NOT_FOUND`；探针插件在子进程内成功 `import('@deepseek-ai/dsh-tools')`。

## v3.1.6（2026-11-10）

**主题：回滚 v3.1.5 的两个回归（元宝运行态启动失败、分身 client 插件 pending）。**

### 修复
- **元宝运行态启动失败**：v3.1.5 在 `forker.spawn` 里跳过 essence-runtime 的生产盘锁并解锁，导致 DSH 启用 plugin-manager 后因运行态模块树不完整退出（`runtime-spawn-failed: exited`）。恢复 v3.1.4 行为：spawn 重新写入锁并设置只读。
- **分身 client pending**：v3.1.5 禁用了 `ui-plugin-manager`，而它提供 `pluginNavigation`，导致 `dsh-client-ui-plugin-recommendations` pending。改回只禁用 `ui-settings-plugin-inventory`；并自动移除历史 profile 里的 `ui-plugin-manager disabled:true`。
- 保留 v3.1.5 的 queue-journal 0.1.4 排队列表恢复、分身 Web 说明页、元宝卡片等改动。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.6.md`。

# CHANGELOG

> **发布豁免（人工批准，2026-11-03）**：v3.0.0–v3.0.6 **永不发布**，首个 Release 为 **v3.0.7**；
> 此后不得再覆盖“不跳号”规则——任何跳版本必须单独申请并经人工手动豁免、书面记录。详见 docs/RELEASE-WAIVER-v3.0.7.md。


## v3.1.5（2026-11-09）

**主题：排队消息列表恢复真正可用 + 分身界面不再出现母体 404 错误。**

### 修复
- **queue-journal 0.1.4**：DSH QueueDock 使用 hashed CSS class，旧扫描器只能靠 `class*=queue` 命中不到 → 只保存单草稿。新增稳定锚点 `[data-queue-dock]` 扫描，恢复时显示并放回完整排队消息列表。
- **分身 Web UI**：`role=fork` 只渲染分身说明页，不再无条件渲染母体状态/任务/会话/审批/看护的 404 错误横幅，也不再发起母体 API 请求。
- **fork 插件设置入口**：分身 profile 额外锁定 `ui-plugin-manager` / `ui-settings-plugin-inventory`，隐藏插件设置入口，避免点击启用时因只读 package.json 报 EPERM。
- **essence-runtime 不再被 spawn 重新上锁**：元宝运行态 spawn 时跳过生产盘锁并解锁历史锁。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.5.md`。

### 已知边界
- 分身仍是生产盘；插件配置请在母体或元宝运行态完成。
- PluginUpdater/SuperAgent/HarnessMM/PJM/Worker 本体未接。

## v3.1.4（2026-11-09）

**主题：元宝工作区卡片 UI + 元宝运行态插件管理修复 + 发布流水线幂等。**

### 新增/修复
- **元宝工作区卡片**：每个元宝独立方框，两行信息；第一行名称（微软雅黑 16px），第二行“生成时间 / 最后一次与母体同步时间”；操作收为图标按钮，不再挤在一起。
- **元宝运行态不再套生产盘锁**：`essence-runtime` 是配置实例，跳过 `applyForkConfigLock`；新增 `clearForkConfigLock()` 清理历史 provision 写入的 `tool-plugin-manager disabled:true`，避免插件设置被锁。
- **发布流水线幂等**：npm publish 对已发布版本（202/403 previously published）视为成功；final verify checkout 增加 `fetch-tags: true`，annotated tag 不再被误判 lightweight。
- **queue-journal 0.1.3** 继续锁定（恢复列表）。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install/reinstall drill；证据见 `docs/AUDIT-v3.1.4.md`。

### 已知边界
- DSH 设置页插件列表只读；行级激活需“能唯一定位的 profile patch 行”，第三方插件建议走侧边栏「插件」页。
- PluginUpdater/SuperAgent/HarnessMM/PJM/Worker 本体未接。

## v3.1.3（2026-11-09）

**主题：新机器迁移修复 + 排队消息列表恢复真正生效。**

### 修复
- **queue-journal 0.1.3**：恢复列表代码此前只在仓库里，npm 仍发 0.1.2（只能恢复单草稿）；本版把 `@twinsearth/dsh-fang-queue-journal` 锁到 **0.1.3**，支持“恢复全部 (n)”把队列逐条放回官方输入队列。
- **npm 安装名分身检查**：`fork-bundle-unavailable` 硬编码只认 `@local/dsh-fang`；现在同时接受 `@twinsearth/dsh-fang`，npm 安装的新机器不再误判。
- **运行态 node_modules 自愈**：迁移后 runtime profile 的 junction 可能指向不存在的 `merged/profile/node_modules`；现在检测 broken junction、重建到 `essenceModules`，元宝不再因 `cannot resolve profile bundle` 丢插件。
- **迁移 profile 的旧机器路径**：后续版本继续过滤 `file:`/`link:`/绝对路径依赖与不可解析 bundle。

### 测试/门禁
- 发布前重跑 `preflight --e2e`、install drill、reinstall drill；证据见 `docs/AUDIT-v3.1.3.md`。

### 已知边界
- 旧机器迁移数据仍可能含不可移植依赖；建议用新机器重新安装插件，或按 `docs/AUDIT-v3.1.3.md` 的修复步骤处理。
- PluginUpdater/SuperAgent/HarnessMM/PJM/Worker 本体未接。

## v3.1.2（2026-11-09）

**主题：把 v3.1.1 未发布的启动韧性/自检/更新器门禁收口，并完成首次四方发布。**

### 新增
- **boot-guard**：bundle 行解析、重复 id、子进程 `import()`/`apply()` 冒烟；`--apply` 禁用失败行（profile patch 备份）、`--safe-mode` 全禁用；`--candidate-dir` 供更新器做候选包冒烟。
- **启动入口自动自检**：`desktop-launch` / `restart-watchdog` 默认自动跑 boot-guard；未给 profile 时自动探测 `DSH_PROFILE_DIR` / `DSH_HOME/profiles/<profile>`；失败 + execute → 安全模式，dry-run 只报告。
- **运行时崩溃记录/熔断**：restart-guard `boot-state.json`（booting/running/clean/crashed）+ `runtime-crash.jsonl`（`uncaughtExceptionMonitor`）；launcher 检测上次 booting/crashed 且 pid 已死 → 自动安全模式。
- **restart-guard selfCheck**：`GET /fang/api/restart/selfcheck`（state/HMAC/清单/supervisor/unclean-boot/crash-ledger）。
- **持久化**：多代快照（`snapshotGenerations` 默认 3，A–J）+ 崩溃 journal（request/settled/orphaned，重启只标 orphaned）。
- **重装/毒数据 drill**：同一 DSH_HOME 覆盖安装 + 16 类毒文件后二次 boot。

### 修复
- 无效/旧盘 `fang-home.txt` 迁移指针自动回退本机布局，避免 apply 阶段 ensureDir 抛错。
- 真实 EssenceManager 冲突不出票（`recomputeAll()` 数组长度），未读计数口径，drawer `requestAnimationFrame` guard。
- 重复路由注册导致后续路由静默丢失（`/api/forks/supervision`、`/api/essence/default`）。

### 测试/门禁
- `preflight --e2e` **GREEN**：1026 tests / 1015 pass / 0 fail / 1 skip / 10 todo（179.9s）；e2e **81/81**（16.9s）；allow-list routes=104 findings=0；compat COMPATIBLE；syntax vet 0 失败。
- 安装 drill **10/10**（boot-guard precheck、client half、19 行、零残留）；reinstall drill **7/7**（覆盖安装 + 16 类毒数据后二次 boot）；healthz **HEALTHY @3.1.2**。
- 产物：`dist/dsh-fang-3.1.2.tgz`（510,726 B / 135 entries）sha256 `558a81da140005879c830a80048e4a89a00e2562fee2e782de8dfe2586b809b2`。

### 已知边界
- PluginUpdater / SuperAgent / HarnessMM / PJM / Worker **本体未接**；契约/client/CLI/fork tool/boot-guard 候选门禁已就绪。
- DSH 宿主内其他插件 apply 硬失败无法当场拦截；只能记录 + 下次启动熔断。
- npm 发布依赖仓库 `NPM_TOKEN` secret；私有镜像 verify 依赖 `MIRROR_TOKEN`/`MIRROR_REQUIRED`；自托管 e2e runner 需在线。

## v3.1.1（2026-11-09）

**主题：决策中心（注意力收件箱）+ fork outbox/ingest + AI 流式/多模型/SSRF + 镜像官方源 + 重启监督闭环 + 分身看护 UI。**
**诚实说明：外部业务生产者本体（PluginUpdater/SuperAgent/HarnessMM/PJM/Worker）仍未接入；本版只交付契约、客户端与测试。**

### 新增
- **决策中心**：红/黄/蓝/绿/灰 ticket、会话日配额、注意力预算、红票硬上限、批量 resolve/abandon、动作执行钩子、SSE 推送、AI 建议/采纳审计、执行状态 chip。
- **AI**：token 级流式建议（SSE）、多模型/多 provider/多 Key 路由（`profiles/routes`）、私网 allowlist、SSRF 防护（元数据/私网字面量 + 请求前 DNS 预检）。
- **fork 转发**：fork outbox（失败落盘/退避/flush）、独立进程 ingest client/CLI、`ADAPTER_OP.DECISION_INGEST`、`request_human_decision`/`report_pjm_timeout`/`report_worker_deviation` 工具、母体 `originForkId/taskId` 标签与跨 fork 聚合（含 AI 建议采纳统计）。
- **业务生产者**：统一 producer 契约 v1（`normalizeProducerPayload`/`createProducerSubmitter`/`producerCatalog`）+ 目录路由；MirrorUpgrade、EssenceManager、PM、umbrella 已接线；PJM/Worker 客户端与工具就绪（本体未调用）。
- **镜像升级**：officialSource manifest adapter（`officialSourceUrl`/`officialSourceToken`）、真实下载/替换、成功 → 红色 restart ticket（`confirm_restart`）。
- **重启监督**：HMAC 签名清单/回执、supervisor/watchdog、desktop launcher、启动恢复与执行回执校验。
- **客户端**：独立收件箱侧栏入口 + 右侧 pane / 固定 drawer 回退；五色分组折叠、分组头三态全选、键盘导航、批量失败逐条 UI、AI 流式、分身看护开关；主面板移除旧决策中心渲染。
- **持久化**：approver 快照从 A/B 扩展为多代（`snapshotGenerations` 默认 3，A–J 可回滚；index v2 跨重启保留）；新增 `dsh-approval-journal.jsonl` 崩溃 journal（request/settled/orphaned），重启把未结 request 标记 orphaned，不复活已死 Promise。
- **启动韧性**：无效/旧盘 `fang-home.txt` 迁移指针自动忽略回退；新增真实重装 drill（同一 DSH_HOME 覆盖安装 + 毒数据后二次 boot）。
- **启动自检**：`tools/boot-guard.mjs`（bundle 行解析/重复 id/子进程 import 冒烟；`--apply` 禁用失败行、`--safe-mode` 全禁用；`--candidate-dir` 候选包冒烟）；restart-guard `selfCheck()` + `GET /fang/api/restart/selfcheck`；`tools/desktop-launch.mjs` 与 `tools/restart-watchdog.mjs` 已自动接 boot-guard（自动探测 profile；失败 + execute → 安全模式；dry-run 只报告；watchdog 可 `--no-boot-guard`/`--no-safe-mode`）。
- **运行时崩溃记录/熔断**：restart-guard 写 `boot-state.json`（booting/running/clean/crashed）+ `runtime-crash.jsonl`（`uncaughtExceptionMonitor`，不改变宿主退出）；launcher 检测上次 booting/crashed 且 pid 已死 → 自动安全模式，避免启动期崩溃循环。
- **更新器门禁**：boot-guard 新增候选包 `smokePackage()` / `--candidate-dir`（子进程 import + 导出 apply）；更新器可按“快照 → 候选冒烟 → 转正/回滚”接线（PluginUpdater 本体仍不在本仓）。
- **测试**：jsdom 客户端 DOM harness（13 项）；SSRF、producer 契约、outbox、streaming、restart HMAC、fork 聚合、多代快照/崩溃 journal 等用例。

### 修复
- **真实 EssenceManager 冲突不出票**：`recomputeAll()` 返回的是 id 数组，旧代码 `Number(array)=NaN` 导致 conflicted/failed 统计为 0；改为数组长度并补真实冲突/失败测试。
- **未读计数口径不一致**：侧栏/tab 用 `rev>seenRev`，收件箱标题用 pending；统一为 pending，`seenRev` 仅做新票提醒去重。
- **无 `requestAnimationFrame` 环境的 drawer ReferenceError**：增加 guard，jsdom 下不再抛错。
- **路由数保持 84**：新增 `/api/forks/supervision`（GET+POST 单注册）后同步删掉重复注册的 `/api/essence/default`；`compat`/allow-list/门禁同步，避免宿主 duplicate-path 抛错导致后续路由静默丢失。
- 其他：AI Key 持久化说明、fork umbrella `decisionTicketPromise` 异步回传、三态全选不误触折叠。

### 测试/门禁
- `preflight --e2e` **GREEN**：1026 tests / 1015 pass / 0 fail / 1 skip / 10 todo（176.8s）；e2e **81/81**（17.4s）；allow-list routes=104 findings=0；compat COMPATIBLE；syntax vet 0 失败。
- 干净 profile 实机安装 drill：**GREEN 9/9**（client half、version=3.1.1、19 行、zero-residue temp home/port）；healthz HEALTHY。
- 产物：`dist/dsh-fang-3.1.1.tgz`（510,730 B / 135 entries）sha256 `385951cd8d1910fe243b190e57f8ebe7fbcba5bf29b573394a578c71d1b53e34`；package-smoke PASS；allow-list(pkg) 117 files。
- **六方发布未执行**：本机缺 npm/GitHub 凭据、工作树未 commit、tag 未落在 main、.exe 安装器不在本仓构建链。详见 `docs/AUDIT-v3.1.1.md`。

### 已知边界
- PluginUpdater / SuperAgent / HarnessMM / PJM / Worker **本体未接**：契约、client/CLI、fork tool、adapter op 已就绪，需外部进程实际调用。
- Agent Loop hook、真实官方 manifest 源、真实 .exe 安装器与桌面壳真机验证未完成。
- 多 Agent 投票/仲裁不做；WebSocket 不做（SSE 足够）。

## v3.1.0（2026-11-07）

**主题：元主运行态继承本机插件/设置；修复 essence 派生 JSON 补丁导致的 `spawn-failed`、派生会话丢失、元主设置 EPERM；隔离迁移遗留会话。**

### 修复
- **元主运行态继承元主配置**：`startEssenceRuntime` 现在传 `cleanTemplate: false` + `nodeModulesSource`，从 essence `merged/profile` 克隆，而不是退回 `base + web-app + fang` 的 clean template。官方/用户元主打开后能看到本机插件与设置。
- **JSON 形状 profile patch 归一化**：`applyForkConfigLock` 识别 `{ insert: [...] }` 与 JSON 数组，结构化合并锁条目/欢迎说明；不再在 JSON object 后追加 YAML 列表，修复 essence 派生分身启动即退出的 `spawn-failed: exited`。
- **元主行派生的会话复制**：`POST /fang/api/tasks/create` 透传 `importSession` / `seed`，元主栏选中的会话会真正复制进分身 home。
- **元主运行态可写**：`setProfileConfigReadonly` 跳过 `essence-runtime`，启用内置插件/修改设置不再 `EPERM rename package.json.<tmp>`；真正的分身仍保持只读。
- **欢迎说明预置**：clean template 与 fork lock 均写入 `ui-settings-general.welcomeNoticeVersion`，首次运行预览说明可正常保存。
- **迁移遗留会话隔离**：官方元主运行态 home 中由旧运行态迁移带入的 4 个历史会话与 workspace 索引移入 `quarantine-sessions/`（数据保留），新打开默认不带历史会话；需要时显式「启动并导入」。

### 测试
- `fork-config-lock`：JSON `{insert}` 结构化合并、`essence-runtime` 不设只读。
- `orchestrator`：`startEssenceRuntime` 的 provision 必须 `cleanTemplate=false` 且带 `nodeModulesSource`。

### 门禁
- `preflight --e2e` GREEN：754 pass / 0 fail / 1 skip；e2e 75/75；allow-list routes=84 findings=0。
- `dist/dsh-fang-3.1.0.tgz`（396,470 B，119 entries）sha256 `a78ab4eb443d8d4f9702ea52322fc13605745c8d1f1e3857a1cc90c8e71a5ac7`。
- `package-smoke` PASS；`install-drill` GREEN 7/7（干净 profile boot 含 `@twinsearth/dsh-fang/client.js`，version=3.1.0）；`healthz` HEALTHY。

## v3.0.10（2026-11-07）

**主题：修复 npm 发布包剥离 `dsh.client` 导致 Web「瓮城」主面板不加载；发布门禁补上 client half 物化断言。**

### 修复
- **npm 包恢复浏览器 client half**：`tools/release/build.mjs` 不再删除 `dsh.client`。v3.0.9 的发布包在 staging 时删掉了该字段，安装后 Web 端只剩设置页入口，侧边栏「瓮城」与主面板（元主/分身 50:50 控制台）全部不出现；构建现在在 `dsh.client` 缺失时直接失败。
- **smoke 断言反转**：`package-smoke.mjs` 由「client half 必须禁用」改为断言 `dsh.client.platform === 'web'`、`client.js` 注册发布包 ID、包含 `sidebar.panellist` 与 `main` 槽位；v3.0.9 的 tarball 会在该门禁直接 FAIL。
- **安装 drill 真实拉取 boot 页**：`install-drill.mjs` 在干净 profile 启动 Web 后请求首页（先交换 302 的 set-cookie），断言 `@twinsearth/dsh-fang/client.js` 在插件清单中；profile 现在写入 `dependencies`，与 `pnpm add` 落盘一致。drill 结束时用 `taskkill /T` 清理宿主进程。
- **healthz 增加 client half 启用检查**。
- **PR 门禁识别 GitHub 合成 merge ref**：`pr-gate` 在 CI 的 `refs/pull/N/merge` 检出上会先解包到真实 PR 提交，再做线性历史与 conventional-commit 检查，避免平台生成的 merge 提交被误判为本 PR 的提交。

### 门禁
- `preflight --e2e` GREEN：751 pass / 0 fail / 1 skip；e2e 75/75；allow-list routes=84 findings=0。
- `dist/dsh-fang-3.0.10.tgz` sha256 `6afe97710f54a6dc84cfff1cb7d8d425a73a5c241d3bb6b3f3488964b240bbb0`。
- `package-smoke` PASS；`install-drill` GREEN 7/7（干净 profile boot 含 `@twinsearth/dsh-fang/client.js`）；`healthz` HEALTHY。
- 详见 `docs/AUDIT-v3.0.10.md`。

## v3.0.9（2026-11-06）

**主题：三区数据布局落地、元主默认元宝与派生入口、分身生产盘硬禁修复、发布物 v3.0.9。**

### 新增
- **三区布局**：`mirror/<tag>`、`essence/`、`forks/`、`sessions/<essenceId>/home` 实拆；`fang-home.txt` 迁移指针；跨区路径守卫（`path-escape` / `invalid-workspace-key`）。
- **迁移工具**：`tools/migrate-to-fang-home.mjs`（dry-run 默认、自动备份、junction 感知、结构化路径重写、运行态归口）、`tools/migrate-runtime-homes.mjs`、`tools/rewrite-fang-paths.mjs`、`tools/repair-fork-patches.mjs`。
- **默认元宝**：`copy-local` 模式只复制本机插件启用状态与设置（不复制会话/数据/代码/凭据）；无用户元主时自动创建，快速派生默认使用。
- **元主「派生」按钮**：替代详情按钮；选一个进行中会话 → 创建分身沙箱并整目录复制会话。
- **物理分支**：adapter `fork-session` op（分身内 `ctx.sessions.fork`）+ 分支库 `sessionId` + `activeBranchId`；分身卡分支面板。
- **运行态开关**：运行中显示「停止 + 进入」，停止后回「打开」；工作区比例 50:50。

### 修复
- 分身 profile patch 的 `[]` 残留导致 YAML 非法、`spawn-failed: exited`；`cordis.yml` 只读导致启动 `EPERM`；两处均已修复并修复存量分身。
- 元主派生时 `cleanTemplate` 覆盖原身模板的问题；派生模板固定为来源元主 `merged/profile`，每次 spawn 重放配置。
- `forker.spawn` 缺 `homeDir` 的 `no-home-dir` 诊断与回归测试。
- 显式 `dataRoot` 不再自动跳 `D:\ToFuture`。

### 门禁
- 全量测试 **750 pass / 0 fail / 1 skip**；rich UI smoke **21/21**。
- 发布物：`dsh-fang-v3.0.9.zip`；PC 安装包 `DSH-Fang-3.0.9-x64-Setup.exe`（默认安装目录 `D:\ToFuture\app`，升级沿用原目录，不删数据区）。
- 已知边界：官方源升级适配器未接入；物理分支真实 `sessions.fork` 待现场验收；分身硬禁的文件系统 ACL 需宿主权限位。

## v3.0.8（2026-11-05）

**主题：分支/回流运行时、MCP 只读桥、FANG_HOME 数据根、DSH Web 侧边栏入口。**

### 新增
- **分支 HTTP**：`GET/POST /fang/api/tasks/branches`、`/activate`、`/status`；`BranchStore` 原子持久化，单写者与不可合并约束沿用。
- **回流策略**：`GET /fang/api/reflow/policy`（sealed→verified→quarantine→adopted，禁止字段，不合并）。
- **MCP**：`tools/mcp/{tools,server}.mjs`；stdio JSON-RPC；默认只读工具 + 高风险 `get_op`/`abandon_op`；输出递归清洗 token/path/template。
- **FANG_HOME**：`$FANG_HOME/mirror/<profile>`、`$FANG_HOME/essence`、`$FANG_HOME/sessions`；未设置时保持旧布局兼容。
- **DSH Web 入口**：侧边栏「瓮城」图标 + 主面板自动唤起 `dsh-fang://open`；插件配置页保留「打开瓮城控制台」。
- **Electron 桌面端**：宿主自动发现、托盘常驻/退出、连接信息掩码弹窗、日志分类与 100/300 分页、标题栏 Slogan；安装器默认 `D:\ToFuture`，AGPL 源码随包。

### 修复
- 任务创建异常返回空响应 → 结构化 500；母体 palette `app is not defined`。
- 代理绝对 URL 可崩溃主进程 → 仅接受单一 `/` 路径 + origin 校验 + 400（absolute-form/`//`/反斜杠/控制字符全部拒绝）。
- 启动器默认开 CDP、写死 Electron 路径；`desktopInfo` 下发 token；`#fang-fallback` 残留。
- **HTTP 契约审计（docs/AUDIT-v3.0.8-HTTP-CONTRACT.md）**：
  - 修复 DSH exact 路由以 path 为键导致的 GET+POST 同路径吞并：`/tasks/branches` 与 `/bridge/sessions` 改为单注册按 method 分发（否则 POST 405、后续路由不注册）。
  - `/sessions*`、`/bridge/*`、`/sync/*`、`/route` 接入与 `/status` 相同的 Host/Origin/CSRF/token 门禁；鉴权先于 method（无 token 不再拿到 405）。
  - 未知 `/fang/api/*` 统一 JSON 404（先鉴权）；branches 未知 taskId 404、taskId/branchId 路径穿越拒绝、分支错误映射 400/404/409。
  - adapter 路由补 loopback Host、Origin/CSRF、JSON 写校验与 405 `Allow`；代理层 403/404/502 统一 JSON，接住 `file://`/`//`/反斜杠 target，token 轮换后自动 bootstrap 并重试 GET；`client.js` 不再因 `headers` 覆盖丢失 `x-fang-auth`。
  - Host 严格解析，拒绝 `[::1]evil` 等 loopback 前缀伪造。

### 门禁
- 路由 **67**；单测 **718 pass / 0 fail / 1 skip**；e2e **73/73**；桌面代理套件 **51/51**；preflight `--e2e` GREEN；安装包 `DSH-Fang-3.0.8-x64-Setup.exe` + SHA256SUMS。

## v3.0.7（2026-11-03）

**主题：发布门禁加固——e2e 不可跳过、client half 物化断言、16 行完整性、.sha256 伴随产物。**

### 门禁修复
- **preflight**：未传 `--e2e` 时新增失败项 `e2e: required for release green`，不再可能 `e2e:null` 仍发绿灯；
  已存在 tarball 时校验同目录 `.sha256`（缺失/不匹配均失败）。
- **e2e**：新增两条免疫本次线上故障的断言：
  - `client half registers @local/dsh-fang`：vm 执行 client.js，确认 `window.__ModuleLoader__.load` 注册；
  - `client half materializes apply()`：调用 factory（stub React）后确认导出 `{inject, apply}`；
  - `16 fang plugin rows composed`：`dsh --profile e2e --dump-config` 统计 `fang-*` 行 ≥16。
- **build**：默认调用 `preflight --e2e`；构建前清理同版本旧产物；生成 `dist/dsh-fang-<ver>.tgz.sha256`。
- **release workflow**：build job 改为 self-hosted Windows 且执行带 e2e 的构建；artifact 与 GitHub Release 均上传 `.sha256`。
- **fallback 面板鉴权**：`/fang/panel` 注入 `<meta name="fang-auth">`，内联 `api()` 自动携带 `x-fang-auth`
  （修复页面「派生失败: unauthorized」）。
- **client half 发现机制纠正**：验证后确认 client half 由宿主 Loader 对**bare 包名行** `@local/dsh-fang`
  的 `dsh.client` 扫描发现；**不新增** `ui-fang → @local/dsh-fang/client` 行（子路径不是包根，会被当作坏插件：
  `failed to import`）。e2e 改为断言 `package declares dsh.client` 与 `no inactive plugin entries`。
- **测试计划**：新增 `docs/TEST-PLAN-v3.0.7.md`（87 条用例，PKG/SEC/ESS/DRV/UI/MIR/CMP/BR/MCP/REL）。
- **PKG-01**：新增 `tools/release/package-smoke.mjs` 并接入 build：解包 tarball、校验入口/16 行/插件 `apply`/
  client 归一一致/`.sha256`；**SEC-07** 增加 e2e 磁盘断言（tasks.json/forks.json 无 token）。
- **S1 UI 动作语义**：新增 `src/lib/ui-actions.mjs`（稳定 action id：分身 6 项 / 元主 7 项；
  每项 `{enabled, code, reason, confirm}`；任务/元主接口统一返回 `actions + blocks`），
  UI-10/UI-11 转为真实断言，剩余 UI 用例以 todo 追踪。

### 验证（本机）
- 无 `--e2e`：**RED**（e2e required + sidecar missing）；
- `--e2e`：**GREEN 3.0.7**（**648 tests**、e2e **66/66**、62 路由、sha256 match）；
- build：preflight GREEN → package smoke PASS → tarball 生成 + `.sha256` 一致。

## v3.0.6（2026-11-03）

**主题：元主 CRUD + 默认元主 + 分身列表契约字段（后端契约 B，先行；UI 移植随后）。**

### 新增
- `EssenceManager`：`rename/archive/setDefault/getDefault/copy/pluginCount/downloadBundle`；
  - 复制只带 overlay/settings，**不复制 credentials**；导出 JSON 附件同样排除凭据；
  - locked 官方原身拒绝 rename/archive；默认元主持久化到 `essences/default.json`，官方兜底。
- orchestrator 路由（10 条）：`essence/create|rename|archive|delete|copy|default|download`、
  `tasks/rename|copy|download`；`essence/list` 增加 `defaultId/defaultEssence/capacity{slots:7,defaultLimit:5,used}` 与
  `locked/official/archived/pluginCount`。
- 分身列表字段：`phase`、`health{adapter,error}`、`sessionTitle`、`startedAt/updatedAt`、`projectBytes`、`essenceId`。
- 契约文档：`docs/API-v3.0.6.md`。

### 测试
- 新增 `test/essence-crud.test.mjs` 5 项（rename/archive/default/copy 无凭据/导出无凭据）；
- orchestrator 路由断言更新（62 路由），create→rename→list 契约链路。

### 未交付（明确）
- 配额准入执行（reserve/commit/tombstone）、元主 pause/restart、分身完整项目归档、分支/单会话租约（v3.0.7+）。

## v3.0.5（2026-11-03）

**主题：安全止血（完整包）：B1 路由鉴权/CSRF/Host + B2 Adapter fail-closed + B3 路径穿越/大小上限 + B4 token 去 URL/不落盘 + B5 派生 env 白名单 + B6 官方原身 create-only + B8 凭据不复制。**

### 安全修复
- **B1** 新增 `src/lib/http-auth.mjs`：安装级 token（`<dataDir>/fang-auth.json`，0600，env/显式配置可覆盖）；
  所有 `/fang/api/*` 默认要求 `x-fang-auth`（或 Bearer）；loopback Host 校验、Origin/`Sec-Fetch-Site` CSRF 校验、
  写请求 JSON content-type；面板通过同源 `GET /fang/api/auth-token` bootstrap（仍受 Host/Origin 校验）；
  `client.js` 统一缓存并携带 header。e2e 作为本机客户端按真实方式读取 token 文件。
- **B2** `adapter.mjs`：fork 角色未拿到 `DSH_ADAPTER_TOKEN` 时默认 **fail-closed**（控制面 401），
  v2 兼容必须显式 `allowLegacyNoToken: true`；启动时记录 warn。
- **B3** `session-bundle.mjs`：导入时校验 `file/sessionId` 必须落在 bundle/sessions 与 targetRoot 内，
  拒绝 `../` 穿越；新增单文件/总大小/文件数上限（默认 64MB/512MB/2000）。
  `session-sync.mjs`：bundleId 只允许安全段；bundleDir 必须位于 bundleRoot 内；
  targetHome 只允许当前 DSH_HOME 或 fork homes 根；请求体上限 1MB（413）。
- **B4** `remote.mjs`：token 只走 `Authorization` header，不再拼进请求 URL；
  `forker.mjs`：`publicFork`/`forks.json` 的 URL 去 token、不再持久化 token；
  `orchestrator`：`tasks.json` 不落 token、列表 URL 去 token；新增 `GET /fang/api/tasks/open-url`
  在内存中临时下发带 token 的 URL（client.js 打开分身改走该接口）。
- **B5** `forker.mjs`：新增 `buildForkChildEnv` 环境变量白名单，不再 `...process.env` 全量继承；
  云密钥/自定义 token 不进入派生子进程（Adapter token 仍由 forker 显式注入）。
- **B6** `essence.mjs`：`create()` 改为 **create-only**（已存在 id 直接拒绝，不能抢占官方原身）；
  `ensureOfficialEssence()` 发现 locked/official 被篡改时修复 meta（uid 不删数据）；
  `locked/official` 只能由内部 official seed 设置。
- **B8** `essence.mjs`：物化 `merged/profile` 时**永不复制 credentials**（镜像与原身凭据都不进入派生 profile）。

### 测试
- 新增 `test/security-hardening.test.mjs`（5 项：create-only、seed 修复、env 白名单、bundle 穿越、大小上限）；
  新增 `test/http-auth.test.mjs`（7 项：token 文件 0600、Host/Origin/CSRF、415、bootstrap 校验）；
- 更新 `essence` 凭据断言、`adapter` legacy auth 断言、`remote`/`adapter-client`/`orchestrator`/`e2e` 的 token 断言；
- 门禁：**636 tests / 0 fail / 1 skip**、**e2e 59/59**、**52 路由**。

### 说明
- B1/B4 已包含在本版本内，v3.0.5 达到“安全止血包”退出条件（可进入 tag 流程，但仍需按 v3.0.0 起的严格序列补发）。
- 已知例外：SSE `eventsUrl` 仍以查询参数携带 token（EventSource 无法设 header），后续改为 fetch streaming 时消除。

## v3.0.4（2026-11-02）

**主题：三层产品形态权限契约 + 官方推荐原身（fast derive 默认基底）。**

### 新增
- `src/lib/permissions.mjs`：三层权限矩阵（母体禁插件/禁会话、原身可插件/禁会话、分身禁插件/可会话），
  `checkPermission` / `createEnvironmentGuard`（can/check/assert + `PermissionDeniedError`）/
  `describePermissions`；未知环境或未知动作 **fail-closed**（供 UI 与 Adapter 第二道门）。
- `EssenceManager` 官方推荐原身：
  - `ensureOfficialEssence()` 首次启动幂等 seed（`essence-official-dev`，locked + official，
    预装默认插件条目 `DEFAULT_OFFICIAL_PATCH_ENTRIES`）；
  - 锁定保护：`update/remove/setTier` 对 locked 原身一律拒绝；
  - `create()` 支持显式 id / locked / official / skipQuota / defaultPatchEntries。
- orchestrator：启动时 seed 官方原身（失败仅 warn，不阻塞主插件）；
  新增 `GET /fang/api/essence/list`（`{officialId, official, essences}`）。
- 测试：`permissions` 7 项、`official-essence` 5 项 + orchestrator 路由断言。
- compat 门禁路由契约更新为 50 条，必需路由增加 `/fang/api/essence/list`。

### 边界
- 分身派生（DerivedInstanceManager）与三种 Web 视图路由为 v3.0.5+；
- 真正的硬隔离仍靠 profile 组合（装不装插件/会话），本版本提供第二道门与默认基底。

## v3.0.3（2026-11-02）

**主题：客户端升级后的兼容性门禁（compat gate）——子插件默认关闭，验证通过才启用。**

### 新增
- `src/lib/compat.mjs`：`runCompatGate`（内核入口可导入、全部子插件模块可导入且导出 `apply`（当前 16 个，后续自动纳入）、
  路由契约数量 + 必需路径检查）；`writeCompatStatus`/`readCompatStatus`（`compat-status.json`，
  **`subPluginsEnabled` 是唯一允许启用子插件的判据，未检查/失败时均为 false**）。
- `MirrorManager` 新增 `compatGate` / `onCompatResult`：客户端版本升级成功后先跑 compat 门禁；
  未通过 → 保留新版本但 `reason: 'compat-gate-failed'`、子插件保持关闭、**跳过原身重算钩子**；
  门禁抛错按失败处理；通过 → 正常触发重算。升级返回体携带 `compat` 结果。
- orchestrator 接线：`GET /fang/api/mirror/recompute-status`（协调器状态）、`GET /fang/api/compat`、
  `POST /fang/api/compat/check`；启动 1.5s 后自动跑一次门禁；门禁使用真实 webServer 路由列表
  （期望 49 条）+ 必需路由清单。
- 测试：`compat` 10 项（模块导入/apply/路由契约/状态默认关闭/门禁与升级联动）+ orchestrator 路由断言。

### 语义
- 更新客户端版本后默认不开启子插件；门禁通过才写 `subPluginsEnabled: true`；
- 失败时主插件继续服务（面板/路由可用），等待开发者更新插件版本后再次检查（POST compat/check）；
- 门禁失败不回滚客户端版本（保留新版本），回滚仍可走镜像备份/还原盘。

## v3.0.2（2026-11-02）

**主题：升级后重算协调 + 镜像偏好 schema 化 + 空闲降级审计。**

### 新增
- `src/lib/semaphore.mjs`：计数信号量（并发上限）。
- `EssenceManager.recomputeAll(options)` 异步增强：ensureFresh（fingerprint 匹配 → skipped）、
  `concurrency`（默认 4）、`perEssenceTimeoutMs`（默认 60s）、`AbortSignal`、`onProgress`；
  返回 `{recomputed, skipped, conflicted, failed, aborted, durationMs}`，单原身失败/超时不中断整批。
- `MirrorManager.postUpgradeHook`：升级成功后 fire-and-forget 触发（`postUpgradeTriggered`），
  失败/回滚不触发，钩子异常只 warn，不影响升级结果。
- `src/lib/upgrade-coordinator.mjs`：`onUpgradeSuccess` 去重并发批次、`getRecomputeStatus`、
  `waitForRecompute`，向 UI 暴露 running/startedAt/finishedAt/progress/lastResult/lastError。
- `src/lib/preferences.mjs` 重写为 schema 驱动：6 个字段描述符（交互超时/活跃与空闲轮询间隔/
  备份保留天数/空闲提示/严格冲突模式），默认值、min/max/step、enum options、migrate、
  `normalizePreferences` 纯函数、未知字段丢弃、损坏文件不覆盖；新增
  `GET /fang/api/mirror/preferences` 与 `POST /fang/api/mirror/preferences/set`。
- `src/lib/status-store.mjs`：外部 store（每个订阅者共享状态、304 只更新 lastUpdatedAt、
  订阅计数、`acquireActive` 引用计数 + `pokeActive` + 30s 无交互降级、`setActiveIdleTimeout`）。
- `src/lib/idle-audit.mjs`：空闲降级事件聚合（单条审计 + 周期 summary、byTimeout 统计、
  rapidAway/fullTimeout、样本足够时生成建议）；滚动窗口 `getRecommendations()` 输出结构化建议
  （fieldKey/suggestedValue/text/sampleCount/confidence），快照窗口与滚动窗口分离。
- `src/lib/interaction-poke.mjs`：DOM 交互节流 poke（框架无关）。
- 测试：`upgrade-coordinator` 8 项、`status-store` 12 项、`idle-audit` 7 项、
  `idle-recommendations` 7 项、`preferences` 9 项 + orchestrator preferences 路由断言。

### 边界
- coordinator / status-store / idle-audit 的 UI 接线在客户端包与后续版本完成；
- 自动备份清理、dismissals 7 天冷却等仍待实现。

## v3.0.1（2026-11-02）

**主题：母体镜像管理（文件夹 1）：备份 / 恢复 / 自动备份 / 升级 / 回退 + 小光盘面板入口。**

### 新增
- `src/lib/mirror.mjs`（零依赖）：
  - 目录布局 `active/ + backup/ + restore/ + backups.json + meta.json`；
  - `backup()`（自动/手动分桶）、`restore()`（先自动备份当前 active 再替换）、`deleteBackup()`、
    `setBackupInterval()`（仅 6/12/24）、`maybeAutoBackup()`（到期检查）、`checkUpdate()`；
  - `upgrade({autoBackup, autoRollback, onProgress})`：检查 → 备份 → 下载 staging → 原子替换 → 失败自动回滚；
    未配置官方源时显式返回 `official-source-unavailable`（不假装成功）；
  - `getStatus()`：版本/官方最新/更新可用/备份列表/磁盘占用/活跃分身数；`backupId` 正则防路径穿越。
- 服务 `SERVICE.mirror = 'fangMirror'`（由 `fang-orchestrator` 提供）+ 6 条路由：
  `GET /fang/api/mirror/status`、`POST /fang/api/mirror/{backup,restore,backup/delete,backup-interval,upgrade}`。
- orchestrator 每 60s 检查自动备份到期；新增 `Config.mirrorRoot`（空 = `<dataRoot>/mirror`）。
- `client.js`：顶栏「镜像」按钮（蓝色小光盘 `IconDisc`）+ 「母体镜像」卡片：状态轮询（8s）、
  6/12/24 小时间隔、立即备份、备份列表恢复/删除（二次确认）、升级（indeterminate + 已用时间）。
- `test/mirror.test.mjs` 16 项 + `test/orchestrator.test.mjs` 路由/处理器断言；
  `docs/MIRROR.md`（布局/路由/升级语义/边界/未交付）。

### 未交付（明确边界）
- 官方源未接入：`checkUpdate/upgrade` 显式降级，升级按钮在无更新/无源时禁用；
- 原身（文件夹 2）与会话（文件夹 3）的派生与隔离（P2/P3）；
- 升级进度的 SSE 推送（当前为 indeterminate + 已用时间）。

> 版本策略：`x.y.z`；新增能力进 minor 位（v2.10.0 → v3.0.1）。

## v2.10.0（2026-11-02）

**主题：Essence 原身覆盖层合并库（镜像 × 原身，零依赖实现）。**

### 新增
- `src/lib/essence.mjs`（v2.10.0）：
  - 纯合并 `mergeProfiles(mirror, overlay)`：patch 条目按 id（覆盖/禁用/新增，config 深合并）、
    package.json 依赖并集与主版本兼容判定、settings 深合并、锁定项 fatal 保护、重复 id warning；
  - 冲突模型：`missing-plugin` / `locked-plugin-overridden` / `locked-plugin-disabled` /
    `version-incompatible` / `duplicate-id`，分 `fatal` 与 `warning`；
  - `EssenceManager`：`create/update/remove/list/listChildren/setTier/recompute/recomputeAll/getConflicts`，
    磁盘布局 `overlay/ + merged/profile/ + meta.json (+ conflicts.json)`；fatal 时保留上一次物化结果并标记
    `status: conflicted`；物化时剔除镜像凭据、只复制原身 `credentials/`；
  - 配额：`VIP_QUOTAS`（free 5 / vip10…vip100 100）+ `checkEssenceQuota` / `checkSubEssenceQuota` /
    `checkActiveSessionQuota`；两级原身、父原身删除保护；
  - YAML 复用 `rule-registry` 的 `parseYamlSubset`（无新增依赖）；写出 JSON（JSON 是合法 YAML）。
- `test/essence.test.mjs` 23 项：合并语义 / 冲突分级 / 配额 / 物化 / 凭据边界 / 配额上限 / 两级原身 / recomputeAll。
- `docs/ESSENCE.md`：三层数据边界、合并语义、配额表、冲突状态机、未交付项。

### 未交付（明确边界）
- 本版本不接 HTTP 路由、不接面板 UI、不创建分身进程；`merged/profile` 已可作为 `--profile` 供后续 P3 派生使用。

> 版本策略：`x.y.z`；新增能力进 minor 位（v2.9.x → v2.10.0）。

## v2.9.2（2026-11-02）

**主题：顶栏新增「母体打开」按钮（蓝色地球图标）。**

### 新增
- `client.js`：顶栏在「母体连接」与「派生新分身」之间新增「母体打开」按钮（`IconGlobe`，
  INFO 蓝色地球图标）；点击在新窗口打开母体瓮城独立门户 `/fang/panel`。
- 桌面壳下用 v2.9.1 的 `resolveMotherOrigin()` 拼绝对地址（如
  `http://127.0.0.1:52648/fang/panel`），避免 `dsh-app://app/fang/panel` 这类自定义协议
  在新窗口里打不开；普通 Web 下回退相对路径 `/fang/panel`。
- `window.open` 被拦截时回退到同标签页跳转，不静默失败。

> 版本策略：`x.y.z`；这是 v2.9 的补丁位。

## v2.9.1（2026-11-02）

**主题：修复桌面端「母体连接」默认地址不可探测（`dsh-app://app` → target-scheme）。**

### 修复
- `client.js`：新增 `resolveMotherOrigin()`——桌面壳里 `window.location.origin` 是
  `dsh-app://app`（自定义协议，不是可探测的 HTTP 源），改为优先读取宿主注入的
  `__DSH_TRANSPORT__.streamBaseUrl`（desktop `main.ts` 注入的 Host 真实 HTTP 源，
  如 `http://127.0.0.1:52648`）；普通 Web 下回退 `location.origin`；两者都不可用时
  返回空串让用户手动填写，而不是预填一个必然失败的地址。
- `client.js`：探测错误码翻译为可操作原因（`target-scheme` → “桌面壳地址不是可探测的
  HTTP 源”，`timeout`/`network-error`/`target-empty` 等各有提示），不再把原始码直接丢给用户。
- 服务端无改动：`probeLink` 继续只接受 http(s) origin（拒绝 `dsh-app://` 是正确行为，
  分身无法跨进程访问该协议）。

> 版本策略：`x.y.z`；这是 v2.9 的补丁位。

## v2.9.0（2026-11-02）

**主题：瓮城面板「母体连接」——只描述、只读探测，不持有连接状态。**

### 新增
- 服务 `SERVICE.link = 'fangLink'`（由 `fang-orchestrator` 提供）：
  - `describe()`：`{ ok, role, version, at, prefix, motherApiBase, adapterBase, probe, tokenPolicy, sharedConfig, forkInstructions }`；
  - `probe({ target, timeoutMs? })`：只读 GET `<target>/fang/api/status`，失败结构化、绝不抛异常。
- 母体路由：`GET /fang/api/mother-link`、`POST /fang/api/mother-link/probe`（prefix 默认 `/fang`）。
- `src/lib/mother-link.mjs`：地址归一化（只接受 http(s) origin，拒绝凭据/查询串/非 http）、
  profile 共享配置摘要（读 `dsh.profile.bundles`，失败降级 null）、探测超时夹在 [200, 10000]ms。
- 客户端：顶栏「母体连接」卡片（母体版本 / 母体 API / 分身 Adapter / 共享配置 / 令牌策略 +
  地址输入 + 复制地址 + 测试连通 + 收起）；分身 Web UI 的说明页增加分身旁路模式，地址与结果
  仅本次会话内存态（分身不保存插件设置）。
- 审计：`AUDIT.LINK_PROBE='link-probe'`（target / ok / latencyMs / error）。

### 语义与边界
- 令牌由 Forker 在 spawn 时注入 `DSH_ADAPTER_TOKEN`；fang 不落盘、不回显（描述里不含 token 值，有测试断言）。
- 共享配置 = 母体 profile 层（分身只读继承）；本版本不提供写入入口。
- 分身跨源直读母体受浏览器 CORS 约束：失败显示 `cross-origin-or-network`，不伪造成连通。
- 探测不写任何配置，不改变副本状态。

### 文档与测试
- `docs/CONTRACTS-V2.md §5.10`、`docs/UI-瓮城入口.md §9`、`docs/AUDIT-v2.9.0.md`。
- `test/mother-link.test.mjs` 7 项；`orchestrator.test.mjs` 增路由与处理器断言。

> 版本策略：`x.y.z` 每一位 0–9；v2.8 的补丁位已满（2.8.4），本次进位到 v2.9.0。

## v2.8.4（2026-11-02）

**主题：公共仓 / 私有镜像仓 发布管理 —— 可重复的 REST 同步 + 内容树/资产双重校验。**

### 新增
- `tools/release/sync-private.mjs`（零依赖，仅 GitHub REST API）：
  - `verify --tag vX.Y.Z`：比较两仓 tag→commit→**内容树 SHA**，下载各自 Release tarball 校验
    `manifest.json`、`.sha256`、实际哈希三者自洽；不一致退出码 1；支持 `--json`；
  - `sync --tag vX.Y.Z`：以内容寻址做增量 blob（复用未变文件）、断言私有 tree == 公共 tree、
    私有 `main` 仅 fast-forward、创建 annotated tag 与 Release 资产；支持 `--dry-run`；
  - 用 REST 而非 git push：发布机只放行 `api.github.com`/`uploads.github.com`。
- `docs/RELEASE-MIRROR.md`：两仓定位（公共=唯一事实来源、私有=只读镜像）、版本流转、
  同步语义、发布后三件核对、故障表与红线（禁手工提交/禁 force push/同步后必须 verify）。
- `test/sync-mirror.test.mjs` 8 项：参数解析、增量 blob 计划、资产自洽判定、树比较、SHA-256 向量。

### 同步实践（v2.8.3 已镜像）
- 私有仓 `main` 更新到 **v2.8.3 内容**（tree `cd9e53f4…`，与公共仓 tag 树一致），annotated tag `v2.8.3`，
  Release 资产 3 个（tarball 286,944 B / sha256 `3c97748e…`、`manifest.json`、`.sha256`）；
- 公共 Release v2.8.3 的 `.sha256` 已按 CI 重建产物校正为 `8bc30c67…`（286,952 B）；
- `verify --tag v2.8.3` 通过（`trees.ok=true`、两仓资产均自洽）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 4 个补丁位。

## v2.8.3（2026-11-02）

**主题：严格模式 + 语法错误的回退语义（组 4 扩展）——事务化 rebuild，失败层对后续层不可见。**

### 变更
- `rule-registry.rebuild` 重构为**纯计算** `computeRebuild(layerList)`：不再就地修改 `effective`/`status`，
  返回 `{ applied, effective, status }`；`applyLayer`/`applyConfig`/`clearLayers` 只在 `applied` 时提交。
  失败时 `layers`/`effective`/`status`/`strictMode` **全部保持上一次成功值**，失败层对后续层完全不可见。
- 失败结果新增 `revertedToLayerIndex`（`-1` = 内置全集），审计与 `ruleConfigStatus()` 可直接回答
  「哪一层被拒绝、回退到了哪一层」。
- **YAML 解析修正**：支持 flow 映射 `{ k: v, k2: v2 }` 与嵌套 flow 列表 `[{ re: "..." }]`
  （深度感知、尊重引号）。此前 `settings: { failOnInvalidPattern: true }` 会被当成标量字符串，
  导致 `settings` 静默回落到默认值——写了严格设置却不生效。这是组 4 测试暴露的真 bug。

### 测试
- 扩展组 4（`test/rule-config.test.mjs` 30 → **35 项**）：严格层编译失败回退到上一个成功层、
  第二个严格层失败回退到第一个严格层（不是内置全集）、失败后 `inherit:true` 层叠加到上一个成功层、
  失败层状态隔离（layers/effective/strictMode 均不被污染）、插件层状态报告。
- 全量测试 **494 → 499 项**（498 pass / 1 skip）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 3 个补丁位。

## v2.8.2（2026-11-02）

**主题：`inherit: false` 严格模式 —— 项目可完全替换可调规则集，但拆不掉安全边界。**

### 新增
- YAML 顶层 `inherit`（boolean，默认 `true`）。`inherit: false` 表示**丢弃此层之前所有可调规则**，
  只保留硬规则（`hard-deny`/`non-negotiable`）+ 兜底 `unknown-tool`，再从该层开始叠加。
- `registry.applyLayer` 支持多段严格模式：以**最后一个** `inherit: false` 层为起点重建；它之前的层全部丢弃；
  之后的 `inherit: true` 层叠加在严格结果上，**不会**恢复被丢弃的内置可调规则。
- 后续层可按 id **重新引入**被丢弃的内置规则（用内置定义"复活"再覆盖），避免严格模式后必须重写谓词。
- 严格模式返回 `source: 'strict-replaced'` 与 `strictMode: { layerIndex, preservedHardRules, preservedFallback, discardedRuleCount }`；
  `ruleConfigStatus().strictMode` 同步可见。
- 审计：严格模式激活时写一条 `AUDIT.UMBRELLA_STRICT_MODE`（`umbrella-strict-mode`），
  记录层号、保留的硬规则、丢弃数量与各层应用结果（新增 kernel 审计类型）。
- 安全网：rebuild 结果若不含 fallback 规则视为 bug，直接拒绝应用。
- `docs/RULES-BASELINE.md §8`：严格模式语义矩阵、优先级重置、审计、示例；`CONTRACTS-V2.md §5.9` 同步。

### 语义要点
- `inherit: false` + 无规则定义 = 只剩 3 条硬规则 + 兜底的「极简安全模式」，**合法**，不报错；
- 硬规则在严格模式下仍受锁定约束：不可关闭、不可降级；可追加 pattern、可提升灯色；
- 严格模式层自身的 `errors` 按该层 `settings` 判定 fatal；锁定违规一律 fatal；
- 被拒绝的层从层栈弹出，effective 保持上一次有效规则。

### 测试
- `test/rule-config.test.mjs` 23 → **30 项**：极简严格模式、只保留自定义可调规则、硬规则拒绝关闭/降级、
  严格后叠加不回退、较晚严格模式覆盖较早层、`inherit` schema、插件状态与审计事件。
- 全量测试 **487 → 494 项**（493 pass / 1 skip）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 2 个补丁位。

## v2.8.1（2026-11-02）

**主题：Umbrella 推荐基线配置 + 三层叠加 + 硬规则锁定。**

### 新增
- `defaults/umbrella-rules.yaml`：随包分发的**推荐基线**。只显式锁定 4 条规则——
  `dsh-lifecycle` / `destructive-command` / `credential-access`（red，hard-deny + non-negotiable）
  与兜底 `unknown-tool`（yellow，priority 9999）；11 条可调规则**留空 = 用内置默认**（注释里给推荐值），
  项目按需在自己的叠加层里覆盖。`package.json files` 新增 `defaults/**`。
- 分层加载（`registry.applyLayer`）：**基线 → 项目 `rulesFile` → 环境 `UMBRELLA_RULES_PATH`**（`envRulesFile` 可覆盖路径）；
  后层按 id 覆盖前层；被拒绝的层**从层栈弹出**并恢复上一次有效规则（否则坏层会污染后续 rebuild）。
- 硬规则锁定（`NON_NEGOTIABLE_TAGS = hard-deny | non-negotiable`）：不可 `enabled: false`、不可降低灯色；
  允许提升灯色 / 追加 `pathPatterns`·`commandPatterns` / 改 reason / 改 priority。锁定违规**一律 fatal**。
- 插件配置新增 `baselineFile`（空 = 随包基线；`:none:` = 关闭）与 `envRulesFile`；
  `ruleConfigStatus()` 现在返回每层 `name/file/applied/found/errors`。
- `docs/RULES-BASELINE.md`：基线内容、分层与合并、锁定语义、部署位置与加载顺序、覆盖率边界。

### 测试
- `test/rule-config.test.mjs` 18 → **23 项**：基线文件可解析且带锁定标签、三层合并顺序、
  锁定拒绝关闭/降级且整层回退、允许追加 pattern、插件默认加载随包基线、环境层叠加。
- 全量测试 **482 → 487 项**（486 pass / 1 skip）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.8 的第 1 个补丁位。

## v2.8.0（2026-11-02）

**主题：动作规则表 YAML 化 —— 内置规则 + 叠加层，按需启用/禁用/调参而不改代码。**

### 新增
- `src/lib/rule-registry.mjs`：
  - **YAML 子集解析器**（`parseYamlSubset`）：块映射 / 序列 / 引号标量 / 简单 flow 列表 / 注释；
    tab 缩进、多文档、结构错误都给出明确错误（不静默）；
  - **schema 校验**（`validateRuleConfig`）：`version` / `settings` / 规则字段 / 9 种 matcher kind /
    pattern 长度与数量上限；错误逐条给出，**不做部分接受**；
  - **正则安全启发式**（`isSafePatternSource`）：拒绝明显灾难回溯形状（`(a+)+`、`(.*)*`）与超长模式，
    `settings.rejectUnsafeRegex: false` 时可关闭（不推荐）；
  - **声明式编译器**（`compileDeclarativeRule`）：9 种 matcher（`command-pattern` / `path-pattern` /
    `path-outside` / `url-host-in` / `url-host-not-in` / `tool-in` / `pid-equal` / `always` / `never`）
    + 3 种 evidence（`pattern-match` / `list-match` / `static`）；
  - **RuleRegistry**（`createRuleRegistry`）：内置规则 + YAML 叠加，**事务化**应用
    （失败保留旧规则）；支持 `enabled:false`、`light/priority/reason/tags/category` 覆盖、
    给内置规则追加 `commandPatterns`/`pathPatterns`、声明式新规则、`resetToBuiltin`；
  - **文件加载 + 热加载**：`loadRuleConfigFile` / `watchRuleConfigFile`（`fs.watch` + 防抖，失败保留旧规则）。
- 插件 `fang-umbrella` 配置新增 `rulesFile` / `rulesWatch` / `rulesDebounceMs`；
  服务面新增 `ruleConfigStatus()` / `reloadRules()` / `applyRuleConfig()` / `ruleRegistry`。
- `createUmbrella({ registry })`：动作评分改用注册表规则（不传则沿用原规则集）。
- `docs/UMBRELLA-RULES.example.yaml`：带注释的完整示例（开关 / 覆盖 / 追加正则 / 声明式新规则）。

### 语义要点
- 内置规则**永远存在**，YAML 只是叠加层；未提及的规则保持原样；
- 优先级：`DEFAULT_RULE_PRIORITIES`（10…9999）为基线，YAML 可覆盖；同优先级按内置顺序稳定排序；
- 未知 id 默认只警告；`settings.failOnUnknownRule: true` 时整份拒绝；
- 正则编译失败：`failOnInvalidPattern: false` 跳过该条、`true` 整份拒绝；
- 热加载失败 **不得** 让评分器裸奔：先构造新数组、校验通过才替换。

### 测试
- 新增 `test/rule-config.test.mjs` **18 项**（YAML 解析、schema、正则安全、9 种 matcher、
  禁用/覆盖/优先级/追加正则、未知 id、failOnInvalidPattern 事务化、文件加载、热加载管线、
  插件接线、门面 registry 接线）。
- 全量测试 **464 → 482 项**。

> 版本策略：`x.y.z` 每一位 0–9；`2.7.9` 已满位，本次进位到 `2.8.0`（v2.8 的首个补丁位）。

## v2.7.9（2026-11-02）

**主题：把 `parseShellRedirects` 从正则升级为 shell 词法/语法解析（AST-lite）。**

### 变更
- `src/lib/umbrella.mjs` 新增 **AST-lite 词法器**（`tokenizeShell`），`parseShellRedirects` 改为在其上按语法结构提目标：
  - 重定向操作符语义化：`>` `>>` `>|` `&>` `&>>`、`<`、`<>`、`>&`、`<&`、`<<`、`<<-`、`<<<`，支持 fd 前缀（`2>` `3>>`）；
  - **fd 复制不是文件**：`2>&1` 不再被误判为「写目标 `&1`」；
  - **heredoc 正文整段跳过**（`cat <<EOF > out.txt` 只认 `out.txt`，正文里的 `>` 是数据）；
  - **引号内的 `>` 不是重定向**（`bash -c 'echo x > out.txt'` 不误抓，落 exec 规则判黄）；
  - 动态目标（`$VAR` / `$(...)` / 反引号 / brace / 通配）标记 `dynamic` 并写进 `warnings`，不当作路径；
  - 命令段边界（`;` `&&` `||` `|` `&` 括号 换行）使重定向只归属自己那段命令；
  - 隐式文件命令从 argv 取目标：`tee`、`dd if=/of=`、`Set-Content`/`Out-File`/`Add-Content`、`cat/Get-Content/type/less/head/tail/more`。
- `buildActionContext()` 新增 `parseFailed` / `parseError` / `heredocs` / `warnings`；规则据此 **fail-closed**：
  - `exec-read-only` 在解析失败时不再匹配（不宣称只读）；
  - 有 `>` 且解析失败 → `write-outside-buffer` 命中，证据 `unparsed-redirect-fail-closed`（黄）；
  - 否则 → `exec-side-effect` 的 `unparsed-command-fail-closed`（黄）。
- 未引入第三方依赖：`shell-quote` 只 tokenize 不认操作符，`@aliou/sh`（v0.3.4，MIT AND BSD-3-Clause，零运行时依赖）
  虽是合理选择但会破坏本仓库零依赖约束，因此手写只覆盖重定向提取的词法器；PowerShell 走同一词法器并如实声明边界。
- TypeScript 参考实现同步（`tokenizeShell` / 新 `parseShellRedirects` / `parseFailed` / 规则 fail-closed）。

### 测试
- `test/umbrella.test.mjs` **45 → 53 项**：操作符全覆盖、fd 复制、heredoc 跳过、引号、动态目标、命令边界、
  隐式文件命令、语法错误 fail-closed、token 结构断言。
- 全量测试 **456 → 464 项**；TS 参考实现行为断言 **76 → 95 项**。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 9 个补丁位。

## v2.7.8（2026-11-02）

**主题：动作规则表声明化 —— 与 AST 规则表同粒度（`match` / `evidence` 可独立测试）。**

### 新增
- `src/lib/umbrella.mjs`：
  - `DEFAULT_ACTION_RULES`：15 条**声明式规则**，字段统一为
    `{ id, category, light, reason, tags[], match(evidence, context), evidence(evidence, context) }`，
    数组顺序即优先级、**首个命中胜出**；规则 id / 灯色与 v2.7.6 完全一致（行为不变）。
  - `buildActionContext()`：`mode` / `commandText` / `targetPath` / `url{raw,host,hostPort}` / `targetPid` /
    `writeTargets[]` / `readTargets[]`，一次解析供 15 条规则共享。
  - `parseShellRedirects()`：`>` `>>`、`tee`、`dd of=`、`Set-Content`/`Out-File` 的写目标，
    `cat/less/head/tail/more/Get-Content/type` 的读目标；**只解析字面量**，`$VAR`/`$(...)`/通配等动态构造一律跳过
    （交给兜底规则判黄，不静默放行）。
  - `parseUrlParts()`：不依赖 `URL` 全局对象，带默认端口（http 80 / https 443）。
  - `createActionRuleSet()` + `assertActionRule()`：`register(rule, {before|after})` / `override` / `remove` / `reset`。
    注册**必须显式给位置**（追加到表尾等于永不命中）；重复 id、未知 `category`、未知灯色、缺 `match`/`evidence`
    一律在注册时抛错，不会在评分路径上静默漏判。
  - `baseLight()` 改为表驱动，返回新增 `category` / `tags` / 结构化 `evidence`（`matchedPattern` 等）；
    `assessAction` 与 `umbrella-decision` 审计记录同步带 `category` + `evidence`。
- 插件面 `fangUmbrella` 新增：`explain(evidence)`、`rules`、`ruleIds()`、
  `registerRule/overrideRule/removeRule/resetRules`。
- TypeScript 参考实现同步声明式规则表（`DEFAULT_ACTION_RULES` / `createActionRuleSet` / 上下文解析），
  编译产物上跑 76 项行为断言。

### 测试
- `test/umbrella.test.mjs` **35 → 45 项**：规则表形状/顺序/冻结、15 条规则逐条命中与证据形状、
  上下文解析（重定向/URL/相对路径/PID）、规则集注册/覆盖/移除/重置与错误分支、
  自定义规则影响真实评分与决策审计、评分调用不修改规则表。
- 全量测试 **446 → 456 项**。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 8 个补丁位。

## v2.7.7（2026-11-01）

**主题：保护伞的 TypeScript 参考实现 —— 可编译、可验证、不随包发布。**

### 新增
- `types/umbrella/`（7 个 `.ts`）：`types` / `paths` / `cache` / `plugin-scorer` / `action-scorer` /
  `umbrella` / `index` —— v2.7.6 运行时语义的**可编译镜像**。它不 import 任何 `node:` 内建模块，
  文件系统（mtime/hash）、时钟、评分服务、审计全部走注入端口，因此任意宿主只需一个 `tsc` 即可编译。
- `types/tsconfig.json`：`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` +
  `noUnusedLocals/Parameters` + `noImplicitReturns` + `noEmit`。
- `tools/release/typecheck.mjs` + `npm run typecheck`：找到编译器就**真的编译**（失败非零退出）；
  找不到就打印 `SKIP` 与安装方法并退出 0，**绝不会在未编译的情况下说 PASS**。
- `types/README.md`：编译方法（`npx tsc -p types/tsconfig.json` 或 `DSH_FANG_TSC=…`）、Node 宿主适配示例、
  `.mjs ↔ .ts` 映射、8 条与设计稿的差异、边界（无 realpath / 无 UNC / 无强制拦截）。

### 说明
- 运行时仍是纯 `.mjs`；`types/` **不进 `package.json files`**，tarball 不含它；CI 零第三方依赖策略不变
  （未新增 workflow job，也没有新增 `devDependencies`）。
- 本地证据：TypeScript **5.9.2** 严格编译 **0 error**；编译产物跑 35 项行为断言 **35/35**
  （15 条规则、两张下限表、决策矩阵、指纹缓存 / LRU / mtime 失效、审计记录形状）。
- `types/` 与运行时出现分歧时，以 `.mjs` + `docs/UMBRELLA.md` 为准，并应同步修正 `types/`。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 7 个补丁位。

## v2.7.6（2026-11-01）

**主题：保护伞系统（Umbrella）—— 一个证据管道，两个评分出口。**

### 新增
- 新增子插件 `fang-umbrella`（`src/plugins/umbrella.mjs`，loader 行 `fang-umbrella`，
  服务键 `fangUmbrella`，母体 + 分身都激活）与纯逻辑库 `src/lib/umbrella.mjs`：
  - **插件评分**：复用既有 `fang-scorer` 的 import 层扫描与 A–E 分档（不重复扫源码），
    按入口文件 `mtime`（或 inline 源码 sha1）做 LRU 缓存；拿不到 scorer 时失败往坏里判（E + degraded）。
  - **动作评分**：`green / blue / yellow / red` 四色，15 条规则（生命周期、破坏性、凭据、外连、
    动态加载、写、只读 shell、只读、未知工具），每条带 `matchedRule` 供审计追溯。
  - **耦合**：`effectiveLight = max(baseLight, gradeFloor(grade))`，等级只抬不降；
    下限表 `umbrella`（A/B 绿、C 蓝、D 黄、E 红，= 设计稿）与 `strict`（= kernel `GRADE_COLOR`）可选。
  - **决策矩阵**：`allow / mark / ask / delegate / deny`；DSH 生命周期动作委托 restart-guard
    （带 `originLight`），凭据访问是唯一硬拒绝。
  - **审计**：一次 `decideAction` 落一条 `umbrella-decision`；插件评分沿用 scorer 的 `score`，不双写。
- kernel 词汇：`SERVICE.umbrella`、`ROW.umbrella`、`LIGHT`（四色）、`LIGHT_RANK`、
  `AUDIT.UMBRELLA_DECISION`、`MATRIX.umbrella: ['mother','fork']`。
- 依赖注入：`fang-umbrella` 在 `bufferRoot` 未配置时读 `buffer-keeper` 的实时 `dir`，
  策略以函数形式传入，buffer root 变化不需要重建保护伞（缓存不受影响）。

### 文档
- 新增 `docs/UMBRELLA.md`：三层结构、两张下限表的取舍、15 条规则表与顺序、
  决策矩阵、服务面、缓存策略、与 Router/Approver/RestartGuard/HotReloader 的**接线现状**
  （含「没有工具拦截钩子，保护伞是决策库不是强制闸门」这一边界）、审计形态、校准三问、差异表。
- `docs/CONTRACTS-V2.md §5.9`：`fangUmbrella` 服务契约（输入/输出/失败语义）。

### 测试
- `test/umbrella.test.mjs` 35 项：灯色词汇、两张下限表、4×6 单调性属性、15 条规则与优先级、
  决策矩阵七行、缓存命中/失效/逐出/失效接口、失败往坏里判、等级耦合、审计、实时策略、延迟预算、插件形态。
- `test/role-extensions.test.mjs`、`test/plugins-shape.test.mjs`、`test/kernel.test.mjs`、
  `tools/e2e.mjs` 同步版本号与矩阵行数（15 → 16）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 6 个补丁位。

## v2.7.5（2026-11-01）

**主题：端口生命周期文档化 —— Adapter 复用 DSH 端口，不存在第二个 Adapter 端口。**

### 说明（设计评审结论，非代码变更）
- 设计稿提出「Forker 分配 DSH + Adapter 两个端口、写 `adapterPort`、注入 `DSH_ADAPTER_PORT`、
  AdapterServer 独立 listen、双端口 waitReady / 归还」。本仓库在 v2.6.8 已明确采用
  **单端口**方案：Adapter 的路由挂在分身自己的 DSH `webServer` 上
  （`docs/ADAPTER-COMMANDS.md §1`），没有第二个监听者，因此没有第二份端口生命周期。
- Forker 仍是唯一端口分配者：每分身 1 个池端口（18000–18100，101 个；`maxForks` 默认 8），
  失败/超时/退出/stop/reap/死孤儿六条归还路径均已有代码与测试覆盖；
  Adapter 就绪由 Orchestrator 在同端口做 `/fang/adapter/hello` 握手判定，而不是第二个端口探活。

### 文档
- 新增 `docs/PORT-LIFECYCLE.md`：端口所有权、env 契约、就绪判定、六条归还路径、
  「为什么不需要双端口」、以及未来若真要独立端口的完整改动清单与风险。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 5 个补丁位。

## v2.7.4（2026-11-01）

**主题：连接三步流程可观测化 —— version 信息 / 协议区间 / session 一致性诊断。**

### 说明
- 「GET /version → GET /state → SSE」自 v2.6.1 起已是 `createAdapterClient().connect()`
  的固定顺序（`negotiateProtocol` 先于 state，协议不兼容时不拉快照、不订阅）；
  本版本只补**可观测性**，不改变连接行为。

### 新增
- `connect()` 结果新增 `version`（最近一次 version 响应）与 `sessionMismatch` 字段；
- `client.lastVersionInfo`：version 原始响应（protocol / version / sessionId…）；
- `client.protocolRange`：本次协商实际使用的 `{min,max}`；
- `client.sessionMismatch`：version 与 state 的 `sessionId` 不一致时记录
  `{versionSession, stateSession, at}`（Adapter 在两次请求之间重启过）；
  此时仍以 state 为准续流，不重试三步（state 已是新进程的最新快照）。

### 文档 / 测试
- `docs/CONNECT-PREFLIGHT.md`：三步流程现状、可观测字段、版本兼容规则、错误处理与边界；
- `test/adapter-client.test.mjs` 新增 2 项（8 项）：version 信息/协议区间可观测、
  sessionId 不一致时记录 sessionMismatch 且 SSE 用 state 的 session。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 4 个补丁位。

## v2.7.3（2026-11-01）

**主题：重启结果事件化 —— Forker 发 `fork-restart-failed`，TaskHandle 终态 fail-fast。**

### 新增
- **事件 `fang/fork-restart-failed { forkId, error, terminal }`**（Forker）：
  - 自动重启尝试失败（`restartFork` spawn 失败）→ `terminal:false`（Forker 可能按
    supervise 计划再试）；
  - 放弃重启（`planRestart` give-up / `restart-no-cli`）→ `terminal:true`（不会再有自动重试）。
- **TaskHandle 订阅该事件**：
  - `terminal=true` → 立即 `failed`，不再等 `restartTimeoutMs`（60s）；
  - `terminal=false` → 只记日志、保持 `reconnecting`，由后续 `fork-started` 或
    `forker.status()` 轮询兜底推进（不把「还会重试」误判为终态）；
  - `taskId` 不匹配忽略；`stop()` 仍会立即打断等待（`restartSlot.finish`）。
- 既有 `waitForRestart` 的「事件优先 + 轮询兜底」保留；`fork-started` 仍是成功的完成信号。

### 说明
- 设计稿的 `fork-restarted` 对应仓库既有 `fang/fork-started`（不再新增重复事件）；
- TaskHandle 不自己挂 child `exit` handler，统一由 Forker 的 `fang/fork-crashed` 驱动，
  因此没有「attach 两次」的重复挂载问题；
- 非终态失败不 settle(false)：设计稿原方案会把「Forker 还会重试」误标成 failed，
  这里改为继续等待（见 `docs/TASK-HANDLE.md §3`）。

### 测试 / 文档
- `test/task-handle.test.mjs` 新增 3 项（20 项）：terminal fail-fast、非终态继续等、
  taskId 过滤；
- `test/forker.test.mjs` 新增 1 项（27 项）：supervise give-up 时 emit
  `fang/fork-restart-failed`（terminal=true）；
- `docs/TASK-HANDLE.md §3`：事件驱动重启流程与 terminal 语义。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 3 个补丁位。

## v2.7.2（2026-11-01）

**主题：Forker token 生命周期显式化 —— 补齐 TokenRegistry 公开面（getToken / onTokenRefresh）。**

### 说明
- token 生命周期本身自 v2.6.1 起已在 `forker.mjs` 内联实现（每次 spawn 生成、
  stop 作废、重启重生成、内存 only、env 注入）；本版本补齐设计稿 `TokenRegistry`
  的**公开 API** 并对齐命名。

### 新增
- `forker.getToken(forkId)`：`adapterToken(forkId)` 的别名；
- `forker.onTokenRefresh(handler) → disposer`：每次 `spawn()` 重新生成/刷新 token 时广播
  `(forkId, token)`；handler 异常隔离，disposer 幂等；
  - 首次派生（生成）与崩溃重启（刷新）都会触发；语义是「当前 token」，不是「进程就绪」。

### 测试 / 文档
- `test/forker.test.mjs` 新增 1 项（26 项）：onTokenRefresh 每次 spawn 广播、getToken 别名、
  异常隔离、disposer；既有 adapterToken 生命周期测试保持不变；
- `docs/FORKER-TOKEN.md`：现状、公开面、TS 形状映射、边界（含 adapterPort → webServer 复用）。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 2 个补丁位。

## v2.7.1（2026-11-01）

**主题：修复归档不生效 + 新增「读档」存档管理（还原 / 删除）。**

### 修复
- **归档失败却显示成功**：旧实现 `archiveTask` 调 `service.reap()`（停进程 + 删 home），
  且 `reap` 失败时仍返回 `ok:true`。现在归档 = **停止进程 + 保留 home**：
  - 调 `forker.stop()` 后用 `forker.alive()`（真实 PID 存活）确认进程退出；
  - 超时/停不掉 → `{ok:false, error:'stop-failed'}`，任务保持原样，不再假装归档成功；
  - 只有确认退出后才写 `status:'archived'`、`archivedAt`、清空 url/port/token。
- `autoReapIdleMinutes` 的空闲回收改回 `reap()`（删 home），不再误用归档。

### 新增
- **读档 / 存档管理**：
  - `POST /api/tasks/archive`：归档（保留 home，url/port/token 清空）；
  - `POST /api/tasks/restore`：用原 home/profile 重新 spawn（新端口/新 token）+ 握手；
  - `POST /api/tasks/archive/delete`：reap 删除 home + 记录（forker 记录丢失时按 home 兜底）；
  - `GET /api/tasks` 的 archived 任务新增 `archivedAt` / `archiveRemote` 字段。
- **面板顶栏「读档 (N)」按钮**：切换存档视图；存档卡片支持「还原」「删除存档」，
  普通右栏只保留存档提示 +「打开读档」入口。
- `forker.alive(forkId)`：真实 PID 存活判断（归档确认用，不只看 `rec.running`）。
- `archiveStopTimeoutMs` 配置（100–30000，默认 3000）。

### 测试 / 文档
- `test/orchestrator.test.mjs` 新增 3 项：归档停进程且保留 home、stop-failed 不假装成功、
  还原重新 spawn、删除存档 reap 并移除记录（21 项）；
- `docs/ARCHIVE.md`：生命周期、接口、UI、配置、兼容与边界。

> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.7 的第 1 个补丁位。

## v2.7.0（2026-11-01）

**主题：ForkSseClient（SSE 层）网络层模糊测试 —— 随机分块 + 随机断连的等价性。**

### 新增
- **`tools/fuzz/sse-client-mock.mjs`**：真实 `http.createServer` mock：
  - `/fang/adapter/version`、`/state`、`/events` 三个端点；
  - `/events` 按 `since` 过滤帧并记录 `{since, session}`；
  - plan 控制 200/401/409/410/503、`serve` 帧数、`ending`（hold/end/destroy）、心跳插入；
  - `destroy` 前等最后一个 write 回调 + 5ms，降低“数据未到 TCP 就断开”的 flake。
- **`tools/fuzz/sse-client-generators.mjs`**：事件序列（3–10 帧）、每帧 4 种切块模式、
  四类策略（无断/单断/多断/心跳）、`expectedSinceFor()`。
- **`tools/fuzz/sse-client-fuzz.mjs`**：
  - 性质：401 致命不重试；409/410 触发 `resetCursor=true` + 快照重置；心跳不产生事件；
    断连后 cursor 无重复/无空洞且 `since` 正确；
  - 随机：逐 case 配置 mock → 新 client → `connect()` → 等覆盖全部 cursor →
    比较**未去重**的 cursor 序列与请求 `since`；失败报告含 seed/iteration/strategy/
    expectedCursors/actualCursors/requests；
  - CLI `--iterations` / `--seed`。
- **`test/sse-client-fuzz.test.mjs`（3 项）**：性质测试全通过；120 次随机 fuzz 0 failures
  且四类策略均覆盖；同 seed 可复现。

### 文档
- `docs/FUZZ-SSE-CLIENT.md`：与 SseParser fuzz 的区别、MockSseServer 能力、I1–I7 不变量、
  生成器、性质测试、CLI、证据与边界。
- `docs/PROTOCOL-V3.md §11/§12`：测试与实现记录。

### 本机证据
- 200 次随机 fuzz（seed=20261110）：**0 failures**；
  noDisconnect 47 / singleDisconnect 51 / multiDisconnect 53 / withHeartbeats 49；
- 60 次：3.6s；200 次：10.8s（mock 无每 chunk 延迟，靠 write 回调保序）。

> 版本策略：`x.y.z` 每一位只能是 0–9；v2.6 的补丁位已到 9，本次进位为 **v2.7.0**。

## v2.6.9（2026-11-01）

**主题：SseParser 定向生成器 —— 为 9 个分支各构造“边界恰好命中”的最小输入。**

### 新增
- **`tools/fuzz/sse-directed.mjs`**：
  - 9 个分支、**61 条**定向用例：`cr-trimming`（8）/ `multi-line-data`（7）/
    `empty-data-dropped`（9）/ `comment-ignored`（9）/ `space-trimming`（7）/
    `field-override`（6）/ `retry-and-unknown`（6）/ `data-field-edge`（4）/ `buffer-boundary`（5）；
  - 40+ 条用例带 `expectedFrames`，锁定“只裁一个 CR / 只裁一个空格 / 空 data 帧丢弃 /
    无冒号 data 仍产帧”等精确语义；
  - `pickDirected(rng)` 均匀选分支与用例；`generateMixed(rng, { directedProb })` 按概率混合定向/随机；
  - `runDirectedSmokeTest()`：一次性解析 + expectedFrames + 6 种分块策略 × 3 种子等价性；
    支持注入 parse 函数用于 mutation 测试。
- **`tools/fuzz/sse-parser-fuzz.mjs`**：
  - `runSseParserFuzz({ directedProb, directed })` 支持混合策略，返回 `branchCounts` /
    `directedHits` / `randomHits`；失败记录带 `branch`；
  - CLI 先跑定向 smoke（61/61），再跑随机模糊，并打印分支覆盖率；
    `--directed-prob` / `--no-directed` 可调；`directedHits > 100` 时零命中分支告警。
- **`test/sse-directed.test.mjs`（8 项）**：用例完整性、smoke、expectedFrames 覆盖、
  mutation 检出（裁掉所有尾部 CR 会被抓到）、混合确定性、均匀抽样、fuzz 全定向/全随机/可复现。

### 文档
- `docs/FUZZ-SSE-DIRECTED.md`：分支表、用例设计、smoke 流程、混合策略、CLI、取舍与边界。
- `docs/PROTOCOL-V3.md §11/§12`：定向生成器测试与实现记录。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 9 个补丁位。

## v2.6.8（2026-11-01）

**主题：Adapter 命令入口的扩展面 —— 外部插件注册命令 + 413 body 上限。**

### 新增
- **`adapter.registerCommand(op, executor)`**（`src/plugins/adapter.mjs`）：
  - executor 签名 `(payload, { commandId, trackingId, emit, logger })`；
  - **同步/异步由 executor 的返回值决定**：普通对象 = 200；`{status:'completed',result}` = 200；
    `{status:'rejected',code,message}` = 失败信封；`{status:'accepted',trackingId}` = **202**，
    由 executor 异步执行并通过 `emit({kind:'command-done',…})` 推送结果；
  - `trackingId` 未显式给出时默认 `track_<commandId>`，同一 commandId 重试稳定；
  - 内置 op 不可覆盖（抛错），避免协议语义被第三方替换；disposer 后该 op 回到 `unknown-op`；
  - 仍由 `CommandCache.run(commandId, …)` 包裹：accepted 也缓存，重试不会启动第二个异步任务。

### 修复
- **body 超限 → 413**：`POST /adapter/commands`（以及 `/adapter/command`）请求体超过 1 MB 时，
  之前返回 400 `bad-request`；现在按 `ADAPTER_ERROR_STATUS` 返回 **413 `body-too-large`**，
  且 executor 不会被调用。

### 文档 / 测试
- `docs/ADAPTER-COMMANDS.md`：设计稿（CommandHttpHandler / EventLog / CommandHandler /
  AdapterServer）与本仓库已有实现的映射；为什么复用 DSH webServer 而不是独立端口；
  HTTP 状态表、SSE cursor/session 语义、命令注册示例、边界。
- `docs/PROTOCOL-V3.md §6.2/§6.4/§11/§12`：扩展命令约定与 413。
- `test/adapter.test.mjs` 新增 4 项：registerCommand 同步幂等 + disposer、异步 202 + command-done +
  重试同 trackingId、拒绝覆盖内置 op / rejected 映射、1 MB body → 413。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 8 个补丁位。

## v2.6.7（2026-11-01）

**主题：TaskHandle —— 把 fork 启动、Adapter 连接、命令代理、崩溃重建连接收进一个生命周期对象。**

### 新增
- **`src/lib/task-handle.mjs`**：`TaskHandle` 组合 Forker（进程层）+ ForkClient（传输/命令层）。
  - 状态机：`idle / starting / running / reconnecting / stopping / stopped / failed`；
  - `start()`：fork 未运行则 `forker.spawn()`（可选 spawnOptions），用 `forker.adapterToken()`
    建 ForkClient 并 connect；重复调用幂等；
  - **崩溃重建连接**：监听 `fang/fork-crashed` → `reconnecting` → 等 `fang/fork-started`
    （事件优先 + `forker.status()` 轮询兜底）→ 用**新 url + 新 token** 重建 client；
    token 由 Forker 在每次 spawn 时重新生成（内存 only），重启后不会 401；
  - **命令代理**：`command(op, payload)` + dsh-Fang 9 个便捷方法；重连窗口内最多等
    `commandWaitMs`（默认 5s），超时 reject `task-unavailable`；idle/stopped/failed fail-closed；
  - 生命周期：`stop()`（断开 client + forker.stop，保留 home）、`recycle()`（stop + reap）、
    `dispose()`（只释放本地资源，不杀 fork）；stop/recycle 幂等；
  - 事件聚合：`onEvent()` 转发 SSE 事件；`onTaskEvent()` 输出
    `status-changed / crashed / restarting / reconnected / failed`。
- **文档** `docs/TASK-HANDLE.md`：状态机、崩溃恢复流程、与 Forker 的接口约定、
  TS 形状映射、测试清单、边界（supervise 默认关闭、命令不缓冲、未接线 Orchestrator）。

### 变更
- `docs/PROTOCOL-V3.md §9/§11/§12` 增加 TaskHandle 的职责与测试列。

### 测试
- 新增 `test/task-handle.test.mjs`（17 项）；全量门禁见 `docs/AUDIT-v2.6.7.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 7 个补丁位。

## v2.6.6（2026-11-01）

**主题：分身 Web UI 模式 —— 不再把「母体 API 在分身里不存在」渲染成插件故障。**

### 修复
- **分身 Web UI 面板 404**：分身的 profile 也包含 `@local/dsh-fang` 的 client 半，所以分身页面
  侧栏会出现「瓮城」；但 orchestrator 是 mother-only，`/fang/api/status|tasks|sessions` 在分身里
  全部 404。v2.6.6 先探测宿主角色（`/fang/api/status` 200 = 母体；否则 `/fang/adapter/hello`
  200/401 = 分身），分身里只渲染一段说明卡，不再请求母体 API、不再显示「不可读」错误块。
- **分身里隐藏 dock 徽标**：不再对 `/fang/api/status` 轮询，也不显示「瓮城离线」假故障。
- **母体行为保持不变**：只有探测为 mother 后才开始刷新 `/fang/api/*`，避免启动时先打一轮 404。

### 说明
- 分身里 Adapter 路由存在但 v2.6.1+ 要求 Bearer（浏览器拿不到 token），所以角色探测把 401 也
  视为「这是分身」，不展示 Adapter 详情（避免把 401 当适配器故障）。
- 侧栏注册项无法按角色摘除，点击仍会打开说明卡；这是宿主 slot 能力的限制。

### 文档
- `docs/UI-FORK-MODE.md`：404 原因、探测规则、分身/母体行为差异、验证步骤、限制。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 6 个补丁位。

## v2.6.5（2026-11-01）

**主题：SSE 解析器独立成类 + 模糊测试（随机输入 / 分块等价 / 参考实现 / 帧边界）。**

### 新增
- **`src/lib/sse-parser.mjs`**：`SseParser` 类（行式增量解析，`push()`/`flush()`）。
  只按 `\n` 切行、行尾裁一个 `\r`（CRLF 支持）；空行切帧、无 data 帧丢弃、注释/`retry`/未知字段忽略；
  多行 data 用 `\n` 拼接；`flush()` 按 SSE 规范丢弃未完成残帧。
- **模糊测试工具** `tools/fuzz/`：可复现种子 RNG（SplitMix32 + XorShift128）、9 种输入模式、
  独立参考实现 oracle、6 种字符串分块 + 字节级切分、roundtrip、flush 不变量、失败报告（seed/hex/chunks）。
- **CI 档位** `test/sse-parser-fuzz.test.mjs`（7 项）：性质断言 + 固定种子 × 6 × 25 iterations +
  随机 seed smoke + 可复现性 + 已知 CRLF/多行/字节切分边界。
- CLI：`node tools/fuzz/sse-parser-fuzz.mjs --iterations 5000 --seed <seed>`；失败时打印可复现命令。
- 文档 `docs/FUZZ-SSE-PARSER.md`：不变量 I1–I6、结构、分块策略、复现方式、已知边界。

### 修复 / 行为变化
- **CRLF 帧边界**：旧 `createSseParser` 用 `indexOf('\n\n')` 找块边界，`\r\n\r\n` 不含 `\n\n`，
  CRLF 流会延迟到 flush 且把 `\r` 混进 data；新 `SseParser` 逐行处理，CRLF 正常切帧。
- `flush()` 不再解析残帧（SSE 规范：EOF 丢弃未完成事件）；解析器也不再把无 `event:` 的帧
  默认成 `event:'message'`（字段缺失即省略）。
- `adapter-protocol.mjs` 的 `createSseParser()` 改为 re-export `SseParser`（单一实现）。

### 测试
- 新增 `test/sse-parser-fuzz.test.mjs`（7 项）；CLI 额外跑过 5000 iterations，0 failure。
  全量门禁见 `docs/AUDIT-v2.6.5.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 5 个补丁位。

## v2.6.4（2026-11-01）

**主题：ForkClient 完整实现 —— inflight 追踪、command-done 匹配、超时兜底。**

### 新增
- **`src/lib/fork-client.mjs`**：`ForkClient` 组合 AdapterClient（传输 + SSE）与 `CommandCache`（幂等）。
  - **同步命令**：POST 返回 completed → 直接返回；同 commandId 命中缓存不重复 POST；
  - **异步命令**：202 accepted + trackingId → `inflight` Map 等待 SSE `command-done`，
    拿到终态后才写入缓存（不缓存 accepted）；
  - **command-done 匹配**：按 trackingId 匹配（trackingId 与 commandId 是两个键）；
    超时/断开后迟到的 command-done 静默忽略（debug）；
  - **超时兜底**：同步 POST 走传输层 AbortController（`synchronousTimeoutMs`）；
    异步命令用 `asynchronousTimeoutMs`（默认 120s）timer，超时 reject → 缓存移除 → 可重试；
  - **SSE 生命周期**：断开保留 inflight（cursor 补发）；`resetCursor=true`（分身重启）/
    `disconnect()`（用户主动）→ 全部 inflight reject；
  - **事件扇出**：`onEvent/onReconnect/onDisconnect`，handler 异常隔离；`state-changed` 更新快照；
  - **fail-closed**：未 connect 或已 disconnect 时命令直接 reject（`not-connected` / `disconnected`）；
  - dsh-Fang 的 9 个 Adapter op 便捷方法：ping/status/flush-buffer/score-plugin/read-plugin/
    route-confirm/approvals/approval-decide/archive。
- **文档** `docs/FORK-CLIENT.md`：TS 接口形状与 `.mjs` 映射、命令生命周期、inflight 语义、
  超时矩阵、SSE 处置规则、错误码、测试清单、边界（无 tsc、node:http 传输待实现、尚未接线）。

### 变更
- `docs/PROTOCOL-V3.md §9/§11/§12` 同步 ForkClient 实现与测试清单。

### 测试
- 新增 `test/fork-client.test.mjs`（13 项）；全量门禁见 `docs/AUDIT-v2.6.4.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 4 个补丁位。

## v2.6.3（2026-11-01）

**主题：CommandCache LRU + 幂等语义 —— in-flight 合并、失败契约、只淘汰已完成项。**

### 新增
- **`src/lib/command-cache.mjs`**：`CommandCache.run(commandId, fn)` 幂等执行。
  - 两态：`running`（value 是同一个 promise）/ `completed`（value 是结果）；
  - **并发合并**：同一 `commandId` 并发提交 → 第二次等待同一个 promise，不重复执行副作用；
  - **失败契约**：业务失败（`fn` 返回 `status:'rejected'`）与 async accepted 都缓存；
    `fn` 抛错（传输/编程错误，命令可能没执行）不缓存并移除，允许重试重新执行；
  - **LRU**：Map 插入顺序即使用顺序；`run()` 命中 touch，纯 `get()` 不 touch；
    超容量时从头部淘汰第一个 completed，跳过 running；全是 running 时允许临时超限，
    in-flight 完成后自动收敛；
  - `invalidate()` 只对 completed 生效、`clear()` 保留 running、`stats()` 暴露容量/命中/去重/淘汰/丢弃计数；
  - 容量必须 ≥1（否则 `RangeError`）；`onEvict` 回调异常被隔离；缓存不实现超时（超时属于命令层）。
- **Adapter 接线**：`commands()` 改为 `commandCache.run()`；并发同 commandId 只执行一次、
  第二个请求返回 `deduplicated:true`；只有真正执行的那一次发 `command` / `command-done` 事件；
  无 commandId 的请求仍不缓存（v2 兼容）。
- **文档** `docs/COMMAND-CACHE.md`：决策表、API、并发时序、失败契约、LRU 细节、Adapter 接线、
  测试清单、边界（单进程/不持久化/accepted 缓存）。

### 变更
- `adapter-protocol.mjs` 不再自带命令缓存实现，改为 re-export `command-cache.mjs`（避免两份幂等语义）；
- `docs/PROTOCOL-V3.md §6.2/§12` 补充 in-flight 合并与失败契约，并指向 `docs/COMMAND-CACHE.md`。

### 测试
- 新增 `test/command-cache.test.mjs`（16 项）与 Adapter 并发幂等用例（1 项）；全量门禁见 `docs/AUDIT-v2.6.3.md`。

> 版本策略：`x.y.z` 每一位只能是 0–9；本次是 v2.6 的第 3 个补丁位。

## v2.6.2（2026-11-01）

**主题：控制面板分类折叠 —— 进行中 / 已归档 / 临时 三组，进行中只先显示 7 条会话。**

### 新增
- **左栏（母体 项目 & 对话）三组折叠**：
  - **进行中**（默认展开）：只先渲染 7 条会话，其余折叠为「展开剩余 N 个」；展开后可「收起多余会话」；
  - **已归档**（默认折叠）：`session.archived = true` 的对话，按工作区分组；
  - **临时**（默认折叠）：`session.empty = true` 的空会话（没有用户消息、无法继续开发）。
- **右栏（分身 任务 & 项目）三组折叠**：
  - **进行中**（默认展开）：普通任务卡片；
  - **已归档**（默认折叠）：`status = archived` 的任务（沿用原分组，改为统一分区标题）；
  - **临时**（默认折叠）：快速派生任务（标题为 快速派生 / 双击快速派生 / 徽标快速派生 / 重试快速派生，
    空白且未继承会话）。
- **「隐藏/显示临时内容」顶栏开关**：整组隐藏或恢复临时内容；偏好写入
  `localStorage["fang.panel.showTemporary"]`（storage 不可用时只影响本次面板会话）。
- 分类判定**只用宿主已返回的事实**（`archived` / `empty` / 任务标题），不改协议、不新增接口；
  分区标题的 tooltip 写明「临时」的定义。

### 变更
- 左栏/右栏标题栏的计数补充分类明细（进行中 / 已归档 / 临时，临时隐藏时标注「已隐藏」）。
- 同一工作区同时存在进行中/已归档/临时会话时，会在对应分区各出现一次，折叠状态按分区独立记忆。
- 临时全部隐藏且没有其它内容时，给出「当前只有 N 条临时内容（已隐藏）」的空态 + 一键恢复按钮。

### 测试
- UI 层改动，无新增单元测试；`node --check client.js` 通过；全量测试与 e2e 门禁见
  `docs/AUDIT-v2.6.2.md`。视觉验收需重启宿主加载新 client 后人工确认（本机后台宿主未重启）。

> 版本策略：`x.y.z` 每一位只能是 0–9（一个次版本含 10 个小版本）；本次是 v2.6 的第 2 个补丁位。

## v2.6.1（2026-11-01）

**主题：Adapter v3 协议化 —— 版本协商 / 状态快照 / SSE 事件流 / 幂等命令 / Bearer 认证。**

> 版本策略：`x.y.z`，每一位只能是 0–9（一个次版本含 10 个小版本）。
> 本次是 v2.6 的第 1 个补丁位（`2.6.0` → `2.6.1`）；v2.6.9 之后才进 `2.7.0`。

### 新增
- **协议词汇**：`ADAPTER_PROTOCOL_VERSION=3`、v3 五条路由常量、`ADAPTER_EVENT`、`ADAPTER_ERROR_STATUS`
  （错误码 → HTTP 状态码的唯一来源）。
- **共享协议库** `src/lib/adapter-protocol.mjs`：cursor 编解码（uint64 十进制字符串）、环形缓冲 `EventLog`、
  LRU `CommandCache`、版本协商、Bearer 解析、命令信封校验、SSE 帧编解码。
- **分身侧 Adapter v3**：`GET version/health/state`、`GET events`（SSE：回放/心跳/410 cursor-expired/409 session-changed）、
  `POST commands`（`commandId` 幂等 + `async:true` → 202 + `trackingId` → `command-done` 事件）；
  审批 diff 生成 `approval-requested/approval-resolved`；进程级 `sessionId`。
- **母体侧**：`remote.mjs` 增加 `version/health/state/commands/eventsUrl` 与 Bearer 头；新增
  `src/lib/adapter-client.mjs`（`connect()` 协商→快照→SSE、断线指数退避、409/410 自动重拉快照、
  同 `commandId` 网络重试一次）。
- **Forker token 生命周期**：每次 spawn 生成 48 hex Adapter token，经 `DSH_ADAPTER_TOKEN` 注入分身；
  `adapterToken(forkId)` 只读母体内存；`stop` 即作废；不写 `forks.json` / `fang-meta.json` / `status()` / URL。
- **Orchestrator**：握手后调用 `/version` 协商并记录 `task.adapter.protocol`；`remoteFor()` 自动带 Bearer；
  协议过新时 fail-closed（不假装 READY）。
- **文档** `docs/PROTOCOL-V3.md`：接口粒度协议（定位/选型/认证/协商/状态模型/cursor/错误码/时序/测试/遗留决策）。

### 变更
- 版本 2.6.1；Adapter 路由 5 → 10（v2 五条全部保留，向后兼容）；`hello()`/`status()` 增补
  `protocol/sessionId/lastCursor` 等字段（旧客户端忽略未知字段）。
- 旧分身（无 `/version`）按 legacy 协议继续可用；旧母体（不注入 token）下 Adapter 退化为 v2 语义，不加认证层。

### 测试
- 新增 25 项：协议库 11、Adapter v3 5、AdapterClient 6、Remote v3 2、Forker token 1。
- 全量 **331 项（330 pass / 1 skip）**；门禁证据见 `docs/AUDIT-v2.6.1.md`。

## v2.6.0（2026-11-01）

**主题：Forker 完整化 —— 端口池/健康探测/崩溃退避/孤儿恢复/每分身 meta。**

### 新增
- **每分身 `fang-meta.json`**（原子写、0600）：status/pid/port/url/profile/crashCount/restartCount/lastError/时间戳；
  reap 前写入，删除 home 后不会复活目录（修复了"meta 写晚导致 home 重建"的回归）。
- **崩溃退避**：`supervise=true` 时，已就绪分身崩溃按指数退避（默认 1s/2s/4s，上限 30s、±20% 抖动）自动重启，
  最多 3 次；只重启 **ready 过** 的分身（首启失败直接如实报错，避免 loop-spawn）。
- **孤儿恢复**：`recover()` 对账持久化记录：pid 已死 → 标 crashed + 归还端口；pid 存活 → 保留（绝不 kill 别的实例）。
- **健康探测**：`health(forkId)` = 进程状态 + 回环 HTTP 探测（任何响应都算活着）；
  `probeHttpAlive` 作为纯函数可测。
- **纯函数库**：`src/lib/fork-supervisor.mjs`（backoff / planRestart / reconcileOrphans / meta 读写 / HTTP 探测）。
- 配置：`supervise/maxRestarts/backoffBaseMs/backoffMaxMs/backoffJitter/healthPath`；默认 **opt-in**（patch 行 `supervise: false`），
  因为自动重启会与 Orchestrator 的 archive/reap 生命周期竞争；需要时显式打开。

### 测试
- 新增 `test/fork-supervisor.test.mjs`（5 项）：退避边界/抖动、重启策略、孤儿对账、meta 原子读写、HTTP 探测。
- forker 服务契约新增 `health/recover`；全量 306 项（305 pass / 1 skip），e2e 45/45。

## v2.5.0（2026-11-01）

**主题：同步 / 桥接 / 混合路由三个子插件（P0 契约版，API + 纯函数 + 测试）。**

### 新增
- **角色**：`consumer`（PC 消费端）成为一等形式；矩阵 15 个插件。
- **`fang-session-bridge`（桥接）**：mother 侧只读 façade，复用 PC 宿主 `desktop-bridge.json`
  （127.0.0.1 + Bearer，端口/token 每次重读，拒绝非回环 descriptor）；
  暴露 list / events / send(1–4096B) / create，路由 `/fang/api/bridge/*`；PC 不可达时 `bridge-unavailable`。
- **`fang-session-sync`（同步）**：勾选会话导出到 staging bundle（manifest + 每文件 sha256，源只读），
  导入按工作区路径/名称精确匹配，**永不覆盖**：冲突保留 `.fork-<ts>` 副本；未匹配进 `pendingMatch`。
  路由 `/fang/api/sync/{status,export,import}`。
- **`fang-session-router`（混合路由）**：纯函数 `chooseMode`：
  跨机+实时 → `deny`；一次性迁移 → `sync`；同机+宿主在跑+bridge+实时 → `bridge`；其余 `sync`。
  路由 `/fang/api/route` 返回决策与理由。
- 历史隔离说明：PC 与 Web 的会话数据不会自动双向流动；sync 是"文件搬运"（可离线/跨机），
  bridge 是"驱动活进程"（仅同机回环）。派生 fork 的默认回退仍是文件导入（v2.4.0 的 importSession）。

### 验证
- 新增 7 个测试：descriptor 校验与 token 不泄漏、四个 bridge 调用、bundle 导出只读/冲突保留/待匹配、
  路由真值表；全量 301 项（300 pass / 1 skip）；e2e 45/45；新增 allow-list 自检门禁（29 路由、0 findings）。

## v2.4.0（2026-11-01）

**主题：母体会话数据修正 + 派生时真正继承历史 + 「瓮城」控制面板重设计。**

### 修复（母体 · 项目 & 会话）
- **创建时间**：列表此前只回传文件 mtime（并当成时间展示），现在从会话日志 header 读取真实 `createdAt`，
  API 同时返回 `createdAt/createdAtIso/updatedAt`；UI 分别显示「创建」与「更新」。
- **空会话**：没有 `user/message` 的会话标记 `empty:true`，UI 显示「空会话」标签并禁止「继续开发」，
  派生时返回 `session-empty`，不再生成只有 header 的假交接。
- **历史会话继承**：派生前构建真正的交接种子（有界多帧读取 + 对话摘录，默认 48KiB），
  并把母体会话日志**复制进分身自己的 `$DSH_HOME`**（`sessions/<workspaceKey>/<sessionId>`），
  同步写入分身的 `storages/workspace.json`，让分身原生 UI 能看到这段历史；
  日志超过 `importMaxBytes`（默认 32 MiB）时如实标记「仅交接摘要」。
- 之前 `fang-seeds/*.md` 只写不读（注释称"fork reads it"，实际无消费方），现改为种子+历史导入双轨，
  派生响应返回 `importedSession` 供 UI 如实展示。

### UI（控制面板重设计）
- 3:7 分屏保留；新增品牌/状态/主操作分层、会话搜索、分组折叠、两栏回顶、选中条两段式。
- 会话标题来源感知：`session/title` → 原生标题；`preview` → 首条消息；缺失 → 「未命名会话 + 短 ID」，
  绝不拿工作区名冒充标题。
- 任务健康拆成生命周期/适配器两枚徽章；`running + adapter 失败` 标记异常（僵尸分身），
  错误带 code/中文原因/诊断/就地重试；分身会话读取失败只影响该卡。
- 响应式 ≤980px 单列堆叠、键盘可达、对比度 ≥ WCAG AA（详见 `docs/UI-瓮城入口.md`）。

### 测试
- 新增：真实 `createdAt`（非 mtime）、空会话拒绝、`seed()` 对话摘录、派生导入会话日志与 workspace 索引。
- 全量 294 项（293 pass / 0 fail / 1 skip；skip 为手动容器探针）。

## v2.3.1（2026-11-01）

**主题：npm 包名改为 `@twinsearth/dsh-fang` + 修复 CI 上的 watchdog 取消。**

### 变更
- npm 发布包名：`@twinsearth/dsh-fang`（scoped、公开、AGPL-3.0-or-later）；构建时
  `@local/dsh-fang` 统一改写为 `@twinsearth/dsh-fang`，tarball 仍为 `dsh-fang-<ver>.tgz`。
- 注册表 PUT 路径/tarball URL 按 scoped 规则编码（`@twinsearth%2Fdsh-fang`）；healthz 远端检查同步。

### 修复
- restart-guard 的审批 watchdog 定时器不再 `unref()`：挂起审批时事件循环必须保持存活，
  否则 Node 测试调度器会在 1s 定时器触发前判定事件循环已结束并 `cancelledByParent`
  （CI Windows node 22 实测 8 个用例被取消，本地 node 24 偶发不复现）。
- release workflow 修复：`secrets` 不能用于 job 级 `if`，改为 step 级检查 + `workflow_dispatch`。

## v2.3.0（2026-11-01）

**主题：8 步发布流水线落地 —— 以 npm 与 GitHub Release 为主，验收门禁可执行。**

### 新增
- **验收门禁** `tools/release/preflight.mjs`：版本三处一致（package/FANG_VERSION/CHANGELOG）、许可矩阵、
  全量测试、可选 `--e2e`；结果写 `dist/preflight.json`，GREEN 才能继续。
- **构建** `tools/release/build.mjs`：零依赖、用系统 tar 产出 `dist/dsh-fang-<ver>.tgz` + `dist/manifest.json`
  （sha256/大小/条目/包清单）；staged 包名统一为 `dsh-fang`，`@local/dsh-fang` 自动改写。
- **healthz** `tools/release/healthz.mjs`：解包校验 + kernel/plugin 可加载；`--remote` 核对 npm 与 GitHub Release；
  `--serve` 暴露 `/healthz`。
- **npm 发布** `tools/release/publish-npm.mjs`：本机无 npm CLI 也走 registry REST API 发布（token 只从 env/文件读取，不打印）。
- **Docker**：`docker/Dockerfile` + `docker/healthz-server.mjs`，发布健康镜像（`/healthz`，含 HEALTHCHECK）。
- **工作流**：`release.yml`（tag → test → build → npm → GitHub Release → docker → healthz）、`compat.yml`（Node 22/24 导入兼容）。
- **验收文档** `docs/ACCEPTANCE.md`（8 道门禁与已知边界）。

### 修复
- GitHub Actions 功能测试改为 **windows-latest**（本产品依赖 junction/taskkill/AppContainer），许可门禁留在 ubuntu；
  清掉最后几处本地绝对路径字符串。

### 发布
- npm 包名：`dsh-fang`（unscoped，公开发布，AGPL-3.0-or-later）；
- GitHub：`TwinsEarth/dsh-fang`（public）、`TwinsEarth/dsh-fang-private`（private），tag `v2.3.0` 起由 `release.yml` 自动发布。

## v2.2.0（2026-11-01）

**主题：控制面板 3:7 水平分屏 —— 左「母体项目 & 会话」，右「分身项目 & 会话」。**

### 新增
- 控制面板改为 **3:7 网格**：左栏母体（按 workspace 分组的项目 + 会话），右栏分身
  （每个任务一个项目，展开即该分身自己的会话列表）；两栏各自独立纵向滚动
  （`overflowY:auto` + 视口高度上限），条目多时不再撑长页面。
- 新增母体 API `GET /fang/api/tasks/sessions?taskId=` + orchestrator `listForkSessions()`：
  只读分身自己的 `<forkHome>/sessions`，有界解帧（≤32 帧 / 1MiB）提取会话标题，失败如实降级。
- 左栏会话点选 → 两段式「继续开发 →」（派生新分身 + lineage 种子）；
  右栏分身会话点选 → 「打开分身 →」；右栏每个项目保留 打开/归档。
- 右栏默认展开全部项目，可逐个折叠；会话标题沿用 v2.1.1 的原生标题 + 来源标注。

### 测试
- orchestrator：`listForkSessions` 读取分身会话日志与工作区索引、标题/来源/preview、未知任务。
- e2e：创建任务后写入一份分身侧多帧会话日志，断言
  `GET /fang/api/tasks/sessions` 返回原生标题。

## v2.1.1（2026-11-01）

**主题：会话可辨认 + 分身不再"派生出僵尸"。**

### 新增
- 会话标题：从会话日志的有界多帧读（`session/title` 事件）提取原生标题；
  无原生标题时退化为"首条用户消息预览"，再退化才用工作区名。API 返回 `title/titleSource/preview`
  （来源如实标注：`session/title` / `first-user` / `workspace`）。
- 控制面板会话行显示真实会话名（长标题截断 + 完整 title 提示），下方标注来源与工作区。

### 修复
- **分身僵尸**：orchestrator 的模板解析改为"只选一个真的装了本 bundle 的 profile"，
  并在 provision 后校验 `<forkHome>/profiles/<p>/node_modules/@local/dsh-fang`；
  解析不到 bundle 时直接回收（`fork-bundle-unavailable`）而不是派生出一个
  `/fang` 全部 404、adapter 永远 `http-404` 的僵尸分身。
- `cordis.patch.yml` 移除了遗留的 `motherProfile: web`（它把分身模板指向了没有 Fang 的 web profile，
  正是上面僵尸分身的根因）。
- 标题提取有界：最多 64 帧 / 2MiB 压缩预算，超出如实 `frame-limit` 降级，绝不整文件解压；
  标题按 `mtime+size` 缓存，列表刷新不重复解帧。

## 协议分层（2026-11-01，不改变运行时行为）

**主题：AGPL 核心 + MIT 生态 + 商业闭源的许可分层，以及"不赌解释"的边界文档。**

### 新增
- `LICENSE-CORE`（AGPL-3.0 全文，gnu.org 原文 34,523 bytes）、`LICENSE-SDK`（MIT）、
  `LICENSE-COMMERCIAL`（商业许可草案：评估/生产/OEM 三档 + 占位价格）。
- `CLA.md`：贡献者许可协议，含**永久不可撤销的再许可/双许可授权**（商业双许可路径的法律前提）。
- `NOTICE`：逐目录/逐文件许可地图 + 第三方归属；`LICENSES/cordis-MIT.txt`。
- `docs/LICENSING.md`：决策（为什么 AGPL 而非 BUSL/SSPL）、Open Core 与双许可、收入结构、
  **AGPL 与 MIT 的 DSH 兼容边界分析**（推荐 fangd 独立进程 + MIT bridge 的迁移路径）。
- `sdk/`（MIT）：插件模板 + 调用 `/fang/api/status` 的示例插件；`relay-server/`、`enterprise/` 商业占位。
- 全仓源码 `SPDX-License-Identifier` 头（核心 64 个 AGPL、生态 MIT、vendored cordis MIT）。
- `test/licensing.test.mjs`：许可文件/分层标注/package.json 许可/第三方归属的回归测试。

### 注意
- 版本仍为 2.1.0（许可证变更不改变运行时行为）。
- 发布前必须替换 `NOTICE`/`LICENSE-COMMERCIAL`/`CLA.md` 中的主体、邮箱、价格占位，
  并由律师审阅；这不是法律意见。

## v2.1.0（2026-11-01）

**主题：把「瓮城」做进 Harness Web UI，并让门户能"选中已有会话 & 任务继续开发"。**

### 新增
- **左侧导航「瓮城」**（`sidebar.panellist` id=fang order=90）：图标 = 红色城门组件
  （瓮圈红色 `--fang-gate-accent` + 门洞 currentColor + 门基），单击由外壳切到面板。
- **双击快速派生**：图标 / dock 徽标双击（400ms 窗口、6px 容差、2s 冷却、单飞）→
  POST /fang/api/derive → 打开带 token 的分身标签页；弹窗被拦时面板内给「打开分身 ↗」。
- **中列面板 `main` key='fang'**：任务 + 母体已有会话的「选中 → 确认 → 继续开发」两段式；
  状态/离线/空态/加载态显式呈现。
- **母体只读会话目录**：新插件 `fang-session-catalog`（mother-only，只读 fs）+
  `src/lib/session-format.mjs`（多帧 zstd 有界头读、脱敏、digest ≤32KiB、id 不透传路径）；
  路由 `GET /fang/api/sessions`、`/sessions/item`、`/sessions/head`。
- **lineage 种子**：`orchestrator.derive({sessionId})` → catalog.digest → 写入分身
  `<forkHome>/fang-seeds/<seedId>.md` → createTask；`taskView.seed` 暴露来源与大小。
- `POST /fang/api/derive`（标题 + 可选 sessionId）；`normalizeSeed()` 64KiB 上限、超限抛错。

### 变更
- 版本 2.1.0（package / kernel FANG_VERSION / e2e 断言）。
- 角色矩阵新增 `sessionCatalog: ['mother']`（12 行）。
- 客户端半重构：三个槽位登记（导航/面板/徽标）共用一份 client.js，颜色改用 `--dsw-alias-*` 回退链。

### 已知边界
- 导航行点击归外壳，双击热区只能是 18px 图标本身（dock 徽标是更大的目标）。
- 会话继续是 lineage + 有界摘要，不复制 transcript、不挂载母体会话目录（母体不可变）。
- v2.1 需母体重启 + 页面刷新才生效（ESM/客户端 bundle 缓存）。

## v2.0.0（2026-11-01）

**主题：从「1 编排器 + 9 子插件」升级为「母体大脑 + 分身器官 + 容器兜底」三层部署。**

### 新增
- **Adapter 插件（第 11 行，`fang-adapter`，仅分身）**：跨进程桥。HTTP 端点
  `/fang/adapter/{hello,status,approvals,audit,command}`；命令 ping/status/flush-buffer/
  score-plugin/read-plugin/route-confirm/approvals/approval-decide/archive。
- **Remote 客户端（`src/lib/remote.mjs`）**：母体侧调用分身的纯模块，统一 `{ok,kind,error}`，永不抛。
- **角色矩阵与 `roleGate`（`src/kernel/role.mjs`）**：11 个插件按 mother/fork 激活；
  同一 bundle 同时装进母体与分身，运行时决定。
- **任务语义**：`createTask / listTasks / getTaskStatus / promoteTask / archiveTask`，
  HTTP `/fang/api/tasks*`；v1 的 fork/reap/listForks/promote 保留为兼容别名。
- **端口池（18000–18100）**：Forker 确定性分配并校验 URL 端口；占用表持久化、启动回收。
- **干净分身模板**：`ensureTemplate()` 生成 base+web-app+bundle 的最小 profile，不再继承母体脏 profile。
- **Router 双阶段**：`decide`（母体初判）/ `confirm`（分身复核，只升不降，deny 不可推翻）。
- **Scorer 环境阈值**：`thresholds.{mother,fork}` + `basis{environment,thresholds,note}`。
- **Auditor 汇总**：`aggregate({limit,sources})`；分身独立落盘、母体按需拉取。
- **Approver 双侧语义**：`scope`、`requestPromotion/requestRestart`、`summary({remotes})`。
- **容器兜底**：`src/lib/container`（AppContainer 执行器 + 申报写代理 + NDJSON 帧）；
  BufferKeeper 追加 proxyState/setDeclared/proxyWrite/proxyLog。
- **商用钩子**：`src/kernel/extensions.mjs`（collaboration/git/backup/tokenApi/teams），默认关闭、无 provider 即 no-op。
- **e2e 脚本 `tools/e2e.mjs`**：临时 `$DSH_HOME` + 真实 dsh 母体 + 真分身全链路验收。

### 变更
- `FANG_VERSION` 与 `package.json` 版本 → `2.0.0`。
- 所有插件 apply 首行 `roleGate()`：未部署角色不注册服务/定时器/路由。
- 旧测试按新矩阵固定角色（fork-only 插件测试置 `DSH_FANG_ROLE=fork`）。
- `orchestrator` 模板默认 = 当前 profile；fork 的 role 由 `DSH_FANG_ROLE` 注入，防止分身自升为母体。

### 修复（v1 遗留）
- 宿主 `approval` 行被误禁用 → 恢复，permission-presets/auto-review/gpw 的 pending 告警清零。
- `node --test test/` 在 node v24 不可用 → 统一为 `node --test --test-concurrency=1 "test/*.test.mjs"`。
- 客户端半注册根因（loader 行必须是裸包名）已固化在 patch 与预检测试里。

## v1.0.0（2026-11-01）
- 首次整合：单包 `@local/dsh-fang`、10 个插件行、共享 kernel、141 项测试、门户与 dock 徽标、
  真实 fork/reap 机制验收、审计链与 A/B 审批。
