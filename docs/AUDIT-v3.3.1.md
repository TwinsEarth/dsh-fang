# AUDIT v3.3.1

范围：主城门禁第七类目标 `workflows`。

## 威胁模型

| 工作流写法 | 后果 | 门禁 |
|---|---|---|
| `pull_request_target` + checkout PR | fork PR 可拿到 secrets | blocker |
| `permissions: write-all` | 任意步骤可写仓库 | blocker |
| `secrets: inherit` | 子工作流拿到全部 secrets | blocker |
| PR title/body 直接进 `run:` | 命令注入 | blocker |
| 缺 main-city gate / build.mjs | 绕过门禁发布 | blocker |
| 缺 timeout | runner 卡死挂住发布 | warning |

## 验证

```text
真实仓库 source   GREEN A
真实仓库 workflows GREEN A
注入 pull_request_target -> RED
删除 release.yml -> RED
```
