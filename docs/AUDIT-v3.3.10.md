# AUDIT v3.3.10

范围：收件箱滚动与滚动条。

## UI 合约

| 项 | 值 |
|---|---|
| drawer | 100vh/100dvh, overflow hidden |
| body | flex:1 1 0; height:0; overflow-y:scroll |
| scrollbar | 12px WebKit + thin |
| wheel | 显式转发到 body（passive:false） |
| AI 区 | max-height:32vh, overflow:auto |

## 验证

- client-inbox-dom 20 pass。
