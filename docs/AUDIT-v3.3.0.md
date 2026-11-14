# AUDIT v3.3.0

范围：主城门禁、崩溃循环制动、评分/审批/审计/修复接线。

## 门禁目标

| target | blocker 示例 |
|---|---|
| source | 版本不一致、契约副本漂移、缺失防线、restart 默认被改成 enforce/自动重启 |
| package | sha256/sidecar/manifest 不一致、私有包、缺 client/bundle、tarball 含禁用条目 |
| publish | tag 与版本不一致、同版本已发布（无显式 allow） |
| install | profile 越界、bundle 重复、patch 不可解析、宿主仍活着、崩溃循环/safe-mode、审计链坏、磁盘不足 |
| deploy | install + 无备份 + 无 supervisor 证据 |
| profile | 保留名 desktop/plugin、路径逃逸、已存在且未 --force、磁盘不足 |

## 接线点

```text
preflight -> source gate
build     -> package gate（构建失败，不留下可发布产物）
publish   -> publish gate（失败时不读 token、不碰 registry）
install drill / reinstall drill -> install gate before boot
restart-watchdog -> boot-guard + deploy gate before relaunch
forker.provision -> profile gate before first write
ci.yml / release.yml -> source gate
```

## 新增防线

1. 崩溃循环：15 分钟内 3 次 → safe-mode，执行权不交接；人工 clear 才恢复。
2. 门禁评分：blocker=E；warning=15/25 分；A/B 才放行。
3. 审计：deploy/install/publish 前校验链；门禁结论 appendChained。
4. 备份：写 profile 前 `.gate-backups/<stamp>/`（只复制配置）。

## 验证

```text
main-gate              9 例（新增）
restart-crash-loop     3 例（新增）
真实 e2e               95/95
全量测试               见构建输出
```
