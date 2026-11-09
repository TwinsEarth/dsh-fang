# AUDIT v3.1.1

> 版本：3.1.1（2026-11-09）
> 结论：**本地发布候选已通过门禁并生成 tarball；六方发布未执行**（缺凭据/未合 main/安装器不在本仓）。

## 1. 本轮集成与修复

| 修复 | 说明 |
|---|---|
| 重复路由导致后续路由静默丢失 | `/api/forks/supervision` 的 GET/POST 双 `route()` 改为一次 `routeMethods`；删除重复注册的 `/api/essence/default` 并合并语义。此前宿主 duplicate path 抛错，导致 compat/check、branches、composer journal 等后续路由全部丢失（e2e 63/75）。 |
| 原身派生分身缺 bundle | 从默认元宝/未物化 node_modules 的原身派生时，回退母体模块树 junction，修复 `fork-bundle-unavailable`（e2e derive 失败）。 |
| 持久化最后一块 | approver 多代快照（`snapshotGenerations` 默认 3，A–J；index v2 跨重启可回滚 C+）+ 崩溃 journal（request/settled/orphaned；重启只标 orphaned，不复活 Promise）。测试：3 代轮换/回滚 C/重启恢复、journal 落盘与 crash 恢复。 |
| 启动韧性 | `fang-home.txt` 迁移指针指向不存在盘/普通文件时忽略并回退本机布局，避免插件 apply 因 ensureDir 抛错；新增真实重装 drill：同一 DSH_HOME 覆盖安装 + 16 个毒文件后二次 boot 仍返回 Web/status。 |
| 运行时崩溃记录/熔断 | restart-guard 写 `boot-state.json` + `runtime-crash.jsonl`（`uncaughtExceptionMonitor` 只观察，不改变宿主退出）；`selfCheck()` 报告 unclean-boot/runtime-crash-ledger；launcher 检测上次 booting/crashed 且 pid 已死 → 自动安全模式，避免启动期崩溃循环。 |
| 启动入口自动自检 | `desktop-launch` 与 `restart-watchdog` 默认自动执行 boot-guard；未给 profile 时探测 `DSH_PROFILE_DIR` / `DSH_HOME/profiles/<profile>`；失败 + execute → 安全模式（备份），dry-run 只报告；watchdog `--no-boot-guard`/`--no-safe-mode` 可关。 |
| 更新器门禁 | boot-guard 新增候选包 `smokePackage()` / `--candidate-dir`（子进程 import + 导出 apply）；更新器可按“快照 → 候选冒烟 → 转正/回滚”接线。PluginUpdater 本体仍不在本仓。 |
| 版本断言 | kernel/plugins-shape/role-extensions 断言同步到 3.1.1；role matrix 恢复 17 项（含 decision-center）。 |
| 发布 package smoke | cordis 行数期望 18→19（decision-center 行）。 |

## 2. 门禁证据（本机，2026-11-09）

```text
preflight --e2e : GREEN
  tests         : 1026 total / 1015 pass / 0 fail / 1 skip / 10 todo (176.8s)
  e2e           : 81/81 (17.4s)
  allow-list    : routes=104 findings=0
  compat        : COMPATIBLE node 26.13.0 (21 modules)
  package smoke : PASS
  allow-list(pkg): 117 files allow-listed
  syntax vet    : 83 src/tools/test mjs, 0 failures
  healthz       : HEALTHY (@twinsearth/dsh-fang@3.1.1)

干净 profile 实机安装 drill（--no-popup）: GREEN 9/9
  - 干净 profile boot + client half 物化
  - status version=3.1.1
  - 19 个 fang-* 行
  - zero-residue: temp home removed / drill port released

产物：
dist/dsh-fang-3.1.1.tgz          510,730 B / 135 entries
sha256                           385951cd8d1910fe243b190e57f8ebe7fbcba5bf29b573394a578c71d1b53e34
dist/dsh-fang-3.1.1.tgz.sha256   sidecar 已生成
dist/manifest.json               version=3.1.1, preflight.green=true, e2e=81/81
dist/preflight.json              GREEN
```

零残留复核（e2e 结束后）：临时 home 目录 0 个；无 dsh 宿主进程带 e2e home；端口由 e2e 随机分配并随进程树退出释放。

性能实测（本机 Node 26.13 / Windows）：
- 全量单测 176.8s（1026 项）≈ 5.8 项/s；
- e2e 81 项 17.4s ≈ 4.7 项/s；
- install drill 单次约 20s（含真实 DSH boot、client half、19 行、清理）。

## 2.1 开发进度

| 能力 | 状态 |
|---|---|
| 决策中心（ticket/配额/批量/SSE/AI 建议/执行钩子） | ✅ 已实现并有单测 + 真实 e2e 落库断言 |
| fork outbox / adapter ingest / 母体聚合 | ✅ 已实现并测试；外部进程本体未接 |
| AI 流式 / 多模型/多 provider / SSRF / 私网 allowlist | ✅ 已实现并测试 |
| 镜像 officialSource adapter / 升级后 restart ticket | ✅ 已实现并测试；真实官方源仍需 URL |
| 重启监督（HMAC/清单/回执/watchdog/launcher） | ✅ 已实现并测试；真机重启待验证 |
| 分身看护 UI 开关 + forker 运行时 supervise | ✅ 已实现并测试 |
| 外部生产者（PluginUpdater/SuperAgent/HarnessMM/PJM/Worker） | ❌ 本体未接（契约/client/CLI/fork tool 就绪） |
| Agent Loop hook / 真实 .exe 安装器 | ❌ 未实现 |

## 2.2 代码质量

- 入口/插件语法检查：**83 个 src/tools/test `.mjs`，0 失败**；
- 规模：`src/` 27,886 行；`test/` 23,054 行；`client.js` 5,813 行；
- 测试：1026 项（1015 pass / 0 fail / 1 skip / 10 todo）；todo 为 UI 手动用例（富面板 DOM harness 待接入）；
- 静态检查：无 TypeScript 编译器（typecheck SKIP）；无 ESLint 配置，质量靠单测/e2e/allow-list；
- allow-list：307 文件扫描，0 密钥/本地路径/包越界 findings；
- 已知风险：81 项工作树变更未提交；路由注册依赖“单 path 单注册”纪律（本轮已修 2 处重复注册）。

## 2.3 功能/性能实测

| 指标 | 实测 |
|---|---|
| 全量单测 | 1026 项 / 176.8s ≈ 5.8 项/s |
| e2e（真实母体+分身） | 81/81 / 17.4s ≈ 4.7 项/s |
| 干净 profile 安装 drill | 10/10（含 boot-guard precheck），约 20s；temp home/端口零残留 |
| 重装/毒数据 drill | 7/7：同一 DSH_HOME 二次 boot；覆盖安装 + 16 个毒文件后仍正常 |
| 发布门禁 | preflight GREEN；allow-list 0 findings；compat COMPATIBLE |
| 产物 | 510,730 B / 135 entries；sha256 见 §2 |

## 3. 六方发布状态

| 方 | 状态 | 原因/下一步 |
|---|---|---|
| GitHub Release | ❌ 未执行 | 当前分支 `fix/v3.1.0` 有未提交变更；tag 必须打在 origin/main 尖端。需要 commit → PR → merge main → tag `v3.1.1` 触发 `.github/workflows/release.yml`。 |
| npm | ❌ 未执行 | 本机 `npm whoami` = `ENEEDAUTH`，无 `NPM_TOKEN`；需要 `npm login` 或 CI secret。 |
| CI | ❌ 未触发 | 没有 push/PR（无 gh CLI、无 GITHUB_TOKEN）；本地测试/e2e 已替代证据但不等于 CI。 |
| Compat | ✅ 本地通过 | `node tools/release/compat.mjs` = COMPATIBLE；远端 compat workflow 未触发。 |
| Release workflow | ❌ 未触发 | 依赖 tag on main；不能从当前工作树直接触发。 |
| .exe 安装包 | ❌ 未构建 | 本仓无 Electron/NSIS 安装器构建链（`enterprise/` 只有 README）；安装器由外部 Electron 仓构建，需提供源码/流水线。 |

## 4. 未完成能力（不随版本假装完成）

- PluginUpdater / SuperAgent / HarnessMM / PJM / Worker **本体未接**：契约、client/CLI、fork tool、adapter op 已就绪。
- Agent Loop hook、真实官方 manifest 源、真机 UI/SSE 验证未完成。
- 多 Agent 投票/仲裁不做；WebSocket 不做。

## 5. 发布下一步（需人工/凭据）

```text
1. git add -A && git commit -m "release(v3.1.1): ..."
2. git push -u origin fix/v3.1.0
3. 开 PR → 合入 main（squash）
4. git checkout main && git pull && git tag v3.1.1 && git push origin v3.1.1
5. 在 GitHub Actions 观察 release.yml：guard → tests → build(e2e) → npm → GitHub Release → healthz → mirror
6. 外部 Electron 仓构建 DSH-Fang-3.1.1-x64-Setup.exe + SHA256SUMS，附到 Release
```
