# AUDIT v3.4.0

范围：母体（宿主）浮窗总开关。

## 契约

| 项 | 值 |
|---|---|
| 状态载体 | `document.documentElement[data-fang-overlays]` = `visible`/`hidden` |
| 偏好键 | `localStorage["fang.overlays.hidden"]` = `0`/`1` |
| 恢复入口 | 侧栏底部「浮窗」按钮（永不隐藏）、面板头同名按钮 |
| 隐藏范围 | relay FAB/panel、red alerts、inbox drawer/backdrop、mother palette、overlay、toast、essence notice |
| 不隐藏 | 宿主 UI、瓮城控制台本身、开关按钮 |
| 状态语义 | 纯视觉开关；不 unmount、不清队列、不 ACK |

## 风险与处置

- 隐藏后看不到红色阻塞？按钮文案变 `浮窗已隐藏`；恢复即回到原状态。
- localStorage 不可用（隐私模式）？只在本次 DOM 生效，不抛错。
- 跨窗口不同步？监听 `storage`，并广播 `fang:overlays-changed` 给同页组件。

## 验证

```text
client DOM 19/19（含新增开关用例）
全量测试见构建输出
```
