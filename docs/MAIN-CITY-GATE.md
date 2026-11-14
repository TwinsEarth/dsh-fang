# 主城门禁（main-city gate）

> 目标：任何会影响 DSH 端安全的动作——打包、发布、安装、部署、新建 profile——都必须先通过同一套可复核检查。门禁拿不到证据时 **fail-closed**，不允许「先上再补」。

## 1. 六个入口

| target | 何时 | 关键检查 |
|---|---|---|
| `source` | 提交/CI/发布前 | 版本、CHANGELOG/AUDIT、vendored contract 逐字节、关键防线文件、restart 默认 observe/不自动重启、build/publish 已接线 |
| `package` | 打包完成后 | staged package 名称/版本/private/client/bundle；tarball sha256、sidecar、manifest、禁用产物条目、必需文件 |
| `publish` | npm 发布前 | package 检查 + tag 与版本一致 + registry 同版本重复发布阻断（可显式 `--allow-existing`） |
| `install` | 干净 profile 安装 | package + profile 路径/捆绑去重/patch 可解析 + 无活跃宿主 + 崩溃循环/safe-mode + 审计链 + 磁盘 |
| `deploy` | 重启/部署前 | install 检查 + 备份（可 `--repair` 自动建）+ supervisor 证据 |
| `profile` | 新建/覆盖 profile | 名称白名单、禁止 `desktop`/`plugin`、路径必须在 `$DSH_HOME/profiles`、磁盘、已存在须 `--force` + 自动备份 |

## 2. 输出与退出码

- JSON 报告写入 `dist/main-city-gate.json`；
- `ok=false` 当且仅当存在 `blocker`；`warning` 不阻断但会进入评分；
- 评分由 `scorer.scoreGateFindings` 折算 A–E：0 warning=A，1–2=B，3+=C，任何 blocker=E；
- 退出码 0=GREEN，1=RED，2=用法错误。

## 3. 与五个子插件的关系

| 子插件 | 在主城门的职责 |
|---|---|
| restart-guard | 崩溃循环（15 分钟内 ≥3 次）自动进入安全模式并**永久放弃交接执行权**，直到人工 `clearSafeMode`；门禁把 safe-mode/崩溃循环当 blocker |
| scorer | `scoreGateFindings` 把 findings 折成准入分；A/B 才放行 |
| approver | 需要写 profile 时由门禁生成 `.gate-backups/<stamp>/`（审批式快照，不覆盖） |
| auditor | 部署/安装/发布时校验 `audit.jsonl` 链；门禁结论写链（`main-city-gate`），链坏拒绝追加 |
| healer | 输出修复建议；修复不确定时保持 fail-closed（`blockingOnUnknown`） |
| 门禁/CI | build/publish/install/deploy 全部调用同一 CLI；CI hygiene/release guard 先跑 source gate |

## 4. 常用命令

```bash
node tools/gate/main-city.mjs --target source
node tools/gate/main-city.mjs --target package --package-dir dist/npm/package --tarball dist/dsh-fang-X.tgz
node tools/gate/main-city.mjs --target publish --tag vX --check-registry
node tools/gate/main-city.mjs --target install --home <DSH_HOME> --profile fang-x
node tools/gate/main-city.mjs --target deploy  --home <DSH_HOME> --profile fang-x --repair
node tools/gate/main-city.mjs --target profile --home <DSH_HOME> --profile demo --create
```

## 5. 人工解除崩溃循环安全模式

1. 先读 `<dataDir>/restart/safe-mode.json` 与 `runtime-crash.jsonl`，确认崩溃原因；
2. 在运行中的宿主里调用 `ctx.get('fangRestart').clearSafeMode({ by, note })`（或对应面板）；
3. `clearSafeMode` 会把 crash ledger 改名为 `.cleared-<stamp>`，并写链式审计，下一次启动不会按旧证据重新触发；
4. 重新跑 deploy gate；`runtime: no active crash loop` 与 `runtime: restart safe-mode clear` 必须为 PASS。

## 6. 明确不做

- 不自动「修复」产物 hash/sidecar（会掩盖损坏），只报修复建议；
- 不自动清审计链或崩溃记录；
- 不在门禁里调用网络（`--check-registry` 例外，且只读 registry 的 latest）；
- 不改 DSH 核心文件；写 profile 仅限 `--repair` 备份和 `profile --create`。
