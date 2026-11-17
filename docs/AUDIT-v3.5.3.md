# v3.5.3 审计（2026-11-18）

> 用户指令：**三方发布 v3.5.3**；母体操作面板改为三块：① 母体&元主 ② 决策中心 ③ 分身；
> 决策中心与分身分开（左列上=决策中心、下=分身，可通过滑块调节分区比例&大小）。

## 1. 变更

| 项 | 内容 |
|---|---|
| 面板布局 | 左列 = 决策中心（上）/ 分身（下）+ 水平分隔条；右列 = 母体&元主；列分隔条保留 |
| 决策中心 | 从分身滚动区移出，成为独立 `.panel` 块；mini 组件填满面板并自行滚动（`data-zone="decision"`） |
| 分隔条 | 水平：拖动 / ↑↓ / 双击 50:50，偏好 `fang.panel.decision.split`；垂直（列）：沿用 `fang.panel.split` |
| 加速分身修复 | `forker.provision()` 误用 `spawn()` 作用域的 `acceleratedHome` → 原身派生加速分身静默退回 minimal（插件面全失效）；已修复并显式失败 `accelerated-sync-unavailable` |

## 2. 测试

- `test/client-layout-dom.test.mjs`：三块 DOM 结构 + 两个分隔条（含持久化/键盘/双击）；
- `test/forker-accelerated-sync.test.mjs` 3 项（回归 + 显式失败 + minimal 仍可用）；
- 全量 tests / e2e 见 preflight 报告 `dist/preflight.json`。

## 3. 诚实边界

- 母体正式 profile 的 LSP 仍未安装（`docs/INSTALL-LSP-MOTHER.md`），生产 LSP 委托仍 `contract-unavailable`；
- fork-local（路线 B）安装默认关闭；
- 面板布局为 jsdom + 现有 headless 冒烟级验证；未做真实桌面窗口截图回归。
