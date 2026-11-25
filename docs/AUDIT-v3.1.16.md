# AUDIT v3.1.16

> 版本：3.1.16（2026-11-11）
> 范围：原身运行态环境注入 + 契约 SDK HTTP headers（跨进程桥零配置）。

## 1. 变更审计

| 变更 | 风险 | 处理 |
|---|---|---|
| `startEssenceRuntime` 注入 `DSH_FANG_MOTHER` | 仅新增一个**路径**环境变量，不含凭据 | 值来自 `resolveFangLayout().dataDir`（与普通分身的 846/1461/1534 行同源），不写入日志 |
| 契约 HTTP `headers` 透传 | 若把任意 header 透传到第三方 URL，可能泄露 | 仅由房主显式配置 `httpHeaders`（安装级 `x-fang-auth`）；SDK 不读取环境变量、不自动注入 |
| 内嵌 SDK 与 npm 发布版差异 | 长期漂移风险 | 房主侧新增一致性测试（导出面/常量/方法表/错误码 + 双向 server×client 往返）；本版只保留“可选 headers”这一加性差异 |

## 2. 安全边界（未变）

- 契约 HTTP 端点仍要求 Bearer token，token 为空即禁用；
- `x-fang-auth`/adapter token 不出现在日志、状态与错误消息中；
- fork 角色不暴露契约服务；原身只作为**调用方**，不持有母体凭据以外的权限；
- `DSH_MASTER_*` env 白名单逻辑不变（仍不透传其他变量）。

## 3. 验证

- 单元测试：`npm test` 1034 pass / 0 fail；
- `test/contract.test.mjs`：2/2；
- e2e preflight：通过（见发布 run）；
- 手工：真实双 Host 场景下原身 Router 使用自动推导的 outbox（由房主 3.2.5 smoke 覆盖）。
