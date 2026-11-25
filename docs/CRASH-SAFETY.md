# CRASH-SAFETY — 瓮城防崩溃方案（防线、强制点、运行手册）

> 状态：生效中（2026-11-10 起固化）。与 `docs/WORKFLOW-UI.md` 一起受测试/打包/发布门禁保护。
> 发布动作遵循 `docs/WORKFLOW-UI.md` §0：**发布必须由人类显式授权**，禁止自动 release/npm/GitHub Release。
> 目标：**插件树坏一行，不拖垮宿主；分身崩溃，不扩散；配置变更，可回滚。**

## 1. 威胁模型

| 威胁 | 后果 | 现有防线 |
|---|---|---|
| 插件 bundle 某行解析失败 / 模块缺失 / `apply()` 抛错 | 宿主启动崩溃或半启动 | boot-guard 启动前自检 + 失败行 `disabled` + 安全模式 |
| 插件崩溃把宿主 fiber 带走 / 反复崩 | 母体不可用 / 崩溃循环 | Cordis fiber 隔离 + RestartGuard 唯一重启闸门 |
| 分身进程崩溃 / 事件循环耗尽 / `process.exit()` | 任务失败、端口/资源泄漏 | 独立进程 + 独立 `DSH_HOME` + 退避重启 + 孤儿回收 |
| 角色/权限边界被绕过 | 越权写母体 | role fail-closed（`roleGate`/`roleAllows`） |
| 崩溃后状态丢失/重复执行 | 重复任务、丢事件 | fork meta（crashCount/restartCount/lastError）+ 待处理缓冲 + 未清洁启动检测 |
| 升级把运行中的 profile 改坏 | 客户端崩溃、用户配置丢失 | 升级安全规程（停 host、备份、候选包冒烟、装后 dry-run、回滚） |

## 2. 防线清单（代码事实）

| 防线 | 入口 | 行为 |
|---|---|---|
| boot-guard | `src/lib/boot-guard.mjs`、`tools/boot-guard.mjs` | 解析 fang bundle 行；重复 id / 模块解析 / 隔离子进程 `import` 且导出 `apply()`；失败行可 `--apply` 写成 `disabled:true`（写前备份）；`--safe-mode` 全禁 fang 行；`--candidate-dir` 用于更新候选包冒烟 |
| RestartGuard | `src/plugins/restart-guard.mjs` | `classifyRisk` / `decide` / `findGrant`；母体重启唯一入口，默认只到审批/审计，不直接退出进程 |
| 分身隔离与监督 | `src/plugins/forker.mjs`、`src/lib/fork-supervisor.mjs`、`src/lib/process-identity.mjs` | 每任务独立进程 + 独立 `DSH_HOME`；`planRestart` 指数退避 + 最大次数；`reconcileOrphans` 只回收死亡孤儿、不 kill 活实例；`writeForkMeta` 原子写 meta；**孤儿清理**在 spawn 后记录进程 `CreationDate` + `CommandLine` SHA-256，清理与 `taskkill` 前双重核对；新任务身份/启动时间缺失即 fail-closed，旧任务退化到 profile+port 校验；`watchdog.json` 目标同样记录 `CreationDate`/`CommandLine` 指纹，sidecar `taskkill` 前复核；宿主 `hostStartedAt` 也用于识别 host PID 复用，防误杀 |
| 角色 fail-closed | `src/kernel/role.mjs` | `roleGate` / `roleAllows`：未知角色默认拒绝，不默认放行 |
| 待处理缓冲 | `src/plugins/buffer-keeper.mjs` | pending 观察 + digest 兜底 + 静默窗口；时间戳缺失时补观测时间，避免误判 |
| 未清洁启动检测 | `src/lib/desktop-launch.mjs` | `readUncleanBoot` / `runBootGuard` / `resolveDesktopLaunch`：桌面启动前检测上次崩溃并跑 guard |
| 诊断日志轮转 | `src/lib/log-rotation.mjs` | `browser-samples.jsonl` / `memory-samples.jsonl` 按大小（默认 16 MiB）轮转，归档按天数（默认 7 天）清理；写入失败不阻断任务路径 |
| Safe Mode 恢复 UX | `client.js`、`src/plugins/orchestrator.mjs` | 顶部 banner 解释 Safe Mode 原因并给出迁移/检查入口；解除前弹出 pagefile/Commit、旧数据迁移、内存占用检查清单，未勾选不允许解除 |
| 宿主诊断文件边界 | `src/lib/host-housekeeping.mjs`、`src/plugins/orchestrator.mjs` | `host-crashes.json` 最多 50 条 / 30 天；旧 `watchdog-<pid>.json` 按 20 份 / 7 天清理，死亡 PID 文件移入同卷 `recycle/watchdog`（保留 10 分钟 sidecar 观察窗；当前宿主与存活 PID 文件不移动） |
| Panic 强确认 | `client.js` | 顶部「释放全部内存」先打开强确认弹窗；必须输入 `PANIC` 才提交 `/fang/api/panic`，防止误触 |
| CDP 指标趋势 | `src/lib/browser-metrics.mjs`、`src/plugins/orchestrator.mjs`、`client.js` | `browser-samples.jsonl` 记录 `documents` / `listeners` / `layoutCount`；任务卡显示三张 60 点 sparkline（仅 CDP 成功采样入环）；历史不写入 `tasks.json` |
| 内存阈值自适应 | `src/lib/memory-policy.mjs`、`src/plugins/orchestrator.mjs`、`client.js` | 按宿主物理内存（缺失时用 CommitLimit）缩放浏览器 Commit/JS heap、分身杀/增长阈值：浏览器与分身各取 20% / heap 10%，上下限 512–4096 / 384–3072 MB；无探针或关闭 `memoryAdaptiveThresholds` 时回退固定值；`/fang/api/status` 与 `memory/probe` 暴露 `memoryPolicy`，触发审计带 `source`/`limitMB` |
| 迁移报告面板 | `src/lib/migration-report.mjs`、`src/plugins/orchestrator.mjs`、`client.js` | 只读读取 `D:\ToFuture\FangData\_migration` 下最新有效 `migration-*.json`；状态 `layout.migrationReport` 暴露复制/跳过/冲突/来源/目标；面板横幅与弹窗展示；报告缺省或损坏不显示假状态，冲突最多展开 20 条 |
| 真实宿主 boot smoke | `tools/release/host-boot-smoke.mjs` | 启动打包 DSH CLI + 隔离 profile；断言该 profile 只有 1 个宿主、sidecar 是 DSH runtime node.exe、client boot 图与 DOM 挂载、无 pending/plugin-load/handler-threw；详见 `docs/HOST-SMOKE.md` |

## 3. 强制点矩阵（改坏就红）

| 环节 | 命令/文件 | 覆盖 |
|---|---|---|
| 单测 | `test/boot-guard.test.mjs`、`test/desktop-launch.test.mjs`、`test/fork-supervisor.test.mjs`、**`test/crash-safety.test.mjs`（新增）**、`test/process-identity.test.mjs`、`test/watchdog-sidecar-identity.test.mjs`、`test/log-rotation.test.mjs`、`test/client-safe-mode.test.mjs`、`test/host-housekeeping.test.mjs`、`test/host-housekeeping-wiring.test.mjs`、`test/client-panic-confirm.test.mjs`、`test/browser-metrics.test.mjs`、`test/cdp-metrics-wiring.test.mjs`、`test/client-cdp-trends.test.mjs`、`test/memory-policy.test.mjs`、`test/memory-policy-wiring.test.mjs`、`test/migration-report.test.mjs`、`test/client-migration-report.test.mjs` | 行解析/隔离冒烟/禁用写回；未清洁启动；退避/孤儿；门禁工具自身；PID 身份/CreationDate/命令行指纹与 fail-closed；sidecar 目标复核；日志轮转；Safe Mode 恢复清单；诊断文件上限/回收；Panic 强确认；CDP 指标环与趋势图；内存阈值缩放/回退/状态暴露；迁移报告读取/损坏回退/面板渲染 |
| 发布前源码门禁 | `node tools/release/preflight.mjs` → `crash-safety --json` | 防线文件存在、纯函数导出、插件闸门 token、client 半浏览器安全、文档与打包清单 |
| 打包后门禁 | `node tools/release/build.mjs` → `crash-safety --package dist/npm/package --tarball …` | **最终产物**内必需防线文件、版本/client 声明、候选包 `apply()` 冒烟、manifest sha256、tarball 内约束文档 |
| 真实宿主门禁（Windows） | `npm run smoke:host -- --cli <D:\DSH\...\dsh.cmd> --plugin <plugin dir>` | 打包 DSH 真实启动、单宿主、sidecar node 身份、client DOM/boot 图；需 Edge/Chrome，不纳入 Linux CI |
| 发布 | release workflow build job（内置 `build.mjs` → preflight + crash-safety） | 未过 crash-safety 的产物不会进入 GitHub Release / npm |

## 4. 运行手册

### 4.1 启动前自检（profile 有 Fang）

```bash
node tools/boot-guard.mjs --profile-dir <profile> --json        # dry-run，只读
node tools/boot-guard.mjs --profile-dir <profile> --apply       # 禁用失败行（备份后写 profile patch）
node tools/boot-guard.mjs --profile-dir <profile> --safe-mode   # 全禁 fang 行（救急）
```

### 4.2 升级候选包（不碰运行中的 profile）

```bash
node tools/boot-guard.mjs --candidate-dir <解包后的候选包目录> --json  # 入口存在 + apply() 冒烟
# 停 host → 备份 profile 用户层 → 安装 → 装后 dry-run → 启动 → 失败则恢复备份/--apply
```

### 4.3 崩溃后处置顺序

1. 先看 `fang-meta.json` 的 `crashCount/lastError` 与宿主日志，确认是分身还是母体；
2. 分身：等监督重启（opt-in）或手动重启；孤儿按 `reconcileOrphans` 规则处理，不 kill 活实例；
3. 母体：走 RestartGuard 审批；启动前跑 boot-guard dry-run，确认不是插件树坏行；
4. 若确认是某行插件：`--apply` 禁用该行并记录，恢复后单独排查该插件；
5. 复盘：把新发现的崩溃模式补进本文件和 `test/crash-safety.test.mjs`。

## 5. 边界（诚实）

- 不承诺宿主内核/Node 自身崩溃恢复；Cordis fiber 隔离只覆盖插件生命周期错误。
- 分身与母体是**同用户、同 ACL**，不是权限隔离；`DSH_HOME` 隔离只防数据串写。
- 桌面 Electron 壳（`dsh-fang-desktop/panel`）是另一套 UI，不在 web 控制台门禁覆盖内。
- `crash-safety` 是**静态+冒烟**门禁，不是形式化证明；它保证“已知防线还在、产物能加载”，
  不保证任意新插件逻辑无崩溃。
