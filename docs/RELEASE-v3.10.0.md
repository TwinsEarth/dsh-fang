# Fang v3.10.0 — 安装链修复版

版本：`@twinsearth/fang-dsh-plugin@3.10.0`
日期：2026-11-28

## 主题

移除会让 pnpm 11 拦截的安装期 `postinstall`，把 macOS sidecar 清理改到 `prepack`。升级不再需要卸载重装，也不会再弹 `approve-builds`。

## 根因

- 包内 `postinstall` 属于依赖 build script。pnpm 11 默认拒绝执行，要求先写 `allowBuilds` 或交互式 `pnpm approve-builds`。
- DSH 更新器在非交互环境调用 pnpm，无法回答审批；`ERR_PNPM_IGNORED_BUILDS` 被判定为升级失败，随后回滚到旧版本。
- 手动卸载重装走交互安装，pnpm 弹窗批准后写入当前版本的 `allowBuilds`，`postinstall` 才执行；这就是「只有重装能成功、每次都要确认 pnpm」的来源。
- 该 `postinstall` 只清理 macOS `._*` / `.DS_Store` / locale sidecar，不参与插件运行。

## 修复

- `package.json`：删除 `postinstall`，新增 `prepack`：
  `node tools/release/clean-apple-double.mjs && node tools/release/clean-locale-sidecars.mjs`
- `tools/release/build.mjs`：staged package metadata 只保留 `prepack`，不再向发布包注入安装期 hook。
- `test/package-metadata.test.mjs`：断言 `prepack` 存在，`preinstall` / `install` / `postinstall` 均不存在；保留清理函数单测。
- 版本：`package.json`、`package-lock.json`、`src/kernel/types.mjs` 提升到 `3.10.0`。

## 兼容性

- 运行时代码与 v3.9.10 一致，本版只改发布包生命周期与版本元数据。
- 用户安装/升级不会再触发 `pnpm approve-builds`。
- 已安装 3.9.10 的 profile 可直接升级到 3.10.0。

## 验证

- `node tools/release/build.mjs` preflight GREEN。
- 全量测试 1583 pass / 0 fail / 13 skip；e2e 125/125。
- package smoke / crash-safety / allow-list / main-city 全部 PASS。
- 最终 tarball 948,877 bytes，211 entries，SHA-256 `f369d30e0459786ae75280bfd0caa8110aff4343a086f6b565bd206296e6cdd3`。
- pnpm 11.28.5 无 `allowBuilds` 安装最终 tarball：exit 0，无 `ERR_PNPM_IGNORED_BUILDS`、无 `approve-builds`、无 `postinstall`。

细节见 `AUDIT-v3.10.0.md`。产物 `dist/dsh-fang-3.10.0.tgz`，SHA-256 见同目录 `.sha256` 与交付目录 `SHA256SUMS-3.10.0.txt`。

## 资产

- npm：`@twinsearth/fang-dsh-plugin@3.10.0`
  https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.10.0
- GitHub Release：`v3.10.0`
  https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.10.0
- 交付目录：`E:\DBH\Fang-v3.10.0\`
- tarball：`dsh-fang-3.10.0.tgz`；SHA-256 见交付目录 `SHA256SUMS-3.10.0.txt`
