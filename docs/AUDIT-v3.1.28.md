# AUDIT v3.1.28

范围：发布流水线定稿（去掉与 build 重复的发布 job）。

## 问题

```text
v3.1.27 build job : PUBLISHED @twinsearth/dsh-fang@3.1.27   → npm 直发成功
v3.1.27 npm job   : FAIL npm publish: HTTP 409
                    Cannot publish over previously staged version "3.1.27"
→ 冗余 job 把流水线打红，healthz / final verify 被 skip
```

## 修复

| 项 | 改前 | 改后 |
|---|---|---|
| 发布者 | build 直发 + 2 个独立 job 重复 | 只有 build 直发 |
| job 数 | guard/test/build/npm/github-release/docker/healthz/mirror/verify | guard/test/build/docker/healthz/mirror/verify |
| 依赖图 | healthz←npm；mirror←github-release | 全部←build |

## 定稿流水线

```text
guard (tag on main) → test (node 22/24) → build (e2e + npm + Release)
                                          ├→ mirror (private)
                                          └→ healthz (remote)
                                               └→ verify (final)
```
