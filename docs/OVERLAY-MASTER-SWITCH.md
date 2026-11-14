# 宿主浮窗总开关（v3.3.2）

## 目标

母体（宿主）页面里，瓮城的决策浮标、红色告警、收件箱抽屉、Mother 浮窗、通知/弹层都是浮层。
需要一键隐藏/显示，而不是逐个关闭；隐藏后还要能随时恢复。

## 入口

| 位置 | 形态 | 说明 |
|---|---|---|
| 宿主侧栏底部 | `浮窗` / `浮窗已隐藏` 按钮 | 常驻；其他浮窗全隐藏时仍然可见，作为恢复入口 |
| 瓮城控制台面板头 | `隐藏浮窗` / `显示浮窗` 按钮 | 在控制台内直接切换 |
| 偏好 | `localStorage['fang.overlays.hidden']` | `1` 隐藏 / `0` 显示；刷新、重启后保持 |
| 跨窗口 | `storage` 事件 | 一个窗口切换，其他窗口同步 |

## 行为

1. 切换 `document.documentElement[data-fang-overlays]` 为 `hidden|visible`；
2. CSS 统一隐藏以下瓮城浮层（`display:none!important`）：
   - `.fang-relay-fab` / `.fang-relay-panel`（会话决策中继）
   - `.fang-red-alert-stack` / `[data-fang-red-alerts]`（红色告警）
   - `.fang-inbox-drawer` / `.fang-inbox-backdrop`（收件箱抽屉）
   - `.mother-palette`（Mother 浮窗）
   - `[data-fang-essence-notice]`（元主落地提示）
   - `.fang-console .overlay`（确认/截图等弹层）
   - `.fang-console .toast`（面板 toast）
3. **不销毁 DOM、不关闭状态**：隐藏只是视觉开关；再显示时原样恢复（例如收件箱仍停在原分组/滚动位置）。
4. 不隐藏宿主自己的 UI 与瓮城面板本身；开关按钮自身也不在隐藏列表里。

## 明确不做

- 不修改宿主的浮窗系统，不注入全局 CSS 变量；
- 不把「隐藏」当成分身/元主 UI 锁（那是角色收敛，不是浮窗偏好）；
- 不在隐藏时丢弃红色告警：告警仍在 DOM 中，恢复后可见；若需要真正处理，必须点开关显示后再处置。
