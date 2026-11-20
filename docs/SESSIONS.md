# DSH 会话指南（SESSIONS）

> 本文件描述本项目（`E:\DSH\DS\Fang`）的会话存储、恢复、导出与官方 ZIP 导入。
> 工具：`tools/session/`（来自 SESSION-MIGRATION-KIT，零依赖，Node ≥ 22.15）。

## 1. 存储事实（本机 DSH 实测）

- DSH home：`%USERPROFILE%\.dsh`（可用 `DSH_HOME` 覆盖）
- 会话日志：`<DSH_HOME>\sessions\<projectKey>\<sessionId>\session.v4.jsonl.zstd`
- 工作区注册表：`<DSH_HOME>\storages\workspace.json`
- `projectKey`：cwd 的盘符/分隔符折叠为 `-`，两端包 `--`；`E:\DSH\DS\Fang` → `--E-DSH-DS-Fang--`
- 日志是**多帧 zstd**：首帧恰好一行 header，后续帧是完整 JSONL 行；header 的 `cwd` 必须与磁盘
  projectKey 一致，否则读取报 `corrupt session log`
- 工作区可见 = `workspace.json` 的 `workspaces.<id>.sessionIds` 含该会话 **且** `record.path` 与 header
  `cwd` 一致
- `storages\session_projcache\` 是派生物，cwd 变化后自动失效，**不要手改**

## 2. 本次迁移已恢复的 Fang 会话

| 项 | 值 |
|---|---|
| 源（旧工作区 `E:\GPT`） | `session-a6b0ed16-c58c-430d-a911-e4fe9577fc56`（检查时 14.9 MB，31164 events；会话仍在运行） |
| 新会话（本工作区） | `session-5460c1e7-523f-40d3-b35c-dcbfa7813dbf` |
| 源（瓮城重建版） | `session-0c36661d-182c-499c-964e-f663fc9edff6` |
| 新会话（瓮城重建版） | `session-c0a6a6e0-47fd-4324-bea5-ecf9155b5848`（8925 events） |
| 工作区 | `E:\DSH\DS\Fang`，workspaceId `c4b73d36-a36a-4c7c-bf40-6da944c6b0c5`，标题 `Fang` |
| 恢复方式 | 复制 + 换新 id（原会话不动）；DSH 运行时用 `--force-running` 挂载 |
| 注册表备份 | `%USERPROFILE%\.dsh\storages\workspace.json.bak-preimport-20261120230147` / `…230154` |
| 项目内快照 | `sessions\migrated-2026-11-21\current\`（新会话）、`sessions\migrated-2026-11-21\legacy\`（瓮城 0c36661d；原始 瓮城 fb8e6ae8 含 64 个后代） |
| 官方格式 ZIP | `sessions\dsh-session-5460c1e7.zip`（9,358,555 B；`session.v4.jsonl` 48,767,105 B / 31,164 events） |

未恢复、仅快照的历史会话：`session-fb8e6ae8-6037-46ae-9e95-cf47c0992c1c`（原始「DSH：Fang“瓮城”」，77.1 MB，
含 64 个后代会话）。需要时用 §4 的命令从快照恢复（默认换新 id，不动原会话）。

## 3. 打开与继续

1. 刷新/重启 DSH 后，选择工作区 **Fang**（path `E:\DSH\DS\Fang`）；
2. 其中应出现 `session-5460c1e7…`（当前开发会话）与 `session-c0a6a6e0…`（瓮城重建版），可直接继续；
3. 若工作区列表没有出现（DSH 运行中写注册表可能被宿主覆盖），退出 DSH 后补挂：

```powershell
node tools\session\restore-session.mjs --attach-only `
  --session-id session-5460c1e7-523f-40d3-b35c-dcbfa7813dbf `
  --workspace E:\DSH\DS\Fang
```

## 4. 从 DSH 存储 / 项目快照恢复（复制为新会话）

```powershell
cd E:\DSH\DS\Fang

# 从当前 DSH 存储复制某个会话（含子代理）到本项目工作区
node tools\session\restore-session.mjs --from-dsh session-<id> --workspace E:\DSH\DS\Fang

# 从项目内快照恢复（可离线、可换机）
node tools\session\restore-session.mjs --snapshot sessions\migrated-2026-11-21\legacy\session-fb8e6ae8 --workspace E:\DSH\DS\Fang
```

- 默认给每个会话分配新 id（root `session-<uuid>`，子代理 `<uuid>`），不改原会话；
- header `cwd` 重写为目标工作区规范路径；`workspace.json` 自动备份后挂载；
- DSH 运行中需加 `--force-running`（可能被宿主覆盖，优先退出 DSH 后执行）；
- 只写日志 + 注册表，不触碰其它项目会话。

## 5. 官方会话导出 ZIP：导出与导入

DSH 菜单「下载 Session 日志」的导出结构（无 manifest）：

```
session.v4.jsonl                      根会话（明文 JSONL）
subagents/<childId>/session.v4.jsonl  子代理（可选）
media/sha256:<64hex>.<ext>            图片附件
files/<ab>/<64hex>/<name>             文件附件
attachments-missing.txt               可选
```

本项目已把恢复后的会话导出为官方格式 ZIP：`sessions\dsh-session-5460c1e7.zip`（导出脚本见
`scratch/export-official-zip.mjs` 的历史用法；重新导出时按同结构生成 `session.v4.jsonl` 即可）。

导入有两种方式：

1. **界面入口**：DSH 新会话/工作区的官方「导入会话」入口，选择 `sessions\dsh-session-5460c1e7.zip`，
   目标工作区选 `E:\DSH\DS\Fang`；
2. **命令行**（等价，可脚本化）：

```powershell
node tools\session\import-session.mjs --zip sessions\dsh-session-5460c1e7.zip --workspace E:\DSH\DS\Fang

# 先看会写什么 / 不改注册表
node tools\session\import-session.mjs --zip <dsh-session-*.zip> --workspace <dir> --dry-run
node tools\session\import-session.mjs --zip <dsh-session-*.zip> --workspace <dir> --no-attach
```

行为：解包校验 header/JSONL → 冲突 id 自动换新（级联改 `parentSession` 与事件引用）→ 按 v4 frame
规则重写落盘 → 附件写入 `<DSH_HOME>\attachments\v1\` → 可选挂载到目标工作区。

本次迁移已做真实导入验证：ZIP 导入临时工作区得到新 id `session-11bdf42e-…`，header `cwd` 正确，
测试产物（会话目录/临时工作区）已清理。

## 6. 规则与注意

- 只操作本项目会话；**不改其它项目会话、不手改 projcache**；
- 手改 `workspace.json` 前必须备份（工具已自动备份 `workspace.json.bak-preimport-*`）；
- 会话恢复/导入是本地动作，不上传网络、不发布；
- seed/fork 会话的 `inheritedEventCount` 不在官方 ZIP 内，极端情况下无法完全无损还原（普通会话不受影响）；
- 历史事件里的旧绝对路径仍是旧路径（历史事实不重写）；在本工作区继续操作时用新路径；
- 详细原理与坑见 SESSION-MIGRATION-KIT 的 `PLAYBOOK.md`（2Xray 项目 `share\SESSION-MIGRATION-KIT\`）。
