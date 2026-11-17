# AUDIT v3.5.0

范围：**加速分身（Accelerated Fork）P0 地基 + P1 开关与运行 + P2 兼容与文档**。
基线：v3.4.2（`708ad4a`）。分支：`feat/accel-p0`。**未打 tag、未推送、未发布。**

## 1. 目标与边界（用户确认）

| 对象 | core |
|---|---|
| 桌面客户端 / 母体宿主 | 原厂，不加速 |
| 元主运行态 | 原厂，**强制**（源码守卫） |
| 分身 Web | 原版 / 加速版，母体面板开关切换 |

旧「加速模式」侧车（第二个母体 Web）下线，`/fang/api/accelerated/status|start|stop` 移除（路由 88 → 86）。

## 2. 变更清单

### P0 地基

| 文件 | 内容 |
|---|---|
| `src/lib/accelerated-install.mjs` | 安装到 `<FANG_HOME>/accel/cli` + `state.json`；只接受 `lib/bin.js`（拒绝 `.cmd` shim）；解析链 config→`FANG_ACCEL_CLI`→state→标准位置；缺失即 `accelerated-cli-missing` |
| `src/lib/accelerated-fork.mjs` | 极简 profile（base+web-app+fang 三 bundle 恒定）；fang/子插件 junction；模型 overlay（`@deepseek-ai/dsh-`→`@twinsearth/dsh-`）；不覆盖非本工具生成的 home patch |
| `src/plugins/forker.mjs` | `provision({coreMode})` 加速分支；`spawn` 按 coreMode 解析 CLI、缺失即失败；跳过 fork-seed / 官方 node_modules 镜像 / 官方 headless overlay；`publicFork.coreMode` |
| `src/plugins/orchestrator.mjs` | 加速侧车路由下线；essence provision+spawn 显式 `coreMode:'stock'` |
| `tools/release/accelerated-install.mjs` | 安装 CLI + **1 GiB 体积门禁**：`>1 GiB` 必须二次确认（TTY 提示 / `--confirm-oversize`），未确认不写 `state.json`；`acceleratedCoreInfo` 暴露 `sizeBytes/limitBytes/requiresConfirmation` |
| `tools/release/accelerated-fork-smoke.mjs` | 真实加速分身 smoke（7 检查） |
| `test/accelerated-{install,fork,fork-live}.test.mjs` | 单测 + `FANG_ACCEL_LIVE=1` 真机 live |

### P1 开关与运行

| 文件 | 内容 |
|---|---|
| `src/lib/fork-core-settings.mjs` | `<dataDir>/fork-core.json`（mode/sessionMode/updatedAt/updatedBy），原子写，损坏降级 stock+new |
| `src/plugins/orchestrator.mjs` | `GET/POST /fang/api/fork-core`（同路径经 `routeMethods`，避免二次 register 抛错）；createTask/归档还原/autostart 按设置传 coreMode；**重新打开时按开关重新 provision（非热更新）**；加速缺失错误透传 `accelerated-cli-missing` + `searched`；`taskView.coreMode` |
| `client.js` | 母体头部 `M-09`「分身Core核心加速引擎：官方 / 一键加速」开关（切换提示需重新打开分身 Web）；分身卡「加速核」徽标；刷新轮询 `/fang/api/fork-core` |
| 会话策略 | `sessionMode:'new'`（默认）只建新会话；`sessionMode:'copy'` 允许导入旧会话但只复制成新副本进分身 home（绝不原地挂载）；`inherit` 归一为 `copy` |
| 未安装 fail-closed | 点「一键加速」→ 明确 `accelerated-cli-missing`（设置未改变）；服务端 POST 返回 409 + `unchanged:true` 且不写设置；GET `effectiveMode:null` + `blocked`，不做静默 stock 降级 |

### P2 兼容与文档

- `docs/ACCEL-FORK-COMPAT.md`：核心/官方 bundle/第三方插件兼容矩阵（含未验证项）；
- **D2 混合插件面（alias/shim）**：`accelerated-fork.mjs` 新增 `translateBundles` / `scanDeepseekSpecs` / `writeAliasStubs` / `buildSyncedAcceleratedProfile`；`writeAcceleratedForkProfile({sourceProfileDir, accelNodeModules})` 同步原身插件面并返回 `sync`（mapped / unsupportedBundles / copiedPlugins / alias）；`task.acceleratedSync` 暴露给任务视图；真机验证 0 导入失败（57 alias resolved / 8 unsupported / 5 pending 服务等待）；
- `tools/release/accel-alias-spike.mjs`：可复现的 alias 覆盖率量化工具（baseline 2/4 失败 → 桩包后 4/4 激活）；
- `tools/release/accel-plugin-smoke.mjs`（`npm run smoke:accel-plugins`）：逐插件功能冒烟——synced profile 真机启动、activated/pending-service/failed-import 分类、host 页面与 `/fang/adapter/identity` 探针；真机结果 3/3 激活 + identity `{role:'fork', version:'3.5.0'}`；
- `docs/ACCELERATED-FORK.md`：P0+P1 全量说明、安装/验证/限制；
- `docs/CHANGELOG.md`：v3.5.0 段；
- 本审计；
- `package.json` `test:accel-live` 脚本。

## 3. 验证证据（本机实测）

```
accelerated-install 单测             10/10
accelerated-fork 单测                9/9
fork-core-settings 单测              8/8
accelerated-fork-live（FANG_ACCEL_LIVE=1）  pass（forker 真派生：identity role=fork, version=3.5.0）
accelerated-fork-smoke               7/7（banner/identity/client.js/core 版本/非 stock CLI）
tools/e2e.mjs                       106/106（含 4 项 fork-core 契约断言 + 3 项 B 契约基线 + 4 项 B 委托：白名单只读目录 / contract-unsupported 拒绝 / 只读能力委托成功 / contract-unavailable 映射）
allow-list self-check               110 路由 findings=0
main-city source gate               grade=A blockers=0
```

真实安装：`@twinsearth/dsh 3.5.0` → `<FANG_HOME>/accel/cli`（651 包；安装 8 分钟实测）。

## 4. 已知限制

1. 真实模型对话未做端到端验证（仅配置层 `mismatch=0`）；
2. 加速分身默认不带第三方插件、不带官方可选 bundle（见兼容矩阵）；
3. 旧会话继承（`sessionMode:'inherit'`）未经格式兼容验证；
4. 开关只影响新派生/重启；运行中分身不热切换；
5. `approver` 文件桥 ACL 门禁在宽 ACL 的临时目录会按设计禁用桥——测试改为显式 `bridgeAclCheck:false`（功能测试），生产默认仍开启。

## 5. 发布状态

- 版本：3.5.0（开发完成，未发布）；
- 路由契约：86；
- **D2 下一阶段**：B（无头能力契约委托）与 UI client half 浏览器映射已立项（`docs/D2-NEXT-PHASE.md`），**不阻塞 v3.5.0 发布**；
- 未执行：push / tag / GitHub Release / npm publish。发布需用户明确指令并走主城门禁。
