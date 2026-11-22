# v3.7.5 审计（2026-11-22）

> 用户指令：**“三方发布，v3.7.5”**。跳号 v3.7.4，豁免见 `docs/RELEASE-WAIVER-v3.7.5.md`。

## 内容

1. Vault 独立子插件：分类导出/导入；工作区快照默认关闭，显式勾选；凭据默认包含（明文，需保管）。
2. 全局红线：所有 fork 的 fs 写守卫，保护母体 profile、DSH 安装、官方元主/runtime、其他 fork、tasks/auth/audit。
3. 会话状态/同步修复：restore 不搬会话、attach-only 校验、open-url GET 只读 + POST 同步、存量 fingerprint 迁移、来源插件面默认对齐。
4. UI：failed → 黄色「等待启动」；crashed 仍红色。

## 验证（待回填）

- 全量 tests：**1330 pass / 0 fail / 2 skip**；
- preflight --e2e：**GREEN；e2e 125/125**；
- 发布 PR CI：**#157 8/8 绿**；
- release-order：**10/10**；

## 边界

- 全局红线是插件级 in-process 守卫，不拦截子进程/OS 写；不是 VM 级隔离。
- 工作区快照默认不导出；凭据默认明文包含在 `70_SECRETS`，导出包需妥善保管。
- 运行中的旧分身需重启宿主后加载新代码。
