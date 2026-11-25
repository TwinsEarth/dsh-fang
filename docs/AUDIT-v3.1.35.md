# AUDIT v3.1.35

范围：适配 `@twinsearth/dsh-fang-contract@1.1.0`（两个回流方法），不改既有方法语义。

## 改动面（最小 diff）

| 文件 | 改动 |
|---|---|
| `src/contract/*` | 从 npm 逐字节同步到 1.1.0（8 文件，新增 `relay.js`） |
| `src/contract/VENDOR.json` | 新增：版本 + 每文件 sha256（供一致性测试） |
| `src/plugins/orchestrator.mjs` | 引入 `createRelayStore`/`relayHandlers`；`handlers` 首行加 `...relayHandlers(relayStore)`；health 加只读 relay 计数 |

**传输层零改动**：local/http/file/legacy 全部复用。

## 关键常量

```text
peerLabel      : 'dsh-fang-bundle'   （房主据此判定真实瓮城对接）
CONTRACT_VERSION: 1.1.0
RELAY_LIMITS    : maxBatch=128  maxEventBytes=32000  maxPayloadBytes=512000  maxRecords=5000
capabilities    : [..., 
'event-relay']
```

## 安全

- `/fang/api/contract/*` 继续走现有 Bearer token；**未新增无鉴权路由**；
- relay 只记账，不联动修改其它服务状态；内存有界（maxRecords 5000，幂等窗口有界）。

## 验收对照（交接文档 §6）

| # | 项 | 结果 |
|---|---|---|
| 1 | `hello().methods` 含两个 relay 方法 + `event-relay` capability | ✅ |
| 2 | 同 `event.id` 重投 → `accepted:0, duplicates:1`，cursor 不倒退 | ✅ |
| 3 | 空批 / 129 条 / 单事件 >32KB → `relay-events-invalid`（非静默截断） | ✅ |
| 4 | 1.0 方法行为一字不变 | ✅ |
| 5 | `fang.relay.status().peer === 'dsh-fang-bundle'` | ✅ |
| 6 | `src/contract/*` 与 npm 1.1.0 逐字节相同 | ✅（sha256 钉死） |
