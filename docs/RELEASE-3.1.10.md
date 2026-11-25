# dsh-Fang v3.1.10 发布说明（**未发布，等待人类授权**）

- 版本：`3.1.10`（上一个发布 `3.1.9`）
- 主题：把「瓮城防崩溃方案」固化为可回归的测试 / 打包 / 发布门禁；固化 UI 与发版流程。
- **状态：代码与门禁已完成、本地验证通过；尚未打 tag、未运行 release workflow、未发布 npm/GitHub Release。**

## 内容

### 1. 固定流程（持久约束）

新增 `docs/WORKFLOW-UI.md`：

- 先判定「纯样式 vs 结构/高度链」，纯样式 ≤10 分钟交付；
- 浏览器冒烟只在涉及宿主布局/滚动/拖拽时做，复用现成 harness、单次为上限；
- 合并前一次性验证（单测 + jsdom + 本地全量，最多 2 轮）；
- **发版前置硬门禁**：runner 在线、`git ls-remote github.com` 可达、npm token 有效、目标版本未打 tag；
- **发布必须由人类显式授权**；发版后不再移动 tag/回写文档；
- Token/时间预算：单 UI 改动 ≤15 分钟、验证 ≤2 轮，超限立即汇报；
- 运行中 profile 升级安全规程（本次事故后新增，见 §5）。

### 2. 防崩溃方案固化

新增 `docs/CRASH-SAFETY.md` 与 `tools/release/crash-safety.mjs`：

- **源码门禁**（preflight 调用）：boot-guard / restart-guard / 分身监督与孤儿回收 / role fail-closed / 未清洁启动检测的文件与导出必须存在；client half 必须浏览器安全；约束文档与打包清单必须齐全；
- **打包门禁**（build 调用）：最终 tarball 必须包含防线文件与两篇约束文档；候选包入口在隔离进程 `import` 且导出 `apply()`；manifest sha256 必须与 tarball 一致；
- 两篇约束文档随 npm tarball 一起发布，可审计。

### 3. 事故与恢复（环境，不入代码）

2026-11-10 21:33 在**运行中**的 desktop profile 上执行 `dsh plugin add @twinsearth/dsh-fang@3.1.9`，DSH 崩溃且用户层被重置（bundles 回退为 `dsh-base`+`dsh-web-app`、`cordis.patch.yml` 被模板覆盖）。
已从 `.bak-*` 备份恢复 bundles（16 项）与用户 patch 层；3.1.9 安装校验通过（installed client.js 与 npm 发布产物 sha256 一致；boot-guard dry-run 19 行 PASS）。恢复文件需要**重启 DSH** 才生效。

## 验证（本地）

```text
node tools/release/crash-safety.mjs --json            GREEN  source 3.1.10（10 checks）
node --test test/crash-safety.test.mjs                4/4 pass
node --test test/boot-guard... fork-supervisor...    23/23 pass（含 crash-safety）
node tools/release/preflight.mjs --json               crash-safety PASS；tests 1042 pass / 0 fail；
                                                      allow-list findings=0；仅 e2e（未传 --e2e）为 RED
node tools/release/build.mjs --skip-preflight         PASS package smoke + crash-safety(packaged)
                                                      tarball 530 KB / 140 entries
```

## 升级（发布后）

```bash
pnpm add @twinsearth/dsh-fang@3.1.10
```

**升级前必须停止 DSH host**，按 `docs/WORKFLOW-UI.md` §5 备份 profile 并做候选包冒烟，禁止在运行中的 profile 上直接执行 `dsh plugin add`。

## 边界

- `crash-safety` 是静态 + 隔离冒烟门禁，不是形式化证明；它保证已知防线还在、产物可加载，不保证任意新插件逻辑无崩溃。
- 桌面 Electron 壳是另一套 UI，不在 web 控制台门禁覆盖内。
- 本版**未**改动 v3.1.9 的 UI 行为；UI 修复已在 v3.1.9 发布。
