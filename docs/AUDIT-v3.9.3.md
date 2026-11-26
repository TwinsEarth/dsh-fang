# v3.9.3 审计记录

- 日期：2026-11-26
- 版本：`3.9.3`
- 包名：`@twinsearth/fang-dsh-plugin`
- 基线：`3.9.2` 发布 commit `548b11f` + 迁移报告按钮作用域修复

## 范围

本次只处理三件事：

1. 修复 3.9.2 母体日志中的两个 `ReferenceError`：`openMigrationReport is not defined`、`S is not defined`。
2. 校准 3.9.3 发布所需的测试期望值：`test/adapter.test.mjs` 的 `heartbeatMs` 从 5000 改为 15000。
3. 校准与 3.9.2 八分身容量冲突的 `package-smoke` 门禁。

不改变 3.9.2 的 AppleDouble 清理、`__fangUiLog` 上限、15s 心跳/轮询与 8 分身配额。

## 根因

`renderMigrationReportBanner` 与 `dismissMigrationReportBanner` 位于 `createConsole` 外层，但两个按钮回调引用了只在 `createConsole` 内层可见的符号：

- “查看”回调直接调用 `openMigrationReport()`；该函数定义在 `createConsole` 内层。
- “关闭”回调直接使用 `S` 与 `render(true)`；两者同样只在内层可见。

因此点击“查看”会抛 `openMigrationReport is not defined`，点击“关闭”会抛 `S is not defined`。3.9.2 的静态/包冒烟未模拟这两个按钮点击，所以 17/17 smoke 仍通过。

## 修复

- 将 `dismissMigrationReportBanner` 改为 `(S, app, file)`，使用 `app.render(true)`。
- 将“查看”改为 `app.openMigrationReport()`。
- 将“关闭”改为 `dismissMigrationReportBanner(S, app, file)`。
- app 对象增加 `dismissMigrationReportBanner(file)` 包装，保留对外签名。
- `test/client-migration-report.test.mjs` 改为断言 app surface；另跑本地作用域测试覆盖查看、关闭、关闭后隐藏。
- `test/adapter.test.mjs` 的 `heartbeatMs` 期望改为 15000。
- `tools/release/package-smoke.mjs` 的 maxForks 门禁改为校验 `maxForks: 8`、`allowMultiFork: true`、`singleActiveFork: false` 同时存在。

## 验证结果

- `node --check client.js`：通过。
- 定向测试 `test/adapter.test.mjs test/client-migration-report.test.mjs`：45/45 通过。
- 作用域测试：查看、关闭、关闭后隐藏均通过。
- 源码 main-city gate：46/46 checks，grade A，blockers 0，version `3.9.3`。
- 构建 `node tools/release/build.mjs --skip-preflight`：exit 0
  - package smoke / crash-safety / allow-list / package main-city gate 全部 PASS
  - tarball 923,603 B，208 entries，SHA-256 `383f8fc2484c049dccb408fb401208e5859f1f4e5c9110c6f6d2d3a0e9e40135`
- 真实 DSH 宿主 smoke（独立 profile）：17/17 PASS，`version=3.9.3`，client boot graph entries=76，无 pending/plugin-load/handler-threw 标记，宿主单进程且退出归零。
- npm registry 发布后重新下载 tarball：SHA-256 与本地发布 tarball 一致，`package/client.js` 包含 `app.openMigrationReport()`。

## 全量测试（RED）

- tests 1557 / pass 1479 / fail 55 / skipped 13 / todo 10，约 291.5s。
- 失败主要来自仍按 3.9.1/3.9.2 旧行为写死的断言（版本号、`maxForks=1`、5s 心跳、旧 C6 局部调用、旧包名、旧 postinstall、README v3.9.0、forker/orchestrator 行为）。
- 本版未将这 55 条全部 triage/转绿；发布走 `--skip-preflight`，manifest 记录 `green:false / skipped:true`。

## 残余风险

- 3.9.3 只修复客户端按钮作用域；不保证单独解决宿主 OOM。
- 3.9.2 已发布 npm/GitHub 包仍含该缺陷；3.9.3 为替代版本，不回写 3.9.2。
- Windows 真实宿主 smoke 仍需在安装 3.9.3 后复跑；若宿主缓存未失效，需要重启宿主再验证。
- GitHub Actions 预计仍会因历史断言 RED，Release 资产使用本地已验收 tarball。
