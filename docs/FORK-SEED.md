# FORK-SEED — 派生分身的默认第三方插件

> v3.1.12 起：新机器 / 新用户的干净分身不再只有 `base + web-app + fang`，而是按
> “安装不激活 / 安装并激活”两组清单带上默认第三方插件。

## 默认清单（2026-11-11）

安装不激活（只进 `dependencies` + `node_modules`，不加入 profile bundles）：

```text
@twinsearth/dsh-2xray
@michengai/dsh-agency-agents
dsh-better-sidebar
dsh-context
@liustack/modlens
@liustack/modsearch
```

安装并激活（额外写入 `dsh.profile.bundles`，分身启动即加载）：

```text
dshmarket
@twinsearth/dsh-im2a-plugin
@openviking/dsh-memory-plugin
@twinsearth/w2m-dsh-plugin
```

## 行为

- 位置：`fang-forker` 插件 Config 的 `forkSeed`：
  - `enabled`（默认 true）；
  - `install[]`、`activate[]`（默认值即上面的清单）。
- 时机：**每次 spawn**（首次派生与崩溃重启都会走）在启动 DSH 子进程前执行；
  已按指纹缓存，首次安装后重启只重新打 profile patch，不重复安装。
- 安装：独立 seed home（`<forksRoot>/.plugin-seed/seed-<fingerprint>`）里用 DSH 自带 pnpm
  执行 `dsh plugin --profile seed add ...`；模块树以 hardlink 合并进分身的 `node_modules`，
  不替换 mother 镜像里的运行时包。
- 两种派生入口（开发者推荐 / 绿色“派生新分身”）都走同一个 `Forker.spawn`，因此清单一致。
- 失败不阻塞分身启动：结果在 spawn 返回值 `forkSeed`（`ok/error/detail/cached`）与审计中可见。
- 环境变量 `DSH_FANG_FORK_SEED=0` 可全局关闭（e2e/CI 使用，避免每次联网装包）。

## 自定义

在母亲 profile 的 Cordis 覆盖层里改 `fang-forker` 的 config，例如：

```yaml
- id: fang-forker
  config:
    forkSeed:
      enabled: true
      install:
        - '@twinsearth/dsh-2xray'
      activate:
        - dshmarket
```

`install` 只装不激活；`activate` 会同时进依赖与 profile bundles。包名会做格式校验，
非法名（路径、参数注入）会被忽略。

## 边界

- 首次派生需要联网从 npm 安装；离线时分会话仍可启动，只是 `forkSeed.ok=false`。
- 仅作用于**任务分身**；元宝运行态（`essence-runtime`）继续继承元宝自己的模块树。
- 已在运行的旧分身在下次重启时补装（配置回放后重新打 patch）。
