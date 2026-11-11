# AUDIT v3.1.15

> 版本：3.1.15（2026-11-11）
> 范围：与房主 dsh-Master 的独立互联契约（fang-master contract 1.0）+ 多级保底通讯。

## 1. 目标

- 双方独立升级/发布仍能互联互通；
- 接口架构可整体升级/替换；
- 保底通讯：local → http → file → legacy 四级降级。

## 2. 实现证据

- 内嵌 `@twinsearth/dsh-fang-contract` 1.0.0 同源源码（`src/contract/`，独立源码仓 TwinsEarth/dsh-fang-contract）；
- `SERVICE.contract='fangContract'`（mother 提供）：
  - `hello/health`、`fang.fork.spawn/stop/list`、`fang.decision.create/resolve`、
    `fang.session.list`、`fang.orchestrator.status`；
- HTTP 端点（可选）：`POST /fang/api/contract/hello`、`POST /fang/api/contract/invoke`、
  `GET /fang/api/contract/health`；Bearer token 常量时间比较；token 留空禁用；
- 文件 outbox（可选）：`contract.fileDir` 下 requests/responses 原子文件交换；
- env 只透传 `DSH_MASTER_*`；fork 角色不暴露 `fangContract`。

## 3. 测试

```text
test/contract.test.mjs   2/2
  - mother 角色暴露 fangContract 服务；hello 协议/版本/方法齐全
  - FORK_SPAWN 契约调用 → fangForker.spawn；env 仅 DSH_MASTER_* 透传
  - fork 角色不暴露契约服务
本地 preflight --e2e GREEN：tests 1062 / e2e 81/81 / crash-safety 10 checks failed=0
```

## 4. 兼容与安全

- 原有服务键与旧版房主直连方式全部保留；legacy 传输可调用旧服务键；
- contract 1.x 方法只增不改；MAJOR 升级需双写一个 MINOR 周期；
- HTTP token 不入日志/状态；契约响应不含 key/私钥；
- file fallback 依赖受控本机目录 + OS 账户隔离。

## 5. 已知限制

- npm 首次发布 contract 包被 staged publishing 置为 `0.0.0-stage` 占位，待 2FA/stage 审批；
  本版以“同源内嵌 + 独立源码仓”先行发布，协议不变；
- HTTP 契约默认关闭（token 留空），部署时需两侧配置同一 token；
- 前端实时事件 UI、token 轮换/审计仍待后续版本。
