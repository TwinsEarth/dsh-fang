# AUDIT v3.1.2

> 版本：3.1.2（2026-11-09）
> 主题：启动韧性 / 自检 / 更新器门禁收口 + 四方发布。
> 原则：只记录本机实际执行过的命令与结果；未执行项明确标 ❌。

## 1. 本版内容

| 项 | 状态 |
|---|---|
| boot-guard（bundle 行 / import 冒烟 / `--apply` / `--safe-mode` / `--candidate-dir`） | ✅ |
| desktop-launch 自动接 boot-guard（profile 自动探测、失败安全模式） | ✅ |
| restart-watchdog 重启前自动接 boot-guard（失败不 spawn） | ✅ |
| restart-guard selfCheck + `GET /fang/api/restart/selfcheck` | ✅ |
| boot-state + runtime-crash ledger + launcher 启动期崩溃熔断 | ✅ |
| approver 多代快照 + 崩溃 journal | ✅ |
| 无效 `fang-home.txt` 指针回退 | ✅ |
| 真实重装/毒数据 drill | ✅ |
| PluginUpdater/SuperAgent/HarnessMM/PJM/Worker 本体 | ❌ 外部进程未接 |
| DSH 宿主内其他插件 apply 硬失败当场拦截 | ❌ 需宿主 API |

## 2. 门禁证据

> 下列数字在发布前最后一次 `preflight --e2e` / build / drill 后回填。

```text
preflight --e2e : GREEN
  tests         : 1026 total / 1015 pass / 0 fail / 1 skip / 10 todo (179.9s)
  e2e           : 81/81 (16.9s)
  allow-list    : routes=104 findings=0（scanned 308）
  compat        : COMPATIBLE（本地）
  package smoke : PASS
  install drill : GREEN 10/10（boot-guard precheck：19 行、2 个可选子插件 warn）
  reinstall     : GREEN 7/7（同一 DSH_HOME 覆盖安装 + 16 类毒数据后二次 boot）
  healthz       : HEALTHY @twinsearth/dsh-fang@3.1.2
  artifact      : 510,726 B / 135 entries
  sha256        : 558a81da140005879c830a80048e4a89a00e2562fee2e782de8dfe2586b809b2
```

## 3. 四方发布状态

| 方 | 状态 | 证据 |
|---|---|---|
| GitHub Release | 待执行 | tag 必须打在 main 尖端；release workflow 触发 |
| npm | 待执行 | 依赖 `NPM_TOKEN`；无 token 时 workflow 跳过 |
| CI | 待执行 | push/PR 触发；自托管 e2e runner 需在线 |
| Compat | 待执行 | `compat.yml` 或本地 COMPATIBLE |

## 4. 已知边界

- 外部业务生产者本体不在本仓；本仓只能提供契约/client/CLI/门禁。
- 私有镜像 verify：`MIRROR_TOKEN` 或 `MIRROR_REQUIRED=0`，否则 release workflow 会红。
- Docker job 依赖 Docker Hub secrets；无凭据可能红（不影响 GitHub Release 本体）。
- .exe 安装器不在本仓构建链。
