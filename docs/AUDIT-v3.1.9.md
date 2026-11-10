# AUDIT v3.1.9

> 版本：3.1.9（2026-11-10）
> 范围：元主 / 分身工作区滚动（鼠标滚轮 + 可拖动滚动条）+ 中间分隔条。

## 1. 问题与根因

| 现象 | 根因 | 修复 |
|---|---|---|
| 元主/分身多了以后，列表底部无法选中 | `.fang-console` 只有 `min-height:100%`（无上界），`.panel` 用 `max-height:calc(100vh - 132px)` 估算；DSH `main` 槽（`mainPanel` = `flex:1;min-height:0;overflow:hidden`）给的高度更小，超出部分被宿主裁掉，且控制台自身没有滚动容器 | 高度链改为 `main 挂载节点 flex:1;min-height:0;height:100%` → `.fang-console height:100%;overflow:hidden` → `.fang-body height:100%;overflow:hidden;align-items:stretch` → `.panel height:100%`；两栏内部各自 `.panel-scroll` 滚动 |
| 左栏滚动区几乎为 0 高（即使滚动条存在） | 元主卡片 `.essence-list` 直接挂在 `.panel` 上、在 `.panel-scroll` 之外；卡片越多，同级的会话滚动区越矮 | 把 `.essence-head` + `.essence-list` 用 `prepend` 收进左栏唯一的 `.panel-scroll[data-sk="left"]`；右栏保持单一 `.panel-scroll[data-sk="right"]` |
| 滚动条太细/不可拖 | `.panel-scroll` 只有 `scrollbar-width:thin` 与 10px webkit 滚动条，且无 `scrollbar-gutter` | 明确 `overflow-y:auto;scrollbar-gutter:stable`；12px 宽滚动条（thumb 30% 黑、hover 46%），`scrollbar-color` 同步；轨道可见 |
| 中间比例调节 | 已有 `.fang-split-handle` + grid 列宽拖动 | 保留；左右两栏各自滚动、互不影响 |
| 窄屏堆叠 | 单列时高度约束会把两栏压扁 | `@media (max-width:1100px)`：整页滚动，每栏 `height:auto;max-height:62vh`，分隔条隐藏 |

## 2. 验证证据

### 单元/结构（可进 CI）

```text
node --test test/client-layout-dom.test.mjs
✔ client layout: the main slot fills a DSH-like fixed-height panel and both columns scroll
✔ client layout: the middle split handle is registered for width resizing
2/2 pass

既有 client 套件（inbox DOM + HTTP contract + layout） 22/22 pass
版本相关：kernel / plugins-shape / role-extensions 31/31 pass（FANG_VERSION=3.1.9）
```

断言内容：主槽挂载节点 `display:flex;flex-direction:column;flex:1 1 auto;min-height:0`；
两栏各一个 `.panel-scroll`；24 张元主卡片全部在左滚动区内且不是 `.panel` 的直接子节点；
右栏任务卡片在右滚动区内；CSS 含 `height:100%/overflow:hidden/overflow-y:auto/scrollbar-gutter:stable/12px 滚动条/窄屏 62vh`；中间分隔条存在。

### 真实浏览器冒烟（本地 headless Edge，不入 CI）

环境：1440×900，DSH 主面板结构（`#mainPanel` flex column、`overflow:hidden`），模拟 30 元主 + 30 分身；
通过 CDP 发送真实鼠标滚轮与拖拽事件：

```text
左栏 .panel-scroll:  scrollTop 0 → 420（wheel），clientHeight 342 / scrollHeight 3056
右栏 .panel-scroll:  scrollTop 0 → 420（wheel），clientHeight 445 / scrollHeight 5777
中间手柄拖拽 160px:  grid columns 692px 692px → 850px 534px
截图：两栏各显示可拖动滚动条；滚到底部可见元主 29/30 与分身 28/29/30（已人工核对）
控制台错误：0；mountError：0
```

## 3. 发布

本次发版由 tag `v3.1.9` 触发的 release workflow 完成（guard → tests → build+e2e → GitHub Release → npm → private mirror → healthz → final verify）。
产物摘要以 npm registry 的 `dist.shasum` / `dist.integrity` 与 GitHub Release asset digest 为准；
本文件随 tag 冻结，不再回写发布后数字（v3.1.8 的教训：tag 后再改文档需要移动 tag，会造成 npm 与 Release 产物摘要不一致）。

## 4. 已知边界

- 只改 web 控制台；Electron 桌面板是另一套 UI，不在本版范围。
- macOS 触控板使用系统覆盖式滚动条；滚动条可见性由平台决定。
- 真实滚轮/拖拽验证依赖本地浏览器冒烟，CI 只跑 jsdom 结构/CSS 契约。
- 若宿主 `main` 槽未来取消 `min-height:0`/`flex` 链，高度约束会重新失效；`client-layout-dom` 测试会先失败。
