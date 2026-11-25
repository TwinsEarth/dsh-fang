# 审计报告 · dsh-Fang v2.6.9（SSE 定向生成器）

> 证据来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 9 个补丁位（`2.6.8` → `2.6.9`）。

## 1. 范围

为 `SseParser` 的每个已知分支补“边界恰好命中”的定向生成器，与随机模糊互补：

- 新文件 `tools/fuzz/sse-directed.mjs`：**9 个分支 / 61 条最小输入**，40+ 条带 `expectedFrames`；
- 分支：`cr-trimming`（8）/ `multi-line-data`（7）/ `empty-data-dropped`（9）/
  `comment-ignored`（9）/ `space-trimming`（7）/ `field-override`（6）/
  `retry-and-unknown`（6）/ `data-field-edge`（4）/ `buffer-boundary`（5）；
- `runDirectedSmokeTest()`：一次性解析 + expectedFrames + 6 种分块策略 × 3 种子等价性；
  支持注入 parse 函数，用 mutation 证明用例能抓到错误实现；
- `generateMixed(rng, { directedProb })`：默认 30% 定向 + 70% 随机；
- `runSseParserFuzz` 增加 `directedProb` / `directed`、`branchCounts` / `directedHits` / `randomHits`；
  CLI 增加 `--directed-prob` / `--no-directed`，先跑 61 条定向 smoke，再打印分支覆盖率；
  `directedHits > 100` 时对零命中分支告警。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.9** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **396 pass / 0 fail / 1 skip（397 项，15.3s）** |
| e2e 实机验收 | 同上 | **45/45（12.3s）** |
| allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、137 文件扫描、包内 69 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.9.tgz`（**244,127 B，85 entries**）<br>sha256 `fdd5f5a57f7d953eaca6b213576aea98d517a2dfc917e55706f4fcce24372318` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.9`（15 个模块可 import） |
| 5000 次混合模糊 | `node tools/fuzz/sse-parser-fuzz.mjs --iterations 5000 --seed 20261109` | **0 failures**；directed=1498 / random=3502；9 分支全部命中 |

## 3. 5000 次模糊的分支覆盖（seed=20261109）

| 分支 | 命中 | 占比（/directed 1498） |
|---|---|---|
| `cr-trimming` | 166 | 11.1% |
| `multi-line-data` | 180 | 12.0% |
| `empty-data-dropped` | 144 | 9.6% |
| `comment-ignored` | 188 | 12.6% |
| `space-trimming` | 142 | 9.5% |
| `field-override` | 175 | 11.7% |
| `retry-and-unknown` | 167 | 11.1% |
| `data-field-edge` | 162 | 10.8% |
| `buffer-boundary` | 174 | 11.6% |

定向命中率 1498/5000 ≈ 30%（与默认 `directedProb=0.3` 一致）；无零命中分支。

## 4. 新增测试（8 项，`test/sse-directed.test.mjs`）

1. 9 分支、每分支 ≥3 条、61 条、描述唯一；
2. 定向 smoke 全通过（61/61，含分块等价性）；
3. expectedFrames 覆盖每个分支（≥40 条）；
4. mutation：把实现改成 `replace(/\r+$/gm,'')`（裁掉所有尾部 CR）后，
   定向用例必须检出（`cr-trimming` / “only one stripped”）；
5. 混合生成确定性 + prob=0/1 边界；
6. 均匀抽样覆盖 9 分支；
7. `runSseParserFuzz(directedProb=1)` 900 次：全定向、9 分支命中 >0、0 failures；
8. `directed=false` 全随机（branchCounts 全 0）+ 同 seed 可复现。

测试计数：389（v2.6.8）+ 8 = **397 项**（396 pass / 1 skip），与 preflight 输出一致。

## 5. 与设计稿的差异

| 设计稿 | 本仓库落地 |
|---|---|
| `fuzz/directedGenerators.ts` | `tools/fuzz/sse-directed.mjs`（仓库无 TS 工具链；纯 `.mjs` + JSDoc） |
| `GeneratedInput` 复用 | 定向返回 `{input, description, branch}`；`generateMixed` 兼容随机生成器返回形状 |
| `buildStrategies`（用户设计名） | 仓库实际为 `buildChunkStrategies`（6 种字符串策略）；smoke 跑 3 种子 |
| `runDirectedSmokeTest` 独立 CLI | 已接入 `sse-parser-fuzz.mjs` 的 `main()`，先于随机模糊执行 |
| 分支覆盖率报告 | 在 CLI 打印；零命中仅在 `directedHits > 100` 时 WARN（避免小样本误报） |

## 6. 边界

- 定向用例锁的是**当前 SseParser 语义**；若未来对齐 SSE 规范（例如“无冒号行忽略”），
  `data-field-edge` 的 expectedFrames 必须同步更新，不能被绕过。
- 分支覆盖统计是“定向输入命中”，不等于真实代码覆盖率工具（无 instrumentation）。
- 定向 smoke 复杂度约 61 × 3 × 6 ≈ 1098 次解析，CI 成本可忽略。
- 随机生成器仍负责 UTF-8 字节切分、超长行、任意残帧等非定向场景。

## 7. 提交状态

- 分支：`feat/sse-directed`（stacked 在 PR #17 的 `feat/adapter-command-registry` 之上）；
- 发布物：`dist/dsh-fang-2.6.9.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
