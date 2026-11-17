# AUDIT v3.5.0

范围：**加速分身（Accelerated Fork）P0 地基 + P1 开关与运行 + P2 兼容与文档**。
基线：v3.4.2（`708ad4a`）。分支：`feat/accel-p0`。**未打 tag、未推送、未发布。**

## 1. 目标与边界（用户确认）

| 对象 | core |
|---|---|
| 桌面客户端 / 母体宿主 | 原厂，不加速 |
| 元主运行态 | 原厂，**强制**（源码守卫） |
| 分身 Web | 原版 / 加速版，母体面板开关切换 |

旧「加速模式」侧车（第二个母体 Web）下线，`/fang/api/accelerated/status|start|stop` 移除（路由 88 → 86）。

## 2. 变更清单

### P0 地基

| 文件 | 内容 |
|---|---|
| `src/lib/accelerated-install.mjs` | 安装到 `<FANG_HOME>/accel/cli` + `state.json`；只接受 `lib/bin.js`（拒绝 `.cmd` shim）；解析链 config→`FANG_ACCEL_CLI`→state→标准位置；缺失即 `accelerated-cli-missing` |
| `src/lib/accelerated-fork.mjs` | 极简 profile（base+web-app+fang 三 bundle 恒定）；fang/子插件 junction；模型 overlay（`@deepseek-ai/dsh-`→`@twinsearth/dsh-`）；不覆盖非本工具生成的 home patch |
| `src/plugins/forker.mjs` | `provision({coreMode})` 加速分支；`spawn` 按 coreMode 解析 CLI、缺失即失败；跳过 fork-seed / 官方 node_modules 镜像 / 官方 headless overlay；`publicFork.coreMode` |
| `src/plugins/orchestrator.mjs` | 加速侧车路由下线；essence provision+spawn 显式 `coreMode:'stock'` |
| `tools/release/accelerated-install.mjs` | 安装 CLI + **1 GiB 体积门禁**：`>1 GiB` 必须二次确认（TTY 提示 / `--confirm-oversize`），未确认不写 `state.json`；`acceleratedCoreInfo` 暴露 `sizeBytes/limitBytes/requiresConfirmation` |
| `tools/release/accelerated-fork-smoke.mjs` | 真实加速分身 smoke（7 检查） |
| `test/accelerated-{install,fork,fork-live}.test.mjs` | 单测 + `FANG_ACCEL_LIVE=1` 真机 live |

### P1 开关与运行

| 文件 | 内容 |
|---|---|
| `src/lib/fork-core-settings.mjs` | `<dataDir>/fork-core.json`（mode/sessionMode/updatedAt/updatedBy），原子写，损坏降级 stock+new |
| `src/plugins/orchestrator.mjs` | `GET/POST /fang/api/fork-core`（同路径经 `routeMethods`，避免二次 register 抛错）；createTask/归档还原/autostart 按设置传 coreMode；**重新打开时按开关重新 provision（非热更新）**；加速缺失错误透传 `accelerated-cli-missing` + `searched`；`taskView.coreMode` |
| `client.js` | 母体头部 `M-09`「分身Core核心加速引擎：官方 / 一键加速」开关（切换提示需重新打开分身 Web）；分身卡「加速核」徽标；刷新轮询 `/fang/api/fork-core` |
| 会话策略 | `sessionMode:'new'`（默认）只建新会话；`sessionMode:'copy'` 允许导入旧会话但只复制成新副本进分身 home（绝不原地挂载）；`inherit` 归一为 `copy` |
| 未安装 fail-closed | 点「一键加速」→ 明确 `accelerated-cli-missing`（设置未改变）；服务端 POST 返回 409 + `unchanged:true` 且不写设置；GET `effectiveMode:null` + `blocked`，不做静默 stock 降级 |

### P2 兼容与文档

- `docs/ACCEL-FORK-COMPAT.md`：核心/官方 bundle/第三方插件兼容矩阵（含未验证项）；
- **D2 混合插件面（alias/shim）**：`accelerated-fork.mjs` 新增 `translateBundles` / `scanDeepseekSpecs` / `writeAliasStubs` / `buildSyncedAcceleratedProfile`；`writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})` 同步原身插件面并返回 `sync`（mapped / unsupportedBundles / copiedPlugins / alias）；`task.acceleratedSync` 暴露给任务视图；真机验证 0 导入失败（57 alias resolved / 8 unsupported / 5 pending 服务等待）；
- **LSP 真实 provider 调研**：`docs/LSP-PROVIDER-RESEARCH.md`（官方可选包族版本矩阵、`ctx.lsp` 查询 API 无需 Agent Session、4 只读操作、安装/合规风险与开放决策；实测本机无 LSP 服务器）；
- **UI client half spike**：`npm run spike:ui-client`（真实 synced 加速分身；87 client 入口、第三方 bundle 200、scope-alias 缺口证据）→ `docs/UI-CLIENT-HALF-SPIKE.md`；修复 `accelNodeModulesRoot`（forker 同步插件面 alias 依赖它，含单测）；
- `npm run probe:mother`（`tools/release/mother-capability-probe.mjs`）：生产母体能力探测（`sessionCatalog` READY 证据：`/fang/api/sessions` 200 + 真实会话项；生产 3.4.2 重启 3.5.0 后复测 delegation 方法）；
- **M1 能力注册表**：`CAPABILITY_CATALOG`/`DEFAULT_READ_ALLOW` + hello 广告（按注册 handler）+ 白名单/错误码表/版本裁剪/payload 上限单测（`test/contract-registry.test.mjs`）；**contract SDK 升到 1.2.0（仅追加：3 委托方法 + 7 委托错误码 + METHOD_VERSION）**，vendored `src/contract` 从 contract 仓库重新同步（8 文件 sha256 钉死，vendor-sync 绿色）；
- `tools/release/accel-alias-spike.mjs`：可复现的 alias 覆盖率量化工具（baseline 2/4 失败 → 桩包后 4/4 激活）；
- `tools/release/accel-plugin-smoke.mjs`（`npm run smoke:accel-plugins`）：逐插件功能冒烟——synced profile 真机启动、activated/pending-service/failed-import 分类、host 页面与 `/fang/adapter/identity` 探针；真机结果 3/3 激活 + identity `{role:'fork', version:'3.5.0'}`；
- `docs/ACCELERATED-FORK.md`：P0+P1 全量说明、安装/验证/限制；
- `docs/CHANGELOG.md`：v3.5.0 段；
- 本审计；
- `package.json` `test:accel-live` 脚本。

### 发布后（Unreleased）：B-6 LSP 真实 provider 接入（路线 A 先行）

- **决策落地**：来源 = bundle 依赖 npm `typescript-language-server` + `typescript@5.9.3`；A+B 都装、能力目录区分；workspaceRoot = 母体配置根 + 所有 fork 工作区根（显式登记）+ realpath 校验 + 审计；写类 LSP 不提供；母体 Agent 同时挂 `dsh-tool-lsp`；
- **`lsp-provider/` 配置型 bundle**（`@twinsearth/dsh-fang-lsp`）：依赖官方三件套 0.2.2-rc.3 + 语言服务器；patch insert 挂 seam/provider/tool；`test/lsp-provider-bundle.test.mjs` 3 项完整性断言；
- **fang 委托层**：`collectForkWorkspaceRoots` / `resolveLspAllowedRoots` / `lspAuditRecord`（workspaceRoot/outcome 审计 trail）；配置 `contract.delegate.lsp.allowedRoots` + `includeForkWorktrees`；
- e2e `--lsp` **124/124**：TS 双文件 fixture 真实 definition/hover/**references 跨文件解析**、fork 工作区根自动登记后可查询、越界根 `contract-unauthorized`（root-not-allowed）、文件逃逸 `contract-invalid-request`（file-outside-root）、审计 ok/denied trail。
- **3.1 母体侧实现口径落地**：参数 0-based 非负整数（seam 原生坐标透传）、workspaceRoot 必填+realpath 校验（越界→contract-invalid-request）、结果归一化 `{path,line,character}`(1-based)/`{contents}` + maxLocations/maxResultChars 裁剪（truncated）、审计/并发/超时复用 M5；e2e --lsp 124/124、默认 118/118。
- **B-6 契约口径修订**：目录只 advertise provider 实提供的 4 个只读操作（无 provider → 空 actions）；diagnostics 对外零宣称（测试缝结果 `testSeam/nonProduction` 标记，目录 `provider.nonProduction`）；写类从官方语义移除但保留通用审批门禁路径；错误码映射固定（LSP_UNAVAILABLE→contract-unavailable；LSP_FILE_OUTSIDE_WORKSPACE/LSP_INVALID_PROVIDER→contract-invalid-request；LSP_MALFORMED_RESPONSE/LSP_SERVER_ERROR→contract-unavailable，附 detail）；单测 5 组映射断言。
- **M3.5 语言服务器锁定（已落地）**：`typescript-language-server@6.1.0` + `typescript@5.9.3` + 官方三件套 `0.2.2-rc.3` 精确锁定；`LOCKED-VERSIONS.json` ↔ package.json 一致性测试（bundle 测试 4 项）；setup 脚本钉死 tls 6.1.0；锁版本后 e2e --lsp 124/124、test:lsp-bundle 5/5。**路线 B 再评估：暂缓**（保留 forkLsp 探测；不安装、不默认启用；触发条件/风险见 RESEARCH §6.2）。
- **M3.2 母体 LSP 栈原型（已验收）**：`npm run test:lsp-bundle`（`tools/release/lsp-bundle-install.mjs`）在临时测试 profile 安装 bundle 并真机 boot：5/5 PASS（bundle 链接 / boot banner / `ctx.lsp` 存在且 query 可用 / tools 服务可见 / knownNames 含 `lsp`）；不写用户 profile。

- `src/lib/lsp-provider.mjs`：契约四动作 → 官方 `ctx.lsp.query`；1-based→0-based；locations/hover 归一化；seam 错误码映射；`workspaceRoot` 显式 + `contract.delegate.lsp.allowedRoots` realpath 包含校验（空=拒绝）；
- `src/lib/lsp-delegation.mjs`：对齐官方只读口径（4 动作）；legacy diagnostics/format/rename → `contract-unsupported`；位置必填；
- Orchestrator：母体 `ctx.lsp` 优先（`provider:'mother-lsp'`），测试缝保留，未安装时 `contract-unavailable`；`fang.capability.list` 增加 `provider`/`lspProvider`（按 provider 区分、available=false 显式）；
- 路线 B（增强，口径已定）：`detectForkLspSupport(accelNodeModules)` 探测 `@twinsearth/dsh-lsp*`，暴露 `forkLsp` 并传播进任务记录 `accelerated.forkLsp`；**fork-local 不走契约委托**（契约不新增方法/错误码，能力目录不 advertise fork-local，避免虚假宣称）；安装默认关闭，待语言服务器来源决策；
- 测试：`test/lsp-provider.test.mjs` 7 项 + `test/lsp-delegation.test.mjs` 5 项；e2e 测试缝 **118/118**；**真实 provider 闭环** `npm run test:lsp-live`（**e2e --lsp 119/119**：definition/hover 走真实 `ctx.lsp`、provider=mother-lsp；diagnostics 真实 provider 下只在测试缝可用并被可读拒绝；staging 安装走 `npm run setup:lsp-live`，不写用户 profile）。

## 3. 验证证据（本机实测）

```
accelerated-install 单测             10/10
accelerated-fork 单测                9/9
fork-core-settings 单测              8/8
accelerated-fork-live（FANG_ACCEL_LIVE=1）  pass（forker 真派生：identity role=fork, version=3.5.0）
accelerated-fork-smoke               7/7（banner/identity/client.js/core 版本/非 stock CLI）
tools/e2e.mjs                       117/117（含 4 项 fork-core 契约断言 + 3 项 B 契约基线 + 14 项 B 委托：白名单目录 / contract-unsupported 拒绝 / 只读委托成功 / contract-unavailable 映射 / session.events 有界读 / contract-timeout 超时 / lsp diagnostics 成功 / 写类 contract-approval-required / 非法 action contract-invalid-request / chat.import dryRun 一致 / 真实导入 contract-approval-required / 并发 contract-rate-limited / 委托审计完整性 / 审计 outcome 覆盖 / P2 pro 能力默认拒绝）
allow-list self-check               110 路由 findings=0
main-city source gate               grade=A blockers=0
```

真实安装：`@twinsearth/dsh 3.5.0` → `<FANG_HOME>/accel/cli`（651 包；安装 8 分钟实测）。

## 4. 已知限制

1. 真实模型对话未做端到端验证（仅配置层 `mismatch=0`）；
2. 加速分身默认不带第三方插件、不带官方可选 bundle（见兼容矩阵）；
3. 旧会话继承（`sessionMode:'inherit'`）未经格式兼容验证；
4. 开关只影响新派生/重启；运行中分身不热切换；
5. `approver` 文件桥 ACL 门禁在宽 ACL 的临时目录会按设计禁用桥——测试改为显式 `bridgeAclCheck:false`（功能测试），生产默认仍开启。

## 5. 发布状态

- 版本：3.5.0（开发完成，未发布）；
- 路由契约：86；
- **D2 下一阶段**：B（无头能力契约委托）与 UI client half 浏览器映射已立项（`docs/D2-NEXT-PHASE.md`），**不阻塞 v3.5.0 发布**；
- 未执行：push / tag / GitHub Release / npm publish。发布需用户明确指令并走主城门禁。
