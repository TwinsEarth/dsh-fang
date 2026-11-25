# 计划 · v3.0.7 S1：data 钩子 + 富面板断言 harness（docs-only）

> 状态：已评审计划，不含版本 bump。目标：把 UI-01…UI-12 从 todo 变成可重复的自动断言。
> 前置：`src/lib/ui-actions.mjs` 已提供 actions/blocks 语义；`UI-10/UI-11` 已真断言。

## 1. 目标与边界

**目标**
1. 渲染层补齐稳定 `data-*` 钩子（纯属性，不改视觉）；
2. 新增富面板挂载 harness（slots stub + headless Edge）；
3. 逐条把 UI-01…UI-12 转为真实 DOM 断言；
4. 失败可自动分析：输出 `{case, selector, expected, actual}`。

**不在本计划**
- 不 bump 版本；不改 actions/blocks 契约（只消费）；
- 不引入 Playwright/jsdom 依赖（复用系统 Edge + CDP）；
- 不改浏览器 client half 的最终去留（PC 面板迁移另立计划）。

## 2. data 钩子契约

| 属性 | 取值来源 | 断言用途 |
|---|---|---|
| `data-zone` | `header / essence / derived` | 三区存在性 |
| `data-btn-id` | `actions` 的 action id | 稳定选择器（UI-11） |
| `data-enabled` | `action.enabled` | 禁用态（UI-05/06/10） |
| `data-reason` | `action.reason`（禁用非空） | 禁用原因（UI-11） |
| `data-confirm` | `action.confirm`（none/once/strong） | 删除/归档确认（UI-08） |
| `data-state` | `phase`（running/paused/crashed/archived/unknown） | 状态色（UI-06） |
| `data-slot` | `0..6` | 7/5 槽位（UI-05） |

需要落的渲染点：Header Mother/派发；元主卡 7 动作；分身卡 6 动作；重命名 input（Enter/Esc）。

## 3. harness 设计（`tools/ui-rich-smoke.mjs`）

1. 本地静态服务：`/panel.html` 注入 client.js + 假 API（status/tasks/essence/list/rename）；
2. stub：`window.__ModuleLoader__.load` 捕获注册；`React.createElement` 返回 `{type, props}`；
   `ctx.slots.inject/register` 记录组件；
3. 调用 `plugin.apply(ctx)` → 取 `main` 组件 → `React.createElement` 结果里的 `DomMount.props.mount(host)` 挂到真实 DOM；
4. Edge headless + CDP：导航、等待渲染、按 `data-btn-id` 点击、读取 `data-*`/`window.__fangUiLog`；
5. 每条用例输出 `{id, ok, expected, actual}`，失败写 `dist/ui-cases.json`。

## 4. UI-01…UI-12 → 断言映射

| 用例 | 断言要点 |
|---|---|
| UI-01 | 三计数文本 = status/essence/tasks 的统计值 |
| UI-02 | 单击 `[data-btn-id="mother"]` → `[data-zone="palette"]` 可见；含 克隆/打开/备份 |
| UI-03 | 双击 Mother → `window.open` 记录母体 URL；不弹浮层 |
| UI-04 | 浮层 Esc / 遮罩关闭；焦点回到 Mother |
| UI-05 | `data-slot` 0–6；6/7 槽 `data-enabled="false"` 且有 reason |
| UI-06 | phase→`data-state`/色 token 映射：running/paused/crashed/archived/unknown |
| UI-07 | 双击名称 → input；Enter 调 rename；Esc 零请求；500 回滚 |
| UI-08 | 折叠开关；6 个动作按 actions 渲染；删除 `data-confirm="strong"` |
| UI-09 | 信息栏含会话名/创建/更新/体积 |
| UI-10 | locked 元主：配置/删除不渲染（服务端 actions 已禁） |
| UI-11 | 每个动作有 `data-btn-id`；禁用项 `data-reason` 非空 |
| UI-12 | F2 进入编辑；目标尺寸 ≥34px；`hover:none` 下动作常显 |

## 5. 顺序与验收

1. **H1** data 钩子（渲染层）→ UI-11/UI-10 先转真断言；
2. **H2** harness 骨架 + 假 API → UI-01/05/06 转真；
3. **H3** 交互（浮层/折叠/重命名）→ UI-02/03/04/07/08/09/12；
4. 全绿后把 10 条 todo 清零；`ui-smoke`（fallback）与 `ui-rich-smoke` 都进冒烟清单；
5. 每次提交跑 `preflight --e2e`，不 bump 版本；版本号仍为 3.0.7。

## 6. 风险

- slots stub 与宿主契约漂移 → 以 `apply()` 返回的 `inject: ['slots']` 为准，stub 只实现 `inject/register`；
- headless Edge 在 CI 可能缺失 → harness 缺浏览器时 `SKIP`（退出码 2），不阻断非 UI 门禁；
- 重命名 409/超时语义 → 由 `ui-actions` 的 code/reason 与后端 rename 契约共同断言。
