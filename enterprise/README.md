# enterprise — 商业层（闭源）

**本目录不是开源软件。** 适用 [商业许可](../LICENSE-COMMERCIAL)。

企业功能（规划/商业功能）：SSO、组织与组权限、审批链、审计导出、私有化部署、SLA 支持。

## 状态

截至 v2.1.0：本目录只有占位说明，**没有实现代码**。开源核心层已预留并实现接入点：

- `src/kernel/extensions.mjs`：`COMMERCIAL.teams` + `invokeCommercial()`（无 provider 时放行并记录 basis）；
- `src/plugins/approver.mjs`：`summary({remotes})` 汇总审批（团队审批链的接入位置）；
- `src/plugins/auditor.mjs`：`aggregate()` 审计汇总 + `cloudSink()` 占位。
