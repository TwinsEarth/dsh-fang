# 启动韧性（Boot Resilience）

> 目标：插件/持久化状态出错时，DSH 宿主仍能启动进 UI；不要求用户删除 `.dsh`。
> 说明：DSH 的 `import`/`apply` 硬失败策略在宿主侧；本仓只能在发布门禁、启动前自检、运行守卫、安全模式四层做纵深防御。

## 四层防线（仓库现状）

| 层 | 机制 | 状态 |
|---|---|---|
| 1. 静态/发布门禁 | `preflight --e2e`、`allowlist`、`compat`、`healthz`、`package-smoke`；`tools/boot-guard.mjs --check` 解析 bundle 行、查重复 id、子进程 import 冒烟 | ✅ 已有；`boot-guard` 本轮新增 |
| 2. 启动预检 | `tools/desktop-launch.mjs --profile-dir <profile>` 默认先跑 boot-guard（未给 profile 时自动探测 DSH_PROFILE_DIR / DSH_HOME/profiles；探测不到跳过）；失败按安全模式禁用 fang 行再启动。`tools/restart-watchdog.mjs` 重启宿主前同样自动跑 boot-guard（`--profile-dir` 可显式指定，`--no-boot-guard` 关闭，`--no-safe-mode` 失败只拒绝重启）。 | ✅ 已接 launcher + watchdog |
| 3. 运行时守卫 | restart-guard `selfCheck()` + `GET /fang/api/restart/selfcheck`：state 目录可写、HMAC、清单解析、supervisor marker；`boot-state.json`（booting/running/clean/crashed）+ `runtime-crash.jsonl`（`uncaughtExceptionMonitor`，只观察不改退出行为）；approver 崩溃 journal; forker supervise | ✅ 新增 runtime crash ledger；`apply/import` 硬失败仍由宿主决定是否退出 |
| 4. 最终兜底 | `--safe-mode`：禁用全部 fang 行；**launcher 检测上次 `boot-state=booting/crashed`（启动期崩溃）时自动安全模式**，让 DSH 先启动进 UI，再人工修复/重装 | ✅ launcher 已接 unclean-boot 熔断 |

## 使用

```powershell
# 发布前/启动前 dry-run（只报告）
node tools/boot-guard.mjs --profile-dir <DSH_HOME>/profiles/<profile>

# 禁用失败行（写 profile/cordis.patch.yml，自动 .bak-<ts>）
node tools/boot-guard.mjs --profile-dir <profile> --apply

# 安全模式：禁用全部 fang 行
node tools/boot-guard.mjs --profile-dir <profile> --safe-mode

# 重启契约自检（运行中宿主）
GET /fang/api/restart/selfcheck
```

## 测试矩阵

| 测试 | 覆盖 |
|---|---|
| `boot-guard.test.mjs`（3） | 行解析、重复 id、模块解析失败、import 抛错、无 `apply`、YAML/JSON patch 禁用合并、备份、幂等、CLI dry-run/apply/safe-mode |
| `restart-guard selfCheck` | state 目录/HMAC/坏清单 → warn，不把 stale 清单当 boot blocker |
| `paths.test.mjs` | 无效 `fang-home.txt` 指针（旧盘/普通文件）回退本机布局 |
| `reinstall-drill.mjs` | 同一 DSH_HOME 覆盖安装 + 16 类毒文件后二次 boot 仍成功 |
| `install-drill.mjs` | 干净 profile 安装/启动/零残留 |
| e2e 81 项 | 真实母体+分身、路由表、decision 落库、清理 |

## 更新器接线契约（PluginUpdater 不在本仓）

`boot-guard` 提供候选包冒烟，更新器只需按顺序调用：

```js
import { smokePackage } from 'dsh-fang/src/lib/boot-guard.mjs'

const gate = smokePackage(candidateDir)          // 子进程 import + 导出 apply()
if (!gate.ok) {
  await restoreSnapshot(snapshotId)              // 回滚
  throw new Error(`candidate rejected: ${gate.error}`)
}
await promote(candidateDir)                      // 原子转正
```

CLI 等价：

```powershell
node tools/boot-guard.mjs --candidate-dir <candidate-package-dir> --json
```

- dry-run / 冒烟失败：不转正、不写 profile；
- 更新器仍负责快照、原子替换、回滚；本仓没有 PluginUpdater 本体，不能替它执行这些步骤。

## 明确未做

- **宿主进程级 import 拦截**：DSH 的插件 `import/apply` 硬失败发生在宿主内部；本仓无法在不改宿主的情况下兜住任意第三方插件。
- **PluginUpdater 热更新子插件**：本仓仍无插件更新流水线；`boot-guard` 已提供候选包 `smokePackage`/`--candidate-dir` 门禁，快照/替换/回滚需更新器接线。
- **自动禁用失败行**：`--apply` 是显式操作；默认 dry-run，避免在未确认时改 profile。
