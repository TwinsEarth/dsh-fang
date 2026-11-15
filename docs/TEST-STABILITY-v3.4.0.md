# 测试稳定性修复（v3.4.0）

## 问题

release 的 `test (node 22)` 在 `decision-level-policy.test.mjs` 偶发失败/挂起：

```text
expected: deferred
actual:   undefined
```

并在重跑时卡住 20+ 分钟。Node24 全量测试正常。

## 根因

测试直接 `await service.wait(yellowId)` / `await service.wait(blueId)`，
依赖 60ms 策略定时器在重载 runner 上准时唤醒；等待没有上限，漏唤醒就会挂死整条测试。
另一个 history 用例只等蓝票 resolved，没等黄票 deferred，存在竞态。

## 修复

- 改为有界 `waitFor(..., 5000)` 轮询持久化状态；
- history 用例同时等待 yellow=deferred 且 blue=resolved；
- 不改变产品逻辑，只消除测试对定时器唤醒顺序的依赖。

## 验证

```bash
node --test test/decision-level-policy.test.mjs
```
