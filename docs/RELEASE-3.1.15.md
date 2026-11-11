# dsh-Fang v3.1.15 发布说明

- 版本：`3.1.15`（上一版 3.1.14）
- 主题：与房主 dsh-Master 的独立互联契约（fang-master contract 1.0）+ 多级保底通讯。

## 新增

- 内嵌 `@twinsearth/dsh-fang-contract` 1.0.x 同源 SDK（`src/contract/`，无运行时 npm 依赖）；
- mother 提供 `fangContract` 服务（`SERVICE.contract`）：
  - `contract.hello/health`；
  - `fang.fork.spawn/stop/list`、`fang.decision.create/resolve`、
    `fang.session.list`、`fang.orchestrator.status`；
- HTTP 契约端点（可选启用，必须 Bearer token）：
  - `POST /fang/api/contract/hello`
  - `POST /fang/api/contract/invoke`
  - `GET  /fang/api/contract/health`
- 可选文件 outbox 兜底：`contract.fileDir` 下 `requests/` → `responses/`，与房主共享文件系统时可用；
- 配置新增：
  ```yaml
  contract:
    enabled: true
    token: ''        # 留空 = HTTP 契约端点禁用
    fileDir: ''      # 留空 = file fallback 关闭
    pathPrefix: /fang/api/contract
  ```
- 契约 env 只透传 `DSH_MASTER_*`；HTTP token 常量时间比较；fork 角色不暴露契约服务。

## 兼容性

- 旧版房主（直连 `fangForker` / 母体 bridge）不受影响：原有服务键全部保留；
- 新版房主按 local → http → file → legacy 自动降级；
- contract 1.x MAJOR 内方法只增不改；删除/改义需 2.0 + 双写一个 MINOR 周期。

## 验证

```text
test/contract.test.mjs   2/2（mother 暴露契约服务 + fork 不暴露；env 过滤）
preflight --e2e          见 release build（含 crash-safety + 打包后门禁）
```

## 已知限制

- npm 首次发布 `@twinsearth/dsh-fang-contract@1.0.0` 被 npm staged publishing 置为
  `0.0.0-stage` 占位，待 2FA/stage 审批；本次以“内嵌同源 SDK + 独立源码仓”先行发布；
- HTTP 契约默认关闭（token 留空），需部署时配置双方 token；
- 前端实时事件 UI、token 轮换审计仍待后续版本。
