# dsh-Fang v3.1.9 发布说明

- 版本：`3.1.9`（上一个发布 `3.1.8`）
- 主题：元主 / 分身工作区滚动（鼠标滚轮 + 可拖动滚动条），中间分隔条调节两栏宽度。

## 问题

元主与分身数量变多后，列表底部超出可视区域、无法选中：

- 控制台整页高度没有被约束到 DSH `main` 面板，多余内容被宿主 `overflow:hidden` 裁掉；
- 左栏的元主卡片（`.essence-list`）位于滚动容器之外，卡片一多就把母体会话滚动区挤到几乎 0 高；
- 两栏都没有可靠的可拖动滚动条。

## 修复

1. **高度链贯通**
   - `main` 槽挂载节点：`display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%`；
   - `.fang-console`：`height:100%;overflow:hidden`；
   - `.fang-body`：`align-items:stretch;height:100%;overflow:hidden`；
   - `.panel`：`height:100%`（不再用 `100vh` 估算）。
2. **两栏各自滚动**
   - 左栏：元主卡片 + 母体会话统一进 `.panel-scroll[data-sk="left"]`；
   - 右栏：任务卡片在 `.panel-scroll[data-sk="right"]`；
   - `.panel-scroll`：`overflow-y:auto;scrollbar-gutter:stable`，12px 宽可拖动滚动条，支持鼠标滚轮 / 触控板。
3. **中间分隔条**：拖动调节左（元主）/右（分身）宽度比例，两栏滚动互相独立。
4. **窄屏（≤1100px）**：整页滚动 + 每栏 `max-height:62vh` 内部滚动，分隔条隐藏。

## 升级

```bash
pnpm add @twinsearth/dsh-fang@3.1.9
```

重启 DSH 桌面应用后生效（client 半随宿主加载）。

## 验证

- 新增 `test/client-layout-dom.test.mjs`（jsdom）2 例：主槽高度链 / 两栏滚动容器 / 元主卡片在左滚动区内 / CSS 契约 / 分隔条存在；
- 本地 headless Edge 实测（1440×900，30 元主 + 30 分身）：
  - 左栏 wheel 0→420，scrollHeight 3056 / clientHeight 342；
  - 右栏 wheel 0→420，scrollHeight 5777 / clientHeight 445；
  - 拖动中间手柄：列宽 692/692 → 850/534；
  - 截图确认两栏滚动条可见、滚动到底部可选中最后一项。
- 既有 client DOM/HTTP 套件 22/22 通过；完整门禁结果见 `docs/AUDIT-v3.1.9.md` 与 release workflow。

## 已知边界

- 本轮只调整 web 控制台布局；Electron 桌面板（`dsh-fang-desktop/panel`）为另一套 UI，未改动。
- 滚动条宽度沿用 Chromium/WebKit 样式（Windows/Linux）；macOS 触控板走系统覆盖式滚动条。
- 布局回归测试在 jsdom 中断言结构/CSS 契约，真实滚轮与拖拽由本地 headless Edge 冒烟覆盖，未纳入 CI（CI 无浏览器滚动度量）。
