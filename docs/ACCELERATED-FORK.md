# 加速分身（Accelerated Fork）· P0

> 适用范围：瓮城 dsh-fang **3.4.x P0 地基**。加速引擎只服务**分身 Web**；宿主（桌面/母体）与**元主运行态永远原厂 core**。

## 1. 边界（硬约束）

| 对象 | core | 说明 |
|---|---|---|
| 桌面客户端 / 母体（宿主） | 原厂 | 不替换、不第二实例 |
| 元主运行态（essence runtime） | 原厂（强制） | `forker.provision/spawn` 均显式 `coreMode:'stock'`，有源码守卫测试 |
| **分身 Web** | 原厂 / 加速 可切 | 唯一加速对象；P0 只做后端地基，开关在 P1 |

旧「加速模式」侧车（第二个母体 Web：`/fang/api/accelerated/start|stop|status`）已下线，替换为只读 `GET /fang/api/fork-core`（路由 88 → 86）。

## 2. 组成

| 文件 | 作用 |
|---|---|
| `src/lib/accelerated-install.mjs` | 安装/发现加速核：`<FANG_HOME>/accel/cli` + `state.json`；只接受 JS 入口 `lib/bin.js`（Windows `.cmd` shim 不能 spawn）；解析链 config → `FANG_ACCEL_CLI` → state → 标准位置；缺失即 `accelerated-cli-missing` |
| `src/lib/accelerated-fork.mjs` | 极简分身 profile（**只有** `@twinsearth/dsh-base` + `@twinsearth/dsh-web-app` + `@local/dsh-fang`，加两个子插件 junction）+ 模型 overlay（`@deepseek-ai/dsh-` → `@twinsearth/dsh-`，避免 name mismatch 被跳过） |
| `src/plugins/forker.mjs` | `provision({coreMode:'accelerated'})` 走极简 profile；`spawn` 按 coreMode 解析 CLI，**加速缺失即失败，绝不静默回退 stock**；跳过 fork-seed / 官方 node_modules 镜像 / 官方 headless-picker overlay |
| `tools/release/accelerated-fork-smoke.mjs` | 真实加速分身 smoke（起真进程 + 断言 adapter identity + 启动页含 `dsh-fang/client.js`） |

## 3. 安装

```powershell
# 安装到 <FANG_HOME>/accel/cli（约 651 包 / 738MB / 数分钟；实测 8 分钟）
node -e "import('E:/GPT/dsh-fang/src/lib/accelerated-install.mjs').then(async m=>console.log(await m.installAcceleratedCore({fangHome:'D:/ToFuture'})))"
# 或复用已安装版本
node tools/release/accelerated-fork-smoke.mjs --fang-home <FANG_HOME>
```

## 4. 验证

```powershell
$env:DSH_HOME='%DSH_HOME%'
node tools/release/accelerated-fork-smoke.mjs        # 期望 exit 0：7 项检查全绿
$env:FANG_ACCEL_LIVE='1'; $env:FANG_HOME='<FANG_HOME>'
node --test --test-concurrency=1 test/accelerated-fork-live.test.mjs   # 经 forker 真派生的加速分身
```

已实测（2026-11-17，本机）：`@twinsearth/dsh 3.5.0` 的 `lib/bin.js` 启动分身成功；页面含 `dsh-fang/client.js`；`/fang/adapter/identity` 返回 `{role:'fork', version:'3.4.2', protocol:3}`。

## 5. 已知限制（P0 未做）

- 开关（原版/加速版、母体面板）是 P1；
- 加速分身**不继承**桌面 profile 的第三方插件（极简插件面）；
- 加速分身的会话策略（新会话 vs 继承旧会话）待 P1 决定；
- `GET /fang/api/fork-core` 目前只读；`/accelerated/*` 已移除。

## 6. P1 · 开关与运行（已实现）

### 6.1 持久化

`<dataDir>/fork-core.json`：

```json
{ "mode": "stock" | "accelerated",
  "sessionMode": "new" | "inherit",
  "updatedAt": "ISO", "updatedBy": "panel" }
```

缺文件/损坏 → 安全默认 `stock` + `new`（原子写，别名 `writeForkCoreSettings`）。

### 6.2 API

`GET/POST /fang/api/fork-core`（同一路径，经 `routeMethods` 注册，避免二次 register 抛错）：

- GET → `{ ok, mode, sessionMode, effectiveMode, blocked, accelerated:{installed,version,cliPath,error}, forks:{stock,accelerated}, essence:'stock' }`
- POST `{ mode?, sessionMode?, by? }` → 校验非法值 400/409；持久化后返回同 GET 形状 + `changed:true`
- 开关只影响**新派生/重启**的分身；母体与元主永远原厂。

### 6.3 行为

| 项 | 行为 |
|---|---|
| 生效范围 | **不是热更新**：开关只决定「下一次打开分身」用哪个 core。新派生、归档还原、autostart 重启时都会按当前开关重新 provision 该分身的 profile（会话目录不动）；运行中的分身保持原 core，直到被重新打开 |
| 面板开关 | 母体头部 `M-09`：**「分身Core核心加速引擎：官方 / 一键加速」**（当前状态即按钮文案，点击切到另一档） |
| 分身卡徽标 | `taskView.coreMode` → 卡片 meta 显示「加速核」；`forks.json` 的 `publicFork.coreMode` 同步 |
| 启动失败 | 加速核缺失 → 任务错误 `accelerated-cli-missing`（附 `searched` 轨迹），**绝不静默回退 stock**；端口仍走池预分配 + 冲突拒绝 |
| 会话策略 | `sessionMode:'new'`（默认）：加速分身跳过旧会话导入，记录 `accelerated-new-session`；`inherit` 才允许导入（旧会话由原厂 core 写入，兼容性未验证） |

### 6.4 测试

- `test/fork-core-settings.test.mjs`：默认值/归一化/原子读写/损坏降级/路由与 UI 源码守卫
- `test/accelerated-fork.test.mjs` 更新：fork-core 必须经 `routeMethods` 注册（同路径不可 register 两次）
- 真机：`tools/e2e.mjs` 95/95；`accelerated-fork-smoke` 7/7；`FANG_ACCEL_LIVE=1` forker 真实派生加速分身通过
