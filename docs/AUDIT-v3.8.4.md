# v3.8.4 审计（2026-11-25）

> 用户指令：**“应修的代码：确认并同意”**、**“三方发布，v3.8.4”**。基线 v3.8.3（未单独发布）。

## 一、事故与责任边界

本次 Host 崩溃不是“3.8.3 看门狗没防住”，而是 Windows 没有页面文件：Commit 上限被压到约 31.7 GB，DSH 在加载 profile/核心插件阶段就因 Commit 压力读不出文件，插件管理器逐行禁用核心插件，Renderer 随后崩溃。Fang 插件当时尚未获得执行机会。Safe Mode 是事后检测，不是事前拦截。

另有一条独立故障：Renderer 报 `app.openMigrationReport is not a function`，只影响“查看迁移报告”按钮/面板，不是 Host `commit-free-critical` 的根因。两条故障不得合并归因。

## 二、根因

### A. 页面文件缺失 + Safe Mode 解除门禁只信复选框

- `Win32_PageFileUsage` 为空，`AutomaticManagedPagefile=False`，`SizeStoredInPagingFiles=0`。
- `commitFreeMB=20735`、`commitLimitMB=32476`，对 31.7 GB 物理内存没有页面文件兜底。
- 旧版 `POST /fang/api/safe-mode/reset` 在页面文件缺失时仍返回 `HTTP 200 {ok:true,safeMode:false}`，说明服务端没有重新探测，只信客户端复选框。
- 页面文件修复前，继续调内存阈值不能保证不崩；Fang 只能检测并 fail-closed，不能替代启用页面文件。

### B. `openMigrationReport` 客户端 API

- Fang 3.8.3 `client.js` 第 2077 行定义 `function openMigrationReport()`，第 3576 行 `const app = {...}` 未挂载，第 4098 行按钮调用 `app.openMigrationReport()`。
- 在 TOFUTURE 整个 profile `node_modules` 执行 `findstr /S /M /C:"openMigrationReport" *.js`，只命中 `@twinsearth\fang-dsh-plugin\client.js`；`@deepseek-ai` 及其他 DSH 插件没有该符号。
- 因此该条在 3.8.3 上是 Fang 客户端 API 漏挂；仍按用户要求与 Commit 崩溃分开处理，不混进崩溃修复。

## 三、修复

1. **Safe Mode 解除硬门禁（服务端）**
   - 新增纯函数 `evaluateSafeModeReset(memory, { hostCriticalFreeMB })`。
   - `resetSafeMode` 每次强制 `readSystemMemory({ force: true })`，实际读取 `Win32_PageFileUsage`，不再信缓存/复选框。
   - 只有 `memory.ok === true`、`hasPageFile === true`、`pageFileMB > 0`、`commitFreeMB >= hostCriticalFreeMB` 才允许解除；否则返回 409，写 `safe-mode-reset-refused` 审计，`safeMode` 不变。
   - 非 Windows `supported === false` 时允许 skip，不影响 Linux/macOS 测试。
2. **启动前页面文件预检**
   - `apply()` 内新增 `bootPagefileGate`（Windows 异步探针）。
   - 页面文件缺失/被禁用时：`safeMode=true`、`safeModeReason=pagefile-missing`（已有原因则追加 `+pagefile-missing`）、`persistSafeMode()`、审计 `safe-mode-pagefile-missing`。
   - `createTask`、`restoreTask`、`syncTaskOnOpen`、`autostartForks` 都先 `await bootPagefileGate`；Safe Mode 下 `autostartForks` 返回 `{ok:false,error:'safe-mode'}` 并审计 `autostart-refused`，不调用 `forker.spawn`，不拉起浏览器。
3. **客户端硬拦截**
   - `reviewSafeMode()` 读取 `S.status.data.memory` 与 `memoryPolicy`；`pagefileMissing` 同时看 `hasPageFile` 与 `pageFileMB`；新增 `commitLow`。
   - `confirmSafeModeReset()` 对页面文件缺失/Commit 低于 `hostCriticalFreeMB` 直接拒绝，不发请求。
   - 弹窗中页面文件 checkbox 缺失时 `disabled`，确认按钮因 `commitLow`/缺失禁用，红色 notice 与 title 显示具体原因。
   - `renderPagefileBanner()` 改为 `hasPageFile === true && pageFileMB > 0` 才隐藏；页面文件缺失持续红色 banner。
4. **迁移报告防护**
   - `app` 面挂回 `openMigrationReport`。
   - 按钮调用点做 `typeof app.openMigrationReport !== 'function'` 判断；缺失时 `notify` 并提示单独上报 DSH 客户端 API 问题，不抛 TypeError。
5. **暴露阈值**
   - `memoryPolicySnapshot()` 返回 `hostCriticalFreeMB` 与 `memoryMinFreeMB`，供客户端判断。
6. **附带修复旧 child 句柄泄漏**
   - 发布门禁跑全量测试时发现 `forker` 的 `stop → 重启` 场景：上一子进程的晚到 `exit` 事件会无条件 `rec.child = null`，把新 child 句柄清掉，导致新分身失去句柄控制、测试进程残留 `fake-dsh-cli`。
   - 现在 `exit`/`error` 处理器只在 `rec.child === child` 时改当前记录；旧 spawn 用独立 `finishStale` settle，不触碰新记录。回归：`forker.test.mjs` 29/29 且进程正常退出。

## 四、回归

- 新增 `test/pagefile-safety.test.mjs`：页面文件缺失/Commit 低/真实页面文件+Commit 达阈值、启动预检强制 Safe Mode、Safe Mode 下 autostart 不得 spawn。
- 更新 `test/client-safe-mode.test.mjs`、`test/client-migration-report.test.mjs`、`test/client-pagefile-banner.test.mjs`。
- 跨平台测试修正：`kernel.test.mjs` 的 Windows 路径拆段比较；`orchestrator.test.mjs` 的 CLI 用例按平台创建 `dsh`/`dsh.cmd`，不再把 Linux 的路径语义当失败。
- 具体数字见 `docs/RELEASE-v3.8.4.md` 门禁表；发布前跑全量测试不要加 `--test-force-exit`，该参数会造成假 `cancelledByParent`。

## 五、边界

- 不修改 DSH 安装文件；不自动安装/更新插件；部署/重启需用户手动二次确认。
- 页面文件是系统级前置条件，代码不静默改系统配置；需用户单独确认后启用。
- 真实 Windows 宿主 pagefile 缺失场景需部署后复测；本版在 VM 完成代码与单测。
- `openMigrationReport` 仍按 Fang 侧防护处理，不修改 DSH core。
