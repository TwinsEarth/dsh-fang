# v3.7.1 三方发布记录（2026-11-22）

> 用户确认：发布 3.7.1 修复补丁。基线 v3.7.0（`c22c43e`）。

## 内容

- 官方推荐清单与镜像同名行去重：`dsh-context` 等“安装不开启”不再被镜像行重新打开；`dshmarket`、实验性插件同逻辑；镜像锁定行保持冲突可见。
- 3.7.0 的元主同步/默认官方元宝/运行态补包/queue-journal 默认关闭不变。

## 门禁

| 门禁 | 结果 |
|---|---|
| 全量 npm test | **1318 pass / 0 fail / 2 skip**（1330 tests） |
| preflight --e2e | **GREEN 10/10**；tests 1318/0/2；e2e 125/125；routes 111 / allowlist 0；plugins 16 |
| 发布 PR CI（#149） | **8/8 绿** |
| release-order | **10/10 GREEN，warnings=0** |
| 合并 | PR **#149** squash → `5df7607fe073e0ae6e2cb03b1f6fda7129a9945c` |

## 发布结果

- tag：**v3.7.1**（annotated；远端 tag object `c5636c873d18a18383506e886b1478e865fd7b11` → commit `5df7607f…`）
- GitHub Release：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.7.1（id `454214773`，4 资产）
  - `dsh-fang-3.7.1.tgz` — 702,766 B，sha256 `5accaa1c3eb019123d8b23cf3c15dd4d41f47b8e7e1bfadb18abad15d9e20178`
  - `dsh-fang-3.7.1.tgz.sha256`、`manifest.json`（11,391 B）、`preflight.json`（1,872 B）
- npm：`@twinsearth/fang-dsh-plugin@3.7.1`（`latest=3.7.1`）
  - shasum `75b2eafed03b78f984cfbb51c41dbbbb8dd8cb6d`
  - integrity `sha512-...`
- 发布后校验：`verify-release --remote` **GREEN**；`release-order` **10/10**；`healthz --remote` **HEALTHY @3.7.1**。

## 边界

- 推荐清单中本机未安装的包仍不自动 pnpm 安装。
- 三方发布手工执行（self-hosted Windows runner 离线）。
