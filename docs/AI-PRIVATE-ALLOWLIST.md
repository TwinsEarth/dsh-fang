# AI 私网 allowlist（设计）

## 目标

允许 AI 端点指向内网网关（Ollama / vLLM / LiteLLM / 自建代理）走 **http**，
同时保持“公网必须 https”不变。默认不放开任何私网 http。

## 配置

```yaml
- id: fang-decision-center
  config:
    aiPrivateHosts:
      - '192.168.1.10'
      - 'ollama.lan'
```

- 只接受**精确 hostname 或 IP**；
- 自动小写、去尾点、去 IPv6 方括号；
- 拒绝通配符 `*`、URL、userinfo、带端口的条目、含 `/` 的条目；
- 最多 64 条，非法项静默丢弃；
- 生效范围：`configureAi` / `testAi` / 自动建议 / 流式建议共用同一校验。

## SSRF 防护（私网 / 元数据）

即使 scheme 合法，端点仍要过 SSRF 判定：

| 目标 | 默认 | allowlist 命中 |
|---|---|---|
| 字面量私网 IPv4/IPv6（10/8、172.16/12、192.168/16、fc00::/7、fe80::/10…） | ❌ `private-address-blocked` | ✅ |
| 云元数据地址（169.254.169.254、100.100.100.200、192.0.0.192、fd00:ec2::254） | ❌ `metadata-address-blocked` | ❌ **永远拒绝** |
| 元数据主机名（metadata.google.internal 等） | ❌ | ❌ |
| loopback（127.0.0.1 / ::1 / localhost） | ✅ | ✅ |
| 公网 IP / 公网域名 | ✅（公网必须 https） | ✅ |

DNS 预检（请求前）：

```text
hostname → dns.lookup(all)
  解析到元数据 → metadata-address-blocked（永远）
  解析到私网且 host 不在 allowlist → private-address-blocked
  NXDOMAIN / DNS 失败 → 放行（交给 fetch 失败；不构成 SSRF）
```

覆盖范围：`configureAi`、`testAi`、自动建议、一次性建议、流式建议。

**诚实边界**：DNS 预检与 fetch 的真实解析之间仍有 TOCTOU 窗口（DNS rebinding），
Node fetch 没有 pinned-lookup 接口；这里做的是高置信拦截，不是完备隔离。
最稳妥的部署仍是：AI 网关用固定私网 IP + `aiPrivateHosts` 精确放行，公网域名保持 https。

## 判定顺序

```text
1. https                     → 允许（任何公网/私网）
2. http + loopback           → 允许（localhost/127.0.0.1/::1）
3. http + aiPrivateHosts 命中 → 允许（仅显式 allowlist）
4. 其他 http                 → 拒绝：https-required-for-remote-endpoint
```

## 安全边界

| 项 | 说明 |
|---|---|
| 显式 opt-in | 默认空 allowlist；不自动识别 RFC1918 |
| 仍要求 API key | allowlist 只放宽 scheme，不跳过 `apiKey` 校验 |
| 拒绝重定向 | 请求带 `redirect:'error'`，避免被 302 带到第三方 |
| 不读代理环境变量 | 不会因 `HTTP_PROXY` 把私网请求转出 |
| 状态可见 | `aiStatus().privateHosts` 返回生效的 allowlist（不含 key） |
| DNS rebinding | hostname 条目信任 DNS；若担心，使用字面私网 IP（仍可能 DNS 无关，但更可控） |
| 未做 | CIDR 网段、自动私网检测、mTLS、按 profile 独立 allowlist |

## 测试

```text
ssrf-guard.test.mjs
  - 私网 IPv4/IPv6/映射地址
  - 元数据地址/主机名（allowlist 也不能放行）
  - 字面量私网需 allowlist；loopback 放行
  - DNS 预检：公网名解析到私网/元数据 → 拒绝；NXDOMAIN 放行

decision center: AI private-host allowlist gates http endpoints
decision center: AI SSRF guard blocks metadata even when allowlisted
```

## 与官方源 adapter 的关系

`officialSourceUrl` 走独立的 URL 校验（同样允许 loopback http、远端 https），
**不共享** AI 的私网 allowlist；如果要把镜像源也放内网，需要单独扩展，避免一个开关同时放宽两类出站请求。
