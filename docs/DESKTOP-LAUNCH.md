# DSH Desktop 真实启动入口（launcher）

## 现状

本仓现在提供启动适配器：

```text
tools/desktop-launch.mjs        CLI
src/lib/desktop-launch.mjs      argv 构造（可测）
```

它**不修改** DSH Desktop 安装目录，也不自动启动；只负责把桌面进程交给
`tools/restart-supervisor.mjs`，让重启合同真正有执行侧入口。

## 用法

```powershell
# 默认 dry-run：只打印将要执行的 argv，不启动
node tools/desktop-launch.mjs `
  --exe "C:\Path\DSH Desktop.exe" `
  --data-root "C:\...\fang" `
  --profile-dir "C:\Users\<you>\.dsh\profiles\desktop"

# 真正执行（boot-guard 失败时自动安全模式禁用 fang 行，再启动）
node tools/desktop-launch.mjs --execute `
  --exe "C:\Path\DSH Desktop.exe" `
  --data-root "C:\...\fang" `
  --profile-dir "C:\Users\<you>\.dsh\profiles\desktop" `
  --arg=--profile --arg=desktop
```

启动前自检（`--profile-dir` 给出时默认开启；未给时自动探测 `DSH_PROFILE_DIR` / `DSH_HOME/profiles/<profile>`，探测不到则跳过并提示）：

```text
1. boot-guard 检查 fang bundle 行：重复 id、模块解析、子进程 import/apply 冒烟
2. 检查上次 boot-state：booting/crashed 且 pid 已死 → 启动期崩溃，按安全模式熔断
3. 通过 → 交给 restart-supervisor 启动
4. 失败 + --execute + 未 --no-safe-mode → 写 profile disabled:true（备份）后启动
5. 失败 + dry-run → 只报告，不写 profile，exit 2（提示 --apply/--safe-mode）
6. --no-boot-guard 完全跳过；--no-safe-mode 失败时只拒绝启动、不改 profile
```

实际构造：

```text
node tools/restart-supervisor.mjs --execute --data-root <dir> -- <desktop-exe> <desktop-args...>
```

## 语义

- 只有桌面进程以 **退出码 75（EXIT.RESTART）** 退出、且
  `<dataDir>/restart/approved/<id>.json` 存在已武装、未过期、pid 匹配的清单时，
  supervisor 才重启；
- 重启后写 `<dataDir>/restart/executed/<id>.json`，`execution.executed=true` 是唯一执行证明；
- 默认 dry-run；必须显式 `--execute`；
- 不执行任意 shell 字符串：桌面参数保持 argv 数组，全部在 `--` 之后；
- 不读/不猜 DSH Desktop 安装路径：`--exe` 必填。

## 测试

```text
desktop-launch: builds supervisor argv and defaults to dry-run
desktop-launch: --execute is explicit and desktop args stay after --
desktop-launch: rejects missing exe/data-root/supervisor
desktop-launch CLI prints dry-run plan without starting the desktop
```

## 诚实边界

- 这是**仓内启动方式接入**，不是“已在真实桌面壳验证”；
- 首次真实验证需要：找到 DSH Desktop 可执行文件 → dry-run 核对 argv → `--execute` →
  触发一次 restart-guard 请求 → 确认 supervisor 重启与回执；
- 运行中宿主仍是旧 bundle，UI/SSE/DOM 新行为要重启后可见。
