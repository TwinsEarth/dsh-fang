# Fang v3.9.10 审计记录

日期：2026-11-27
范围：分身 Web 并发配额、单 Web 锁根因、版本分层常量、状态面与关闭原因文案。

## 1. 根因

“内存充足却只允许开一个分身 Web”不是内存守卫把配额压成 1，而是托管浏览器窗口上限的旧默认值：

- `src/plugins/orchestrator.mjs` 的 `maxOpenForkBrowsers` 曾为 `z.number().min(1).max(16).default(1)`。
- `openTaskBrowser()` 在拉起新浏览器前统计 `liveBrowsers`；达到上限就调用 `closeTaskBrowser(other, 'max-open-fork-browsers')` 顶掉旧窗口。
- `closeTaskBrowser()` 把关闭信息写入 `task.memoryGuard`，任务卡据此显示“内存保护关闭”，造成误判。

页面文件策略在 v3.9.4 已 advisory 化（`singleForkOnly: false`），不是本次原因。

## 2. 修复

- `src/lib/fork-capacity.mjs` 新增版本表：
  - 普通版：`maxForkWeb=5`、`maxForks=5`、`available=true`
  - 专业版：`maxForkWeb=20`、`maxForks=20`、`available=false`（暂未开放）
  - 团队版：`maxForkWeb=100`、`maxForks=100`、`available=false`（预留）
- `ACTIVE_FORK_EDITION` 固定为 `standard`，不从配置读取“付费版本”；专业/团队只作为后续激活的常量表。
- `effectiveForkWebLimit()` / `effectiveForkLimit()` 先按当前版本夹紧，再交给内存/Commit 守卫。
- `forker` 同步默认 5、硬上限 100；`maxOpenForkBrowsers` 硬上限 100。
- `status.capacity` 暴露任务槽位与 Web 窗口两个独立容量面，避免“槽位 5 但 Web 1”继续混淆。
- `classifyCloseReason('max-open-fork-browsers')` 返回 `capacity`；客户端显示“并发配额关闭”。
- `memoryGuardDefaults().singleActiveFork` 改为 `false`，单活跃只作为显式应急开关。

## 3. 边界与残余

- 专业版/团队版尚未开放，当前没有许可证或套餐校验；代码只预留数值与夹紧能力。
- 旧配置若显式保存 `maxOpenForkBrowsers: 1`，不会被静默改写；这是用户显式选择，需手动改配置。
- 并发上限不等于内存安全：5 个 Web 仍需 Commit/内存守卫；不足时按既有 fail-closed 流程拒绝或关闭。
- 100 个槽位的 UI 圆点尚未做折叠显示；当前普通版只渲染 5 个，不影响现有发行。
- 真机 5 Web 并发未在本轮 Windows 宿主上复测；本轮以单测、静态断言和构建门禁为准。

## 4. 验证记录

- 首轮全量 preflight：`pass=1581 fail=0 skip=13`，e2e `125/125` GREEN。
- 首轮 `npm run build` 在打包冒烟处失败：`tools/release/package-smoke.mjs` 仍要求 `maxForks: 8`。已改为校验两行 `maxForks: 5`、orchestrator `maxOpenForkBrowsers: 5`、`allowMultiFork: true`、`singleActiveFork: false`。
- `cordis.patch.single-row.yml` 同步为 `maxForks: 5` / `maxOpenForkBrowsers: 5`，并新增 `package-metadata` 断言防止回退。
- 最终 `npm run build`：preflight GREEN；全量测试 `pass=1582 fail=0 skip=13`（438.2s）；e2e `125/125`（49.8s）；package smoke、crash-safety、allow-list、main-city 全 PASS。
- 最终产物：`dist/dsh-fang-3.9.10.tgz`（948804 bytes，211 entries），sha256 `2ed8c93f3472182c5580f30547de23e992b5add2876d55d35d91dd101a19127d`。
- 定向测试覆盖：版本配额表、普通版夹紧、Config 默认 5、源码准入守卫、status 双容量面、package 元数据与单行回退配置。
- 构建日志：`E:\DBH\fang-report\build-3910b.log`。
