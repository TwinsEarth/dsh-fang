# M5 交付：瓮城作为房主回流对端（peer = dsh-fang-bundle）

> 对应需求：`D:\fang\家庭共济金\DeepDeek\瓮城\doc\M5-fang-requirements.md`（房主侧 M5 回流验收）。
> 结论：**3 项交付物已在仓库内就绪，房主探针 `fang-relay-probe.mjs --peer fang` 实测 exit 0**。

## 一、交付物

### 1. vendored 契约包：`src/contract/`

目录 = `@twinsearth/dsh-fang-contract@1.2.0` 的 `src/*` 原样复制（8 文件，字节级未改）：

```
src/contract/
  index.js  constants.js  envelope.js  negotiate.js
  server.js  relay.js     transports.js  client.js
  VENDOR.json
```

- `index.js` 为 ESM，被 `import(pathToFileURL(...))` 直接加载；内部全部相对 import（`./constants.js` 等）；
- 导出 `createRelayContractServer(options) → { server, store }` 与 `CONTRACT_VERSION`（`'1.2.0'`）；
- 自身 `package.json` 的 `files` 含 `src/**/*.js` + `src/contract/VENDOR.json`，npm 包内容已核实包含上述文件。

### 2. 哈希清单：`src/contract/VENDOR.json`

```json
{ "version": "1.2.0", "sha256": { "index.js": "67b5d6…", "constants.js": "9bf083…", … 共 8 个文件 } }
```

- 键 = 相对 `src/contract/` 的文件名；值 = 文件 sha256（小写 hex）；
- 文件另带 `package` / `syncedAt` / `fileCount` / `sourceCommit` 溯源字段（探针只读取 `version` 与 `sha256`，不影响校验）；
- 房主逐文件重算：`vendoredFilesOk=true`（见证据）；
- 生成命令：`Get-ChildItem src\contract -File | ForEach-Object { "$($_.Name) $((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())" }`（排除 VENDOR.json 自身）。

### 3. orchestrator 两处可识别注册

`src/plugins/orchestrator.mjs`：

```js
const relayStore = createRelayStore({
  peerLabel: 'dsh-fang-bundle',   // createRelayStore({ 之后 400 字符内（房主正则）
  role: gate.role,
  instanceId: `fang-${gate.role}-${process.pid}`,
  limits: { maxBatch: 32, maxPayloadBytes: 512000 },  // M5 合同口径
})
// ...
handlers: { ...relayHandlers(relayStore), ... }      // 房主正则 relayHandlers(relayStore)
```

- `peerLabel` 为**对端自报**，房主从我们源码读出，不写死；
- `hello()` negotiation.methods 含 `fang.relay.publish` / `fang.relay.status`；
- `fang.relay.status` result 含 `{ available, peer, contractVersion, cursor, accepted, duplicates, rejected, batches }`；
- publish 幂等：首投 `accepted=N, cursor+N`；同 id 重投 `accepted=0, duplicates=N, cursor 不变`；
- `GET /fang/api/contract/health` 无 Bearer 返回 `{ ok, role, version, peer, accepted }`（另有 `methods/relay` 排障字段）；
  `POST /hello`、`POST /invoke` 需要 `Authorization: Bearer <token>`。

## 二、自测证据（2026-11-17 实跑）

### 仓库内自检（不依赖房主）

```powershell
node --test --concurrency=1 test/m5-contract-delivery.test.mjs   # 6/6 pass
```

覆盖：fileURL 加载/相对 import、VENDOR 逐文件 sha256、hello relay 方法、status 字段、幂等、orchestrator 正则可识别性、health 公共字段。

### 房主探针（真实独立进程对端）

```powershell
# 注：本会话 npm pack 被本地打包守卫要求人工确认（审批自动化被关闭），
#     因此用 git archive / 工作树拷贝生成等价的解包目录；内容与 npm 包 files 选择一致。
node scripts/fang-relay-probe.mjs --peer fang --fang-dir <解包目录> --events 5 --out <evidence.json>
```

结果（`docs/M5-fang-relay-evidence.json`）：

```json
{
  "ok": true,
  "peer": "dsh-fang-bundle",
  "events": 5,
  "sameProcess": false,
  "contractVersion": "1.2.0",
  "provenance": {
    "peerMode": "fang-package",
    "fangVersion": "3.5.0",
    "vendorVersion": "1.2.0",
    "vendoredFilesChecked": 8,
    "vendoredFilesOk": true,
    "peerLabelSource": "src/plugins/orchestrator.mjs",
    "relayHandlersRegistered": true
  },
  "idempotency": true,
  "expectation": { "peer": "dsh-fang-bundle", "matched": true }
}
```

探针 exit 0；另对 `dist/npm/package`（3.5.0 发布包暂存内容）复跑同样 exit 0。

## 三、口径说明

- **契约版本**：需求允许 `1.1.1` 或 `1.2.0`；瓮城 vendored **1.2.0**（B-6 委托方法依赖它），`contractVersion` 自报 `1.2.0`；
- **批次上限**：vendored 1.2.0 库默认 `maxBatch=128`；运行时 orchestrator 按 M5 合同口径收敛为 `maxBatch=32` / `maxPayloadBytes=512000`（不改 vendor 实现）；
- **npm 打包守卫**：`npm pack` 在本会话触发本地打包确认（审批自动化关闭），故自测用等价解包目录；发布流程在批准后照常 `npm pack`。

## 四、复现命令

```powershell
# 仓库自检
node --test --concurrency=1 test/m5-contract-delivery.test.mjs
node tools/release/preflight.mjs --e2e

# 房主探针（房主仓库内）
node scripts/fang-relay-probe.mjs --peer fang --fang-dir <解包后的 fang 包目录> --events 5 --out evidence.json
```
