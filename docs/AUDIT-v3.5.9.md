# AUDIT v3.5.9

- 日期：2026-11-21
- 基线：v3.5.8
- 目标：v3.5.9

## 范围（本版改了什么，逐项可核对）
- `src/lib/accelerated-fork.mjs`
  - 新增 `FANG_PUBLISHED_BUNDLE`（`@twinsearth/fang-dsh-plugin`）与 `fangBundleNameOf(fangRoot)`：以 `fangRoot/package.json` 的 `name` 作为 fork profile 的 fang bundle 真名。
  - `buildAcceleratedForkProfile`：`dependencies` / `dsh.profile.bundles` 使用真实包名（不再是源码常量 `@local/dsh-fang`）。
  - `buildSyncedAcceleratedProfile`：真实包名进入 `dependencies` 与 `bundles`；`isFangBundle` 识别发布名，避免把本体当作第三方插件复制。
  - `writeAcceleratedForkProfile`：junction 建在真实包名路径下；包名与 `@local/dsh-fang` 不同时额外保留开发别名 junction。
- `test/accelerated-fork.test.mjs`
  - 新增回归：发布名 fixture 下 profile bundles/deps 使用发布名，`node_modules/@twinsearth/fang-dsh-plugin` junction 可解析且为符号链接。

## 验证（粘贴真实数字，不写“已测试”）
- preflight --e2e：GREEN
- 全量测试：pass=? fail=0 skip=?
- e2e：?/?
- 路由契约 / 插件行数：?/16
- 现场复现：修复后以本机真实插件（`@twinsearth/fang-dsh-plugin` 安装目录）生成加速 profile，探针输出 bundles=`[dsh-base, dsh-web-app, @twinsearth/fang-dsh-plugin]`、junction 存在可解析。

## 风险与边界
- 不改加速核 CLI 版本（`@twinsearth/dsh@3.5.0`）与母体/原身 core；
- 不改数据目录布局（`FANG_HOME` 未设置，运行数据仍在 `<DSH_HOME>/fang/desktop`；加速核在 `D:\ToFuture\accel`，由本机 profile 补丁 `fang-forker.acceleratedCliPath` 指向）；
- 发布包内的 `@local/dsh-fang` 常量仍会被构建改名为发布名；本修复不再依赖该常量决定 junction 名。

## 回滚演练
- 触发方式：`npm i @twinsearth/fang-dsh-plugin@3.5.8`（插件层）；母体/原身快照目录回滚由备份工具提供。
- 恢复耗时：< 2 分钟（npm 降级 + 重启 DSH）。
- 证据：dist/preflight.json / tools/e2e.mjs 输出
