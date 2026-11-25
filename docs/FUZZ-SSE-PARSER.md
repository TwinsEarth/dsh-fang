# SSE 解析器模糊测试（v2.6.5）

> 目标：用**随机输入 + 分块等价性 + 独立参考实现**把 `SseParser` 的状态机边界钉死。
> 代码：`src/lib/sse-parser.mjs`（被测类）；`tools/fuzz/*`（RNG / 生成器 / 不变量 / runner）；
> 测试：`test/sse-parser-fuzz.test.mjs`（固定种子进 CI）；CLI 可跑大批量。
>
> 本仓库是纯 JS，所以用 `.mjs` 实现（与 `node --check` + `node:test` 门禁一致），
> 结构与设计稿的 TS 版本一一对应。

## 1. 被测语义

`SseParser`：

- 只按 `\n` 切行；行尾有且仅有一个 `\r` 时裁掉（支持 CRLF；单独 `\r` 属于 data 内容）；
- 空行 = 帧边界；只有 `dataLines` 非空才产出帧（纯 id/event/注释帧丢弃）；
- `:` 开头为注释（心跳）忽略；`retry` 与未知字段忽略；
- 冒号后一个空格可选；多行 data 用 `\n` 拼接；dispatch 后重置 id/event/data；
- `flush()` 按 SSE 规范**丢弃**未完成的残帧（EOF 不 dispatch）。

> v2.6.5 之前 `createSseParser` 用 `indexOf('\n\n')` 找块边界，CRLF 流（`\r\n\r\n`）不含 `\n\n`，
> 会延迟到 `flush` 且把 `\r` 混进 data。本次替换为行式 `SseParser` 后修复。

## 2. 六个不变量

| # | 不变量 | 检测什么 |
|---|---|---|
| I1 | **分块等价性**：`parseAll(input)` 与任意切分 `parseChunks(chunks)` 逐帧相等 | 跨 chunk 的状态机错乱（buffer / \r 裁剪 / data 累积） |
| I1b | **字节级等价性**：按随机字节切 + `TextDecoder({stream:true})` 解码后解析，与一次性解析相等 | 跨 chunk 的 UTF-8 多字节字符（模拟 `res.setEncoding('utf8')`） |
| I2 | **参考实现等价性**：独立写的“一次性”解析器 `referenceParse(input)` 与实现相等 | 实现自己的语义漂移（oracle 不共享代码） |
| I3 | **roundtrip**：解析结果 → `serializeFrames()` → 再解析，帧序列相等 | 帧序列化/反序列化不对称 |
| I4 | **帧边界**：data 中的 `\n` 不切帧，只有空行切帧 | 把换行符与帧分隔符混淆 |
| I5 | **flush 不泄漏**：`flush()` 丢弃残帧、幂等，之后解析器仍可正常使用 | 残留 buffer / 状态未重置 |
| I6 | **不抛错**：任意输入（含纯噪声、截断、长行）不抛异常 | 畸形输入导致崩溃 |

I1/I1b 是主战场；I2 是 oracle；I3–I6 是每次运行都执行的确定性性质断言。

## 3. 结构

```
tools/fuzz/
├── sse-rng.mjs          # SplitMix32 初始化 + XorShift128（同 seed 完全可复现）
├── sse-generators.mjs   # 9 种输入模式
├── sse-invariants.mjs   # parseAll/parseChunks/parseByteChunks/referenceParse/serializeFrames/分块策略
└── sse-parser-fuzz.mjs  # runSseParserFuzz + runPropertyTests + CLI
test/sse-parser-fuzz.test.mjs  # 固定种子 × 6 + 性质断言 + 已知边界（CI）
```

### 输入模式（`generateInput`）

单帧 / 多帧拼接 / 帧+噪声 / 纯噪声 / 超长 data（400–4000 字符）/ 无 data 帧 /
注释风暴+帧 / 任意位置截断（残帧）/ CRLF 与 LF 混合。

### 分块策略（`buildChunkStrategies` + byte）

`single-codepoint`（`Array.from`，模拟 setEncoding 后的字符边界）、`fixed-3`、`fixed-7`、
`random`（含“在 `\n` 附近切”分支）、`newline-boundary`（每个 `\n` 后立即切）、
`with-empty-chunks`（插入空 chunk），以及 runner 里的 `byte-chunks`（随机字节 + 流式解码）。

## 4. 失败报告与复现

每个 iteration 使用独立子种子 `baseSeed + i * 0x9e3779b1`，所以失败可直接重放，不需要重跑前 i-1 次：

```
node tools/fuzz/sse-parser-fuzz.mjs --iterations 1 --seed <iterationSeed>
```

报告包含：`iterationSeed` / `iteration` / `description` / `kind` / `reason` / `input` /
**`inputHex`**（`\r` 等不可见字符的位置只能靠 hex 看清）/ `chunks` / `expected` / `actual`。

CLI：

```bash
node tools/fuzz/sse-parser-fuzz.mjs                              # 5000 iters，随机 seed 并打印
node tools/fuzz/sse-parser-fuzz.mjs --iterations 20000 --seed 1  # 大批量固定种子
node tools/fuzz/sse-parser-fuzz.mjs --stop-on-first              # 遇错即停（修复循环用）
```

## 5. CI / 门禁

- `test/sse-parser-fuzz.test.mjs` 进全量测试：性质断言 + 6 个固定种子 × 25 iterations +
  默认随机 seed smoke + 可复现性 + 已知 CRLF/多行/字节切分边界；
- 本机额外跑过 `--iterations 5000 --seed 20261101` → **0 failures**
  （见 `docs/AUDIT-v2.6.5.md`）；
- 失败时测试会直接打印第一条 failure 的完整 JSON（含 seed / hex / chunks）。

## 6. 已知边界（不测什么）

1. **不测“是否符合完整 SSE 规范”**：单独 `\r` 换行不在支持范围内（DSH Adapter 只输出
   `\n` 或 `\r\n`）。I1/I2 对任意输入成立，语义以 `SseParser` 的既有行为为准（`data: x\r\r\n`
   只裁一个尾部 `\r`，data 为 `x\r`）。
2. **字符串级切分不是字节级**：`single-codepoint` 按 code point 切，真实场景里
   `res.setEncoding('utf8')` 保证字符边界；字节级由单独的 `byte-chunks` 策略覆盖。
3. **手写生成器没有覆盖率反馈**：SseParser 状态只有 buffer/curId/curEvent/dataLines 四个字段，
   9 种模式已覆盖；若未来引入 BOM/retry/更复杂状态，再考虑 fast-check 等带收缩（shrinking）的库。
4. **roundtrip 的跳过条件**：data 的某一行以 `\r` 结尾时，重新序列化会被再裁一次，属于
   `SseParser` 的既有语义（不是 bug），该输入跳过 roundtrip（I1/I2 仍覆盖）。
