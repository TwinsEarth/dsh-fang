# AUDIT v3.0.9

- 版本：`3.0.9`（上一版 `v3.0.8`）
- 发布门禁：`node tools/release/preflight.mjs --e2e` → **GREEN**
- 报告：`dist/preflight.json` / `dist/release-verify.json`
- 发布确认：用户原话「六方发布，v3.0.9」（2026-11-06，六方通道：GitHub public / GitHub Releases / npm / awesome-dsh-plugin / PC exe / 文档站）

## 1. 门禁证据（本机实测）

| 检查 | 结果 |
|---|---|
| 版本一致（package / kernel / CHANGELOG） | PASS 3.0.9 |
| 许可证与分层 | PASS（AGPL 核心 / MIT SDK / commercial + CLA + NOTICE） |
| client half 语法 | PASS |
| 路由 allow-list | PASS，routes=84，findings=0 |
| 全量测试 | PASS，**750 pass / 0 fail / 1 skip** |
| 真实 e2e（真 dsh 母体 + 真分身） | PASS，**75/75** |
| preflight 总判定 | **GREEN** |

## 2. 本版范围

### 数据布局
- `FANG_HOME` 三区：`mirror/<tag>` / `essence/` / `forks/` / `sessions/<essenceId>/home`；
- `fang-home.txt` 迁移指针；跨区路径守卫；显式 `DSH_HOME` 不再自动跳 `D:\ToFuture`；
- 迁移工具（junction 感知、结构化路径重写、运行态归口、坏 patch 修复）。

### 元主（原身）
- 打开 = 隔离实例 + 可选导入 1–5 进行中会话；复制 = 整目录深拷贝（含沙盒 sessions + workspace 索引）；冻结 = 还原/删除；删除留墓碑、保留会话；
- 默认元宝 `copy-local`（只复制本机插件启用状态与设置，不复制数据/凭据）；
- 「派生」按钮替换详情：选一个现有会话 → 新建分身沙箱并整目录复制。

### 分身（生产盘）
- 来源元主 `merged/profile` 模板；每次 spawn 重放配置 + 重锁；
- 组合层只禁用 `tool-plugin-manager`（实测：禁用 `config-editor`/`ui-settings*` 会移除 configForms，导致 locale 与 50 个客户端插件 pending，故回退为安全集合）；
- `package.json`/`cordis.patch.yml` 只读（`cordis.yml` 保持可写，否则启动 EPERM）；
- 单会话守卫 + 物理分支（adapter `fork-session`，`activeBranchId` 指针）。

### UI / 桌面
- 工作区 50:50；运行态「停止/进入」与「打开」切换；队列恢复条精简；连接信息两行；截图 Ctrl+X；
- PC 安装包：默认安装目录 `D:\ToFuture\app`（仅新装；升级沿用原目录；不动数据区），`DSH-Fang-3.0.9-x64-Setup.exe`。

## 3. 已知边界

1. 官方源升级适配器（`officialSource`）未接入；
2. 物理分支真实 `sessions.fork` 的宿主签名未现场验收（失败显式 `fork-failed`）；
3. 分身硬禁的文件系统 ACL / `node_modules` 只读挂载需宿主权限位；
4. 会话配额为“开实例门禁”，非“创建第 N+1 个会话即拒绝”；
5. 六方中的 **awesome-dsh-plugin / 文档站** 未在本仓库内提供发布目标（仓库无对应配置），需人工按渠道提交。

## 4. 产物

| 渠道 | 产物 | 状态 |
|---|---|---|
| GitHub public | 源码提交 + tag `v3.0.9` | 见发布记录 |
| GitHub Releases | `dsh-fang-v3.0.9.zip` + SHA256 | 待 Release 上传 |
| npm | `@twinsearth/dsh-fang@3.0.9` | 待 CI/npm 发布 |
| awesome-dsh-plugin | 条目信息 | 待人工提交 |
| PC .exe | `DSH-Fang-3.0.9-x64-Setup.exe` | 已构建（sha256 见 release/SHA256SUMS.txt） |
| 文档站 | RELEASE-3.0.9.md / CHANGELOG | 待站点发布 |

## 5. 回滚

- 数据：`fang-home.txt` 删除即回旧布局；迁移备份见 `D:\ToFuture\MIGRATION-REPORT.md`；
- 版本：撤回 tag / Release，npm deprecate `3.0.9`（若已发），PC 回退到上一安装包；不删数据区。
