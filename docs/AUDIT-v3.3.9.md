# AUDIT v3.3.9

范围：决策中心工具结果的 lossless JSON 修复。

## 根因证据

DSH `dsh-tools/lib/pipeline.js`：

```js
const detached = snapshotJsonValue(candidate)
if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"])
```

Fang 结果中的 `undefined` 属性触发该检查。

## 合约

| 项 | 值 |
|---|---|
| 修复函数 | `toLosslessJson` |
| undefined | 丢弃 |
| NaN/Infinity | null |
| BigInt | string |
| 覆盖 | request_human_decision 母体/fork、ask_user_choice |
