# dsh-Fang v3.1.8 发布说明

- 版本：`3.1.8`（上一个发布 `3.1.7`）
- 定位：插件独立可用（`@twinsearth/dsh-fang` 宿主插件 + Web 客户端半），PC 客户端可选
- 规则：不动 `main`、不自动发布；发布动作按渠道执行

## 这一版修什么

用户现场：**元宝（essence）运行态里无法更新/升级/移除插件**，报

```text
无法移除 0.28.0
[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
The dependencies at "...\essence-runtime\node_modules" are currently linked from the store at
"C:\Users\<user>\AppData\Local\pnpm\store\v11". pnpm now wants to use the store at "D:\.pnpm-store\v11"
```

### 根因（两层，均已定位到代码）

1. **pnpm 11 不再从项目 `.npmrc` 读取非鉴权设置。** DSH 0.2.2-rc.1 自带的 pnpm 11.28.5 只把 `.npmrc` 当鉴权/网络配置；`store-dir`、`package-import-method` 等必须写在 `pnpm-workspace.yaml`（camelCase：`storeDir`、`packageImportMethod`）。Fang 旧逻辑只写 `.npmrc`，等于没生效：D: 盘项目按 pnpm 的“按盘符默认 store”选了 `D:\.pnpm-store\v11`。
2. **模块树 manifest 记录的是母体路径。** 运行态 `node_modules` 来自元主模块树复制，`.modules.yaml` 里的 `storeDir`/`virtualStoreDir` 仍指向母体（`C:\Users\<user>\.dsh\profiles\desktop\node_modules\.pnpm`）。即便把 store 指回 C:，pnpm 的兼容性检查还会因 virtual store 不一致拒绝。

### 修复

- 新增 `src/lib/pnpm-store.mjs`：
  - 写 `pnpm-workspace.yaml`：`nodeLinker: hoisted`（与复制来的模块树布局一致）、`storeDir`（取模块树 manifest 里的真实 store）、`packageImportMethod: copy`（跨盘符无法硬链接）；保留既有设置与注释，幂等；
  - 同步 `.npmrc`（旧 pnpm/npm 兼容）；
  - 对齐运行态 `node_modules/.modules.yaml`：`storeDir` + 本项目的 `virtualStoreDir`（`<profile>/node_modules/.pnpm`）。
- `startEssenceRuntime` 在 provision/mirror 之后、拉起实例之前自动应用；返回体新增 `pnpmConfig` 诊断；失败不阻塞实例启动。
- 新增 `test/pnpm-store.test.mjs`（6 例）。
- 附带：`buffer-keeper` `state()` 的时间戳竞态修复（digest 兜底先看到 pending 时补记 `lastEventAt`，避免 CI Node 22 偶发 `pending-high-risk` 无时间戳断言失败）。

## 现场验证

```text
修复前（官方元宝运行态 profile）：pnpm store path = D:\.pnpm-store\v11
修复后                          ：pnpm store path = C:\Users\<user>\AppData\Local\pnpm\store\v11
modules manifest                ：storeDir=C: store，virtualStoreDir=<run-profile>\node_modules\.pnpm
隔离副本（相同 package.json/pnpm-lock.yaml/pnpm-workspace.yaml）：
  pnpm remove dsh-better-sidebar → 成功（13.7s），无 ERR_PNPM_UNEXPECTED_STORE / UNEXPECTED_VIRTUAL_STORE
新单测                          ：6/6 通过
```

## 安装后验收

```bash
pnpm add @twinsearth/dsh-fang@3.1.8
# 重启 dsh 宿主后：打开元宝 → 「打开&设置」→ 设置 → 插件，执行更新/卸载
```

- 打开元宝运行态后可看到 `profiles/essence-runtime/pnpm-workspace.yaml` 含 `storeDir`/`packageImportMethod`；
- 插件更新/卸载不再报 `ERR_PNPM_UNEXPECTED_STORE`；
- `/fang/api/essence/runtime` 返回的 `pnpmConfig.ok` 为 true。

## 已知边界（重要）

元宝运行态的插件改动**当前仍不会写回元宝配置**：每次打开运行态都会从元宝 merged profile 重放 `package.json`/`cordis*.yml`，因此运行态内安装/更新/卸载的插件在关闭重开后会恢复为元宝原配置。本版只解除 pnpm 操作阻塞；“运行态插件变更捕获回元宝（含 node_modules 回流）”列为下一版需求——需要的话请确认，我们按该方向做。

## 门禁

- 本地：新增单测 6/6；受影响套件（kernel/forker/orchestrator/role-extensions/plugins-shape）通过；
- CI：PR/发布流水线全量测试 + e2e（见 Release run 与 `docs/AUDIT-v3.1.8.md`）；
- artifact / sha256 以 release workflow 产物为准。
