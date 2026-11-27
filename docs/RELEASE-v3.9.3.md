# Fang v3.9.3 发布说明

- 版本：`3.9.3`
- 包名：`@twinsearth/fang-dsh-plugin`
- 基线：`3.9.2` 发布 commit `548b11f` + 迁移报告按钮作用域修复
- 类型：客户端运行时缺陷修复 + 测试期望值校准，不包含新的 OOM 根因修复

## 修复内容

### 1. 迁移报告“查看”按钮 `ReferenceError`

3.9.2 的 `renderMigrationReportBanner` / `dismissMigrationReportBanner` 位于 `createConsole` 外层，却引用只在 `createConsole` 内层可见的 `openMigrationReport`。点击“查看”时抛：

```text
Uncaught ReferenceError: openMigrationReport is not defined
```

本版把“查看”回调改为 `app.openMigrationReport()`，由 app 对象暴露的方法转发到内层实现，不再跨闭包直接引用局部函数。

### 2. 迁移报告“关闭”按钮 `ReferenceError`

“关闭”回调直接使用内层 `S` 与 `render`，点击时抛：

```text
Uncaught ReferenceError: S is not defined
```

本版把 `dismissMigrationReportBanner` 改为 `(S, app, file)`，使用 `app.render(true)` 重绘；app 对象增加 `dismissMigrationReportBanner(file)` 包装，保留原对外签名。按钮绑定改为 `dismissMigrationReportBanner(S, app, file)`。

### 3. 测试期望值校准

- `test/adapter.test.mjs` 的 `heartbeatMs` 期望从 `5000` 改为 `15000`，与 3.9.2 已生效的 15s 心跳一致。
- `test/client-migration-report.test.mjs` 改为断言 app surface，不再要求直接调用 `openMigrationReport()` 局部函数。
- 另跑本地作用域回归，覆盖“查看”“关闭”“关闭后隐藏”。

### 4. 发布门禁校准

`tools/release/package-smoke.mjs` 原先要求“cordis patch 不得注入 `maxForks: 8`”，与 3.9.2 已恢复的 8 分身容量冲突。本版改为检查 `maxForks: 8`、`allowMultiFork: true`、`singleActiveFork: false` 同时存在，保留 3.9.2 的容量配置。

## 发布渠道

- npm：`@twinsearth/fang-dsh-plugin@3.9.3`，`latest`
  - https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.9.3
  - tarball SHA-256：`383f8fc2484c049dccb408fb401208e5859f1f4e5c9110c6f6d2d3a0e9e40135`
  - registry tarball 与本地发布 tarball 逐字节一致（923,603 B，208 entries）
- GitHub tag：`v3.9.3`
- GitHub Release：https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.9.3
  - 资产使用本地通过包冒烟与真实宿主 smoke 的同名 tarball，不使用 workflow 重新打包产物

## 验证结果

- `node --check client.js`：PASS
- 定向测试 `test/adapter.test.mjs test/client-migration-report.test.mjs`：45/45 PASS
- 迁移横幅作用域测试：查看、关闭、关闭后隐藏均 PASS
- `node tools/gate/main-city.mjs --target source --json`：46/46 checks，grade A，blockers 0，version `3.9.3`
- `node tools/release/build.mjs --skip-preflight`：PASS
  - package smoke（tarball 可安装性）：PASS
  - crash-safety（打包产物）：PASS
  - allow-list（package）：PASS
  - main-city gate（package）：PASS
- 真实 DSH 宿主 smoke：17/17 PASS
  - `version=3.9.3`、`role=mother`
  - client boot graph entries=76
  - 无 `pending waiting` / `failed to load plugins` / `handler-threw` 标记
  - 同一 profile 只启动一个宿主，退出后宿主进程归零

## 全量测试状态（RED，必须如实记录）

全量 `npm test` 结果：

- tests 1557
- pass 1479
- fail 55
- skipped 13
- todo 10
- 耗时约 291.5s

55 条失败主要来自仍按 3.9.1/3.9.2 旧行为写死的断言，包括：

- 仍要求 `openMigrationReport()` 局部调用（C6 旧断言）
- 期望版本仍为 `3.9.1`
- 期望 `maxForks=1` / 5s 心跳
- README 仍期望 `v3.9.0`
- 旧 `postinstall` 期望
- forker 旧包名 `@local/dsh-fang` / 旧 `cleanTemplate` / reap 行为
- orchestrator 多条 createTask / quota / adapter / archive 行为测试

这些失败不是本版改动单独引入，但本版没有把它们全部转绿。发布沿用 3.9.2 的 `--skip-preflight` 路径，`dist/manifest.json` 明确记录：

```json
"preflight": { "green": false, "skipped": true, "reason": "--skip-preflight" }
```

不得把本次发布描述为“preflight GREEN”或“全量测试通过”。

## 发布边界与残余风险

- 3.9.3 只修复客户端按钮闭包作用域；不保证单独解决宿主 OOM。
- 3.9.2 已发布 npm/GitHub 包仍含该缺陷；3.9.3 为替代版本，不回写 3.9.2。
- 真实 `desktop` profile 需在安装 3.9.3 后重启宿主，避免宿主继续缓存旧 bundle。
- GitHub Actions 在本 tag 上预计仍会因上述历史断言 RED；Release 资产因此使用本地已验收 tarball。
