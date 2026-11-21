# v3.6.0 Stable 三方发布记录（2026-11-22）

> 用户指令：**三方发布：tag/GitHub Releases/NPM，v3.6.0 Stable 稳定版**。
> 基线 v3.5.9；本版内容 = 分身状态栏（4 态 + 2 操作）+ 一键修复 + 核心切回 stock 别名清理 + 还原不再强制归档。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.6.0** | 本次三方发布主体（Stable） |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变（`src/contract/VENDOR.json`） |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 母体面板分身状态栏：**运行中 / 等待启动 / 已停止 / 故障**；两个操作「启动」「一键修复」（折叠时状态栏也可见）；
- 一键修复接口 `POST /fang/api/tasks/repair`：停残留 → 清加速别名桩 → 按来源原身重置 profile → 修 node_modules → 重新拉起；返回逐步 `steps[]`，不删除 home/会话/存档；
- 核心从 accelerated 切回 stock 时自动清理 `@deepseek-ai/*` 加速别名桩（只删 `0.0.0-fang-alias` 桩），修复启动/还原 `spawn-failed exited`；
- 还原任务接受 `failed`/`archived`，取消客户端“先归档再还原”的强制归档 fallback。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e（发布提交） | **GREEN 15/15** | tests **1311 pass / 0 fail / 2 skip**；e2e **125/125**；allow-list **0**（111 路由）；artifact sha256 match |
| 发布 PR CI（#141） | **8/8 绿** | gate required / test node22+24 / compat node22+24 / hygiene / license；e2e self-hosted skipped（runner 离线） |
| version-cut --check | **GREEN** | 3.5.9 → 3.6.0 = minor |
| release-order | **10/10 GREEN，warnings=0** | pre-tag / post-publish 均通过 |
| 合并 | PR **#141** squash → `21c5ddab41` | main 线性历史，tag 打在 main 尖端 |

真机核对：本机 v3.5.9→v3.6.0 修复后，损坏的 `task_mwqedbzich9m` profile 清掉 24 个别名桩后用 stock CLI 实测可启动（取得 Web URL 后探针退出）；一键修复把同样步骤收敛为单接口。

## 3. 发布结果（2026-11-22 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.6.0**（annotated object `9f4c3b417c752d999df253ca2917c665c5efb6bf` → commit `21c5ddab41bcb86bccc33cfafd607fff3e421e52`，即 main 尖端）
- 状态：已推送远端；`verify-release` 校验 first-parent 通过。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.6.0（release id `453919931`，名称 **v3.6.0 Stable**，非 draft / 非 prerelease）
- 资产（4，附 GitHub 记录 sha256）：
  - `dsh-fang-3.6.0.tgz` — 696,934 B，sha256 `628f39f243fb473a8eb3d07b2928e7cd35e94447cb159b12dce3e614e4168dc9`
  - `dsh-fang-3.6.0.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B
  - `preflight.json` — 1,872 B（v3.6.0 GREEN 报告）

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.6.0**（`dist-tags.latest=3.6.0`）
- 发布方式：npm registry REST（`tools/release/publish-npm.mjs`，主城门禁 publish 级 PASS，一次成功）
- 校验：registry `dist.shasum=11af9b7c0ae60039a612e0af76aa6e149be81fa4`（与本地产物 sha1 一致），
  `dist.integrity=sha512-Fm29nXp/o1c6DkKqk90ZxVOMW2uHbVXRZ0NkhXzH3eX0EI6uu5K26QFi2PLhPmDUOf6u2ykxWqXRj0sAhebVNg==`；
  registry 传播约 4–5 分钟后 `latest` 可见（与既有版本一致）。
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.6.0

### 3.4 发布后校验

- `node tools/git/verify-release.mjs --tag v3.6.0 --remote --json` → **GREEN**（16 项：tag/版本/文档/线性历史/preflight GREEN+e2e 真跑/artifact sha256/remote healthz 全 PASS）。
- `node tools/release/release-order.mjs --json` → **10/10 GREEN，warnings=0**。
- `healthz --remote`：`HEALTHY @twinsearth/fang-dsh-plugin@3.6.0`（npm + GitHub Release 均可取到）。

## 4. 诚实边界

- 三方发布为手工执行：tag push 触发 `release.yml`，其中 guard/test 在 ubuntu 运行，build/npm/GitHub Release 仍依赖 self-hosted Windows runner（离线），本版未把该自动链路作为发布通道；
- 一键修复只做进程/配置/模块层修复，不删除数据；运行中分身会重启（面板二次确认）；
- 私有镜像 verify 未执行（本机无 MIRROR_TOKEN）。
