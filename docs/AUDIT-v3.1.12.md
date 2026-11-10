# AUDIT v3.1.12

> 版本：3.1.12（2026-11-11）
> 范围：① 侧栏 Web 端身份徽标（母体 / 元主 / 分身）；② 派生分身默认第三方插件种子。

## 1. 需求

1. 每次进入 Web 不知道当前实例是母体 / 元主 / 分身 → 在左上角 HARNESS 右侧红字标识。
2. 新机器/新用户的干净分身不带推荐第三方插件 → 按两组清单默认安装（部分激活）。

## 2. 实现

### 2.1 身份徽标

| 点 | 实现 |
|---|---|
| 宿主位置 | 不占用/替换 `sidebar.brand.name`（单槽，替换会抹掉官方 HARNESS 词标）；在词标节点后追加只读 `<span class="fang-web-role">` |
| 样式 | `color:#C8102E`、红色描边/浅红底、11.5px/700；只读、`-webkit-app-region:no-drag` |
| 识别 | 母体：`/fang/api/status` 200 且 `role=mother`；否则 `/fang/adapter/hello`：`kind=essence|fork`；旧运行态按 `taskId` 的 `rt-` 前缀兜底 |
| 宿主字段 | adapter hello 新增 `kind`；orchestrator 给元宝运行态注入 `DSH_FANG_ESSENCE=1` |
| 稳定性 | 只在品牌行父节点上 `MutationObserver`；宿主重渲染摘掉即补回；识别失败隐藏（不显示错误身份）；幂等 paint 防止观察器自激循环 |
| 生命周期 | `apply()` 里挂载，disposer 移除节点/定时器/观察器 |

### 2.2 分身默认插件种子

| 点 | 实现 |
|---|---|
| 清单 | `src/lib/fork-seed.mjs` `DEFAULT_FORK_SEED`：install 6 个、activate 4 个（用户给定） |
| 配置 | `fang-forker` Config：`forkSeed.enabled/install/activate`；环境变量 `DSH_FANG_FORK_SEED=0` 关闭 |
| 安装 | 独立 seed home `<forksRoot>/.plugin-seed/seed-<fingerprint>`，用 dsh 自带 pnpm 安装；指纹缓存 |
| 合并 | 模块 hardlink 合并进分身 `node_modules`：普通包整目录覆盖；scope 目录展开为真实目录并保留 mother 镜像子包 |
| 激活 | `activate` 包写入 `dsh.profile.bundles`；`install` 只写 `dependencies` |
| 触发 | Forker.spawn 在每次启动子进程前执行；两种派生入口共用同一路径 |
| 回放 | 每次 spawn 会用模板回放 profile 配置；已缓存路径**重新打 patch**但不重复安装 |
| 失败 | 不阻塞分身启动；结果进 `rec.forkSeed` / spawn 返回值 / 审计 |

## 3. 测试

```text
test/fork-seed.test.mjs              6/6 pass
  - 默认清单与用户给定完全一致
  - 归一化（去重/校验/activate 与 install 去重）
  - profile patch：deps + 仅 activate 进 bundles，二次幂等
  - scope 合并：mother 镜像保留，seed 子包覆盖，staging 清理
  - 安装一次 + 合并 + marker + 模板回放后重新打 patch（仍只装一次）
  - disabled no-op 且不调用安装器
test/client-role-badge-dom.test.mjs  5/5 pass
  - 母体 / 元主 / 元主 rt- 前缀兜底 / 分身 / adapter kind+env 字段
test/forker.test.mjs                 29/29 pass（单测禁用种子，不联网）
test/plugins-shape.test.mjs          21/21（Config 解析后插件 compose 仍绿）
```

发布门禁：`preflight --e2e`（含 crash-safety 源码 + 打包后门禁；e2e 以
`DSH_FANG_FORK_SEED=0` 运行，不下载默认插件）。

## 4. 边界

- 首次派生需联网；离线分身仍可启动，只是 `forkSeed.ok=false`。
- 只作用于任务分身，不影响元宝运行态。
- 身份徽标依赖宿主侧栏品牌行的 class 语义（`*brandName*`）——DSH 若重命名，徽标会隐藏而不是显示错误；
  后续 DSH 大版本升级需回归 `client-role-badge-dom`。
