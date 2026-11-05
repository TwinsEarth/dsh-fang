# SSE 解析器定向生成器（v2.6.9）

> 代码：`tools/fuzz/sse-directed.mjs`；测试：`test/sse-directed.test.mjs`。
> 入口：`tools/fuzz/sse-parser-fuzz.mjs`（CLI + `runSseParserFuzz`）。
> 关系：随机生成器（`sse-generators.mjs`）覆盖广度，定向生成器覆盖深度。

## 1. 九个分支与定向用例

| 分支 | SseParser 代码路径 | 关键语义（定向用例锁定） | 用例数 |
|---|---|---|---|
| `cr-trimming` | `if (line.endsWith('\r')) line = line.slice(0, -1)` | 只裁一个尾部 `\r`；中间 `\r` 保留；`\r\n\r\n` 空行 | 8 |
| `multi-line-data` | `dataLines.join('\n')` | 空值也参与拼接；首/中/尾行为空 | 7 |
| `empty-data-dropped` | `if (dataLines.length === 0) return null` | 只有 id/event/retry/未知字段不产帧；空行同时重置 id/event | 9 |
| `comment-ignored` | `if (line.startsWith(':')) return null` | 帧前/帧中/帧后注释；假字段注释 | 9 |
| `space-trimming` | `if (value.startsWith(' ')) value = value.slice(1)` | 只裁一个前导空格；`data:  x` → `' x'` | 7 |
| `field-override` | `curId/curEvent = value`；data push | id/event 后者覆盖；data 累积；空帧边界重置 | 6 |
| `retry-and-unknown` | `case 'retry'` / `default` | retry 与未知字段不改状态、不产帧 | 6 |
| `data-field-edge` | `colon === -1 → field=line, value=''` | 无冒号的 `data` 仍算一条 data 行（产生空 data 帧） | 4 |
| `buffer-boundary` | `if (nl === -1) break` | 行未完成/帧未完成不 dispatch；`flush` 丢弃残帧 | 5 |

合计 **61 条**定向用例；每条用例是最小化输入（去掉与目标分支无关的字段）。
其中 40+ 条带 `expectedFrames`，用于锁定语义；其余至少验证分块等价性。

## 2. 定向 smoke test（CI 前置）

`runDirectedSmokeTest()` 对每条用例执行：

1. **一次性解析**：不抛错；
2. **expectedFrames**（若有）：与 `framesEqual` 完全一致；
3. **分块等价性**：6 种字符串分块策略 × 3 个不同种子（`hash32(input) ^ trial`），
   分块解析结果必须与一次性解析一致。

支持注入 `parseAll` / `parseChunks`，用于 **mutation 测试**：例如把实现改成
`replace(/\r+$/gm, '')`（裁掉所有尾部 CR）后，定向用例必须报错——测试里已固化这一检出。

## 3. 混合随机模糊

`generateMixed(rng, { directedProb = 0.3 })`：

- 以 `directedProb` 概率 `pickDirected(rng)`（先均匀选分支，再均匀选用例）；
- 否则调用随机 `generateInput(rng)`；
- 返回 `{ input, description, branch? }`，branch 存在即定向命中。

`runSseParserFuzz({ directedProb, directed })` 统计：

- `directedHits` / `randomHits`；
- `branchCounts`（每分支命中次数）；
- 失败记录新增 `branch` 字段，报告里可直接看出是哪个定向分支抓到的。

CLI：

```bash
node tools/fuzz/sse-parser-fuzz.mjs --iterations 5000 --seed 20261109
node tools/fuzz/sse-parser-fuzz.mjs --iterations 20000 --directed-prob 0.5
node tools/fuzz/sse-parser-fuzz.mjs --iterations 5000 --no-directed   # 只跑随机
```

输出顺序：properties → directed smoke（61/61）→ 随机模糊+定向混合 → 分支覆盖率。
当 `directedHits > 100` 时，若某分支计数为 0 会打印 `WARN: zero-hit branches: …`
（防止 `ALL_BRANCHES` 与 `DIRECTED_CASES` 键不一致而静默漏覆盖）。

## 4. 设计取舍

- **为什么每条用例都最小化**：失败时能直接定位到分支；例如 `data: x\r\r\n\n`
  比 `id: 1\ndata: x\r\r\n\n` 更能说明“只裁一个 CR”。
- **为什么同时要 expectedFrames 和分块等价性**：
  - expectedFrames 锁定**语义**（实现“优化”不能悄悄改变行为）；
  - 分块等价性锁定**状态机**（buffer/curId/curEvent/dataLines 跨块一致）。
- **为什么 3 个种子**：`buildChunkStrategies` 的 `random` 策略依赖 rng，单次切分可能
  恰好避开 bug 位置；3 个种子成本可控（61 用例 × 3 × 6 ≈ 1098 次解析）。
- **为什么不替代随机模糊**：定向用例是固定的 61 条，无法发现新的字段组合；
  随机生成器仍负责不规则输入、UTF-8 切分、超长行等。

## 5. 测试（8 项）

1. 9 分支 / 每分支 ≥3 条 / 61 条 / 描述唯一；
2. smoke 全通过（61/61）+ 分块等价性；
3. expectedFrames 覆盖所有分支（≥40 条）；
4. mutation（裁掉所有尾部 CR）被检出；
5. 混合生成确定性 + prob=0/1 边界；
6. 均匀抽样覆盖 9 分支；
7. `runSseParserFuzz(directedProb=1)` 900 次：全定向、9 分支命中 >0、0 failures；
8. `directed=false` 全随机 + 同 seed 可复现。

## 6. 边界

- 定向用例是**已知语义的快照**：若未来决定对齐“无冒号行忽略”等规范变化，
  必须同步更新 `data-field-edge` 的 expectedFrames，而不是绕过；
- `\r` 只按“行尾恰好一个”处理，单 `\r` 不是行分隔符（与 SseParser 实现一致）；
- 定向 smoke 的 time 复杂度随用例线性增长（61 × 18 次解析），对 CI 可忽略；
- 分支覆盖率统计的是“定向输入命中”，不替代真实代码覆盖率工具。
