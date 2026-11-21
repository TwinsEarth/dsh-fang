# v3.6.1 三方发布记录（2026-11-22）

> 用户指令：**三方发布，v3.6.1**。基线 v3.6.0；本版 = 加速分身会话兼容 shim + 还原强制 reprovision。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.6.1** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 加速分身无法打开 stock 会话：catalog v3→v1、删除 v1 禁用的 `name`、加速核不认识的 stock 新事件（如 `team/mode`）标 `ignorable`；在加速 spawn/provision/import 自动执行（帧保留 + 备份）。
- 还原 timeout：`resetForkConfig` 后强制 reprovision，避免 stock 配置 + 加速 CLI 混搭。
- 只改分身会话副本，母体会话不动。

## 2. 门禁（发布前实测）

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e | 待回填 | — |
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

- 包：`@twinsearth/fang-dsh-plugin@3.6.1`（latest 待回填）
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.6.1

## 4. 诚实边界

- 兼容垫片只保证加速核可读；未知事件在加速视图被跳过（team 等不渲染），根治需升级加速核（npm 最新 3.5.0）。
- 三方发布为手工执行（self-hosted Windows runner 离线）。
- 私有镜像 verify 未执行（无 MIRROR_TOKEN）。
