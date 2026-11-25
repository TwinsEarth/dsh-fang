# dsh-Fang v3.1.16 发布说明

- 版本：`3.1.16`（上一版 3.1.15）
- 主题：跨进程契约桥“零配置”——原身运行态注入 `DSH_FANG_MOTHER` + 契约 HTTP headers 同步。

## 变更

### 1. 原身运行态注入母体路径（零配置桥）
`startEssenceRuntime` 的 spawn 环境新增：

```text
DSH_FANG_ROLE=fork
DSH_FANG_TASK_ID=<runtimeForkId>
DSH_FANG_ESSENCE=1
DSH_FANG_MOTHER=<母体 dataDir>     ← 本版新增
```

房主 dsh-Master（3.2.5）的 Router 在检测到 `DSH_FANG_MOTHER` 时会自动使用
`<母体 dataDir>/contract-outbox` 作为契约 file 桥目录，因此：

- 原身内的 Router → 母体契约服务 → 真实 fork 的整条链路**无需手工配置**；
- 未设置该变量时行为不变（仍需 `dispatch.contractFileDir`）。

### 2. 契约 SDK：HTTP 自定义 headers
`createHttpTransport({ headers })`、`createContractClient({ config: { httpHeaders } })`。
瓮城的契约 HTTP 端点要求 **两个** 凭据：契约 Bearer token（`contract.token`）与
安装级 `x-fang-auth`；房主现在可以一次带齐，HTTP 桥不再 401。

加性扩展：不传 `headers` 时与 1.0.0 行为一致。

## 兼容性

- 服务键、路由、环境变量语义均未变化；旧版房主仍可走 `legacy` 传输；
- 房主 3.2.5 与瓮城 3.1.16 组合为“零配置 file 桥”；房主旧版 + 瓮城 3.1.16 也能照常工作。

## 验证

- `npm test`：1034 pass / 0 fail（含 `test/contract.test.mjs` 2/2）；
- release preflight（含 e2e 冒烟）通过；
- npm：`@local/dsh-fang@3.1.16`；GitHub Release：`v3.1.16`。

## 升级方式

```bash
dsh plugin --profile <name> add @local/dsh-fang@3.1.16
```

升级后原身运行态需重启（重新 `startEssenceRuntime`）才会带上新的 `DSH_FANG_MOTHER`。
