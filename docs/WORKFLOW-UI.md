# WORKFLOW-UI — 瓮城 UI 改动与发版固定流程

> 状态：生效中（2026-11-10 起）。本文件是**后续会话的持久约束**；与 `docs/CRASH-SAFETY.md`
> 一起进包、进测试、进发布门禁。违反本流程 = 发布门禁不通过，不是“建议”。

## 0. 铁律

1. **发布必须由人类显式授权。** 禁止自动执行 `release workflow`、`npm publish`、GitHub Release、
   打 tag、移动 tag。完成修改与测试后先汇报，等确认再发。
2. **不是所有修改都值得发版。** 文档/流程/无行为变化的重构可以只合并不发版；
   版本号是否递增由人类确认。
3. **发版后不再动 tag/文档。** 发布后文档状态固化为“以 registry / Release 为准”，
   避免 v3.1.8 的“移动 tag → 重建 tarball → npm 与 Release 摘要不一致”返工。

## 1. 先判定：纯样式 vs 结构/高度链

| 判定 | 处理 | 目标 |
|---|---|---|
| 纯样式（颜色、间距、圆角、滚动条外观） | 只改 CSS + 1 个 DOM 契约测试 | ≤10 分钟 |
| 结构/高度链（宿主容器 flex、`min-height`、滚动容器归属、overlay 层级） | 先画高度链与 DOM 归属，再改；必须加 DOM/CSS 契约测试 | 按预算 |
| 交互/数据（滚动、拖拽、焦点、异步状态） | 加可自动化的行为测试；必要时做一次浏览器冒烟 | 按预算 |

**检查点（改之前先回答）**：目标元素在哪个宿主容器里？宿主对它有 `height` 吗？
滚动容器是不是“唯一的”？有没有内容在滚动容器之外（本次 v3.1.9 的根因就是元主卡片在滚动区外）？

## 2. 浏览器冒烟：只在必要时，复用现成 harness

- 只有涉及**宿主布局 / 滚动 / 拖拽 / 层叠**时才做真实浏览器冒烟；
- 复用仓库已有工具/脚本，**不新建一次性 harness**；单次冒烟为上限，不反复迭代调试；
- 冒烟必须记录：视口尺寸、输入方式（CDP 真实 wheel/drag 要写清楚）、前后指标、截图路径。

## 3. 合并前一次性验证（最多 2 轮）

```bash
node --test test/<相关>.test.mjs      # 单测 / DOM 契约
node --test test/                     # 本地全量（含 jsdom 套件）
node tools/release/preflight.mjs      # 版本/许可/allowlist/client 解析/crash-safety/全量
```

- 全量 1 次绿灯即可；同一轮失败 → 修一次 → 复跑；**第 2 轮仍红就停下汇报**。
- PR body 必须附：改动范围、根因、验证命令与结果、已知边界。

## 4. 发版前置检查（硬门禁，缺一不发）

发版前逐条确认，任何一项不满足先修环境、**不先打 tag**：

1. `git ls-remote https://github.com/<repo> HEAD` 可达（runner 与本机都能访问 github.com）；
2. self-hosted runner 在线且 idle；
3. npm token 有效（`NPM_TOKEN` / 本地 secret 文件，可 `whoami` 或 dry-run 校验）；
4. 目标版本号**未打 tag**、CHANGELOG 有对应 `## vX.Y.Z` 段、`FANG_VERSION` 与 `package.json` 一致；
5. `node tools/release/preflight.mjs --e2e` 本地 GREEN，且构建产物通过
   `crash-safety --package`（打包后二次验证）。

发布顺序（只有人类授权后才执行）：
`PR 合并 → 新 main 打注解 tag → release workflow → 校验 tests/build/Release/npm/healthz/final verify → 告知升级与重启方式`。

## 5. 运行中的 profile 升级安全规程（2026-11-10 事故后新增）

**禁止对正在运行的 DSH host 直接执行 `dsh plugin add` / 插件管理器改 profile。**
2026-11-10 21:33 在运行中的 desktop profile 上执行升级，导致 DSH 崩溃、用户层被重置
（bundles 变回默认、`cordis.patch.yml` 被模板覆盖）；已从 `.bak-*` 备份恢复。

正确步骤：

1. **停止 host**（或走宿主自带的“重启/退出”路径），确认没有进程占用 profile；
2. 备份 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`
   到 `profiles/<name>/.repair-<ts>/`（或 `.bak-*`）；
3. 对**候选包**先冒烟，不先替换：`node tools/boot-guard.mjs --candidate-dir <下载解包目录> --json`；
4. 安装/升级（优先 GUI 插件管理器，其次离线安装）；
5. 装完对 profile 做 dry-run：`node tools/boot-guard.mjs --profile-dir <profile> --json`；
6. 启动 host；若启动失败，用 `--apply` 禁用失败行或恢复备份后重启；
7. 记录：升级前版本、候选包冒烟结果、装后 dry-run 结果、回滚路径。

## 6. Token / 时间预算

- 单 UI 改动：目标 **≤15 分钟**、验证 **≤2 轮**；
- 超出预算立即停下汇报：**卡在哪、已试什么、是否继续深挖**，由人类决定；
- 不做与需求无关的“顺手重构”；不新造工具（先找仓库已有工具）。

## 7. 完成定义（Definition of Done）

- [ ] 根因写清楚（不是“加了 overflow”）；
- [ ] 测试覆盖该根因（DOM/CSS 契约或行为断言）；
- [ ] 本地全量绿灯 / preflight GREEN；
- [ ] 已记录边界与回滚路径；
- [ ] 发布前得到人类显式授权（否则停在“待发布”状态）。
