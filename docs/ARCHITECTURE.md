# dsh-Fang v1.0.0 — 架构

> 产品定义：以「母体-分身」为核心的插件开发环境。
> 母体是稳定模板；每个任务派生一个用完即弃的子 dsh-Web；崩溃不扩散、污染不残留、插件不串味。

---

## 1. 一个包，十个插件行

v1.0.0 是**单包多入口**（`@local/dsh-fang`）：一次安装、十个 loader 行，互相通过 kernel 与 Cordis 服务协作。
拆行装载（`cordis.patch.yml`）是默认方式；若某环境的 loader 解析不了子路径入口，可用单行回退（`src/compose.mjs` + `cordis.patch.single-row.yml`），行为一致。

```
母体（desktop / web profile，长期运行）
 ├─ fang-auditor        2.8 审计：哈希链账本 + 启动自检 + 回滚
 ├─ fang-forker         2.1 派生器：provision/spawn/stop/reap/status
 ├─ fang-buffer-keeper  2.7 缓冲：监视 + 三态 + settled 落盘
 ├─ fang-scorer         2.2 评分：静态 A–E + 动作灯色 + 路由建议
 ├─ fang-healer         2.3 修复：自检/证据/G1–G12 门禁/补丁建议
 ├─ fang-router         2.9 路由：sandbox | container | deny
 ├─ fang-approver       2.4 审批：队列 / A-B 双备 / 监控 / 回滚
 ├─ fang-hot-reloader   2.5 热更新：swapPlugin + 健康窗（失败即回滚，不升红）
 ├─ fang-restart-guard  2.6 红线守卫：只拦母体重启
 └─ fang-orchestrator   主插件：fork/reap/list/promote/status + /fang 门户 + Client 徽标
```

依赖方向是单向的：编排器调用子插件服务；子插件之间只通过 kernel 的 `bus` 与可选服务协作，缺失时显式降级（返回 `{ok:false,error:'xxx-unavailable'}`），不静默假装成功。

---

## 2. 目录与数据布局

```
dsh-fang\
  package.json          bundle 清单（v1.0.0；exports 十个入口 + client + locale + icon）
  cordis.patch.yml      十行装载（默认）
  cordis.patch.single-row.yml  单行回退装载
  src/index.mjs         = orchestrator 入口（包的 "."）
  src/compose.mjs       单行模式：把十个插件挂成嵌套 fiber
  src/kernel/           共享内核（零外部依赖）
    fsx.mjs            原子写 / 摘要 / junction 安全删除 / 拷贝
    paths.mjs          布局解析 / profileTag / web URL 解析（要求带 token）
    ledger.mjs         哈希链审计（已在实机账本验证）
    rounds.mjs         轮次事务（纯逻辑，fsApi 注入）
    core.mjs           ids / bus / 资源采样 / 退出码
    types.mjs          SERVICE/ROW/AUDIT/状态机词表
    schema.mjs         vendored schemastery
  src/plugins/         十个插件（每个导出 name/inject/Config/apply）
  client.js            Client 半：dock 徽标 + 门户入口
  tools/fangctl.mjs    离线运维 CLI（status/forks/verify/tail/doctor）
  test/                node:test 单测（零外部依赖）
  docs/                CONTRACTS.md（接口契约）/ ARCHITECTURE.md / 各 owner 报告
```

数据目录（母体）：`$DSH_HOME/fang/<profileTag>/`

```
audit.jsonl     哈希链审计
state.json      运行状态
forks.json      分身注册表（{forkId, pid, port, url, homeDir, profile, status, createdAt}）
buffer/         母体缓冲区（插件开发目录）
snapshots/      A/B 双备
promoted/       提升 staging（分身验证通过 → 母体侧待生效）
forks/<forkId>/ 每个分身的 $DSH_HOME（内含自己的 profiles/、fang/、会话等）
```

分身的数据布局由它自己的 `$DSH_HOME` 决定，因此天然与母体隔离。分身的 `node_modules` 是指向
母版 profile 的 **junction**；回收时必须用 kernel 的 `removeTree()`（遇到 junction 只 unlink，
绝不进入目标）——这是唯一安全的删除路径。

---

## 3. 生命周期

### 3.1 派生（fork）

```
POST /fang/api/forks/create {taskTitle}
  → orchestrator.fork()
      1. 配额检查（maxForks，默认 8）
      2. forker.provision()：建 homeDir；克隆 profileTemplate 的 package.json + cordis*.yml；
         node_modules = junction(母版 profile/node_modules)
      3. forker.spawn()：spawn(cliPath, ['--profile',<profile>,'--port','0','--no-open'], {env:{DSH_HOME: homeDir}})
      4. stdout 滚动缓冲 → parseWebUrl()（**必须带 token**，裸地址 401 视为未就绪）
      5. 注册表落盘 + 审计 + bus 'fang/fork-started'
      6. probeWebUrl() 健康探测 → 返回 {forkId, url, port, homeDir, profile}
```

### 3.2 回收（reap）

`forker.stop()`（Windows: `taskkill /PID <pid> /T /F`）→ `removeTree(homeDir)` → 注册表删除 → 审计。
**分身重启 = 回收 + 重新派生**，不经过 restart-guard，也不需要审批。

### 3.3 提升（promote）

```
POST /fang/api/promote {forkId, pluginId}
  1. 定位 <forkHome>/fang/<forkProfile>/buffer/<pluginId>
  2. scorer.scoreDir()  → D/E 直接拒绝
  3. healer.gates()     → 任一 G 门禁失败拒绝
  4. approver.request({kind:'promote', risk:'red'}) → 非 approved（deny/timeout）一律拒绝
  5. approver.snapshot() 做 A/B 备份 → 复制到母体 promoted/
  6. 审计 promote-committed
  返回 {ok:true, target, note:'重启母体后生效（重启需 restart-guard 审批）'}
```

v1.0.0 的提升只写 staging，不触碰母体正在使用的插件，也不自行重启母体。

### 3.4 母体重启

唯一入口 `orchestrator.requestMotherRestart()` → `restart-guard.request()`：
决策矩阵（blue/yellow/red）+ 审批（approver，红灯必须显式通过）+ 单飞状态机；
`allowProcessRestart` 默认 false，v1.0.0 **只决策、审计、审批，不执行退出**。

### 3.5 热更新（分身内）

`hot-reloader.swap()`：`?rev=<contentHash>` 动态 import 新 fiber → 健康窗（句柄差分，
`leakedRefed > healthMaxNewHandles` 即泄漏）→ 成功才 dispose 旧 fiber；失败时旧 fiber 从未被触碰。
回滚不了就由编排器回收分身重新派生——把复杂度从"回滚逻辑"移到"进程回收"。

---

## 4. 防线在哪一层（不混淆）

| 层 | 提供什么 | 不提供什么 |
|---|---|---|
| 分身（独立进程 + 独立 DSH_HOME） | 故障隔离、污染隔离、插件不串味 | 权限隔离（同用户同 ACL） |
| 静态评分 + 申报制（scorer/healer） | 装载前的准入判断（词法级） | 运行时强制 |
| approver | 人工确认黄/红动作 | 绕过红灯 |
| restart-guard | 母体重启的唯一闸门 | 分身生命周期（那走 reap） |
| router → container（v1.0.0 仅决策） | 对不可信插件的运行时兜底（需容器可用） | 本机未安装容器时降级为 deny + 原因 |
| auditor | 事后可验证（哈希链） | 事前阻断 |

红线守卫只拦母体重启，是因为**母体不可变**；分身是消耗品，不值得为它写复杂回滚。

---

## 5. v1.0.0 交付边界（诚实清单）

已实现：
- 十个插件行全部可装载（本仓库内可 `import` 全部模块并通过单测）；
- fork / reap / list / health / promote 全链路，母体门户 + Client 徽标；
- 审计链、A/B 双备、审批队列与 TTL fail-closed、健康窗热换版、三态缓冲、评分/门禁/路由决策；
- 离线 CLI（status/forks/verify/tail/doctor）。

未实现（明确 NOT ESTABLISHED）：
- 容器执行后端（router 只做决策；`containerAvailable()` 本机返回 `{ok:false,reason}`）；
- restart-guard 的真实进程退出（`allowProcessRestart=false`，只到审批/审计）；
- 跨设备 Relay 协作、云端备份、AI 审计、团队权限（产品定义的 5 项付费功能，不在 v1.0.0 范围）；
- 分身会话迁移/复制（v1.0.0 每个分身从干净会话开始）。
