# 决策中心工具结果 lossless JSON

生效版本：`v3.3.9`

## P0 现象

调用 `request_human_decision` / `ask_user_choice` 时，DSH 报：

```text
value is not lossless JSON
```

## 根因

DSH `@deepseek-ai/dsh-tools` 在 tool pipeline 里对 **execute 的原始返回值**做
`snapshotJsonValue`（`dsh-tools/lib/pipeline.js`）。Fang 的结果对象含：

```js
{ selectedValue: undefined, selectedActionId: undefined, payload: undefined }
```

`undefined` 不是 lossless JSON；即使 `JSON.stringify` 会丢弃它，DSH 在字符串化之前
就已经拒绝。所以 ticket 已创建，但工具调用最终失败。

## 修复

- 新增 `toLosslessJson(value)`：丢弃 `undefined`，`NaN/Infinity → null`，`BigInt → string`；
- `request_human_decision` 母体 / fork 两条注册的全部 execute 返回都经过它；
- `ask_user_choice` 的三个返回路径同样经过它；
- 回归测试：resolved 结果必须无 `undefined` 字段且可 JSON round-trip。

## 验证

```bash
node --test test/decision-center.test.mjs
```
