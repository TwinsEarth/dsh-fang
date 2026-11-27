# Fang v3.9.7 审计记录

日期：2026-11-27
范围：宿主压力 session 体量阈值对齐；不改 Host JS heap、Commit/Safe Mode、页面文件策略。

## 一、问题证据

用户重启 DSH 后看到：

- 标题：`宿主压力预警`
- `session 合计 365.5 MB · 单文件最大 60.9 MB`
- 合计阈值 `512 / 1024 / 2048 MB`
- 单文件阈值 `16 / 32 / 64 MB`

v3.9.6 的发布说明只覆盖 `fork-health` 的 200/300/500 MB、3000/3600/3900 MB。宿主压力横幅走的是另一条链路：

- `client.js` `renderHostPressureBanner()` 读取 `S.status.data.hostPressure.session.thresholds`
- `orchestrator` 的 `evaluateSessionFootprint()` 使用 `cfg.sessionFootprint*` / `cfg.sessionFile*`
- 这些 schema 默认值仍是 512/1024/2048、16/32/64

因此这不是“3.9.6 未加载”，而是 v3.9.6 没有同步修改 `host-pressure.mjs` 及其 schema。

## 二、代码变更

| 文件 | 变更 |
|---|---|
| `src/lib/host-pressure.mjs` | `SESSION_FOOTPRINT_DEFAULTS` 改为 3000/3600/3900、200/300/500；`levelForMB` 改为严格 `>` |
| `src/plugins/orchestrator.mjs` | 六个 session 体量 schema 默认值同步；Host heap 默认值不动 |
| `test/v3814-host-guard.test.mjs` | 更新默认断言与边界用例，新增 365.5/60.9 回归 |

## 三、边界语义

- `200 MB` / `300 MB` / `500 MB` 与 `3000 MB` / `3600 MB` / `3900 MB` 恰好等于时，仍属于较低一档。
- `fileLevel=emergency` 才设置 `gate`；`totalLevel=emergency` 只设置 `totalGate`。
- 宿主压力横幅仍显示 `warn/critical/emergency` 的实际等级。

## 四、测试记录

定向：

- `E:\DBH\fang-report\test-397-hostpressure.log`：6 tests / 6 pass / 0 fail
- `E:\DBH\fang-report\test-397-forkhealth.log`：19 tests / 19 pass / 0 fail

全量：

- `E:\DBH\fang-report\test-397-final.log`：1566 tests / 1511 pass / 32 fail / 13 skipped / 10 todo
- 32 条失败中，30 条为既有 `orchestrator.test.mjs` 临时夹具缺真实 bundle 的 `fork-bundle-unavailable`；
- 另 2 条为 `forker.test.mjs` 的 `reap stops...` / `dataRoot persists...`：`taskkill /T /F` 后 `run\job-object.log` 句柄释放竞态，`reap` 返回 `removed:true` 但目录尚未完全消失；与本版阈值改动无关，单独重跑仍复现，未纳入本版修复范围。
- 本版新增/修改的 host-pressure、版本、README、docs 断言全部通过。

## 五、构建与部署

- 构建：`node tools/release/build.mjs --skip-preflight`
- tarball：`dist/dsh-fang-3.9.7.tgz`（934,612 bytes）
- SHA-256：`cb092df4992bbb88222ae68028d1adcde8db87fb317c9f154f87e600957647e2`
- 构建的 `manifest.preflight` 记录 `skipped:true / green:false / reason:"--skip-preflight"`，不得表述为 preflight GREEN。
- 本机 profile 已部署 `@twinsearth/fang-dsh-plugin@3.9.7`，部署 digest `f4feac8b2ff577917bb4c0f2e91b4a7460e0f8d8ec8b86651cef8f7e034d78ba`；部署后必须完全退出并重启 DSH Desktop 才会加载新代码。

## 六、未覆盖

- 未改动 `fork-health.mjs` 的 200/300/500、3000/3600/3900 逻辑；v3.9.6 的多帧 zstd 修复保持不变。
- 未新增宿主压力“二次确认”服务端 ticket；现有 `gate` 仍只在单文件 emergency 时拒绝新任务。
- 未处理显式写在 profile 配置里的旧 `sessionFootprint*` 覆盖值；如有覆盖，需单独同步。
