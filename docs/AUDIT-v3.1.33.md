# AUDIT v3.1.33

范围：macOS 元主运行态启动失败（runtime-spawn-failed: spawn-error）。

| 项 | 内容 |
|---|---|
| 现象 | MacMini：启动元主 Web 失败，runtime-spawn-failed: spawn-error |
| 根因 | resolveCliPath 只探测 Windows dsh.cmd + 硬编码盘符，mac 上找不到 launcher |
| 触发 | 回落裸 dsh → 不在 PATH → spawn ENOENT → spawn-error |
| 修复 | 平台感知候选（Resources 优先、无扩展名 dsh、.app 兜底） |
| 增强 | 报错附带 message/spec/log，不再只有笼统 spawn-error |
| 回归 | test/cli-resolve-platform.test.mjs 4 例 |

## 平台差异

```text
win  : <install>\DeepSeek Harness.exe
       → <install>\resources\runtime\cli\bin\dsh.cmd
mac  : <app>/Contents/MacOS/DeepSeek Harness
       → <app>/Contents/Resources/runtime/cli/bin/dsh   （大写 Resources，无扩展名）
```
