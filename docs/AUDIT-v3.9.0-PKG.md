# 包元信息热修记录（未发布）

- 日期：2026-11-26
- 触发：安装/加载时两条错误
  - `@twinsearth/fang-dsh-plugin/locale/._en.json must use a language id as its filename`
  - `$.maxForks expected number <= 1 but got 8`
- 状态：源码/测试/打包门禁已修；**未提升版本、未发布**。`v3.9.0` 已发布包仍是错误版本。

## 一、`maxForks=8` 的根因

`cordis.patch.yml` 自己给两行注入了 `maxForks: 8`：

- `fang-forker` 行
- `fang-orchestrator` 行

而 orchestrator `Config` 在 v3.8.13 后把 schema 上限收成 `HARD_MAX_FORKS=1`。DSH 在加载 patch 时先做 schema 校验，于是整个插件被判 `invalid config`，根本进不到 `apply()` 的“运行时强制回落 1”。

对已发布 `dist/dsh-fang-3.9.0.tgz` 跑本仓库的 package smoke 可复现：

```text
FAIL  cordis patch does not inject maxForks: 8
```

修复：

1. `cordis.patch.yml` 两处 `maxForks: 8` → `1`。
2. `Config.maxForks` 改为 `z.number().min(1).max(64).default(1)`：**接受旧 profile 里的 8**，不再让整个插件 invalid；`apply()` 仍强制 `cfg.maxForks=1`、`allowMultiFork=false`，`effectiveMaxForks()` 生产路径仍返回 1，第二次 create 仍 `quota-exceeded`。
3. 测试同步：`Config({ maxForks: 8 })` 可通过 schema，但 apply 后 status 仍为 1。

这不是放开多开；只是把“配置校验失败”改为“接受并记录 requested，运行时硬限 1”。

## 二、`locale/._en.json` 的根因

`._en.json` 是 macOS AppleDouble / Finder 伴随文件，不是包内正常 locale。DSH 的插件元信息读取器会遍历 `locale/*.json`，并把 basename 当 language id 校验；`._en` 含点号，直接抛错。

已发布 tarball 的 locale 只有 `en.json` / `zh.json`，不含 `._`；因此该文件来自安装/解压/复制阶段的 macOS 伴随文件，而不是 npm tarball 本身。

修复（三道防线）：

1. `tools/release/lib.mjs` 的包文件选择器过滤所有 `._*`、`.DS_Store`，避免未来从 Finder 污染的工作树打进 tarball。
2. `tools/release/package-smoke.mjs` 增加：
   - `cordis patch does not inject maxForks: 8`
   - `locale filenames are language ids`
   - `locale contains no AppleDouble sidecars`
3. `package.json` 增加 `postinstall`：
   `node tools/release/clean-locale-sidecars.mjs`
   安装后删除 `locale/._*` 和 `.DS_Store`；脚本已随包发布。

若安装器禁用 install scripts，仍需手动执行一次清理：

```bash
node tools/release/clean-locale-sidecars.mjs
```

## 三、验证

- 定向：`package-metadata`、`commit-budget-v3813`、`v3810-host-redline`、`v388-redlines`、`main-gate`：44 tests / 44 pass / 0 fail。
- 临时副本构建（`/tmp/fang-hotfix-build`，未写仓库 `dist/`）：
  - package smoke / crash-safety / allow-list / main-city package gate 全 PASS
  - tarball `946501 bytes` / `207 entries`
  - sha256 `b82fcf9b72517d0657ab2b368e6ca627aba537304912f7e413dd7ac2fa4bd0b9`
  - staged `scripts.postinstall` 已确认存在
- 全量：`1598 tests / 1575 pass / 0 fail / 13 skipped / 10 todo`，`duration_ms=200492.796542`。

## 四、发布边界

- 已发布的 npm `3.9.0` 与 GitHub Release `v3.9.0` 不能原地覆盖；修复包若要给用户安装，需要新版本（建议 `3.9.1`）并重新走构建/发布确认。
- 当前工作树只完成源码和门禁修复；未 bump 版本、未发布、未部署到本机 profile。
- 本机 `~/.dsh/profiles/desktop` 安装的是旧 `3.8.2`，未发现 `._en.json`，因此无法用本机复现该文件本身；`maxForks=8` 已用已发布 3.9.0 tarball 的 package smoke 复现。

## 五、范围决定（2026-11-26）

- **D3（Windows ARM64）**：不支持 / 未验证。没有 ARM64 Windows 真机执行证据；不把 `fang-job-host-arm64.exe` 的静态核对写成已支持。ARM64 上 helper 不可用时仍按 `job-object-unavailable` fail-closed，不退化裸 spawn。
- **E3（GitHub 凭据安全）**：暂不处理，继续使用当前 PAT；本轮不做吊销、轮换、OAuth 或 SSH 变更，相关风险由用户接受。
- 因此后续 `3.9.1` 的范围只包含包元信息修复，不包含 D3、E3。

