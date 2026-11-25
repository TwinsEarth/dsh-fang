# AUDIT v3.1.8

> 版本：3.1.8（2026-11-10）
> 主题：元宝运行态 pnpm 插件更新/卸载修复（ERR_PNPM_UNEXPECTED_STORE）。

## 1. 本版修复

| 问题 | 根因 | 修复 |
|---|---|---|
| 元宝运行态无法更新/升级/卸载插件：`[ERR_PNPM_UNEXPECTED_STORE]`，pnpm 想用 `D:\.pnpm-store\v11` | ① DSH 0.2.2-rc.1 自带 pnpm 11.28.5，项目 `.npmrc` 只读鉴权/网络键，`store-dir`/`package-import-method` 已被移到 `pnpm-workspace.yaml`（camelCase）；Fang 旧逻辑只写 `.npmrc`，等于没生效 → 按盘符默认 store；② 运行态 `node_modules/.modules.yaml` 复制自元主，`storeDir`/`virtualStoreDir` 仍记母体路径，pnpm 兼容性检查拒绝 | 新增 `src/lib/pnpm-store.mjs`：写 `pnpm-workspace.yaml`（`nodeLinker: hoisted`、`storeDir`、`packageImportMethod: copy`）+ 兼容 `.npmrc`，并把运行态 `.modules.yaml` 的 `storeDir`/`virtualStoreDir` 对齐为当前项目；`startEssenceRuntime` 每次打开自动应用 |
| 元宝运行态的插件安装/更新/卸载不持久（下次打开按旧元宝配置重放） | 运行态 profile 每次打开都从元宝 merged 重放 `package.json`/`cordis*.yml`；元宝 overlay/merged/模块树从不回写 | 新增 `src/lib/runtime-capture.mjs`：stop 与下次 start 在重放前捕获 `package.json`、差异 patch 条目、pnpm 锁/设置文件到 overlay；重算 merged（`materializeMerged` 保留既有模块树并投影 overlay pnpm 文件）；把 pnpm 重新物化的包目录 hardlink 进元宝模块树、删除已卸载包；指纹幂等跳过无变更场景 |
| （CI 偶发）buffer-keeper `pending-high-risk` 状态 `lastEventAt` 为 null | `state()` 的 digest 兜底可能先于 watch/poll 事件看到 pending；此时 `quietMs` 回退到 `startedAt`，可能在无事件时间戳时报 high-risk | 观察到 pending 时补记 `lastEventAt = nowMs()`；删除无读者的 `startedAt` |

### 关键设计边界

- `storeDir` 取模块树 manifest 中记录的真实 store（复制来源 = 母体 C: store）；`packageImportMethod: copy` 解决 C: store → D: 项目的跨盘符硬链接不可用。
- 保留 `pnpm-workspace.yaml` 其他设置与注释（`autoInstallPeers`、`minimumReleaseAge`、allowBuilds 等），只 upsert 本版需要的键，重复执行幂等。
- pnpm 配置失败不阻塞元宝运行态启动，但通过返回体 `pnpmConfig` 暴露（fail-loud，可诊断）。

## 2. 实测证据（本地）

```text
修复前：D:\...\essence-runtime > pnpm store path
        D:\.pnpm-store\v11
        modules manifest：storeDir=C:\...\pnpm\store\v11（记录值），virtualStoreDir=C:\Users\<user>\.dsh\profiles\desktop\node_modules\.pnpm（母体路径）
修复后：pnpm store path
        C:\Users\<user>\AppData\Local\pnpm\store\v11
        modules manifest：storeDir=C:\...\pnpm\store\v11，virtualStoreDir=D:\ToFuture\sessions\essence-official-dev\home\profiles\essence-runtime\node_modules\.pnpm
隔离副本（相同 package.json / pnpm-lock.yaml / pnpm-workspace.yaml）：
        pnpm install --frozen-lockfile → 因 lockfile 与 package.json specifier 不同而拒绝（预期，见边界）
        pnpm remove dsh-better-sidebar → 成功（13.7s），删除依赖并重装 3.1.4/2.2.4 等，storeDir=C:、virtualStoreDir=副本路径
        无 ERR_PNPM_UNEXPECTED_STORE / ERR_PNPM_UNEXPECTED_VIRTUAL_STORE
新单测：test/pnpm-store.test.mjs 6/6 通过（manifest 读取、settings 保序 upsert、.npmrc 更新、manifest 对齐幂等、端到端 ensure）
受影响既有套件：kernel / forker / orchestrator / role-extensions / plugins-shape 通过
运行态捕获：test/runtime-capture.test.mjs 6/6（package/patch/pnpm 文件写回 overlay、模块 hardlink 回流、已卸载包删除、幂等跳过）；
             essence：模块树在 recompute 后保留 + overlay pnpm 文件投影；orchestrator 62/62 通过
```

## 3. 发布

| 方 | 状态 |
|---|---|
| GitHub Release | 已发布：https://github.com/TwinsEarth/dsh-fang/releases/tag/v3.1.8（4 assets） |
| npm | 已发布 `@twinsearth/dsh-fang@3.1.8`（latest） |
| CI | 成功：release run 42790474055（attempt 3；attempt 1/2 因 npm 传播延迟 healthz 失败，重跑后全绿）；main ci/compat 成功（cd2243d） |

发布物（CI build job 实测）：`dsh-fang-3.1.8.tgz` 524,762 B / 137 entries，
sha256 `9a6c197a6df2a31c24a7dd85b6a43c9939cdbdba761d80ff4b0642a0aa4b6f42`；
CI 门禁 tests pass=1020 / fail=0 / skip=3，e2e 81/81（67.6s），preflight GREEN。

## 4. 已知边界

- 捕获时机是「停止运行态」与「下次打开运行态」；运行中的插件操作不会实时回流，宿主异常退出后由下次打开先捕获再重放。
- 模块回流按「包名+版本」比较；同版本内手工替换包内容不会被 hardlink 覆盖（pnpm 安装/升级都会改版本号）。
- 运行态/元主模块树仍是镜像共享结构，捕获只 hardlink 被 pnpm 重新物化的条目；跨元宝派生的一致性来自捕获后的元宝模块树。
- 已有运行态 profile 在升级后首次打开时自动应用本修复；修复前的运行态若仍开着，需重开一次（或重启宿主后重开）。
