# v3.5.7 三方发布记录（2026-11-21）

> 用户指令：**三方发布，v3.5.7**（v3.5.5 之后的迁移与 UI 改动；跳过未发布的 3.5.6，见 `docs/RELEASE-WAIVER-v3.5.7.md`）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.7** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变（`src/contract/VENDOR.json`） |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 项目整体迁入 `E:\DSH\DS\Fang`（含 git 历史/本地资料/会话快照与官方 ZIP/契约子仓库/会话工具），旧仓库只读保留；
- 派生弹窗会话三分组：① 最近 7 天活跃（可选）；② 已归档（折叠、灰色只读、不可选）；③ 更早（>7 天且未归档，折叠可选）；归档优先于时间；
- 派生倒计时 5 秒 → **7 秒**；
- 移除母体面板页脚提示行（独立门户入口保留在顶部工具区）；
- CHANGELOG「v3.5.7」段 + AUDIT-v3.5.7。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e（发布提交） | **GREEN 15/15** | tests **1302 pass / 0 fail / 2 skip**（本地 150s 级）；e2e **125/125**；main-city A；allow-list **0**（110 路由） |
| 发布 PR CI（#135） | **8/8 绿** | `gate (required)=success`；test node22/24、compat node22/24、hygiene、license 全 success；`e2e (self-hosted windows)` skipped（runner 离线，与既有版本一致） |
| release-order（pre-tag / main 产物） | **10/10 GREEN** | 产物新鲜、sha256 匹配、contract 1.2.0 已发布、tag 未打 |
| 合并 | PR **#135** squash → `9ccbc848b7` | main 线性历史，tag 打在 main 尖端 |

## 3. 发布结果（2026-11-21 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.5.7**（annotated object `cf672d8a3b128e41cb42e9a6e613e05b1ddd35d2` → commit `9ccbc848b79e5a1eabf614613812d1beba8dd218`，即 main 尖端）
- 状态：已推送远端（`refs/tags/v3.5.7`），`verify-release` 校验 first-parent 通过。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.5.7（release id `453654094`，非 draft / 非 prerelease）
- 资产（4，附 GitHub 记录 sha256）：
  - `dsh-fang-3.5.7.tgz` — 691,006 B，sha256 `74d9c3d436d1c1febe9fdb12a82404ae3a37364c3fa84ff4bb17cb737acd8e9a`
  - `dsh-fang-3.5.7.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B
  - `preflight.json` — 1,872 B（v3.5.7 GREEN 报告）

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.5.7**（`dist-tags.latest=3.5.7`）
- 发布方式：npm registry REST（`tools/release/publish-npm.mjs`，主城门禁 publish 级 PASS，一次成功）
- 校验：registry `dist.shasum=8b9f67e58211cc6e70c38588b7a062c870dfeec3`（与本地产物 sha1 一致），
  `dist.integrity=sha512-Rzh4hdZqbu8BsgCuG+q7pZsp1gC4DJ3QQu6icBx6fCecXTPrTMgq0scPWvR+haTcpAl3+ICs1y9wE1Ukshg46A==`；
  registry 传播约 3–4 分钟后 `latest` 可见（与既有版本一致）。
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.7

### 3.4 发布后校验

- `node tools/git/verify-release.mjs --tag v3.5.7 --remote --json` → **GREEN**（tag annotated / 在 main first-parent /
  版本一致 / CHANGELOG+AUDIT / preflight GREEN+e2e 真跑 / artifact sha256 match / remote healthz HEALTHY）；
  报告：`dist/release-verify.json`。
- `node tools/release/release-order.mjs --json` → **10/10 GREEN，warnings=0**。
- `healthz --remote`：`HEALTHY @twinsearth/fang-dsh-plugin@3.5.7`（npm + GitHub Release 均可取到）。

## 4. 诚实边界

- **三方发布为手工执行**：tag push 会触发 `release.yml`（run `44900926089`），其中 guard/test 在 ubuntu 运行，
  但 build/npm/GitHub Release/Docker/healthz 依赖 self-hosted Windows runner（离线），本版按既有惯例不把该自动链路
  作为发布通道；npm 与 GitHub Release 均由本机脚本直接发布并已复核。
- 项目迁移不改运行时行为；`FANG_HOME`（`D:\ToFuture`，约 3.5 GB）未迁移、未改动。
- UI 改动只影响派生弹窗与页脚展示，不改派生/审批/安全语义。
- 私有镜像 verify（`sync-private.mjs`）未执行：本机无 MIRROR_TOKEN；如需私有镜像需单独授权与配置。
