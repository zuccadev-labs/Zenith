# Zenith Threat Model

> **Date:** 2026-06-06
> **Methodology:** STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege)
> **Scope:** Zenith BaaS platform (control plane + data plane + plugins).
> **Out of scope:** customer applications, customer-owned infrastructure, third-party SaaS.

## 1. System overview

```
                                 ┌──────────────┐
                                 │ Customer SDK │
                                 └──────┬───────┘
                                        │ HTTPS / WSS
                                        ▼
┌────────────────────────────────────────────────────────────┐
│                      Zenith Edge Plane                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │CloudFlare│→ │  API GW  │→ │  WAF     │→ │  LB      │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│                      Zenith Control Plane                  │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│   │  Auth    │  │ Tenant   │  │ API Keys │  │  Audit   │  │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│                      Zenith Data Plane                      │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│   │  CRUD    │  │  Files   │  │  Push    │  │Functions │  │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────┬──────────┬──────────┬──────────┬──────────┬──────────┘
      │          │          │          │          │
      ▼          ▼          ▼          ▼          ▼
   MongoDB      S3/GCS    Postal    Vault    Plugin Runtime
                                              (signed)
```

## 2. Trust boundaries

| Boundary                | Trust on one side           | Trust on the other    |
| ----------------------- | --------------------------- | --------------------- |
| Internet ↔ Cloudflare   | Untrusted                   | Trusted (TLS, WAF)    |
| Cloudflare ↔ API GW     | Trusted                     | Trusted (mTLS)        |
| API GW ↔ Zenith backend | Trusted                     | Trusted (mTLS)        |
| Backend ↔ MongoDB       | Trusted (mTLS + auth)       | Trusted               |
| Backend ↔ Vault         | Trusted (AppRole + mTLS)    | Trusted               |
| Plugin runtime ↔ host   | Untrusted (sandbox)         | Trusted               |
| Customer ↔ Customer data| ACL/CLP                     | Other tenants         |

## 3. STRIDE analysis

### 3.1 Spoofing

| Threat                                      | Mitigation                                                       | Status   |
| ------------------------------------------- | ---------------------------------------------------------------- | -------- |
| Forged JWT in Authorization header          | JWT signed with Ed25519 keys from Vault; rotate every 24 h        | ✅       |
| Forged API key (`pk_*`, `sk_*`, `rk_*`)     | Argon2id-hashed (m=64MB, t=3, p=4); key id + hash checked       | ✅       |
| Forged session token                        | Stored in `sessions` collection; compared on every request       | ✅       |
| Forged plugin manifest                      | Ed25519 signature + JCS canonical JSON (RFC 8785)                | ✅ (H-5) |
| Forged gRPC peer identity                   | mTLS with SPKI pinning (Phase 0.C, ADR-002)                      | ✅ (H-3) |
| Replay of signed JWT                        | `jti` claim + 24 h rotation                                       | ✅       |

### 3.2 Tampering

| Threat                                      | Mitigation                                                       | Status   |
| ------------------------------------------- | ---------------------------------------------------------------- | -------- |
| Tampered MongoDB row                        | Field-level encryption for `password`, `token`, `secret`          | ✅       |
| Tampered S3 file                            | Server-side encryption (SSE-KMS); client cannot disable          | ✅       |
| Tampered plugin payload                     | Signature covers all bytes; load fails on mismatch                | ✅ (H-5) |
| Tampered Vault audit log                    | Append-only storage; HSM-signed checkpoints                      | ✅       |
| Tampered Loki log                           | Append-only; chunk integrity hash                                | ✅       |
| Tampered package in transit                 | TLS 1.3 only; HSTS preload; HPKP                                  | ✅       |

### 3.3 Repudiation

| Threat                                      | Mitigation                                                       | Status   |
| ------------------------------------------- | ---------------------------------------------------------------- | -------- |
| User denies a write                         | Audit log (request, user, IP, UA, body hash)                     | ✅       |
| Admin denies config change                  | Vault audit log (signed)                                         | ✅       |
| Plugin author denies deployment             | Signed manifest stored in immutable S3                           | ✅       |
| Customer denies breach                      | All access logged with retention > 1 year                        | ✅       |

### 3.4 Information disclosure

| Threat                                      | Mitigation                                                       | Status   |
| ------------------------------------------- | ---------------------------------------------------------------- | -------- |
| Cross-tenant data leak                      | Tenant id in every query; row-level security; ACL inheritance     | ✅       |
| Sensitive data in error responses           | Strip stack traces in production; structured ZenithError          | ✅       |
| Sensitive data in logs                      | PII redaction middleware; secrets never logged                    | ✅       |
| Sensitive data in metrics                   | Cardinal: no high-cardinality labels (userId, email)             | ✅ (H-9) |
| TLS misconfiguration                        | TLS 1.3 only, modern cipher suites, OCSP stapling                | ✅       |
| Vault token leak                            | Short-lived (1 h), auto-rotate, audit                             | ✅       |
| Database backup leak                        | AES-256-GCM + customer KMS key                                   | ✅ (ADR-010) |
| Heap dump leak                              | Encrypted swap; disable core dumps in production                 | ✅       |
| Timing attack on password comparison        | Argon2id constant-time                                           | ✅       |
| Timing attack on signature comparison       | `crypto.subtle.verify` (constant-time)                           | ✅       |

### 3.5 Denial of service

| Threat                                      | Mitigation                                                       | Status   |
| ------------------------------------------- | ---------------------------------------------------------------- | -------- |
| L7 DDoS                                     | Cloudflare WAF + rate limiting per IP/CIDR                        | ✅       |
| Brute-force login                           | Rate limit (10/min per IP, 60/min per user)                      | ✅       |
| Credential stuffing                         | Cloudflare Bot Management + WAF rules                             | ✅       |
| Slowloris                                   | Request timeout (10 s); connection cap                            | ✅       |
| Large request body                          | 10 MB cap on body, 1 MB on headers                               | ✅       |
| Expensive query                              | Query timeout (5 s), `explain()` analyzer, rate-limit             | ✅       |
| MongoDB connection exhaustion               | Pool size = 100; circuit breaker on Mongo errors                 | ✅       |
| Vault seal/unseal storm                     | Auto-unseal via AWS KMS; sealed detection alert                  | ✅       |
| Cloud function infinite loop                | Timeout (10 s), memory cap (256 MB)                              | ✅       |
| WebSocket flood                             | Max connections per IP (10 000)                                  | ✅       |

### 3.6 Elevation of privilege

| Threat                                      | Mitigation                                                       | Status   |
| ------------------------------------------- | ---------------------------------------------------------------- | -------- |
| Tenant A reads tenant B data                | Tenant id scoping in every Mongo query; row-level security        | ✅       |
| User reads admin data                       | Scope check on every API key                                     | ✅       |
| Master key abuse                            | Master key rotates every 30 d; audit alert on every use          | ✅       |
| Plugin escape sandbox                       | V8 isolate; no `Deno` global; no `fetch` outside allow-list      | ✅ (H-1) |
| Plugin RCE via deps                         | Deny `npm:` imports; only `jsr:` + `https://deno.land/x`          | ✅       |
| Container escape                            | Run as non-root (UID 65532); read-only root FS; no cap-add       | ✅       |
| K8s API access                              | OIDC + RBAC; no static kubeconfig                                | ✅       |
| AWS IAM privilege escalation                | IRSA (IAM Roles for Service Accounts); no long-lived keys        | ✅       |
| Privilege escalation via cron expression    | Validate cron (max 1/min, max 100 jobs/tenant)                    | ⚠️ (Phase 4.0) |

## 4. Residual risks

| Risk                                       | Severity | Owner           | Mitigation plan                  |
| ------------------------------------------ | -------- | --------------- | -------------------------------- |
| Zero-day in Deno runtime                   | high     | Security lead   | Subscribe to Deno security advisories; auto-patch policy |
| Supply-chain attack via npm registry       | medium   | Security lead   | Block `npm:` in plugin runtime; SBOM tracking |
| Insider threat (employee)                  | medium   | Security lead   | Background checks; least privilege; audit log review |
| Quantum computing breaks Ed25519           | low (2030)| Crypto lead    | Migration plan to Dilithium (NIST PQC) |
| Plugin runtime escape via novel V8 bug     | low      | Security lead   | Subscribe to V8 CVE feed; rapid plugin kill-switch |

## 5. Open items

- [ ] **Penetration test** scheduled with NCC Group (Q3 2026).
- [ ] **SOC 2 Type II** audit by Schellman (Q4 2026).
- [ ] **ISO 27001** certification by BSI (Q1 2027).
- [ ] **Bug bounty** program on HackerOne (Q2 2026).
