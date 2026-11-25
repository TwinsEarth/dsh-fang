# 审计报告 · dsh-Fang v2.6.0（Forker 完整化）

> 生成时间：2026-11-01T09:58:48.582Z ｜ 分支：`feat/forker-supervisor`（堆叠在 #8 之上）
> 本报告由门禁实际输出生成（`dist/preflight.json` / `dist/allowlist.json` / `dist/manifest.json`）。

## 1. 本轮实现与修复

| # | 项 | 实现 | 证据 |
|---|---|---|---|
| 1 | 每分身 meta 持久化 | `<forkHome>/fang-meta.json`（原子写/0600；status/pid/port/url/profile/crashCount/restartCount/lastError/时间戳） | fork-supervisor 单测 |
| 2 | 端口池 | 18000–18100 + 分配前 listen 探测 + `ports.json` 持久化 + 死 pid 保留项启动回收 + 每 pid 绑定 | forker 24 项测试 |
| 3 | junction 幂等 | `makeJunction` 幂等；`removeTree` junction-safe（不进入母体） | forker 测试 |
| 4 | spawn/就绪 | Windows `.cmd` → shell；--port 预分配；stdout tokenized URL 解析；端口不符 → 停止并报 `port-mismatch` | forker 测试 |
| 5 | 崩溃退避（opt-in） | `supervise=true` 时只重启 `ready=true` 的崩溃：`min(maxMs, base*2^n)` ± jitter，最多 `maxRestarts`；首启失败不重启 | `planRestart` 真值表 + backoff 边界 |
| 6 | 孤儿恢复 | `recover()`：pid 死 → crashed + 归还端口；pid 活 → 保留（绝不 kill 他人实例） | reconcileOrphans 单测 |
| 7 | 健康探测 | `health(forkId)`：进程状态 + 回环 HTTP（任何响应算活；404 也算） | HTTP 探测单测 |
| 8 | 回收 | taskkill /T /F（进程树）；Unix SIGTERM→5s→SIGKILL；reap 先写 meta 再删 home | forker reap 测试 |
| 9 | **回归修复** | exit handler 在 reap 删除记录后仍写 meta → 重建 home；已加 `records.get(forkId) === rec` 守卫，e2e 恢复 45/45 | e2e |

## 2. 门禁（真实执行）

| 门禁 | 结果 |
|---|---|
| preflight | **GREEN**（版本/许可/allow-list/305 pass-0 fail-1 skip/e2e 45/45） |
| 全量测试 | **305 pass / 0 fail / 1 skip** |
| 实机 e2e | **45/45** |
| allow-list | **PASS**：29 路由 / 107 文件 / findings=0 |
| 构建 + 包 allow-list | `dsh-fang-2.6.0.tgz`（210290 B，79 entries），sha256 `6459c22e6b3ede0287129bc0786a59c71ed54f1f3bc51fb58ce4e345aa0e1211` |
| 产物 healthz | **HEALTHY** `@twinsearth/dsh-fang@2.6.0` |
| CI（PR） | 待 PR 创建后由 required checks 复核 |

## 3. 关键设计决策

- **supervise 默认关闭（opt-in）**：自动重启与 Orchestrator 的 archive/reap 生命周期竞争（本地实测会重建 home），因此 patch 行 `supervise: false`，需要时显式打开；单测覆盖策略本身。
- **只重启 ready 过的崩溃**：首启失败（spawn/超时）直接返回错误，避免 loop-spawn。
- **health 不伪造 tokenized URL**：HTTP 探测只回答“进程是否在听”，就绪仍以 child 打印的 URL 为准（Adapter 握手需要 token）。
- **孤儿不抢锁**：pid 活着的记录原样保留并计入 `actions`，由上层决定复用/接管。

## 4. 已知边界

1. 同一 fork 被两个母体实例管理时没有跨进程锁，`recover()` 只保留 live pid 一侧。
2. 健康探测是端口级：端口被外部进程占用时 HTTP 可能误判为活，需结合进程状态。
3. supervise 的集成自动化只覆盖纯函数与 forker 单测；崩溃重启的端到端（真 DSH 崩溃）未纳入 e2e（避免 CI 不稳定）。
4. 版本升级到 2.6.0，但 README 仍为维护者网页编辑的旧版本文案；合并后单独 PR 更新。
