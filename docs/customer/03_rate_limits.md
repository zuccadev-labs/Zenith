# API Rate Limiting Policy

> ⚠️ **Estado (2026-11-10): no coincide con el código.** Partes de este documento son obsoletas o incorrectas (rutas, comandos, paquetes). Lo vigente y la lista de diferencias están en [docs/index.md](../index.md).

> **Effective:** 2026-06-06
> **Owner:** API lead, Security lead.

## 1. Per-key rate limits

| Key type | Default | Burst | Headers                                 |
| -------- | ------: | ----: | --------------------------------------- |
| `pk_*`   | 6 000 / min | 200 / s | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` |
| `sk_*`   | 1 000 / min | 50 / s | same                                    |
| `rk_*`   | 60 / min    | 10 / s | same                                    |
| session  | 60 / min    | 10 / s | same                                    |

Custom limits can be set per-key (Enterprise tier).

## 2. Per-IP rate limits (anonymous)

| Path pattern       | Limit            | Notes                       |
| ------------------ | ---------------- | --------------------------- |
| `/login`           | 10 / min / IP    | brute-force protection      |
| `/users` (signup)  | 5 / hour / IP    | prevents mass signup        |
| `/requestPasswordReset` | 3 / hour / IP | prevents email bombing      |
| `/health`          | unlimited        | liveness probes             |
| `/metrics`         | 60 / min / IP    | Prometheus scraping         |

## 3. Per-tenant rate limits

| Tier        | Aggregate RPS | Notes                          |
| ----------- | ------------: | ------------------------------ |
| Starter     | 100           | shared across all keys         |
| Growth      | 5 000         | shared across all keys         |
| Enterprise  | 100 000+      | per-tenant, custom             |

## 4. Response on limit exceeded

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 30
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1717670400
X-RateLimit-Policy: per-key

{
  "code": "rate_limited",
  "message": "Rate limit exceeded: 1000 requests per minute per key.",
  "retryAfter": 30
}
```

## 5. Algorithm

We use a **token bucket** with a per-key refill rate:

```
tokens = min(capacity, tokens + (now - lastRefill) * refillRate)
if tokens >= 1:
  tokens -= 1
  allow
else:
  deny
```

Implementation: in-memory LRU + Redis for shared state across pods.

## 6. Exemptions

- **Master key:** rate limits can be bypassed (audit logged).
- **Health checks:** always allowed.
- **Webhooks (inbound):** allow 1 000 / min per tenant (customers may
  receive bursts from us).

## 7. Customer visibility

- Per-key usage in the admin dashboard.
- Per-tenant aggregate in the admin dashboard.
- Webhook when a key approaches its limit (90 %, 100 %).
- Slack notification for Enterprise customers.

## 8. Adjustments

Customers can request a limit increase via:

- **Self-service** (in dashboard) for up to 2x the default.
- **Support ticket** for higher; requires justification + business case.
- **Sales** for permanent increases or custom limits.

## 9. DDoS protection

Beyond the per-key limits, the WAF enforces:

- 10 000 / s per IP for the entire Zenith platform.
- 100 / s per IP for unauthenticated routes.
- 1 000 / s per CIDR /16.

When these are exceeded, the WAF returns 429 with a Cloudflare challenge
page (CAPTCHA or JS challenge).

## 10. Abuse handling

Repeated rate-limit violations (3+ in 24 h) trigger:

- Email to the customer.
- 1-hour cooldown.
- Repeated violations → 24 h cooldown → key revocation.
- Severe abuse → tenant suspension (manual review).
