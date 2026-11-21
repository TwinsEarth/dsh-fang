# v3.6.0 Stable 三方发布记录（2026-11-22）

> 用户指令：**三方发布：tag/GitHub Releases/NPM，v3.6.0 Stable 稳定版**。
> 基线 v3.5.9；本版内容 = 分身状态栏 + 一键修复 + 核心切回 stock 的别名清理 + 还原不再强制归档。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.6.0** | 本次三方发布主体（Stable） |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变（`src/contract/VENDOR.json`） |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 母体面板分身状态栏：运行中 / 等待启动 / 已停止 / 故障；两个操作「启动」「一键修复」；
- 一键修复接口：停残留 → 清加速别名桩 → 按来源原身重置 profile → 修 node_modules → 重新拉起；不删除 home/会话；
- 核心从 accelerated 切回 stock 时自动清理 `@deepseek-ai/*` 加速别名桩，修复启动/还原 `spawn-failed exited`；
- 还原任务接受 failed/archived，取消客户端“先归档再还原”的强制归档 fallback。

## 2. 门禁（发布前实测）

| 门禁 | 结果 | 证据 |
|---|---|---|
| preflight --e2e | **GREEN** | tests **1311 pass / 0 fail / 2 skip**；e2e **125/125**；allow-list 0（111 路由）；artifact sha256 match |
| 发布 PR CI | 待回填 | — |
| release-order | 待回填 | — |
| 合并 | 待回填 | — |

## 3. 发布结果（发布后回填）

### 3.1 git tag（annotated）

- tag：待回填
- 状态：待回填

### 3.2 GitHub Release

- 地址：待回填
- 名称：**v3.6.0 Stable**
- 资产：待回填

### 3.3 npm

- 包：`@twinsearth/fang-dsh-plugin@3.6.0`（`latest` 待回填）
- 校验：`dist-tags.latest`、`dist.shasum` 与本地产物 sha1 一致、`dist.integrity`
- 页面：https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.6.0

## 4. 诚实边界

- 三方发布为手工执行（self-hosted Windows runner 离线；`release.yml` 的 build/npm/Release job 不参与）；
- 一键修复只做进程/配置/模块层修复，不删除数据；运行中分身会重启（面板确认）；
- 私有镜像 verify 未执行（本机无 MIRROR_TOKEN）。
