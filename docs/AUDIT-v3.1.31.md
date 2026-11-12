# AUDIT v3.1.31

范围：P1 折行纯量解析（修「生成元主失败」）+ P2 CI 校验条件失效。

## P1

| 项 | 内容 |
|---|---|
| 现象 | 生成元主失败：`mother patch parse failed: line 93: unexpected indentation / content` |
| 复现 | `parseYamlSubset(母体 cordis.patch.yml)` → errors=["line 93: unexpected indentation / content"] |
| 最小复现 | `description: ... suited` + 续行 `to complex tasks ...` → line 5 报错 |
| 根因 | 逐行 YAML 子集解析器不接受 plain scalar 折行续行 |
| 修复 | `foldContinuations()` 在三处纯量赋值点吸收非结构续行，空格拼接 |
| 复验 | 真实母体 patch → errors=[]，description 正确拼接，兄弟键不丢 |

## P2

| 项 | 内容 |
|---|---|
| 现象 | CI 的 healthz / final verify 连续多版 skipped |
| 根因 | `if` 引用已删除的 npm / github-release job |
| 修复 | 改为 `needs.build.result` / `needs.mirror.result` |
| 预期 | v3.1.31 起 healthz 与 final verify 真实执行 |

## 回归

```text
test/yaml-folded-scalar.test.mjs   5 例（新增）
test/rule-config.test.mjs         37 例（无回归）
真实母体 patch                     0 错误
```
