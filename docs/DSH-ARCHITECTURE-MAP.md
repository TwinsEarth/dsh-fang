# DSH 系统架构 × 瓮城安全边界（v3.3.0）

> 依据：DeepSeek Harness 0.2.2 架构文档与仓库内实际代码（`dsh --profile <name> --dump-config` 是最终事实）。
> 本文只记录「哪些层会影响主城安全、瓮城在哪一层设闸」。逐文件行号会随 DSH 版本变化，结论以能力边界为准。

## 1. 分层总图

```text
入口：dsh CLI / Web / Electron / SDK / ACP
  └─ Profile（$DSH_HOME/profiles/<name>）
       ├─ 有序 bundles（dsh-base / dsh-web-app / 树外插件）
       ├─ profile cordis.patch.yml
       └─ home 级 cordis.patch.yml + CLI --patch
            └─ Cordis 插件树（一切皆是插件）
                 ├─ Host Plane：llm / sessions / tools / sandbox / approval / subagents / presets
                 ├─ Agent Plane：每个 Agent 的 tools / prompt sections / delegation
                 └─ Session：append-only SessionEvent 日志（模型可见 ⟺ 已记录）
```

## 2. 与主城安全直接相关的十层

| 层 | DSH 机制 | 失败后果 | 瓮城闸门 |
|---|---|---|---|
| Profile 组合 | bundles 有序 + patch 逐层覆盖 | 缺 bundle/重复/坏 patch → 起不来或半残 | `profile` gate：路径、名称、bundles 去重、patch 解析、磁盘 |
| 插件生命周期 | Cordis Fiber；PENDING/LOADING/ACTIVE/FAILED；effect 可回收 | 注册泄漏/依赖缺失 → 静默无能力 | boot-guard + 关键防线文件 + 插件冒烟 |
| Host/Agent 平面 | 注册表与工具作用域隔离 | 把 host 注册表塞进 isolate → 名称解析失败 | 不在门禁里改 profile 层，只做只读校验 |
| Agent Loop | turn/step/工具批次；错误恢复 append-only | 半途崩溃留下不一致历史 | restart safe-mode + 审计链 |
| Session 日志 | 追加式、版本化、可重建 | 篡改/删行会让重放失真 | `audit` 链 + Session 版本校验（DSH 自身） |
| 工具执行 | tools/pre-execute → guard → execute → post-execute | 权限绕过/危险命令 | DSH guard/approval/sandbox 原生；瓮城不削弱默认值 |
| Guard/Approval/Sandbox | 三层安全，fail-closed | 静默放行不可回滚动作 | restart 默认 observe；自动重启默认 false；崩溃循环直接 disarm |
| Preset/HMR | 修订保留；活 Agent 组合稳定 | 热替换失败拖垮进程 | 门禁不热改 profile；变更必须 restart 路径 |
| KV Cache | 前缀稳定是硬约束 | 无关安全，但错误重试造成成本/时序异常 | 门禁报告只读，不改请求前缀 |
| 打包/发布 | bundle 分发即代码执行 | 坏产物/错标签/重复发布污染 registry | `package` / `publish` gate；sha256/manifest/tag 校验 |

## 3. 瓮城 18 个子插件的职责与主城关系

| 子插件 | 关键风险 | 现有保护 | v3.3.0 增量 |
|---|---|---|---|
| orchestrator | 路由/派生/状态机 | 鉴权、fail-closed、配额 | 新 profile 建前过 gate |
| forker | 子进程/端口/配置锁 | 端口池、退避、孤儿回收、只读修复 | `provision` 新建 profile 过 gate |
| restart-guard | 交接执行权 = 进程退出/重启 | 三重门禁 + 审批 + supervisor 契约 | **崩溃循环 15m≥3 → safe-mode，人工清除前永不 handoff** |
| restart-supervisor/watchdog | 外部拉起 | 授权清单 + 回执 + boot-guard | 增加 deploy gate（含备份/审计链/崩溃循环） |
| approver | 快照/回滚会覆盖目录 | digest 校验、代际、TTL | 门禁写 profile 前自动 `.gate-backups` |
| auditor | 审计链是最后证据 | 全链重算 + 篡改检测 | 部署/安装/发布前验链；门禁结论入链 |
| scorer | 静态评分 | A–E 分档、C3 宽限、veto | **scoreGateFindings：0 warning=A，1–2=B，3+=C，blocker=E** |
| healer | 修复建议不得放行 | 只读、UNKNOWN fail-closed | **gateRepairPlan：blocker→可执行修复建议** |
| decision-center | 通知/审批/阻塞 | 红阻塞、黄蓝绿状态机 | 不作为主城放行依据；不绕过 restart/approval |
| session-* / imports | 会话复制/恢复 | 有界读取、摘要大小限制 | profile gate 校验路径与磁盘 |
| essence/mirror/compat | 元主/镜像升级 | 指纹、备份、兼容矩阵 | install/deploy gate 校验 profile |
| hot-reloader | 热替换 | 只做可回收注册 | 主城变更不允许热替换 profile |
| buffer/queue-journal | 持久化队列 | journal/outbox | 门禁不删除运行数据 |
| adapter/approver 客户端 | 跨进程通信 | Bearer/HMAC | 门禁不联网 |

## 4. 为什么必须 fail-closed

1. **Cordis 的注册是副作用**：一个坏插件可以在 ACTIVE 后注册工具/服务，进程看似正常但能力错误。
2. **Profile 是分层覆盖**：任何时候都可能出现「上一层覆盖导致另一层失效」，只看源码无法证明最终组合。
3. **Session 是唯一真相源**：日志损坏后，resume/fork/transcript 全部失真，重装后仍可能复现。
4. **重启是唯一把代码变成新事实的动作**：在崩溃循环/审计链断裂时重启，很可能只是把故障带入下一次启动。
5. **DSH 明确是 Developer Preview**：沙箱/审批降低风险但不保证隔离；对不可信输入应使用一次性环境。

## 5. 门禁的最小信任链

```text
源码（版本/文档/契约/防线）
  → 产物（sha256/sidecar/manifest/必需文件）
  → 发布（tag/版本/registry 幂等）
  → 安装（profile 路径/无活宿主/磁盘）
  → 部署（备份/审计链/崩溃循环/supervisor）
  → 运行（restart-guard 三重门禁 + safe-mode）
```

任何一环缺少证据 = blocker；不允许「先跑起来再说」。
