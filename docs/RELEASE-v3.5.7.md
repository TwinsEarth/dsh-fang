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

## 2. 门禁（发布前实测）

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e | **GREEN** | tests **1302 pass / 0 fail / 2 skip**；e2e **125/125**；main-city A；allow-list **0**（110 路由）；artifact sha256 match |
| 发布 PR CI | 待回填 | 8/8 绿（gate required / test node22+24 / compat / hygiene / license；e2e self-hosted skipped） |
| release-order | 待回填 | 10/10 GREEN |
| 合并 | 待回填 | PR #? squash → main |

## 3. 发布结果（发布后回填）

### 3.1 git tag（annotated）

- tag：v3.5.7 → commit 待回填
- 状态：待回填

### 3.2 GitHub Release

- 地址：待回填
- 资产（3）：`dsh-fang-3.5.7.tgz`（size/sha256 待回填）、`.sha256`、`manifest.json`

### 3.3 npm

- 包：`@twinsearth/fang-dsh-plugin@3.5.7`（`latest` 待回填）
- 校验：`dist-tags.latest`、`dist.shasum` 与本地产物 sha1 一致、`dist.integrity`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.7

## 4. 诚实边界

- 三方发布为手工执行（self-hosted Windows runner 离线；`release.yml` 的 e2e/自动发布 job 不参与）；
- 项目迁移不改运行时行为；`FANG_HOME`（`D:\ToFuture`，约 3.5 GB）未迁移、未改动；
- UI 改动只影响派生弹窗与页脚展示，不改派生/审批/安全语义。
