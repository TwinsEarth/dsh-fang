# Fang v3.9.9 审计记录

日期：2026-11-27
工作树：`E:\DBH\fang-git-392`（分支 `release/v3.9.5`，基线 HEAD `5a5d908`）
主题：安全收口版：权限第二道门、内存/身份回收、发布工具链、P3 结构门。

## 一、范围

本版不是新功能版，而是把 v3.9.8 之后审计出的高风险链路真正接进生产，并给结构性残余加上可执行门禁：

- `permissions.mjs` 第二道门从“有函数”变成 orchestrator/adapter 生产入口执行；
- 内存看门狗、托管浏览器、accelerated-web 的 PID 操作统一做身份复核，身份缺失 fail-closed；
- npm 发布不再把 HTTP 202 当成功；tag 必须落在最终 docs commit 上；
- `compose`/`index`/`watchdog-sidecar` 补直接 smoke；
- 461 处“空 catch”加按文件基线门，不批量替换；
- 14 个未被 `src` 引用的模块逐个裁定，删除候选不在本版删除。

## 二、权限第二道门

### 设计

- `ENV_TYPE.HOST`：母体宿主，`installPlugins=true`、`openSessions=true`。
- `RUNTIME_ENV_BY_ROLE = { mother: 'host', fork: 'derived', consumer: 'derived' }`。
- `resolvePermissionEnv({ envType, role })`：显式 `host/mirror/essence/derived` 优先；`auto`/空值按运行时角色映射；非法值 `unknown`，fail-closed。
- `PERMISSION_ROUTE_ACTIONS`：写路由 → `task-enqueue` / `plugin-install` / `plugin-uninstall` / `plugin-set`。
- `PERMISSION_ADAPTER_OP_ACTIONS`：`fork-session → session-create`、`archive → task-enqueue`。

### 生产接线

- `src/plugins/orchestrator.mjs`：生产 import `permissions.mjs`；Config 新增 `permissionEnv`（`auto/host/mirror/essence/derived`，默认 `auto`）；`roleGate` 之后、路由 handler 之前调用 `enforcePermission`，只拦 POST/PUT/PATCH/DELETE。
- `src/plugins/adapter.mjs`：生产 import；Config 新增 `permissionEnv`；`command()` 在已知 op 校验后、executor 前调用 `checkPermission`。
- 拒绝统一 `403 { ok:false, code:'permission-denied', action, envType }`；orchestrator 写 `permission-denied` audit。
- 默认 `auto` 保持母体 `host`、fork `derived` 的既有行为；显式 `mirror/essence/derived` 才收紧。

### 验证

- `permissions.test.mjs` 11/11。
- `permissionEnv=mirror` 下 orchestrator 写路由 403、adapter `fork-session`/`archive` 被拒，`ping` 不受影响。

## 三、内存与身份回收

### memoryKill 孤儿

- 身份不匹配时不再只 audit；保留 `task.orphan`（`pid`、捕获时 `identity`、`pids`、`source`、`status:'unresolved'`），任务标 FAILED，清运行态 pid/port/url。
- `taskView` 在 `task.orphan.status === 'unresolved'` 时不显示 running，避免 forker 记录仍活着导致面板假绿。
- 新增 `POST /fang/api/tasks/reprobe` → `service.reprobeTaskOrphan()`；面板显示“孤儿待回收”。
- `reclaimOrphan(task, {source})`：先调用 `forker.stop()`，再读根 PID；仍匹配才 `killProcessTree`；根 PID 已复用则标 `reclaimed` 并记 `rootPidReused=true`，不杀无关进程。
- 启动/每 5 分钟 `cleanupOrphanForks` 重试回收。
- 权限映射 `/api/tasks/reprobe → task-enqueue`。

### 托管浏览器 close

- `src/lib/browser-guard.mjs` 无 `startedAt`/`commandLineHash`/`tokens` 任一指纹直接 `identity-required`，不触 CDP、不 taskkill。
- `launchManagedBrowser` 先写 `spawn-provisional` 指纹（`--user-data-dir`、`--remote-debugging-port`），异步 CIM 捕获后替换为完整指纹。
- orchestrator 两个关闭点统一 `browserCloseIdentity(browser)`；旧记录无指纹 fail-closed。

### accelerated-web

- `start` 复用前、`status` 查询、`stop` 前都接入 `verifyStateIdentity`。
- 不匹配的 PID 不 taskkill；`status` 不报 running，返回 `identityOk:false`。
- 旧状态用 `--profile`/`--port` argv tokens 复核；仍不匹配 `accelerated-identity-mismatch`。
- `test/accelerated-web-identity.test.mjs` 4/4。

## 四、发布工具链

### npm 202 语义

- `tools/release/publish-npm.mjs`：200/201/202 统一先打印 `SUBMITTED ... (HTTP xxx)`。
- 轮询 `https://registry.npmjs.org/<pkg>/<version>`，只有读回同一 `version` 才打印 `PUBLISHED`。
- 超时打印 `UNCONFIRMED`，退出码 3；提示“202=已受理，重试前先复查”。
- 轮询参数：`NPM_PUBLISH_CONFIRM_ATTEMPTS=12`、`NPM_PUBLISH_CONFIRM_BASE_MS=5000`，cap 30s。

### tag 早于 docs

- `tools/git/verify-release.mjs` 新增 `--at-head`：断言 `tag^{commit} == HEAD`，并比较 tag 内 `docs/AUDIT-v<版本>.md`、`docs/RELEASE-v<版本>.md`、`docs/DSH-ARCHITECTURE-MAP.md` 与 HEAD 内容。
- `tools/release/release-order.mjs` 在本地存在 tag 时自动检查 tag 指向 HEAD，且 docs 内容一致（CRLF/LF 归一化）。
- 历史 `v3.9.8` tag 不在本版移动；本版流程改为“先提交最终 docs，再打 tag”。

## 五、P3 结构性收口

### 入口 smoke

`test/p3-structural-smoke.test.mjs` 3/3：

- `src/compose.mjs`：嵌套 Config 拒绝 `forker.maxForks=99`；`_modules` 恰好 17 个插件且都有 `apply()`。
- `src/index.mjs`：包根 `name`/`Config`/`apply`/`inject` 与 orchestrator 入口一致。
- `src/lib/watchdog-sidecar.mjs`：临时 `watchdog.json`（`stop:true`）真实拉起，断言 `stopReason=host-clean-stop`、`stoppedAt`、无 identity target 记 `target-identity-missing`，不触 taskkill。

### 空 catch 基线门

- 新增 `tools/gate/empty-catch.mjs` + `empty-catch-baseline.json`；`npm run audit:empty-catch` 按文件比较存量。
- 实测 461 处 / 71 文件：459 处只有注释，裸 `catch {}` 仅 `src/kernel/vendor` 的 2 处。
- **没有修改任何 catch 代码**，只冻结存量；新增/增加即失败。
- `test/p3-empty-catch-gate.test.mjs` 3/3。

### 14 个未引用模块

10 保留 / 4 删除候选。保留：`watchdog-sidecar`、`core-ui-profile`、`desktop-launch`、`decision-ingest-client`（运行/外部入口）；`task-handle`、`accelerated-web`（契约/实验面）；`broker`、`broker-adapter`（IAM 设计资产）；`status-store`、`idle-audit`（客户端契约）。删除候选：`fork-export`、`fs-guard`、`reflow`、`interaction-poke`。**本版不删除、不移动**；删除前移入回收目录并单独确认。

## 六、测试与构建

- 全量：`test-399-final9.log`：**1599 tests / 1576 pass / 0 fail / 13 skipped / 10 todo**。
- P3 定向：`p3-structural-smoke` 3/3、`p3-empty-catch-gate` 3/3；compose/watchdog 相关 5 套件 26/26；13 个模块测试 79/79。
- 构建：`node tools/release/build.mjs`（preflight 含全量测试 + e2e）；产物 `dist/dsh-fang-3.9.9.tgz`，sha256 见 `dist/manifest.json`。
- 包冒烟：`package-smoke`、`crash-safety`、`allowlist`、`main-city package gate` 均由 build 执行。

## 七、未覆盖与风险

- **真机未回归**：本版只做工作树 + 本地测试；未部署到 `C:\Users\fangw\.dsh\profiles\desktop`，`task_mwqenfnxpobe` 同类一键修复未在新版上复测。
- 宿主 `http://127.0.0.1:61412` 在审计期间连接拒绝；发布后需安装新版再跑真机 smoke。
- `release-order` 在本机缺 `contract` 子仓时仍有“contract 版本不可读 / vendored 不匹配”FAIL；与本版代码无关，但完整发布顺序检查需补 contract 仓。
- 删除候选 4 个模块仍在包内；本版不清理，避免把结构清理和发布混在一起。
