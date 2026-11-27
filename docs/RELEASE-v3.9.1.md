# v3.9.1 发布记录：包元信息热修 + B2 / C1–C6 收口

- 版本：3.9.1
- 日期：2026-11-26
- 基线：v3.9.0（tag `v3.9.0`，发布提交 `a023acc6`）
- 发布形式：GitHub `v3.9.1` tag / Release + npm `@twinsearth/fang-dsh-plugin@3.9.1` + 项目目录报告

## 一、本版包含

- **包元信息热修**：`cordis.patch.yml` 两处 `maxForks: 8` → `1`；orchestrator schema 兼容旧配置 1–64 但运行时仍硬限 1；locale 目录过滤 `._*` / `.DS_Store`，package-smoke 增加语言 id 与 `maxForks` 门禁，`postinstall` 清理 sidecar。
- **B2**：单文件 session 紧急线 48 → 64 MB，保留 16/32 MB 预警与 512/1024/2048 MB 合计门。
- **C1–C6**：宿主状态落盘 5s、崩溃窗口可配置、ARCHIVED 保留状态清扫、多开确认仍硬限 1、Idle 优先级档、迁移报告直接调用本地函数。

## 二、本版不包含

- **D3**：Windows ARM64 真机验证。用户选择不支持 / 未验证；没有 ARM64 Windows 真机执行证据，不能写成已支持。
- **E3**：GitHub 凭据安全处理。用户选择暂不处理，继续使用当前 PAT；本轮不吊销、不轮换、不改 OAuth/SSH。

## 三、测试与构建

- 全量：`1598 tests / 1575 pass / 0 fail / 13 skipped / 10 todo`，`duration_ms=216316.144125`。
- 构建：`dist/dsh-fang-3.9.1.tgz`，207 entries；package smoke / crash-safety / allow-list / main-city package gate 全 PASS。精确大小与 sha256 见 `dist/manifest.json` 与项目目录发布报告。
- preflight 以 `--skip-preflight` 构建，manifest 记录 `skipped:true / green:false`；不宣称门禁 GREEN。

## 四、三方发布

发布完成后以 GitHub `v3.9.1` tag / Release、npm `@twinsearth/fang-dsh-plugin@3.9.1`、项目目录报告与校验和为准；本文件不提前宣称未完成的三方动作。

## 五、边界

- 真实 Windows DSH 宿主内的 heap/session 实时读数、pagefile 全盘显示、orchestrator 拉起 browser/fork 全链 E2E 仍未跑。
- D3 ARM64 未验证。
- 若 preflight 为 `--skip-preflight`，manifest 记录 `skipped:true / green:false`，不得写成门禁 GREEN。
