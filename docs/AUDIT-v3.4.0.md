# AUDIT v3.4.0

范围：收件箱滚动 + 发布测试稳定性。

## 收件箱

| 项 | 值 |
|---|---|
| drawer | 100vh/100dvh, overflow hidden |
| body | flex:1 1 0; height:0; overflow-y:scroll |
| scrollbar | 12px WebKit + thin |
| wheel | 显式转发到 body（passive:false） |

## 测试稳定性

| 项 | 值 |
|---|---|
| 失败点 | decision-level-policy: deferred vs undefined |
| 根因 | 无上限等待 60ms 定时器 + 只等蓝票 |
| 修复 | 有界轮询/同时等待黄蓝 |
| 产品逻辑 | 未改 |
