# 房主 ↔ 瓮城 互联契约（v3.2.4）

> 目标：**双方独立升级/发布，仍能互联互通**；接口架构可通过更新契约包整体替换，
> 同时保留多级保底通讯。  
> 实现：`@twinsearth/dsh-fang-contract` 1.0.x（源码独立仓，另见 `TwinsEarth/dsh-fang-contract`），
> 两侧各自内嵌**同一份** `src/contract/` 源码（无运行时 npm 依赖），版本号一致。

## 1. 契约内容

- 方法表：`contract.hello/health`、`fang.fork.spawn/stop/list`、`fang.decision.create/resolve`、
  `fang.session.list`、`fang.orchestrator.status`；
- 信封：`protocol=fang-master, protocolVersion=1, id, method, params, meta`；
- 版本协商：`hello` 返回 `contractVersion / role / methods / capabilities / transports`，
  `negotiate()` 裁剪双方方法交集；MAJOR 不兼容时自动降级；
- 错误码：`unsupported-method / unsupported-version / transport-* / all-transports-failed` 等。

## 2. 四级保底传输

```text
local  同 Host DSH 服务 fangContract（零网络，首选）
  ↓ 不可用/超时
http   POST /fang/api/contract/{hello,invoke}（Bearer token）
  ↓ 不可用/超时
file   同一文件系统 outbox/inbox（requests/*.json → responses/*.json）
  ↓ 不可用/超时
legacy 直接调用 3.1.x 旧服务键（fangForker / fangDecisionCenter 等）
```

业务错误（如 `ticket-invalid`）**不降级**，避免重复副作用；传输/协议/未知方法才降级。
每次尝试记录在 `client.attempts()`，状态可观测。

## 2.5 零配置（v3.1.16 / 房主 3.2.5）

瓮城原身运行态的 spawn 环境新增 `DSH_FANG_MOTHER=<母体 dataDir>`；房主 Router 检测到该变量后
自动使用 `<母体 dataDir>/contract-outbox` 作为 `dispatch.contractFileDir`，无需手工配置：

```text
原身 Host（essence Router）
  env: DSH_FANG_ROLE=fork / DSH_FANG_ESSENCE=1 / DSH_FANG_MOTHER=<母体 dataDir>
    ↓ dispatch.contract=true（自动 file 桥）
<母体 dataDir>/contract-outbox/requests → responses
    ↓
母体 Host（Fang contract service）→ 真实 fork
```

HTTP 桥需要两个凭据：契约 Bearer token + 安装级 `x-fang-auth`；房主通过
`dispatch.motherToken` 与 `dispatch.motherAuthToken` 提供（SDK 侧为可选 `headers`）。

## 3. 两侧实现位置

| 侧 | 文件 | 内容 |
|---|---|---|
| 瓮城 dsh-Fang v3.1.15 | `src/contract/` + `src/plugins/orchestrator.mjs` | 内嵌契约 SDK；mother 提供 `fangContract` 服务；HTTP `/fang/api/contract/*`；可选 file outbox server |
| 房主 dsh-Master v3.2.4 | `src/contract/` + `src/superagent/dispatch.mjs` | 内嵌同一 SDK；派发优先 contract（local/http/file/legacy），失败再回退本地 forker/母体 bridge |

两侧都不 import 对方内部源码，只依赖契约包稳定接口。

## 4. 独立升级 / 完全替换流程

1. 修改并发布契约包（源码仓 `dsh-fang-contract`，版本 `x.y.z`）；
2. 将 `src/contract/` 同步到两侧（同源文件，`CONTRACT_VERSION` 一致）；
3. MINOR：双方可不同时升级；`hello` 协商后使用方法交集，旧端自动降级；
4. MAJOR：新方法同时保留 `method@old` 一个 MINOR 周期（双写），两侧逐侧升级；
5. 观察 `client.attempts()` / `describe()` 的 transport 命中与降级；
6. 旧 MAJOR 下线前至少保留一个 MINOR 周期的 legacy 传输。

> npm 上 `@twinsearth/dsh-fang-contract@1.0.0` 首次发布被 npm **staged publishing**
> 置为 `0.0.0-stage` 占位（需 2FA/stage 审批后才能成为正式版本）；  
> 本次两个主包采用“同源内嵌 + 独立源码仓”的方式先行发布，待 npm 正式可用后
> 可改为依赖 npm 包，无需改协议/代码。

## 5. 安全

- HTTP 契约必须 Bearer token（两侧各自配置 `contract.token` / `dispatch.motherToken`）；
- env 只透传 `DSH_MASTER_*`；契约响应/状态不含 key/token/私钥；
- file outbox 目录须在受控本机路径，由 OS 账户隔离；
- legacy 传输只调用既有服务键，不扩大权限。
