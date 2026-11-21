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

- 仅版本号与发布记录；代码与 v3.6.1 完全一致（`git diff v3.6.1..v3.6.2` 不应有 src/client 变更）。
- v3.6.1 已包含：加速分身会话兼容 shim、还原强制 reprovision、「启动」按钮修正。

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

- 包：`@twinsearth/fang-dsh-plugin@3.6.2`（latest 待回填）

## 4. 诚实边界

- 无代码变更；如果预期 v3.6.2 修复某个具体问题，请告知现象，下一版补上。
- 三方发布为手工执行（self-hosted Windows runner 离线）。
