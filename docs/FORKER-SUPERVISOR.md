# Forker Supervisor（v2.6.0）

## 职责边界

Forker 只负责：端口池、junction/template、spawn、就绪探测、崩溃退避、回收。它不判断“该不该派生”，
也不感知任务语义（那是 Orchestrator 的职责）。

## 状态机

```
provisioning -> ready/running --(exit, intentional)--> stopped
                             --(exit, crash, ready, supervise)--> provisioning(restart scheduled)
                             --(exit, crash, !ready or maxRestarts)--> crashed/failed(restart-given-up)
任何状态 --reap--> reaped (home removed; fang-meta.json written before removal)
```

## 关键决策

- **端口池**：18000–18100，分配前 listen 探测；`ports.json` 持久化（pid 存活校验），死 pid 的保留项在启动时回收。
- **就绪**：以 child stdout 的 tokenized URL 为准（需要 token 才能握手）；`health()` 的 HTTP 探测只做存活/诊断，不伪造 URL。
- **退避**：只有 `ready=true` 的崩溃才重启；attempt 上限 `maxRestarts`，退避 `min(maxMs, base*2^n)` ± jitter。
  **默认关闭（opt-in）**：自动重启会与 Orchestrator 的 archive/reap 竞争，需在 patch 里显式 `supervise: true`。
- **孤儿**：母体重启后 `recover()` 对账；pid 活着的不接管、不 kill、不归还端口（避免两个母体抢同一分身）。
- **meta**：`<forkHome>/fang-meta.json` 原子写；reap 在删目录 **之前** 写，避免删除后重建目录。
- **Windows 回收**：`taskkill /PID <pid> /T /F` 杀进程树；Unix 先 SIGTERM 等 5s，再 SIGKILL。

## 测试

- `test/fork-supervisor.test.mjs`：backoff 边界/抖动、planRestart 真值表、孤儿对账、meta 原子读写、HTTP 探测；
- `test/forker.test.mjs`：端口池/模板/junction/spawn 超时/stop/reap/注册表持久化 + 服务契约（health/recover）。

## 已知边界

- 退避重启不会无限循环：首启失败不重启；达到 maxRestarts 后置 `restart-given-up:*`。
- 若同一 fork 被两个母体实例同时管理，`recover()` 只保留 live pid 的一方，不主动抢锁（需要上层做单实例锁）。
- `health()` 依赖分身绑定 127.0.0.1；端口被外部占用时 HTTP 可能误判为活，需结合进程状态一起看。
