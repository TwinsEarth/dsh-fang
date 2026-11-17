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

## 1.1 真机（v3.5.2）加速核心无法启动 & 按钮点击无效 —— 根因与修复

| # | 根因 | 修复 |
|---|---|---|
| 1 | `forker` 只在 `cfg.dataRoot` 存在时解析 layout → 生产 `acceleratedHome=''`，`fork-core` 报未安装、派生 409 | layout 始终解析；加速核位置统一 `FANG_HOME`/`fang-home.txt` |
| 2 | orchestrator 把母体 stock CLI 作为 `cliPath` 传给加速 spawn | 加速档忽略 stock CLI，仅 config/state/layout |
| 3 | 子进程环境白名单丢掉 `ELECTRON_RUN_AS_NODE`，桌面宿主启动 JS 入口时 exit 0 无输出 | JS 入口 spawn 补 `ELECTRON_RUN_AS_NODE=1` |
| 4 | 面板按钮 onClick 调用未定义 `toast()` → ReferenceError（点击无效） | 改用 `app.notify()`；spawn 失败带回 code/signal/log |

真机等价验证：隔离母体（stock DSH + fang 3.5.3，`FANG_HOME=D:\ToFuture`，forker 不配 `acceleratedCliPath`）
GET fork-core `installed=true`（source=state）→ POST 切加速 200 → 创建分身 `200 status=ready`、`adapter.version=3.5.3`。
## 2. 测试

- `test/client-layout-dom.test.mjs`：三块 DOM 结构 + 两个分隔条（含持久化/键盘/双击）；
- `test/forker-accelerated-sync.test.mjs` 3 项（回归 + 显式失败 + minimal 仍可用）；
- 全量 tests / e2e 见 preflight 报告 `dist/preflight.json`。

## 3. 诚实边界

- 母体正式 profile 的 LSP 仍未安装（`docs/INSTALL-LSP-MOTHER.md`），生产 LSP 委托仍 `contract-unavailable`；
- fork-local（路线 B）安装默认关闭；
- 面板布局为 jsdom + 现有 headless 冒烟级验证；未做真实桌面窗口截图回归。
