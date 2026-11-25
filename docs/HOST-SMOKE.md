# 真实宿主 boot smoke（v3.8.0 / v3.8.1 回归）

> 目标：把 v3.8.0“sidecar 拉起第二宿主”和 v3.8.1“client boot pending / handler-threw”两条回归，从**源码字符串断言**升级为**真实宿主行为断言**。
> 入口：`tools/release/host-boot-smoke.mjs`；Windows 专用，不进入 Linux 默认 `npm test`。

## 为什么不能只查源码

v3.8.0 的事故不是代码里写了 `spawn(process.execPath` 才发生的；真正的问题是打包宿主的 `process.execPath` 是 `DeepSeek Harness.exe`，在 fuse 关闭 RunAsNode 时，子进程会变成第二个 DSH 宿主，随后才出现插件加载失败、client 全 pending。只断言源码没有 `spawn(process.execPath`，无法证明：

- 实际 sidecar 用的是 DSH 自带 `node.exe`；
- 实际进程表里只有一个 `DeepSeek Harness.exe`；
- 实际 client boot 图能加载、DOM 能挂载、没有 pending / handler-threw。

本脚本启动**打包后的真实 DSH CLI**，用隔离 `DSH_HOME` / `FANG_HOME`，不碰用户 desktop profile，然后检查：

1. `Win32_Process` 中该 profile 只有 1 个 `DeepSeek Harness.exe`；
2. watchdog sidecar 是该宿主的子进程，且 executable 是 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe`；
3. `/fang/api/status` 返回 `role=mother`、审计 boot 记录 PID 等于唯一宿主 PID；
4. headless Edge 加载真实 client 页面，DOM 有 `data-fang-overlays="visible"`、`__DSH_BOOT__` 有 entries；
5. DOM 不含 `pending waiting` / `Failed to load plugins` / `handler-threw` / `failed to import` / `missed the module table`；
6. client boot 后再查一遍进程表，仍然只有 1 个宿主。

## 用法

```powershell
# 先在仓库根目录准备 npm 依赖；宿主可以是运行中，脚本只认自己 profile
npm run smoke:host -- `
  --cli "D:\DSH\resources\runtime\cli\bin\dsh.cmd" `
  --plugin "C:\Users\<you>\.dsh\profiles\desktop\node_modules\@twinsearth\fang-dsh-plugin" `
  --out "E:\DB\Fang\scratch\host-smoke-v38" `
  --keep
```

参数：

- `--cli`：打包 DSH 的 `dsh.cmd`；默认 `D:\DSH\resources\runtime\cli\bin\dsh.cmd`。
- `--plugin`：要验证的 Fang 插件目录；默认当前仓库根。
- `--out`：报告目录；默认临时 `DSH_HOME/host-smoke-report`。
- `--dsh-home`：复用隔离根；不传则创建临时目录。
- `--profile`：默认 `fang-host-smoke`。
- `--keep`：保留隔离 `DSH_HOME` 供检查；不传则运行后删除。
- `--json`：只输出机器可读报告。

退出码：`0` 全 PASS；`2` 有 FAIL 或启动失败。报告包含 `report.json`、`boot.html`、`boot.json`、`status.json`、`host-processes*.json`、`sidecar-processes.json`。

## 2026-11-25 实测（TOFUTURE / Windows）

环境：Windows 真机 TOFUTURE，打包 DSH `0.2.2-rc.5`，Fang `3.8.3`，Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。

命令：

```powershell
node tools/release/host-boot-smoke.mjs `
  --cli "D:\DSH\resources\runtime\cli\bin\dsh.cmd" `
  --plugin "C:\Users\<user>\.dsh\profiles\desktop\node_modules\@twinsearth\fang-dsh-plugin" `
  --out "E:\DB\Fang\scratch\host-smoke-v38" --keep --json
```

结果：**17 项检查全部 PASS**。

| 证据 | 实测值 |
|---|---|
| 宿主进程 | 仅 `PID 7132`，`D:\DSH\DeepSeek Harness.exe` |
| sidecar | `PID 13296`，parent `7132`，`...\primary-runtime\dependencies\node\bin\node.exe ...watchdog-sidecar.mjs` |
| 状态 | `role=mother`，`version=3.8.2`，`audit.ok=true`，`health.lastBoot.pid=7132` |
| client boot 图 | `entries=77`，含 `@twinsearth/fang-dsh-plugin` |
| client DOM | 802,125 bytes，`data-fang-overlays="visible"` |
| 错误标记 | pending waiting / Failed to load plugins / handler-threw / failed to import / missed the module table 均为 0 |
| boot 后进程 | 仍只有 1 个宿主；smoke 结束后 0 个 |

原始产物：`E:\DB\Fang\scratch\host-smoke-v38\`（`report.json`、`boot.html`、`host-processes*.json`、`sidecar-processes.json`、`status.json`）。

## 边界

- 脚本验证的是**当前安装的 Fang 版本**（本次为 3.8.2，包含 3.8.1 修复）；它不会主动安装 3.8.0 坏版本做对照。要复现 v3.8.0 故障，需另装 3.8.0 包并用同一脚本跑，预期在“exactly one DSH host”处 FAIL。
- 真实宿主 smoke 依赖打包 DSH、Edge/Chrome 和 Windows 进程表，不在 Linux CI 内跑；`test/watchdog-safety.test.mjs` 的源码断言仍保留，作为快速防线。
- 脚本不读用户 desktop profile、不改用户数据；隔离根默认在临时目录，`--keep` 才保留。
