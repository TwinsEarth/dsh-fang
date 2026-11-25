# AUDIT v3.1.27

范围：给 build job 补 permissions: contents: write（发布流水线最后一个单点）。

## 证据链（真实 CI 日志）

`	ext
v3.1.26 build job:
  PUBLISHED @twinsearth/dsh-fang@3.1.26            ← npm 直发成功
  tag=v3.1.26 repo=TwinsEarth/dsh-fang assets=4    ← 资产选择正确
  FAIL POST /repos/.../releases -> HTTP 403:       ← 缺 contents: write
       Resource not accessible by integration
`

## 修复

| 项 | 改前 | 改后 |
|---|---|---|
| workflow 权限 | contents: read（workflow 级） | build job 级 contents: write |
| Release 创建者 | 独立 job（需 artifact） | build job 直发（不依赖 artifact） |

## 验收

本版发布即验收：build job 内 npm + Release 都成功，且 healthz / mirror / verify 全部真实执行。

## 决策中心浮窗（v3.1.27 一并交付）

| 要求 | 实现 |
|---|---|
| 浮窗居中 | position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) |
| 高度 1/3 | height:33vh; max-height:33vh; min-height:220px |
| 宽度保持不变 | width:min(420px,94vw)（与 v3.1.24 一致） |
| 不影响会话/工作区 | .fang-relay-backdrop{display:none}，无遮罩 |
| 选完自动收起 | submitOption/submitCustom 成功后 setOpen(false) |
| 点其他地方收起 | pointerdown 捕获：命中面板/FAB 外 → setOpen(false) |

回归：	est/client-decision-relay.test.mjs（3 例）+ 	est/decision-relay-dom.test.mjs（5 例）。
