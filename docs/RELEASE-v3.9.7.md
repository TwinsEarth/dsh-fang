# Fang v3.9.7 — 宿主压力阈值对齐版

发布日期：2026-11-27
版本：`@twinsearth/fang-dsh-plugin@3.9.7`

## 主题

修复 v3.9.6 遗留的**两套阈值不一致**：v3.9.6 只把 `fork-health.mjs` 的分身打开门禁改为 200/300/500 MB 与 3000/3600/3900 MB；宿主压力横幅仍由 `host-pressure.mjs` 的旧默认值 16/32/64 MB 与 512/1024/2048 MB 驱动。重启宿主后，365.5 MB 合计 / 60.9 MB 单文件的真实会话仍显示“宿主压力预警”。

## 变更

- `SESSION_FOOTPRINT_DEFAULTS` 改为：
  - 合计：`warn=3000 MB`、`critical=3600 MB`、`emergency=3900 MB`
  - 单文件：`fileWarn=200 MB`、`fileCritical=300 MB`、`fileEmergency=500 MB`
- `orchestrator` 的六个 `sessionFootprint*` / `sessionFile*` 配置默认值同步改为上述值；显式配置覆盖仍然生效。
- session 体量等级判断改为严格 `>`：
  - 恰好 200/300/500 MB、3000/3600/3900 MB 仍属较低一档；
  - 单文件超过 500 MB 或合计超过 3900 MB 才进入 emergency；
  - 单文件 emergency 仍驱动 `gate`，合计 emergency 仍只置 `totalGate`。
- Host JS heap 阈值保持 1024/1536/2048 MB，本版未改。

## 行为变化

- 当前 365.5 MB 合计 / 60.9 MB 单文件的宿主不再触发“宿主压力预警”。
- 单文件 200 MB 以上开始警告，300 MB 以上为严重，500 MB 以上才会拒绝新分身/新浏览器。
- 合计 3000 MB 以上开始警告，3600 MB 以上为严重，3900 MB 以上为合计紧急；合计紧急仍不单独封门。
- 旧配置文件中若显式写了 `sessionFootprintWarnMB` 等旧值，新默认值不会覆盖它；需要同步修改配置，或删除该覆盖项。

## 测试

- `test/v3814-host-guard.test.mjs`：6/6 PASS。
  - 覆盖 365.5 MB / 60.9 MB 返回 `ok`；
  - 覆盖 200/300/500 MB 与 3000/3600/3900 MB 精确边界；
  - 覆盖单文件 `gate` 与合计 `totalGate` 分离。
- `test/v386-crash-closures.test.mjs` + `test/v387-crash-prevention.test.mjs`：19/19 PASS，v3.9.6 的多帧 zstd 修复和分身健康确认流程未回归。
- 构建与全量测试记录见 `docs/AUDIT-v3.9.7.md`。

## 已知边界

- 本版只对齐 session 体量阈值，不改变 Host JS heap 阈值、Commit 余量、Safe Mode 或页面文件策略。
- 宿主压力横幅仍只是提示；新分身/新浏览器准入由单文件 emergency（>500 MB）触发，合计 emergency 只审计/横幅提示。
