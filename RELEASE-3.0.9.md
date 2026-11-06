# dsh-Fang v3.0.9 发布说明

- 版本：`3.0.9`（上一个发布 `3.0.8`）
- 定位：插件独立可用（`@local/dsh-fang` 宿主插件 + Web 客户端半），PC 客户端可选
- 不推 `main`、不自动发布；发布动作按渠道执行

## 亮点

### 1. 三区数据布局（FANG_HOME）
- `mirror/<tag>`（母体镜像）、`essence/`（元主沙箱）、`forks/`（分身 home）、`sessions/<essenceId>/home`（运行态）真正分离；
- `essencesRoot = layout.essenceRoot`、fork homes 独立、运行态归口 `sessions/<id>/home`；
- 跨区路径守卫：拒绝 `..`/绝对路径逃逸（会话导入 `invalid-workspace-key`，fork/merged/runtime home 越界返回 `path-escape`）；
- 迁移指针 `~/.dsh/fang/fang-home.txt`：无需改环境变量即可切换数据根；
- 迁移工具：`tools/migrate-to-fang-home.mjs`（dry-run 默认、自动备份、junction 感知、绝对路径结构化重写、运行态归口）；
- 实测迁移 `%USERPROFILE%\.dsh\fang\desktop → D:\ToFuture`：元主 4、分身 8、会话 3 归口，0 残留。

### 2. 元主（原身/本尊）生命周期
- 打开 = 起隔离实例 + 可选导入 1–5 个进行中会话（>5 拒绝、归档拒绝），合并 `workspace.json` 让分组显示名称；
- 复制 = 整目录深拷贝（overlay/merged/自定义 + 沙盒 sessions + workspace 索引；排除凭据/备份/运行态其余）；
- 归档（冻结）= 只能「还原（解冻）」或「删除」，其余按钮不渲染；
- 删除原身不级联删会话（旧布局运行态先搬出再删），写墓碑；已派生分身保留并标记「原身已删除（仅运行/归档）」，不能再派生（`essence-deleted`）；
- 备份/还原备份/整包下载/导入；`GET /essence/detail` 返回设置/插件/运行日志摘要（不泄露凭据）；
- 默认元宝：`copy-local` 模式只复制本机插件启用状态与设置（不复制会话/数据/代码/凭据），无用户元主时自动创建；快速派生自动以它为模板。

### 3. 分身（生产盘）
- 派生模板 = 来源元主 `merged/profile`（修复 clean-template 覆盖原身配置的问题）；
- 每次 spawn 重放配置（package/cordis/settings），再重新加锁；
- 生产盘硬禁（本版边界）：组合层禁用 `plugin-manager`/`tool-plugin-manager`/`config-editor`/`ui-settings*`（真实 `dump-config` 验证）+ 每次 spawn 重锁 + `package.json`/`cordis.patch.yml` 只读；
- 单会话守卫：启动/还原前隔离未登记多余会话（`quarantine-sessions/`），分支登记会话豁免；
- 物理分支：adapter `fork-session`（分身内 `ctx.sessions.fork`）+ 分支库 `sessionId` + 任务 `activeBranchId`；分身卡「分支」面板（派生/列表/激活/打开分身/复制会话 ID）；
- 「元主」栏「派生」按钮：选一个现有进行中会话 → 创建分身 + 沙箱 + 整目录复制会话。

### 4. 配额与母体
- 子元主 VIP 配额（free 5 / vip10 / vip30 / vip50 / vip100）；
- 每元主进行中会话配额（`quota.sessions={used,limit,over}`），满额拒绝再开实例，归档不计；
- 母体不可删除：`DELETE /api/mother`、`POST /api/mother/delete` → `403 mother-immutable`；
- 母体克隆 / 空白重建 / 单份备份 / 6-12-24h 自动同步。

### 5. UI
- 工作区 37:63（母体/元主 vs 分身）；
- 运行态切换：运行中显示「停止 + 进入」，停止后回「打开」；
- 元主行：详情按钮移除，改为「派生」；冻结行只显示「还原/删除」；
- 队列日志恢复条精简为 `[恢复草稿][清除]`；
- 连接信息两行（页面 URL + fang token）；截图 `Ctrl+X` 走系统截图（`ms-screenclip:` 兜底）。

## 修复
- 分身 profile patch `[]` 残留 + 追加 `- id:` → 非法 YAML，导致派生 `spawn-failed: exited`；已修复并修复存量分身（`tools/repair-fork-patches.mjs`）；
- `cordis.yml` 只读导致分身启动 `EPERM`；只读范围改为 `package.json`/`cordis.patch.yml`；
- `forker.spawn` 缺 `homeDir` 的 `no-home-dir` 诊断增强 + 回归测试；
- 显式 `dataRoot` 时不再自动跳到 `D:\ToFuture`（测试/独立部署不再写真实 D 盘）。

## 已知边界（未在本版承诺）
- 官方源升级适配器（`officialSource`）未接入，`checkUpgrade` 暂不可用；
- 物理分支 `sessions.fork` 的真实宿主签名未现场验收（失败会显式返回 `fork-failed`）；
- 分身硬禁的文件系统级 ACL / `node_modules` 只读挂载需宿主权限位（Q2-B 剩余）；
- 会话配额是“开实例门禁”，不是“创建第 N+1 个会话即拒绝”。

## 升级/迁移
1. 停宿主；
2. `node tools/migrate-to-fang-home.mjs --profile desktop`（dry-run）→ `--apply`；
3. 写 `~/.dsh/fang/fang-home.txt` = 目标数据根（或设 `FANG_HOME`）；
4. 重启宿主；用 `GET /fang/api/status` 的 `layout` 验收四区路径。

## 验收
```bash
node --test --test-concurrency=1 "test/*.test.mjs"
node tools/ui-rich-smoke.mjs
```
本版发布时：全量 **739 通过 / 0 失败**（skipped 1、todo 10），rich UI smoke **21/21**。
