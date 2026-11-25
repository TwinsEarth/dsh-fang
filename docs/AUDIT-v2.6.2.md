# 审计报告 · dsh-Fang v2.6.2（控制面板分类折叠）

> 证据全部来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 自检同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 2 个补丁位（`2.6.1` → `2.6.2`）。

## 1. 范围

`client.js`（瓮城 Client 半）的**纯 UI 分类折叠**改动：

1. 左栏「母体 项目 & 对话」拆为 **进行中 / 已归档 / 临时** 三个可折叠分组；
   - 进行中默认展开，**只先显示 7 条会话**，其余折叠为「展开剩余 N 个」；
   - 已归档默认折叠；
   - 临时（`empty=true` 的空会话）默认折叠。
2. 右栏「分身 任务 & 项目」拆为 **进行中 / 已归档 / 临时** 三个可折叠分组；
   - 临时 = 快速派生任务（空白、未继承会话）；
   - 已归档/临时默认折叠。
3. 顶栏「隐藏/显示临时内容」整组开关，偏好持久化在
   `localStorage["fang.panel.showTemporary"]`（storage 异常时降级为本次会话生效）。
4. 分类判定只用宿主已返回的事实（`archived` / `empty` / 任务标题），**不改协议、不新增接口**。

文档：`docs/UI-PANEL-FOLDS.md`（规则、默认态、计数、验收步骤、限制）。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.2** |
| Client 半可解析 | 同上（v2.6.2 新增检查） | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **330 pass / 0 fail / 1 skip（331 项，14.7s）** |
| e2e 实机验收 | 同上（内嵌 `tools/e2e.mjs`） | **45/45（11.6s）** |
| 路由 allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、114 文件扫描、包内 65 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.2.tgz`（**229,180 B，81 entries**）<br>sha256 `10409a4d594c4359cbdd37d97adb771e73318ca444bc116bd1b1864b59686e88` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.2`（15 个模块可 import） |

## 3. 覆盖方式

- 本次是浏览器 UI 改动，仓库没有浏览器渲染测试环境；因此：
  - 把 `client.js` 的 `node --check` 纳入 preflight（新检查项，防止语法级回归）；
  - 分类规则集中在 `classifyMotherSessions()` / `classifyTasks()` 两个纯函数中，逻辑可人工复核；
  - 全量测试与 e2e 45/45 继续通过，证明运行时/协议/构建未被影响。
- **视觉验收未完成**：本机后台宿主（56080）仍在运行旧 client 半，未重启；需重启宿主后按
  `docs/UI-PANEL-FOLDS.md §6` 的 7 步人工确认。这一项在合并前必须由维护者补上。

## 4. 风险

1. **「临时」是 UI 侧定义**（空会话 + 快速派生标题）。如果派生流程未来支持自定义标题，或空会话
   会被复用，需要显式数据标记（那时应走协议字段，而不是继续匹配标题）。
2. 左栏「进行中」的 7 条上限只作用于渲染，不改变 `/fang/api/sessions` 的 `limit`（母体仍只返回
   最近 N 条）；被折叠的是**已加载**会话。
3. 同一工作区同时有进行中/已归档/临时会话时，会在多个分区各出现一次；折叠状态按
   `分区:工作区` 独立记忆，不会互相影响，但视觉上同一项目会出现多次（这是分类目标的直接结果）。
4. 顶栏新增「隐藏/显示临时内容」按钮：小屏（≤980px）下与刷新/派生按钮一起换行；未做额外的窄屏隐藏。

## 5. 提交状态

- 分支：`feat/panel-fold-groups`（stacked 在 PR #10 的 `feat/adapter-protocol-v3` 之上）；
- 发布物：`dist/dsh-fang-2.6.2.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
