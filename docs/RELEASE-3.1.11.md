# dsh-Fang v3.1.11 发布说明

- 版本：`3.1.11`（上一个发布 `3.1.10`）
- 主题：修复元宝运行态「更新/卸载插件」被 pnpm 11 供应链观察期拦截
  （`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。

## 问题

元宝 web 端执行插件更新/卸载时，pnpm 在校验 lockfile 阶段报：

```text
✗ Lockfile failed supply-chain policy check
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]
@twinsearth/dsh-fang-queue-journal@0.1.4 ... within the minimumReleaseAge cutoff
@twinsearth/dsh-fang@3.1.10 ... within the minimumReleaseAge cutoff
```

pnpm 11 的 `minimumReleaseAge` 默认 24h；DSH 插件管理器只在**安装成功**时自动追加
`minimumReleaseAgeExclude`，更新/卸载会先被 lockfile 策略拒绝。

## 修复

- `ensureEssenceRuntimePnpmConfig` 在元宝运行态 profile 写
  `minimumReleaseAge: 0`（只影响运行态；母体 profile 的供应链策略不改）；
- 每次打开元宝运行态自动应用，插件更新/卸载不再被观察期拦截；
- 回归测试：缺省时必须补键 + 二次运行幂等（6/6）。

## 升级

```bash
pnpm add @twinsearth/dsh-fang@3.1.11
```

按 `docs/WORKFLOW-UI.md` §5：**先停 DSH host、备份 profile、做候选包冒烟**，再升级/重启；
不要在运行中的 profile 上执行 `dsh plugin add`。

## 已知边界

- 母体 profile 由 DSH 管理，Fang 不修改其供应链策略；本机母体问题的环境处置不随包发布。
- 第三方包仍受 24h 观察期保护；仅元宝运行态的自家插件更新被豁免。
- 本版不影响 v3.1.9 的 UI 行为与 v3.1.10 的 crash-safety 门禁。
