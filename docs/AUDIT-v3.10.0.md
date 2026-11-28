# Fang v3.10.0 审计记录

日期：2026-11-28
范围：发布包生命周期、pnpm 11 安装审批、版本元数据。

## 1. 现场

DSH 插件管理器日志位于 `%USERPROFILE%\.dsh\profiles\desktop\.plugin-manager\logs\operation-*\pnpm.log`。升级 3.9.9 → 3.9.10 的序列：

1. `operation-jHw7G6`：安装 3.9.10，pnpm 输出 `ERR_PNPM_IGNORED_BUILDS: @twinsearth/fang-dsh-plugin@3.9.10`，没有执行 `postinstall`。
2. `operation-RdW87O`：回滚到 3.9.9，`postinstall` 正常执行；3.9.9 的 `allowBuilds` 条目已存在。
3. `operation-djl709`：再次安装 3.9.10，仍报 ignored builds。
4. `operation-bUekfR`：交互重装 3.9.10，`postinstall` 执行成功；批准后当前版本被写入 `allowBuilds`。

结论：升级失败不是网络或包内容损坏，而是新版本尚未进入 pnpm 的逐版本 `allowBuilds` 白名单，非交互更新器无法回答 `approve-builds`。

## 2. 根因

- `package.json` 的 `postinstall` 是依赖 build script。pnpm 11 默认不执行，必须 `allowBuilds` 或交互审批。
- 手动重装是交互安装，pnpm 弹窗批准后写白名单；自动更新没有终端，无法审批，于是把 `ERR_PNPM_IGNORED_BUILDS` 视为失败并回滚。
- 该 hook 仅清理 macOS AppleDouble / Finder sidecar 与 locale sidecar，不参与运行逻辑。

## 3. 修复

- 删除 `package.json` 的 `postinstall`。
- 新增 `prepack`：`node tools/release/clean-apple-double.mjs && node tools/release/clean-locale-sidecars.mjs`。
- `tools/release/build.mjs` 的 staged package metadata 只保留 `prepack`，发布包不再包含安装期 hook。
- `test/package-metadata.test.mjs` 增加断言：`prepack` 存在；`preinstall` / `install` / `postinstall` 均不存在。
- 版本元数据：`package.json`、`package-lock.json`、`src/kernel/types.mjs` 到 `3.10.0`。

## 4. 边界

- `prepack` 只在 `npm pack` / `npm publish` 等打包路径执行，不会在用户 `pnpm install` / `pnpm add` 时执行。
- `tools/release/build.mjs` 使用自有 tar 流程，不调用 npm pack；它仍保留 sidecar 路径门禁，发布前会拒绝 `._*` / `.DS_Store`。
- 本版运行时代码与 v3.9.10 一致，未改变配额、fork、浏览器或会话行为。

## 5. 验证

- 构建：`node tools/release/build.mjs`，preflight GREEN。
- 全量测试：1583 pass / 0 fail / 13 skip（563.3s）。
- e2e：125/125（83.9s）。
- 静态门禁：package smoke、crash-safety、allow-list（routes=129 / findings=0）、main-city（grade=A / blockers=0）全部 PASS。
- 产物：`dist/dsh-fang-3.10.0.tgz`，948,877 bytes，211 entries，SHA-256 `f369d30e0459786ae75280bfd0caa8110aff4343a086f6b565bd206296e6cdd3`。
- 包内 `package.json` 的 scripts 只有 `test` 与 `prepack`，无 `preinstall` / `install` / `postinstall`。
- 用最终 tarball 在 pnpm 11.28.5、无 `allowBuilds` 的临时项目中安装：exit 0，4 packages，输出无 `ERR_PNPM_IGNORED_BUILDS`、无 `approve-builds`、无 `postinstall` 执行；安装后的包版本为 `@twinsearth/fang-dsh-plugin@3.10.0`。
- 审计/发布文档随仓库保存，不随 npm 包发布；`dist/manifest.json` 的 files 不含 `docs/AUDIT-v3.10.0.md` 与 `docs/RELEASE-v3.10.0.md`。

首次构建曾因 README 的版本断言仍指向 v3.9.10、审计文档含本机绝对路径触发 allow-list 而 RED；两处修正后复跑得到上述 GREEN。
