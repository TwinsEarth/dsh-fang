# relay-server — 商业层（闭源）

**本目录不是开源软件。** 适用 [商业许可](../LICENSE-COMMERCIAL)，不适用 `LICENSE-CORE`（AGPL）或
`LICENSE-SDK`（MIT）。

Relay 服务器提供（规划/商业功能）：

- 联合开发同步（多设备 / 多 Harness / 冲突合并）；
- 云备份（按插件 / 按会话 / 按用户，增量 + 端到端加密）；
- Token API 路由；
- 团队协作（用户/组权限、审批链、审计归属）；
- SLA 与托管运营。

## 与开源层的关系

Relay 通过**独立服务 + 加密通道**接入，不嵌入 DSH 进程，也不修改 AGPL 核心：
本地核心照常工作在离线模式，Relay 只是增值服务（`kernel/extensions.mjs` 的
`fangCommercial` 钩子；无 provider 时全部 no-op）。

## 状态

截至 v2.1.0：本目录只有占位说明，**没有实现代码**；商业层代码在私有仓库开发，发布时以二进制/镜像形式提供。
