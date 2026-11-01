# 验收标准（Acceptance）

发布门禁是**可执行**的：`node tools/release/preflight.mjs` 必须是 GREEN，报告落到 `dist/preflight.json`。

| # | 门禁 | 命令 | 通过条件 |
|---|---|---|---|
| 1 | 版本一致 | `preflight` | `package.json` / `FANG_VERSION` / `CHANGELOG ## vX.Y.Z` 三者一致 |
| 2 | 许可矩阵完整 | `preflight` + `test/licensing.test.mjs` | AGPL 核心、MIT 生态、商业占位、NOTICE/CLA 均在位；SPDX 头无漂移 |
| 3 | 全量测试 | `node --test --test-concurrency=1 "test/*.test.mjs"` | `fail = 0`（1 个 skip 是手动容器探针，需单独 `FANG_CONTAINER_LIVE=1`） |
| 4 | 实机 e2e（发布前必跑） | `node tools/e2e.mjs` | `N/N checks passed`（临时 `$DSH_HOME` + 真 dsh 母体 + 真分身） |
| 5 | 构建产物 | `node tools/release/build.mjs` | `dist/dsh-fang-<ver>.tgz` + `dist/manifest.json`（含 sha256；不含 `dist/`、`node_modules/`） |
| 6 | 产物健康 | `node tools/release/healthz.mjs` | tarball 可解包、包名 `dsh-fang`、版本一致、AGPL、kernel/plugins 可加载 |
| 7 | 兼容性 | `node tools/release/compat.mjs` | Node 22/24 均可 import 全部模块 |
| 8 | CI | GitHub Actions | `ci`（windows 22/24 + license ubuntu）与 `compat` 全绿 |

发布动作（tag 之后由 `release.yml` 自动执行）：npm publish（`dsh-fang`）→ GitHub Release（附 tarball+manifest）→
Docker healthz 镜像（可选 secrets）→ `healthz --remote` 复核 npm/GitHub 远端版本。

已知边界：
- 容器探针（`FANG_CONTAINER_LIVE=1`）依赖 Windows AppContainer，Linux CI 只做模块导入兼容；
- Docker 镜像只提供 `/healthz` 发布健康服务，不是完整 DSH/Electron 运行环境；
- npm 包名是 `dsh-fang`（仓库内本地 bundle 名 `@local/dsh-fang` 在构建时统一改写）。
