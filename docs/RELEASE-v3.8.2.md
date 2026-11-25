# v3.8.2 三方发布记录（2026-11-24）

> 用户当次指定版本 v3.8.2；基线 v3.8.1。重大数据根隔离修复。

## 门禁

| 项 | 结果 |
|---|---|
| 全量 npm test | **1341 pass / 0 fail / 2 skip** |
| preflight --e2e | **GREEN（e2e 125/125）** |
| 发布 PR CI | N/A（本地仓库，未走 PR） |
| release-order | 未执行（发布未走 release-order） |

## 发布结果

- tag：本地 `v3.8.2` → `c8143738d3063bd2f8cb08d59e0d223faf0c4049`（未 push）
- GitHub Release：未创建
- npm：未发布
- artifact sha256：未构建/未采集

## 数据迁移

- 旧布局默认继续可读，UI 标记「旧数据待迁移」。
- 停宿主后执行 `node tools/migrate-fang-home.mjs --apply`；只复制不删除。
- 新数据根 `D:\ToFuture\FangData`。
