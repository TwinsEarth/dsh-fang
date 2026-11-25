# v3.7.2 三方发布记录（2026-11-22）

> 用户确认 3.7.2。基线 v3.7.1（`0274382`）。

## 内容

- 官方元宝每次使用前自愈（版本/node_modules/推荐表面），不再让分身静默回退 clean template。
- 官方实验性插件完整 15 bundle 全量启用（Windows 跳过 darwin-only cua）。
- `cordis.patch.yml` 顶层数组格式修复，解决 profile 加载/包不可用。
- runtime capture 捕获插件设置参数、bundles/dependencies、node_modules。

## 门禁

| 门禁 | 结果 |
|---|---|
| 全量 npm test | **1320 pass / 0 fail / 2 skip**（1332 tests） |
| preflight --e2e | **GREEN**；tests 1320/0/2；e2e 125/125；routes 111 / allowlist 0 |
| 发布 PR CI（#152） | **8/8 绿** |
| release-order | **10/10 GREEN** |
| 合并 | PR **#152** squash → `ccb6f7379ebee90f7ceed7684703d6cc3dae038f` |

## 发布结果

- tag：**v3.7.2**（annotated；远端 tag object `5a2e0c1a36c205a1a0b02856673563793e4e50ad` → `ccb6f737…`）
- GitHub Release：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.7.2（id `454268532`，4 资产）
  - `dsh-fang-3.7.2.tgz` — 704,833 B，sha256 `bba930ba722eb848511e67316c1e1c330e469219227fb822e8eb7f52b13108bc`
- npm：`@twinsearth/fang-dsh-plugin@3.7.2`（`latest=3.7.2`）
  - shasum `e6f74811396f63032beedc121f283ac6c620507e`
- 发布后校验：`verify-release --remote` **GREEN**；`release-order` **10/10**；`healthz --remote` **HEALTHY @3.7.2**。

## 边界

- 运行中的旧分身不会热改 profile；需关闭/重建后启动。
- 推荐清单中本机未安装的包不自动 pnpm 安装。
- Windows 上 `@deepseek-ai/dsh-cua-bundle` 按 darwin-only 跳过，其余 14 个实验性 bundle 正常。
