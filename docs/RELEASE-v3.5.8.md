# v3.5.8 三方发布记录（2026-11-21）

> 用户指令：**三方发布，v3.5.8**（v3.5.7 之后：会话目录与 DSH 宿主侧栏对齐 + 三分组展示）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.8** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变（`src/contract/VENDOR.json`） |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- `session-catalog` 与 DSH 宿主侧栏对齐：只列工作区注册表里的根会话（排除子代理/未登记目录），标题读 DSH 投影缓存；
- 会话三分组：活跃中（7 天）/ 已归档 / 旧会话（>7 天），组内按最后活跃时间从新到旧（母体面板 + 派生弹窗）；
- `allowArchived` 打开，归档分组可见（灰色只读，仍不可派生）；
- 空会话（宿主侧栏不显示）不再进入派生列表。

## 2. 门禁（发布前实测）

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e | **GREEN** | tests **1306 pass / 0 fail / 2 skip**；e2e **125/125**；main-city A；allow-list 0（110 路由）；artifact sha256 match |
| 发布 PR CI | 待回填 | — |
| release-order | 待回填 | — |
| 合并 | 待回填 | — |

## 3. 发布结果（发布后回填）

### 3.1 git tag（annotated）

- tag：待回填
- 状态：待回填

### 3.2 GitHub Release

- 地址：待回填
- 资产：待回填

### 3.3 npm

- 包：`@twinsearth/fang-dsh-plugin@3.5.8`（`latest` 待回填）
- 校验：`dist-tags.latest`、`dist.shasum` 与本地产物 sha1 一致、`dist.integrity`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.5.8

## 4. 诚实边界

- 三方发布为手工执行（self-hosted Windows runner 离线；`release.yml` 的 e2e/自动发布 job 不参与）；
- 归档会话只展示/分组，仍不能作为派生导入源；
- 标题来自 DSH 投影缓存（派生数据），缓存缺失时回退日志有界读取并标注来源。
