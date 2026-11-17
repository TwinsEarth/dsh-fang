# 加速分身（Accelerated Fork）· v3.5.0

> 适用：dsh-Fang **v3.5.0**（P0 地基 + P1 开关与运行 + P2 兼容与文档）。
> 一句话：**只有分身 Web 可以跑加速核（`@twinsearth/dsh 3.5.0`）**；桌面/母体宿主与元主运行态永远原厂 core。开关在**母体面板**，且**不是热更新**——重新打开分身 Web 才生效。

## 1. 边界（硬约束）

| 对象 | 原版 core | 加速 core | 说明 |
|---|---|---|---|
| 桌面客户端 / 母体（宿主） | ✅ 始终 | ❌ 不动 | 旧 sidecar「第二个母体 Web」已下线 |
| 元主运行态（essence runtime） | ✅ 始终 | ❌ 禁止 | `forker.provision/spawn` 显式 `coreMode:'stock'`，有源码守卫测试 |
| **分身 Web** | ✅ 默认 | ✅ 唯一加速对象 | 母体面板开关切换 |

旧「加速模式」侧车路由 `/fang/api/accelerated/status|start|stop` 已移除（路由 88 → 86），替换为 `GET/POST /fang/api/fork-core`。

## 2. 组成

| 文件 | 作用 |
|---|---|
| `src/lib/accelerated-install.mjs` | 安装/发现加速核：`<FANG_HOME>/accel/cli` + `state.json`；只接受 `lib/bin.js`（Windows `.cmd` shim 不能 spawn）；解析链 config → `FANG_ACCEL_CLI` → state → 标准位置；缺失即 `accelerated-cli-missing` |
| `src/lib/accelerated-fork.mjs` | 极简分身 profile（**只有** `@twinsearth/dsh-base` + `@twinsearth/dsh-web-app` + `@local/dsh-fang`，加两个子插件 junction）+ 模型 overlay（`@deepseek-ai/dsh-` → `@twinsearth/dsh-`） |
| `src/lib/fork-core-settings.mjs` | `<dataDir>/fork-core.json`（`mode` / `sessionMode`），原子写、损坏降级 stock+new |
| `src/plugins/forker.mjs` | 加速分支 provision；`spawn` 按 coreMode 解析 CLI，缺失即失败；跳过 fork-seed / 官方 node_modules 镜像 / 官方 headless overlay；`publicFork.coreMode` |
| `src/plugins/orchestrator.mjs` | `GET/POST /fang/api/fork-core`；createTask / 归档还原 / autostart 按开关换核；元主 spawn 固定 stock |
| `tools/release/accelerated-fork-smoke.mjs` | 真实加速分身 smoke（起真进程 + 断言身份/client 半） |

## 3. 安装

```powershell
# 安装到 <FANG_HOME>/accel/cli（约 651 包 / ~738 MiB）
npm run install:accel -- --fang-home <FANG_HOME>
# 或显式确认超限安装：
node tools/release/accelerated-install.mjs --fang-home <FANG_HOME> --confirm-oversize
```

**体积门禁（产品约束）**：安装目录上限 **1 GiB**（`ACCEL_INSTALL_LIMIT_BYTES`）。
- ≤ 1 GiB：正常安装/复用；
- > 1 GiB：**必须二次确认**——交互式终端会弹确认提示；无 TTY（CI/自动化）默认失败（`accelerated-install-too-large`），需显式 `--confirm-oversize` / `--yes`；
- 未确认时不写 `state.json`（视为未安装），已下载文件保留待人工处理。

## 4. 验证

```powershell
$env:DSH_HOME='%DSH_HOME%'
node tools/release/accelerated-fork-smoke.mjs --fang-home <FANG_HOME>     # 期望 7/7、exit 0
$env:FANG_ACCEL_LIVE='1'; $env:FANG_HOME='<FANG_HOME>'
npm run test:accel-live                                                   # forker 真派生加速分身
```

已实测（2026-11-17）：加速核 `lib/bin.js` 启动分身成功；页面含 `dsh-fang/client.js`；`/fang/adapter/identity` 返回 `{role:'fork', version:'3.5.0', protocol:3}`。

## 5. 已知限制

1. 加速分身默认**不带第三方插件**与官方可选 bundle（见兼容矩阵 `docs/ACCEL-FORK-COMPAT.md`）；
2. 真实模型对话未做端到端验证（仅配置层 `mismatch=0`）；
3. 旧会话继承（`sessionMode:'inherit'`）未经格式兼容验证，默认 `new`；
4. 开关只影响新派生/重启；运行中分身不热切换；
5. 加速核安装约 738 MB。

## 6. P1 · 开关与运行

### 6.1 持久化

`<dataDir>/fork-core.json`：

```json
{ "mode": "stock" | "accelerated",
  "sessionMode": "new" | "inherit",
  "updatedAt": "ISO", "updatedBy": "panel" }
```

### 6.2 API

`GET/POST /fang/api/fork-core`（同路径经 `routeMethods` 注册）：

- GET → `{ ok, mode, sessionMode, effectiveMode, blocked, accelerated:{installed,version,cliPath,error}, forks:{stock,accelerated}, essence:'stock' }`
- POST `{ mode?, sessionMode?, by? }` → 非法值 400；持久化后返回同 GET 形状 + `changed:true`

### 6.3 行为

| 项 | 行为 |
|---|---|
| 面板开关 | 母体头部 `M-09`：**「分身Core核心加速引擎：官方 / 一键加速」**（按钮文案即当前档位） |
| 生效范围 | **不是热更新**：只决定「下一次打开分身」用哪个 core。新派生 / 归档还原 / autostart 启动前按开关**重新 provision** 该分身 profile；运行中的分身保持原 core，直到重新打开 |
| 数据安全 | 重新 provision 只重放 profile 配置；分身 `sessions/` 与生产数据不动 |
| 分身卡徽标 | `taskView.coreMode` / `publicFork.coreMode` → 卡片显示「加速核」 |
| 启动失败 | 加速核缺失 → 任务错误 `accelerated-cli-missing`（附 `searched` 轨迹），**绝不静默回退 stock**；端口继续池预分配 + 冲突拒绝 |
| 会话策略 | **`sessionMode:'new'`（默认）**：加速分身只建新会话，旧会话不导入；**`sessionMode:'copy'`**：允许导入旧会话，但只把会话目录**复制成新副本**进分身 home（绝不原地挂载/读原会话）；`inherit` 为旧别名，统一归一为 `copy` |
| 审计 | 切换写 `fork-core-settings` 与 `fang/fork-core-switched` 事件/审计 |

### 6.4 测试

- `test/fork-core-settings.test.mjs`：默认值/归一化/原子读写/损坏降级/路由与 UI 源码守卫
- `test/accelerated-fork.test.mjs`：极简组合/overlay/junction/路由注册方式
- `test/accelerated-install.test.mjs`：解析链/安装复用/失败
- `test/accelerated-fork-live.test.mjs`：`FANG_ACCEL_LIVE=1` 真机 forker 派生
- `tools/release/accelerated-fork-smoke.mjs`：真实进程 smoke

### 6.5 决策记录（用户确认）

| # | 决策 | 选择 | 确认日期 |
|---|---|---|---|
| D1 | 开关生效范围 | **a) 只影响新派生/重启**（运行中不热切换） | 2026-11-17 |
| D2 | 加速分身插件面 | **a) 极简（当前发布）**；用户后续要求“与元主同步一致”，实验证明无法 100% 一致（第三方插件依赖原厂包、官方实验 bundle 无加速版），A/B/C 待定 | 2026-11-17 |
| D3 | 加速分身旧会话 | **只新会话 + 旧会话仅“复制导入”（新副本，不在旧会话上继续）**；`sessionMode:'new'` 默认，`copy` 开启复制导入 | 2026-11-17 |
| D4 | 安装位置/体积 | `<FANG_HOME>/accel/cli`；**上限 1 GiB，超过必须二次确认**（交互提示 / `--confirm-oversize`） | 2026-11-17 |
| D5 | 版本号 | **v3.5.0** | 2026-11-17 |
