# 分身看护开关（UI / API / watchdog）

## 两个开关

| 开关 | 作用 | 生效时机 |
|---|---|---|
| `autostartForks` | watchdog 启动宿主后是否调用 `POST /api/forks/autostart` 恢复未归档分身 | 下一次 watchdog 启动 |
| `supervise` | forker 是否在已就绪分身崩溃后按退避重启 | **立即生效**（运行时切换，无需重启宿主） |

## 持久化

```text
<dataDir>/fork-supervision.json
{ "version":1, "autostartForks":true, "supervise":false, "updatedAt":... }
```

- UI：主面板「分身看护」两个 checkbox；
- API：
  - `GET  /fang/api/forks/supervision`
  - `POST /fang/api/forks/supervision` body `{ autostartForks?:boolean, supervise?:boolean }`
- 启动时 orchestrator 会把持久化的 `supervise=true` 应用到 forker（插件顺序晚于 orchestrator，用 `ctx.inject([fangForker])`）。

## watchdog 的默认值

`tools/restart-watchdog.mjs`：

```text
--autostart-forks / --no-autostart-forks   显式覆盖
未显式指定 → 读 <dataDir>/fork-supervision.json 的 autostartForks
--execute 且设置未关闭 → 才真正请求 autostart
dry-run / 未 --execute → 永不 autostart
```

## 持续看护的边界

- **崩溃自动重启**由 forker 的 `supervise` 负责（进程内、按退避、只重启已 ready 的分身）；打开 UI 开关后立即生效；
- **watchdog 不持续轮询分身列表**：它只负责“宿主死亡后重启宿主 + 启动时 autostart”。因此：
  - 分身崩溃 → forker supervise 处理（若开启）；
  - forker/宿主崩溃 → watchdog 处理宿主重启，再 autostart；
- `supervise` 默认仍为 **opt-in**：与 Orchestrator archive/reap 生命周期存在竞争，打开前需接受自动重启可能与人工归档冲突。

## 测试

```text
fork-supervision-settings: 默认/写读/部分 patch/非法值
forker: runtime supervise can be toggled without restarting the host
orchestrator: fork supervision toggles persist and apply to the forker
watchdog autostart preference: settings 默认 / CLI 覆盖 / dry-run 不 autostart
client-http-contract: 路由与 UI 钩子
```
