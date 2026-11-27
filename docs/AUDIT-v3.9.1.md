# v3.9.1 审计记录：包元信息热修 + B2 / C1–C6 收口

- 版本：3.9.1
- 日期：2026-11-26
- 基线：v3.9.0 tag `ae3680be` / 发布提交 `a023acc6`
- 发布范围：B2、C1–C6、包元信息热修
- 不包含：D3 Windows ARM64 真机（用户选择不支持 / 未验证）、E3 GitHub 凭据轮换（用户选择暂不处理）

## 一、包元信息热修

### `maxForks: 8`

`cordis.patch.yml` 给 `fang-forker` 与 `fang-orchestrator` 两行都注入了 `maxForks: 8`；v3.9.0 的 orchestrator schema 上限为 1，DSH 在加载 patch 时直接判整个插件 `invalid config`。

修复：

- `cordis.patch.yml` 两处改为 `maxForks: 1`。
- `Config.maxForks` 接受旧配置的 `1..64`，默认 1；`apply()` 仍强制 `cfg.maxForks=1`、`allowMultiFork=false`，第二次 create 仍 `quota-exceeded`。
- 旧 tarball 用新 package-smoke 可复现 `FAIL cordis patch does not inject maxForks: 8`。

### `locale/._en.json`

`._en.json` 是 macOS AppleDouble 伴随文件，不是 npm tarball 内容。DSH 的元信息扫描把 `locale/*.json` 的 basename 当 language id 校验，`._en` 因此报错。

修复：

- 打包选择器过滤 `._*` / `.DS_Store`。
- tarball 构建增加 AppleDouble 检查。
- package-smoke 增加 locale language-id / AppleDouble / `maxForks: 8` 检查。
- `postinstall` 执行 `tools/release/clean-locale-sidecars.mjs`，清理安装目录里的 sidecar。

## 二、B2：单文件 session 紧急线 48 → 64 MB

- `SESSION_FOOTPRINT_DEFAULTS.fileEmergencyMB = 64`；`fileWarnMB=16`、`fileCriticalMB=32` 不变。
- 合计门 `512/1024/2048 MB` 不变；合计 emergency 仍只置 `totalGate`，不置 `gate`。
- 60.91 MB 现场文件由 emergency 降为 critical，不再单文件 gate；64 MB 起仍 gate。

## 三、C1–C6

- C1：`host-state.json` 落盘间隔 15s → 5s，与 host tick 对齐。
- C2：`hostCrashWindowMinutes` 可配置 1–1440，默认 10；崩溃原因、safe-mode 状态与 UI 文案同源。
- C3：`hostEmergency({allTasks:true})` 扫描 ARCHIVED；只清运行时字段，保留归档状态，审计增加 `archivedSwept`。
- C4：新增 `GET/POST /fang/api/forks/multi-fork` 与 UI 二次确认；即使确认也只返回 `enabled:false / hardLimit:1`，不构成多开旁路。
- C5：`processPriority` 新增 `idle` 档；默认 `below-normal`，托管浏览器与三个 fork 启动/恢复点统一传 `priorityClass`。
- C6：迁移报告按钮直接调用本地 `openMigrationReport()`，不再依赖 `app.openMigrationReport` 方法。

## 四、测试

- 定向：`package-metadata`、`commit-budget-v3813`、`v3810-host-redline`、`v388-redlines`、`main-gate` 合计 44/44；`v390-c-items` 等 C 项 69/69。
- 全量：`1598 tests / 1575 pass / 0 fail / 13 skipped / 10 todo`，`duration_ms=216316.144125`
- 构建：`dist/dsh-fang-3.9.1.tgz`，207 entries；package smoke / crash-safety / allow-list / main-city package gate 全 PASS。精确大小与 sha256 见 `dist/manifest.json` 与项目目录发布报告。

## 五、边界

- D3 Windows ARM64：没有 ARM64 Windows 真机执行证据，不支持 / 未验证；ARM64 helper 不可用时仍按 `job-object-unavailable` fail-closed，不退化为裸 spawn。
- E3 GitHub 凭据：继续使用当前 PAT，本轮不吊销、不轮换、不改 OAuth/SSH。
- 真实 Windows DSH 宿主 E2E、页面文件全盘显示、orchestrator browser/fork 全链路仍未在本轮补跑；不得写成已验。
- preflight 如以 `--skip-preflight` 构建，`dist/manifest.json` 必须记录 `skipped:true / green:false`，不得宣称门禁 GREEN。

## 六、发布状态

发布完成后以 GitHub `v3.9.1` tag / Release、npm `@twinsearth/fang-dsh-plugin@3.9.1`、项目目录报告与校验和为准；本文件不提前宣称未完成的三方动作。
