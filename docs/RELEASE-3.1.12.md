# dsh-Fang v3.1.12 发布说明

- 版本：`3.1.12`（上一个发布 `3.1.11`）
- 主题：① 侧栏身份徽标（母体 / 元主 / 分身）；② 派生分身默认第三方插件种子。

## 1. 侧栏身份徽标

侧栏左上角 HARNESS 词标右侧新增红字徽标，进入任何 Web 端即可确认当前实例：

| 徽标 | 判定 |
|---|---|
| **母体** | `/fang/api/status` 返回 `role=mother` |
| **元主** | fork 实例且 adapter hello `kind=essence`（元宝运行态，orchestrator 注入 `DSH_FANG_ESSENCE=1`；旧实例按 `rt-` 前缀兜底） |
| **分身** | fork 实例且 `kind=fork` |

不替换官方品牌槽（`sidebar.brand.name`），只在词标后追加只读徽标；宿主重渲染会补回；
识别失败时隐藏，不显示错误身份。

## 2. 派生分身默认第三方插件

新机器 / 新用户的干净分身默认安装：

- **安装不激活**：`@twinsearth/dsh-2xray`、`@michengai/dsh-agency-agents`、`dsh-better-sidebar`、
  `dsh-context`、`@liustack/modlens`、`@liustack/modsearch`
- **安装并激活**：`dshmarket`、`@twinsearth/dsh-im2a-plugin`、`@openviking/dsh-memory-plugin`、
  `@twinsearth/w2m-dsh-plugin`

两种派生入口（开发者推荐 / 绿色按钮）走同一 Forker.spawn，清单一致。安装缓存在
`<forksRoot>/.plugin-seed`，每次重启只重打 profile patch、不重复下载。可用
`forkSeed.enabled=false` 或环境变量 `DSH_FANG_FORK_SEED=0` 关闭。详见 `docs/FORK-SEED.md`。

## 升级

```bash
pnpm add @twinsearth/dsh-fang@3.1.12
```

按 `docs/WORKFLOW-UI.md` §5：先停 DSH host、备份 profile、候选包冒烟后再升级/重启。
升级后：已存在分身会在下次启动时补装默认插件；新建分身首次派生会先安装默认插件（需要联网）。

## 边界

- 身份徽标依赖宿主侧栏品牌行 class 语义；DSH 大版本升级需回归 `test/client-role-badge-dom.test.mjs`。
- 分身默认插件首次安装需要 npm 网络；离线时分身仍可启动（`forkSeed.ok=false`）。
- 元宝运行态不套用分身默认插件（继续继承元宝模块树）。
