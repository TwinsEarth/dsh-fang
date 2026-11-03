# 审计报告 · dsh-Fang v3.0.7（发布门禁加固）

> 本机真实输出（2026-11-03）。版本线：… v3.0.5 → v3.0.6 → v3.0.7。

## 1. 故障背景

DSH Web「内置插件」页报 `@local/dsh-fang: invalid plugin, ... received undefined`。验收测试工程师定位：
服务端 16 行 active，故障在 **client half 未物化** + 运行进程早于 client.js 3.5 小时；门禁却显示 GREEN，
因为 `preflight.json` 中 `e2e: null` 仍被放行。

## 2. 本次修复

| 项 | 实现 | 验证 |
|---|---|---|
| e2e 不可跳过 | `preflight` 无 `--e2e` → 失败项 `e2e: required for release green` | 本机 RED |
| client half 物化 | e2e 用 vm 执行 client.js，断言 loader 注册 + factory 产出 `{inject, apply}` | e2e 62/62 |
| 行完整性 | e2e 调 `dsh --dump-config` 统计 `fang-*` 行 ≥16 | e2e 62/62 |
| 产物校验和 | build 生成 `dist/dsh-fang-<ver>.tgz.sha256`；preflight 校验 match | sidecar=85 B，match |
| 发布流程 | release build 改为 self-hosted Windows + 默认 `preflight --e2e`；artifact/Release 上传 `.sha256` | 配置已改（CI 需自托管 runner） |
| client loader row | `cordis.patch.yml` 新增 `ui-fang → @local/dsh-fang/client`；e2e 增 `ui-fang client row composed` | e2e 63/63 |

## 3. 门禁结果（本机）

- 无 e2e：**RED**（`e2e: required for release green`、`artifact: sha256 sidecar missing`）；
- 有 e2e：**GREEN 3.0.7**（641 tests / 0 fail / 1 skip、e2e **63/63**、62 路由、`artifact: sha256 sidecar match`）；
- build：preflight GREEN → tarball **334,809 B** → sha256 `2f1d1d414fc1930f563e6b9caae632458cfc094163d7ea328a7ce01876dd9d4c`，sidecar 一致。

## 4. 未完成 / 已知边界

- 真实宿主仍需**重启**才能加载新 client.js；本仓库门禁修复不能代替进程重启。
- 浏览器级截图回归仍未引入（当前为 vm 物化 + dump-config + DOM e2e 断言）。
- GitHub Actions 的 release build 现要求 self-hosted Windows runner；未配置时发布 job 会失败（fail-closed，符合设计）。
- v3.0.0/v3.0.1 的 tag/Release 仍待按严格序列补发。
