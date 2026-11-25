# AUDIT v3.1.20

范围：分身 Web「插件」入口隐藏的兼容性收口。

## 3.1.19 未生效的根因

| 可能原因 | 证据 / 处理 |
|---|---|
| 分身窗口是旧版本 | `GET /fang/adapter/identity` 显示 `version: 3.1.14`；分身是快照，需重新派生 |
| 侧栏行 class 变化 | 3.1.19 只匹配 `panelRow`；3.1.20 增加 nav/aside/sidebar 容器判据 |
| 文本带装饰 | 3.1.20 容忍零宽字符、空白、`插件 3` 计数 |

## 实现

- `client.js` `isPanelRow()` / `isPluginNavText()`：三条判据 + 文本归一化。
- 诊断：`<html data-fang-fork-locks="applied">`、`window.__fangForkLocks`。

## 验证

```text
npm test : 1084 tests / 1073 pass / 0 fail / 11 skip
jsdom    : 4 例（含「宿主丢弃 panelRow 类名」与诊断属性）
```
