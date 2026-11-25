# v3.6.2 三方发布记录（2026-11-22）

> 用户指令：**三方发布，v3.6.2**。基线 v3.6.1。
> **版本快照：与 v3.6.1 无功能/代码差异。**

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.6.2** | 版本快照（无代码变更） |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 不变 |

## 1. 内容

- 仅版本号与发布记录；代码与 v3.6.1 完全一致。
- v3.6.1 已包含：加速分身会话兼容 shim、还原强制 reprovision、「启动」按钮修正。

## 2. 门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e（发布提交） | **GREEN 15/15** | tests **1314 pass / 0 fail / 2 skip**；e2e **125/125**；allow-list **0**（111 路由）；artifact sha256 match |
| 发布 PR CI（#145） | **8/8 绿** | gate required / test node22+24 / compat node22+24 / hygiene / license |
| version-cut --check | **GREEN** | 3.6.1 → 3.6.2 = patch |
| release-order | **10/10 GREEN，warnings=0** | pre-tag / post-publish |
| 合并 | PR **#145** squash → `87d9f1ed1a` | main 线性历史 |

## 3. 发布结果（2026-11-22 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.6.2**（annotated object `20eec5c77dc779fed80f4e0c44412d2b1368a046` → commit `87d9f1ed1a3d48cf472dfeb5387661a4e06c6791`）
- 状态：远端存在；`verify-release` 校验 annotated / first-parent 通过。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.6.2（release id `454049597`，名称 **v3.6.2**）
- 资产（4）：
  - `dsh-fang-3.6.2.tgz` — 700,180 B，sha256 `7657a65e8f8b2fe6984608c859bf6d0725a4e31293f0590c4b6fab0f61a933bd`
  - `dsh-fang-3.6.2.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B
  - `preflight.json` — 1,872 B

### 3.3 npm

- 包：**@twinsearth/fang-dsh-plugin@3.6.2**（`latest=3.6.2`）
- `dist.shasum=dbbd5397560301826f82464a19e86ece1d879534`（= 本地产物 sha1）
- `dist.integrity=sha512-q0HKTtrpFiGXtBrA3jLYecE6haful4naVLtey0PotLR4Km3vvjAqWzkBCIF3Jl0WDYg6Tr75tqYvHwgyp2tslQ==`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.6.2

### 3.4 发布后校验

- `verify-release --remote` → **GREEN 16/16**；`release-order` → **10/10 GREEN**；`healthz --remote` → **HEALTHY @3.6.2**。

## 4. 诚实边界

- 无代码变更；安装 v3.6.2 与 v3.6.1 行为一致。
- 三方发布为手工执行（self-hosted Windows runner 离线）。
- 私有镜像 verify 未执行（无 MIRROR_TOKEN）。
