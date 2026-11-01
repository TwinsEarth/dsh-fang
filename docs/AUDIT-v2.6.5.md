# 审计报告 · dsh-Fang v2.6.5（SseParser 模糊测试）

> 证据全部来自本机真实门禁输出（2026-11-01，Windows / Node 24.16.0）。
> 报告不含凭据、不含本机绝对路径（allow-list 自检同时扫描这两类内容）。
> 版本策略：`x.y.z` 每一位 0–9；本次是 v2.6 的第 5 个补丁位（`2.6.4` → `2.6.5`）。

## 1. 范围

把 SSE 解析器独立成类并补上随机化测试：

1. **`src/lib/sse-parser.mjs`**：行式增量 `SseParser`（`push`/`flush`）；
   只按 `\n` 切行、行尾裁一个 `\r`、空行切帧、无 data 帧丢弃、注释/`retry`/未知字段忽略；
2. **模糊测试** `tools/fuzz/`：
   - 可复现种子 RNG（SplitMix32 + XorShift128，同 seed 同序列）；
   - 9 种输入模式（单帧/多帧/帧+噪声/纯噪声/超长 data/无 data 帧/注释风暴/截断残帧/CRLF 混合）；
   - 独立参考实现 oracle（一次性解析，不复用 SseParser 代码）；
   - 6 种字符串分块 + 字节级切分（TextDecoder streaming）、roundtrip、flush 不变量；
   - 失败报告含 `iterationSeed` / `inputHex` / `chunks` / expected / actual，可直接重放；
3. **CI 档位** `test/sse-parser-fuzz.test.mjs`（7 项）：性质断言 + 固定种子 × 6 × 25 iterations +
   随机 seed smoke + 可复现性 + 已知 CRLF/多行/字节切分边界；
4. **修复**：旧 `createSseParser` 用 `indexOf('\n\n')` 找块边界，CRLF 流（`\r\n\r\n` 不含 `\n\n`）
   会延迟到 flush 且把 `\r` 混进 data；新实现逐行处理修复该问题。`flush()` 改为按规范丢弃残帧。

文档：`docs/FUZZ-SSE-PARSER.md`。

## 2. 门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 版本一致性 | `node tools/release/preflight.mjs --e2e` | **GREEN 2.6.5** |
| Client 半可解析 | 同上 | `node --check client.js` **green** |
| 单元/集成测试 | 同上（内嵌全量） | **367 pass / 0 fail / 1 skip（368 项，15.8s）** |
| e2e 实机验收 | 同上（内嵌 `tools/e2e.mjs`） | **45/45（11.8s）** |
| 路由 allow-list + 秘密/本机路径扫描 | `node tools/release/allowlist.mjs --with-manifest` | **PASS**：34 路由、0 findings、127 文件扫描、包内 68 文件 allow-listed |
| 构建 | `node tools/release/build.mjs` | `dist/dsh-fang-2.6.5.tgz`（**236,351 B，84 entries**）<br>sha256 `76ddd6e0caf19646246d1cb48f3d82ef4868cf689c67ad4a0184a141e0c28ad5` |
| 产物健康检查 | `node tools/release/healthz.mjs` | **HEALTHY** `@twinsearth/dsh-fang@2.6.5`（15 个模块可 import） |
| 大批量 fuzz（本机附加证据） | `node tools/fuzz/sse-parser-fuzz.mjs --iterations 5000 --seed 20261101` | **5000 iterations / 0 failures** |

## 3. 新增测试（7 项）

`test/sse-parser-fuzz.test.mjs`：

1. 性质断言：帧边界 / 多行 data / CRLF / flush / 超长行（1,000,000 字符）/ UTF-8 字节切分；
2. 固定种子（1, 2, 3, 42, 1337, 0xdeadbeef）× 25 iterations：分块等价 + 参考实现 + roundtrip + flush；
3. 默认随机 seed smoke（15 iterations）；
4. RNG 可复现（同 seed 同输入）与 fuzz 结果可复现；
5. 已知边界：CRLF + 多行 data + 无 data 帧 + 参考实现一致；
6. roundtrip：序列化 → 再解析，帧序列一致；
7. flush 丢弃残帧后解析器仍可用。

计：361（v2.6.4）+ 7 = **368 项**（367 pass / 1 skip），与 preflight 输出一致。

## 4. 风险 / 说明

1. **行为变化**：`flush()` 不再产出残帧；无 `event:` 的帧不再默认 `event:'message'`（字段缺失即省略）。
   依赖旧行为的调用方需注意（仓库内只有 adapter-client 使用解析器，未依赖这两点）。
2. **语义范围**：不实现 lone-`\r` 换行（DSH Adapter 只输出 `\n`/`\r\n`）；不测“完整 SSE 规范”，
   只测实现自身在任意分块下的等价性 + 独立参考实现一致性。
3. **RNG 质量**：XorShift128 足够做确定性 fuzz，不作为密码学随机源。
4. **生成器没有覆盖率反馈**：SseParser 状态机字段少，9 种模式已覆盖；未来引入 BOM 等更复杂状态时
   再考虑带 shrinking 的库。
5. **roundtrip 跳过条件**：data 行以 `\r` 结尾时无法无损序列化（既有语义），该输入跳过 roundtrip。

## 5. 提交状态

- 分支：`feat/sse-fuzz`（stacked 在 PR #13 的 `feat/fork-client` 之上）；
- 发布物：`dist/dsh-fang-2.6.5.tgz` + `dist/manifest.json` + `dist/preflight.json` + `dist/allowlist.json`；
- npm/GitHub Release 未执行：等待 PR 合并与维护者确认；
- 未合并 main：本 PR 只推送分支与 PR，合并由维护者手动审核。
