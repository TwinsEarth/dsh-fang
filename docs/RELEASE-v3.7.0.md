# v3.7.0 三方发布记录（2026-11-22）

> 用户指令：修复 5 项问题，「queue-journal 默认关闭随新版本发布」；版本号 **3.7.0**（用户确认）。
> 基线 v3.6.2（`32a496c`）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.7.0** | 5 项修复 + 推荐清单 |
| `@twinsearth/dsh-fang-queue-journal` | **0.1.8** | 子包 patch 默认 `disabled: true` |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 不变 |

## 1. 内容

- 元主 Web 插件设置（内置/实验性/第三方）在分身下一次打开时同步。
- 默认元宝改为保底「开发者推荐（官方）」，不再每次重启新增。
- 开发者推荐：安装/开启两组推荐第三方插件，所有已安装实验性插件默认开启。
- 元主运行态缺包（`@twinsearth/dsh-2xray`）修复。
- queue-journal 默认关闭，需手动开启。

## 2. 门禁（发布前实测）

| 门禁 | 结果 | 证据 |
|---|---|---|
| 全量 npm test | **1318 pass / 0 fail / 2 skip**（1330 tests） | `archive/test-5fixes.log` |
| preflight --e2e | **GREEN 10/10** | tests 1318/0/2；e2e 125/125；routes 111 / allowlist 0；plugins 16 |
| 发布 PR CI（#147） | **8/8 绿** | gate/test 22+24/compat 22+24/hygiene/license |
| release-order | **10/10 GREEN，warnings=0** | pre-tag / post-publish |
| 合并 | PR **#147** squash → `6ed261031bacb4ca2b9cec9e8da7bc7cfd5e41e1` | main 线性历史 |

## 3. 发布结果（2026-11-22 已完成三方发布）

### 3.1 git tag（annotated）

- tag：**v3.7.0**
- 远端 tag object：`8e10c55333ca7cd5b3d90cfcb315c945792de036`
- 指向 commit：`6ed261031bacb4ca2b9cec9e8da7bc7cfd5e41e1`（main 尖端）
- `verify-release` 校验 annotated / first-parent 通过。

### 3.2 GitHub Release

- 地址：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.7.0（release id `454195840`，名称 **v3.7.0**）
- 资产（4）：
  - `dsh-fang-3.7.0.tgz` — 702,520 B，sha256 `f333144ab8ef109c2dee7d82a585d7e5e255f4adc5fb9d2679bbeac100f51e9b`
  - `dsh-fang-3.7.0.tgz.sha256` — 85 B
  - `manifest.json` — 11,391 B
  - `preflight.json` — 1,872 B

### 3.3 npm

- 主包：**@twinsearth/fang-dsh-plugin@3.7.0**（`latest=3.7.0`）
  - `dist.shasum=8f4f796bf8d2bbf6965b9f162d513e32faeda0f0`（= 本地产物 sha1）
  - `dist.integrity=sha512-CiB7KaSkz1juZGS18LM5+jjbLS1Q2JhAKPoyLzkEnT3KyubJzneWzR7dNb0GjBA5bwrCsYn3ITUDYf3b+qRWxQ==`
  - 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.7.0
- 子包：**@twinsearth/dsh-fang-queue-journal@0.1.8**（`latest=0.1.8`，shasum `65a4f60628c1230359696a5e9d3b24a26d22eda5`）

### 3.4 发布后校验

- `verify-release --remote` → **GREEN 16/16**；`release-order` → **10/10 GREEN**；`healthz --remote` → **HEALTHY @3.7.0**。

## 4. 诚实边界

- 推荐清单中本机**未安装**的第三方包不自动 pnpm 安装；只对已安装项写入启用/禁用行。
- 官方元主仍锁定，不支持改设置/重命名/归档。
- 三方发布为手工执行（self-hosted Windows runner 离线）。
- 私有镜像 verify 未执行（无 MIRROR_TOKEN）。
