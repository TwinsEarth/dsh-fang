# v3.5.0 三方发布 runbook（协调 `@twinsearth/dsh-fang-contract@1.2.0`）

> 用户指示（2026-11-17）：**三方发布 v3.5.0 时，需同步发布 contract 1.2.0**。
> 本文是可执行发布清单；发布动作本身需要凭据/审核（见 §5），未执行。
> 配套检查：`npm run release:check`（`tools/release/release-order.mjs`，只读）。

## 0. 版本矩阵与当前 registry 状态（实测）

| 组件 | 版本 | npm 已发布 | 说明 |
|---|---|---|---|
| `@twinsearth/dsh-fang` | **3.5.0** | 3.3.2（latest） | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | **1.2.0** | 1.1.1（latest） | **必须同窗口发布** |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 3.5.0 | 加速分身依赖；不发 |
| 官方 DSH | 0.2.2-rc.3 | — | 母体依赖；不发 |

## 1. 为什么必须同窗口（硬约束）

1. `dsh-fang` 的 `src/contract/VENDOR.json` 已钉死 `@twinsearth/dsh-fang-contract@1.2.0`（8 文件 sha256 + `sourceCommit=bcce47c`）；vendor-sync 门禁按该 pin 校验。
2. 外部插件/宿主若从 npm 取 contract 版本，`1.2.0` 未发布时只能拿到 1.1.1 → 1.2 委托方法（`fang.capability.list` 等）与 7 个委托错误码在外部视角缺失，与 dsh-fang 3.5.0 的 `hello` 广告/能力目录**不一致**。
3. 发布顺序**先 contract、后 dsh-fang**：dsh-fang 发布说明与本仓库 vendor pin 的引用在 contract 上线后才成立；反向顺序会产生“文档先行、依赖未就绪”的空窗。

## 2. 发布前检查（全部只读，先跑再发）

```powershell
# A. contract 仓库（本机示例：contract 检出目录）
cd <contract-repo>
npm test                        # 17/17 pass（2026-11-17 实测）
git status --porcelain          # 必须干净
node -e "console.log(require('./package.json').version)"   # 1.2.0

# B. dsh-fang 仓库（当前分支 feat/accel-p0）
cd <dsh-fang-repo>
node tools/release/preflight.mjs --e2e     # 必须 GREEN（tests 全绿 + e2e 117/117 + allow-list + main-city）
npm run release:check                      # 发布顺序/版本一致性/registry/artifact 检查

# C. 产物：发布前必须用最终 HEAD 重建（build.mjs 内部先跑 preflight --e2e）
node tools/release/build.mjs
npm run release:check                      # artifact fresh + sha256 与 sidecar 一致
```

## 3. 发布序列（严格按序）

### 第 1 步：`@twinsearth/dsh-fang-contract@1.2.0`（先发）

1. contract 仓库提交已就绪：`bcce47c feat(contract): 1.2.0 …`（+ README 1.2 文档）；
2. 推分支 → 合并（contract 仓库当前无 PR 流程记录；若走 GitHub 需写权限 PAT，见 §5）；
3. 打 tag（语义标签，建议 `v1.2.0`）并推送；
4. 发布 npm（二选一）：
   - 面板批准后：`npm publish --access public`（contract 仓库根目录）；
   - 或按 dsh-fang 既有 `tools/release/publish-npm.mjs` 的 REST 方式（需 token）。
5. 验证：
   ```powershell
   npm view @twinsearth/dsh-fang-contract@1.2.0 version   # 必须输出 1.2.0
   npm view @twinsearth/dsh-fang-contract dist-tags.latest
   ```

### 第 2 步：`dsh-fang v3.5.0`（后发，三方渠道）

1. 分支 `feat/accel-p0`（32 提交）推远端 → PR → **main 合并审核**（用户批准；发布纪律：tag 必须打在 main 尖端）；
2. 合并后 main 尖端拉取本地，重建产物并复跑检查：
   ```powershell
   git switch main; git pull --ff-only
   node tools/release/build.mjs
   npm run release:check          # GREEN：artifact fresh、版本一致、tag 未存在
   ```
3. **渠道一：git tag**
   ```powershell
   git tag -a v3.5.0 -m "dsh-Fang v3.5.0"
   git push origin v3.5.0
   ```
4. **渠道二：GitHub Release** —— tag 推送触发 `.github/workflows/release.yml`（guard: tag 必须在 main 尖端 → 测试矩阵 → e2e 构建 → npm / GitHub Release / Docker / healthz / 私有镜像复核 → 终检，fail-closed）；也可在 Actions 手动 `workflow_dispatch` 指定已存在 tag；
5. **渠道三：npm** —— 同上流水线用 Windows 构建产物发布（复用 `dist/npm`，保证 npm sha256 与 GitHub Release 附件同一份字节）；若流水线不可用，走 `node tools/release/publish-npm.mjs`（面板批准）；
6. 验证：
   ```powershell
   npm view @twinsearth/fang-dsh-plugin@3.5.0 version
   npm run release:check          # 应显示 already-published/already-tagged
   # GitHub Release 附件 sha256 == dist/dsh-fang-3.5.0.tgz.sha256
   ```

### 第 3 步：发布后验证（母体真机）

```powershell
# 重启桌面母体到 3.5.0 后（新代码生效）
npm run probe:mother                                  # 能力探测
npm run smoke:contract-delegation -- --base http://127.0.0.1:50895 --token-file <dataDir>/fang-auth.json
npm run smoke:accel                                   # 加速核/分身冒烟
```

## 4. 回滚

| 场景 | 处置 |
|---|---|
| contract 1.2.0 已发、dsh-fang 后续失败 | contract 保留（纯追加，无兼容破坏）；修复后只重发 dsh-fang（不改 contract 版本） |
| dsh-fang tag 已推、CI 红 | 不改 tag（发布不可取消）；修复后发**补丁版**（如 3.5.1），走完整门禁；不得 force-push tag |
| npm 发布内容错误 | 72h 内可 unpublish（版本号不可复用）；超时用 `npm deprecate` + 补丁版；**不跳版本号**（发布纪律：跳号需二次确认） |
| 三者不一致 | 以 GitHub Release tag 为唯一锚点；补齐另一渠道或按补丁版重发，不并行两个版本号 |

## 5. 当前阻塞（2026-11-17）

| # | 阻塞 | 影响 | 解除方式 |
|---|---|---|---|
| B1 | GitHub 写权限 PAT 缺失（当前 token scopes=[]，push 403） | 分支/tag/Release 全链路不可推 | 用户提供有写权限的 PAT，或用户代推 |
| B2 | main 合并需审核 | 不能打 tag（tag 必须 main 尖端） | 用户合并 PR |
| B3 | npm 发布需面板批准（DSH 危险命令守卫） | npm 渠道不可发 | 面板批准（或 CI secret token 可用） |
| B4 | contract 仓库远端推送权限未验证 | contract 1.2.0 不能上线 | 同 B1 |
| B5 | 产物当前为旧 HEAD 构建（13:35 vs HEAD 16:47） | 直接发会发错字节 | ✅ **已解决（2026-11-17 16:52）**：`build.mjs` 重建，新 sha256 `3f5f73ce0c34fc6fc42109bcc516da516faae0c73d42c86d3e60dd6489da937e`（665,945 bytes / 183 entries）；发布前仍需在最终 main 尖端**再重建一次** |

## 6. 发布说明草稿（v3.5.0）

- **加速分身 `official / 一键加速` 可切换**：母体面板 `M-09` 切换、「官方 / 一键加速」显示当前档位；仅新派生/重开生效；未安装加速核时 409 + `unchanged`，设置不静默改变；
- **同步插件面（synced profile）**：加速分身按元主插件面同步，`@deepseek-ai/*` → `@twinsearth/*` alias 层（57 resolved / 8 unsupported 显式分类）；
- **B 契约委托**：contract **1.2.0**（仅追加：3 引导/只读方法 + 7 委托错误码）；委托白名单/超时/并发限流/审计；`chat.import` dryRun + 审批；lsp 通道（真实 LSP provider 调研完成，见 `docs/LSP-PROVIDER-RESEARCH.md`）；
- **UI client half**：浏览器模块映射 spike 完成（`dsh-context` 等第三方 client half 已在启动清单、bundle 可提供；缺口 = `@deepseek-ai/*` 作用域行别名）；
- 门禁：tests 全绿 / e2e 117/117 / allow-list 0 findings / main-city grade A。

## 7. 关联文档

- 发布检查：`tools/release/build.mjs`、`tools/release/preflight.mjs`、`tools/release/publish-npm.mjs`、`tools/release/upload-release-assets.mjs`、`npm run release:check`
- 发布流程与纪律：`docs/RELEASE-FLOW-v3.0.8-v3.3.3.md`、`AGENTS.md` §4（版本发布纪律）
- 契约：`docs/B-CONTRACT-CAPABILITIES.md`、`src/contract/VENDOR.json`
