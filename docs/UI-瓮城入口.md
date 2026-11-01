# 「瓮城」入口 — UI 设计规格与实现对照（v2.1.0）

> 需求：左侧导航栏显示「瓮城」，图标是红色城门模样；单击进入插件控制面板；双击快速跳转打开浏览器、
> 派生分身；进入浏览器标签页后可以选中已有会话 & 任务，进一步开发。
> 平台事实来自 2026-11-01 的活体 `Slots.listSubTree` 与已安装的 `dsh-client-ui-sidebar` 源码。

---

## 1. 平台事实（决定实现形态）

| # | 事实 | 出处 | 后果 |
|---|---|---|---|
| F1 | 左侧导航的真实槽位是 `sidebar.panellist`（root list）；登记项只有 `{id, order, label}` | Slots 拓扑 | 「瓮城」= 一个 panel 行；**图标 = 登记项组件本身**（外壳 `renderSlot('sidebar.panellist', {size, active}, {only:id})`），所以红色城门图标可行 |
| F2 | 行点击归外壳所有（`onClick → selectPanel(id)`），插件无法接管单击 | `ui-sidebar` 源码 `PanelRow` | 单击进面板 = 平台自动行为；**双击只能在图标组件这一层挂**（事件从图标冒泡到行，不冲突） |
| F3 | 中列面板槽是 `main`（root keyed，登记 `{key}`，key 已占用 `conversation` 等） | Slots 拓扑 | 必须同时登记 `main.key='fang'` 与 `sidebar.panellist.id='fang'`，否则 `selectPanel('fang')` 抛错、面板不切换 |
| F4 | 主题颜色 token 是 `--dsw-alias-*`；`--dsh-*` 只承载排版量 | `ui-theme` 契约 | 颜色全部走 alias token + 回退值；红色是插件艺术色 `--fang-gate-accent` |
| F5 | 客户端模块仍要求 loader 行是**裸包名**（`@local/dsh-fang`） | v2.0 实测 | 三个 UI 入口共用同一个 `client.js`，不新增 client 行 |
| F6 | `window.open` 在 `await 派生`（5–20s）之后调用会脱离用户手势 | 浏览器行为 | 弹窗可能被拦 → 面板里必须有「打开分身 ↗」兜底链接 |

---

## 2. 三处入口（同一个 Client 模块）

| 入口 | 槽位 | 单击 | 双击 |
|---|---|---|---|
| 左侧导航「瓮城」 | `sidebar.panellist` id=`fang` order=90 label=瓮城 | 外壳切到面板（原生） | **图标上挂双击** → 快速派生 + 打开标签页 |
| 中列面板 | `main` key=`fang` | — | — |
| 输入框 dock 徽标 | `conversation.composer.dock` id=`fang-badge` | 打开面板 | 快速派生（可发现性：`title` 写明两个手势） |

双击判定：400ms 窗口、6px 位移容差、带修饰键不成立、派生后 2s 冷却、进行中单手（再次双击合并到同一次）。

---

## 3. 红色城门图标

24 网格三笔结构：瓮圈（红，`--fang-gate-accent` 默认 `#C62828`）+ 门洞（`currentColor`，跟随行图标色）
+ 门基（弱化地平线）。渲染 16/18/20px 由外壳 `size` prop 决定，`stroke-width 1.75`、圆角端点。
`aria-hidden="true"`（可读名由行的 `label` 提供），不重复声明 `role="img"`。

---

## 3.5 控制面板布局（v2.2.0）

- **3:7 水平分屏**：左栏 3 份宽 = 母体「项目 & 会话」（按 workspace 分组），
  右栏 7 份宽 = 分身「项目 & 会话」（每个任务是一个项目，展开即该分身自己的会话）。
- 两栏都是独立滚动容器（`overflowY:auto` + 视口高度上限），条目多时面板本身不滚动。
- 交互：左栏会话 = 两段式「继续开发 →」（派生新分身 + lineage 种子）；
  右栏会话 = 「打开分身 →」；右栏项目保留 打开 / 归档，可折叠。
- 数据：左栏来自 `GET /fang/api/sessions`；右栏来自 `GET /fang/api/tasks/sessions?taskId=`
  （只读分身自己的 `<forkHome>/sessions`，有界解帧取标题）。

## 4. 面板信息架构）


```
┌ 城门 瓮城  [母体只读] [2/4 就绪] [1 运行中]              [派生新分身] [刷新] ┐
│ 最近一次快速派生结果（弹窗被拦时的「打开分身 ↗」兜底）                        │
├ 继续开发 · 已有会话 ──────────────────────────────────────────────────┤
│ 会话行（标题 / 短 id · 时间 · 工作区）         点击 = 选中（不派生）      │
├ 继续开发 · 任务 ──────────────────────────────────────────────────────┤
│ 任务行（标题 / 状态 · 端口 · adapter · 种子）  [打开] [归档]             │
├ 选中确认条：取消 / 继续开发 →（会话走 lineage 种子派生；任务直接打开）      │
└ 页脚：双击图标或徽标快速派生 · 独立门户 ↗                                  ┘
```

- **两段式**：点行只选中（可撤销），确认条里的「继续开发 →」才真的派生（5–20s + 一个配额位）。
- 列表只读元数据；会话正文只有 `digest`（≤32 KiB）被注入分身 `fang-seeds/<seedId>.md`，母体会话不被改写。
- 错误/空/加载态都显式呈现；离线时顶部常驻「母体状态不可读 + 重试」，不渲染假空列表。

---

## 5. 数据接口（v2.1.0 新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/fang/api/sessions` | 母体已有会话（只读元数据） |
| GET | `/fang/api/sessions/item?sessionId=` | 单个会话详情 |
| GET | `/fang/api/sessions/head?sessionId=` | 有界头读（脱敏预览） |
| POST | `/fang/api/derive` `{title?, sessionId?}` | 派生任务；带 `sessionId` 时先 `session-catalog.digest()` 生成 lineage 种子并写入分身 `<home>/fang-seeds/`，再调用 `createTask()` |

会话目录由 `fang-session-catalog`（母体 only，只读）提供；派生仍由 `orchestrator.createTask()` 负责，
`derive()` 只是组合：`digest → seed → createTask`，失败 fail-closed（`session-catalog-unavailable` /
`session-seed-failed`），不静默降级成无种子派生。

---

## 6. 已知边界

1. **导航行双击**只能挂在我们自己的图标组件上（行按钮归外壳），所以双击热区 = 图标面积（18px），
   不是整行；dock 徽标是更大的双击目标。
2. 客户端半需要**刷新页面**（新 bundle 在页面加载时装载）；宿主侧 v2.1 模块需母体重启（ESM 缓存）。
3. 「刷新中」保留旧列表；「离线」不显示假空态。
4. 会话继续 = lineage + 有界摘要（不复制 transcript、不挂载母体会话目录）——母体不可变的硬约束。
