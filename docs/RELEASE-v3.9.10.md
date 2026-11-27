# Fang v3.9.10 — 分身 Web 配额分层版

版本：`@twinsearth/fang-dsh-plugin@3.9.10`
日期：2026-11-28

## 主题

修复“内存充足却只允许同时开一个分身 Web”，并把并发配额按发行版分层：

| 版本 | 状态 | 同时存活的托管 Web | 同时存活的分身 |
|---|---|---|---|
| 普通版 | 当前发行 | 5 | 5 |
| 专业版 | 暂未开放，预留 | 20 | 20 |
| 团队版 | 预留未开放 | 100 | 100 |

## 为什么会出现“只允许一个”

`maxOpenForkBrowsers` 的旧默认值是 `1`。打开第二个分身 Web 时，`openTaskBrowser()` 会把已打开的那个按 LRU 关闭，关闭原因记为 `max-open-fork-browsers`；任务卡又把它显示成“内存保护关闭”。所以观感像内存保护，实际是并发窗口配额。

本次把普通版默认改为 5，同时保留 Commit/内存守卫作为第二道门：配额够但内存不足时仍会明确拒绝/关闭，不再用“把配额改成 1”代替内存保护。

## 改动

- 新增 `src/lib/fork-capacity.mjs`：集中定义普通版 5、专业版 20、团队版 100；`ACTIVE_FORK_EDITION` 当前固定为普通版，专业/团队只保留常量，不接授权开关。
- `maxForks`：默认 5，硬上限 100；`maxOpenForkBrowsers`：默认 5，硬上限 100；`forker` 同步为默认 5 / 硬上限 100。
- `status.capacity` 新增 `edition/editionLabel/browsers{limit,hardMax,defaultLimit,used}`；客户端容量条显示 `Web x/y`。
- 关闭原因新增 `capacity`；`max-open-fork-browsers` 归为“并发配额关闭”，不再误显示“内存保护关闭”。
- `memoryGuardDefaults().singleActiveFork` 改为 `false`；单活跃保留为显式应急开关。
- `cordis.patch.yml` 的 forker/orchestrator 默认同步为 `maxForks: 5`，orchestrator 增加 `maxOpenForkBrowsers: 5`；单行回退 `cordis.patch.single-row.yml` 同步为 5/5。

## 边界

- 专业版、团队版没有激活入口，也没有许可证校验；当前所有安装都按普通版 5 夹紧。
- 内存/Commit 守卫不因配额放宽而移除；主机压力大时仍可拒绝新分身或关闭浏览器。
- 旧配置里显式写成 `maxOpenForkBrowsers: 1` 的，仍尊重显式值，不会被静默改写。
- 端口池 18000–18100 共 101 个，团队版 100 个分身仍有 1 个余量。

## 验证

`npm run build` 全绿：preflight `pass=1582 fail=0 skip=13`，e2e `125/125`，package smoke / crash-safety / allow-list / main-city 全 PASS。产物 `dist/dsh-fang-3.9.10.tgz`，SHA-256 见同目录 `.sha256` 与交付目录 `SHA256SUMS-3.9.10.txt`。详见 `AUDIT-v3.9.10.md`。

## 资产

- npm：`@twinsearth/fang-dsh-plugin@3.9.10`
  https://www.npmjs.com/package/@twinsearth/fang-dsh-plugin/v/3.9.10
- GitHub Release：`v3.9.10`
  https://github.com/TwinsEarth/fang-dsh-plugin/releases/tag/v3.9.10
- 交付目录：`E:\DBH\Fang-v3.9.10\`
- tarball：`dsh-fang-3.9.10.tgz`；SHA-256 见交付目录 `SHA256SUMS-3.9.10.txt`
