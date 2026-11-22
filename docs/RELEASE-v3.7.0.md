# v3.7.0 三方发布记录（2026-11-22）

> 用户指令：修复 5 项问题，「queue-journal 默认关闭随新版本发布」；版本号 **3.7.0**（用户确认）。
> 基线 v3.6.2。

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
| 全量 npm test | 1318 pass / 0 fail / 2 skip | 本地实测 |
| preflight --e2e | GREEN | `dist/preflight.json` |
| 发布 PR CI | 待回填 | — |
| release-order | 待回填 | — |
| 合并 | 待回填 | — |

## 3. 发布结果（发布后回填）

### 3.1 git tag

- tag：待回填

### 3.2 GitHub Release

- 地址：待回填
- 资产：待回填

### 3.3 npm

- 包：`@twinsearth/fang-dsh-plugin@3.7.0`（latest 待回填）
- 子包：`@twinsearth/dsh-fang-queue-journal@0.1.8`

## 4. 诚实边界

- 推荐清单中本机未安装的包不自动安装。
- 三方发布为手工执行（self-hosted Windows runner 离线）。
