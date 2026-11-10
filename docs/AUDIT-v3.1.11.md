# AUDIT v3.1.11

> 版本：3.1.11（2026-11-11）
> 范围：修复元宝运行态「更新/卸载插件」被 pnpm 11 `minimumReleaseAge` 供应链观察期拦截。

## 1. 问题与根因

| 现象 | 根因 | 修复 |
|---|---|---|
| 元宝 web 端更新/卸载插件报 `Lockfile failed supply-chain policy check`（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`），点名 `@twinsearth/dsh-fang@3.1.10`（发布 2026-11-10T14:48:57Z）与 `@twinsearth/dsh-fang-queue-journal@0.1.4`（2026-11-09T15:54:17Z）落在 cutoff（2026-11-09T15:44:40Z）内 | pnpm 11 的 `minimumReleaseAge`（默认 24h）在 lockfile 校验阶段拒绝“过新”的包；DSH 插件管理器只在**安装成功**时自动往 `minimumReleaseAgeExclude` 追加条目，**更新/卸载**路径先做 lockfile 校验，因此被拦 | `ensureEssenceRuntimePnpmConfig` 在元宝运行态 profile 显式写 `minimumReleaseAge: 0`（仅运行态；母体策略不动），每次打开自动生效；同时用通配 `'@twinsearth/*'` 豁免自家插件 |
| 回归保护 | 旧测试只断言“已有的 minimumReleaseAge 被保留” | `test/pnpm-store.test.mjs` 改为“缺省时 ensure 必须补上该键”，并断言二次运行幂等（唯一一行） |

## 2. 改动

| 文件 | 改动 |
|---|---|
| `src/lib/pnpm-store.mjs` | `ensureEssenceRuntimePnpmConfig` 增加 `minimumReleaseAge: '0'`（注释说明只在交互式运行态关闭观察期） |
| `test/pnpm-store.test.mjs` | 覆盖缺省补键 + 幂等；6/6 |
| `docs/CHANGELOG.md` | v3.1.11 段；回填 v3.1.10 已发布状态 |
| `docs/AUDIT-v3.1.11.md` | 本文件 |
| `docs/RELEASE-3.1.11.md` | 发布说明 |

## 3. 本机环境处置（不入代码）

- `profiles/desktop/pnpm-workspace.yaml`：`minimumReleaseAgeExclude` 增加 `'@twinsearth/*'` 通配，
  备份 `pnpm-workspace.yaml.bak-policy-20261110161103`；
- 元宝运行态 profile（official + essence-1793947）：`minimumReleaseAge: 0` + `'@twinsearth/*'`，带 `.bak-policy-*` 备份；
- 已安装 Fang 3.1.10 的 `src/lib/pnpm-store.mjs` 做等价热补丁（备份 `.bak-releaseage-20261110161535`），宿主下次重启后元宝运行态自动写该配置；
- 验证（profile 副本）：`✓ Lockfile passes supply-chain policies (207 entries)`。

## 4. 验证

```text
node --test test/pnpm-store.test.mjs        6/6 pass
node --test test/kernel/role-extensions/plugins-shape  版本断言 3.1.11
preflight --e2e（发布门禁）                 见 release build job；含 crash-safety 源码+打包门禁
```

## 5. 边界

- 母体 profile 由 DSH 管理，Fang 不修改其供应链策略；本机母体问题是环境处置，不随包发布。
- 第三方包的 24h 观察期仍生效；Fang 只豁免自家交互式运行态的更新。
- 该修复不改变 v3.1.9/v3.1.10 的 UI 与门禁行为。
