# v3.5.5 三方发布记录（2026-11-21）

> 用户指令：**三方发布，v3.5.5**（v3.5.4 之后的安全与静默错误修复批次）。

## 0. 版本矩阵

| 组件 | 版本 | 说明 |
|---|---|---|
| `@twinsearth/fang-dsh-plugin` | **3.5.5** | 本次三方发布主体 |
| `@twinsearth/dsh-fang-contract` | 1.2.0（已发布） | vendored pin 不变 |
| 加速核 `@twinsearth/dsh` | 3.5.0 | 加速分身依赖；不发布 |

## 1. 内容

- 安全修复 R28（auth-token bootstrap）/ R23（pro 审批参数绑定）；
- 静默错误修复 R13（mirror Promise）/ R14（会话目录脱敏与形状）/ R15（审计失败可见）；
- 继承 v3.5.4 之后主干回收：决策计时器竞态修复 + e2e CLI 新安装根 + CI per-test timeout；
- 新增/更新回归测试；CHANGELOG「v3.5.5」段。

## 2. 门禁（待回填）

## 3. 发布结果（待回填）
