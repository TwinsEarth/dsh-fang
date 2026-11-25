# v3.8.4 发布记录（页面文件硬门禁）

> 基线 v3.8.3（未单独发布，内容并入本版）。本版只做安全门禁与回归，不改 DSH 安装、不改系统页面文件、不改数据根。

## 门禁

| 项 | 结果 |
|---|---|
| 版本一致 | package.json / `FANG_VERSION` / `CHANGELOG ## v3.8.4` 均为 3.8.4 |
| 定向测试（VM） | pagefile-safety + client-safe-mode + client-migration-report + client-pagefile-banner + kernel + memory-guard + plugins-shape + role-extensions：**56 pass / 0 fail** |
| orchestrator + open-fork（VM） | **75 pass / 0 fail / 0 cancelled**（不带 `--test-force-exit`） |
| 全量测试（VM） | **1464 tests / 1432 pass / 0 fail / 22 skipped / 10 todo**；耗时 191,297 ms；`node --test --test-concurrency=1 "test/*.test.mjs"`，不带 `--test-force-exit` |
| e2e（TOFUTURE 真实 DSH，隔离 profile） | **56/58**；仅 `POST /fang/api/tasks/create` 与 `task id returned` 返回 409 `safe-mode/pagefile-missing`。本机 `Win32_PageFileUsage` 为空，新启动预检按设计拦截；不是功能回归，但该环境无法给出全绿 e2e |
| 构建 / package smoke / crash-safety / main-city | **PASS**；tarball 838,124 bytes，225 entries；SHA-256 `5e00430604e901fd966778d889e39860faad51ac891059189aba78bc0fe25bdc`；main-city grade A，blockers=[] |
| GitHub commit / PR | `release/v3.8.4` → PR #171；main 为保护分支，需 5 项检查通过后合并，再打 tag |
| npm publish / GitHub Release / tag | 见下方“发布流水线”回填 |

## 变更

- Safe Mode 解除必须重新读取 `Win32_PageFileUsage`：`pageFileMB > 0` 且 `commitFreeMB >= hostCriticalFreeMB`；页面文件缺失时按钮禁用并显示原因，不能只信复选框。
- Fang `apply()` 启动前检测页面文件；缺失直接进入 Safe Mode（`reason=pagefile-missing`），`createTask`/`restoreTask`/`syncTaskOnOpen`/`autostartForks` 不拉起分身/浏览器。
- `openMigrationReport` 在 Fang 可控调用点做 `typeof` 防护；缺失时提示并单独归为 DSH 客户端 API 问题。
- 新增 `test/pagefile-safety.test.mjs`；定向组合与 Safe Mode autostart 集成回归。
- 收录 v3.8.3 未发布内容：Job Object、旧 workspace 映射、拒绝外部浏览器回退、P1/P2 接线、元主 Web boot 修复、打开分身状态归位、service 面修复、迁移报告漏挂修复。
- 版本号：`3.8.3` → `3.8.4`。

## 产物

- tarball：`dsh-fang-3.8.4.tgz`，838,124 bytes，225 entries
- SHA-256：`5e00430604e901fd966778d889e39860faad51ac891059189aba78bc0fe25bdc`
- 上传 URL：`https://aka.doubaocdn.com/s/XOm6fr4NpL`
- npm：`@twinsearth/fang-dsh-plugin@3.8.4`，由 tag 触发的 release workflow 发布；本地无 npm 凭据，不手工直发
- GitHub Release：tag `v3.8.4`，由 release workflow 创建/上传
- tag：`v3.8.4`，必须在 main 尖端

## 发布流水线

1. PR #171（`release/v3.8.4` → `main`）通过 5 项必需检查后合并。
2. 在 main 尖端创建 `v3.8.4` tag。
3. tag 触发 `.github/workflows/release.yml`：guard → tests → self-hosted Windows build/e2e → npm / GitHub Release → healthz / mirror / final verify。
4. 工作流 fail-closed；任一环节红即停止，不做“部分发布”。
5. 本次提交未纳入 `.github/workflows/release.yml` 的改动：当前 `gh` token 缺少 `workflow` scope，GitHub 拒绝写入该文件；main 保留既有 workflow。该改动不阻塞本版运行。

## 未完成 / 风险

1. 页面文件仍是系统级前置条件；Fang 只能检测并进入 Safe Mode。页面文件修好前，不能保证 Host 在加载阶段不崩。
2. 真实 Windows 宿主上的 pagefile 缺失场景已在 TOFUTURE 隔离 profile 复现；本机无页面文件，e2e 最后两项被新门禁按设计拦截，未获得全绿 e2e。部署到有页面文件的环境后需复跑。
3. 不自动安装/更新 DSH 插件；部署、重启、启用页面文件均需用户手动二次确认。
4. `openMigrationReport` 归属仍按 Fang 侧防护处理，未改 DSH core；如确认是 DSH 客户端问题，单独上报。
