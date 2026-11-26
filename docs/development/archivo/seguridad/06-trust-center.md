# Zenith Trust Center

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../../users/README.md).

> **Live:** https://zenith.io/trust-center
> **Owner:** Security lead, Customer Success lead.

## 1. Compliance & certifications

| Framework      | Status     | Audit window          | Auditor        | Report         |
| -------------- | ---------- | --------------------- | -------------- | -------------- |
| **SOC 2 Type I** | in progress | 2026-Q3              | Schellman      | (forthcoming)  |
| **SOC 2 Type II**| planned    | 2027-Q2 (12-month)   | Schellman      | (forthcoming)  |
| **ISO 27001**    | in progress | 2026-Q4              | BSI            | (forthcoming)  |
| **GDPR**         | compliant   | continuous           | self-attested  | DPA on request |
| **CCPA**         | compliant   | continuous           | self-attested  | addendum       |
| **HIPAA**        | planned     | 2027-Q1              | (TBD)          | (forthcoming)  |
| **PCI-DSS**      | planned     | 2027-Q3              | (TBD)          | (forthcoming)  |

## 2. Sub-processors

Zenith uses the following sub-processors to deliver the service. Customers
are notified 30 days before any change.

| Sub-processor    | Purpose                          | Data processed              | Region(s)         |
| ---------------- | -------------------------------- | --------------------------- | ----------------- |
| AWS              | infrastructure (compute, storage) | all customer data            | us-east-1, us-west-2, eu-west-1, ap-southeast-1 |
| Cloudflare       | WAF, DDoS protection, edge cache | HTTP metadata (no payload)  | global edge       |
| HashiCorp Cloud  | Vault SaaS (Enterprise tier only)| secrets, KMS keys           | us-east-1         |
| Datadog          | logging, monitoring              | logs, metrics, traces        | us-east-1         |
| Statuspage.io    | status page                       | incident metadata           | us-east-1         |
| Stripe           | billing                           | billing info, no app data   | us-east-1         |
| Twilio (Postal)  | transactional email              | email addresses, templates  | us-east-1         |
| APNs (Apple)     | iOS push                          | device tokens, payload     | global            |
| FCM (Google)     | Android push                      | device tokens, payload     | global            |
| PagerDuty        | incident alerting                 | on-call identity, alerts    | us-east-1         |

## 3. Security controls

See `docs/security/03_controls_checklist.md` for the full NIST 800-53 / ISO
27001 / SOC 2 controls matrix.

Headline controls:

- TLS 1.3 only; HSTS preload; OCSP stapling
- AES-256-GCM at rest; customer-managed KMS keys
- Ed25519 signatures on all plugins (ADR-004)
- Argon2id password hashing (m=64MB, t=3, p=4)
- mTLS + SPKI pinning for service-to-service (ADR-002)
- Field-level encryption for PII columns
- Append-only audit log with HSM-signed checkpoints
- 24/7 SOC; SEV-1 response in 5 minutes
- Annual third-party penetration test

## 4. Vulnerability disclosure

See `docs/security/04_vulnerability_disclosure.md`.

- **Email:** security@zenith.io
- **PGP key:** https://zenith.io/pgp-key.asc
- **HackerOne:** https://hackerone.com/zenith
- **Bug bounty:** up to $25 000 per finding

## 5. Data residency

Customers can choose the region where their data is stored:

- `us-east-1` (Virginia, USA) — primary
- `us-west-2` (Oregon, USA) — primary
- `eu-west-1` (Ireland, EU) — primary
- `ap-southeast-1` (Singapore) — primary

Data never leaves the chosen region except for:

- Backups (cross-region replication within the same continent)
- Support escalations (anonymized logs only)
- Customer-initiated exports (customer-controlled)

## 6. Data deletion

| Trigger                         | SLA                              | Method                    |
| ------------------------------- | -------------------------------- | ------------------------- |
| Customer-initiated delete        | 24 h (inaccessible)              | soft delete + tombstone   |
| Tenant offboarding (full purge)  | 30 d (irrecoverable)             | crypto-shred (KMS key)   |
| Backup retention expiry         | per ADR-010 schedule             | S3 lifecycle              |
| Legal hold (subpoena)            | n/a                              | preserved                 |

## 7. Uptime SLA

| Tier        | Monthly SLA | Service credit per 1 % below SLA |
| ----------- | ----------- | -------------------------------- |
| Starter     | 99.5 %      | 5 %                              |
| Growth      | 99.9 %      | 10 %                             |
| Enterprise  | 99.95 %     | 25 %                             |

Service credits are calculated monthly and applied automatically.
See the MSA for the full terms.

## 8. RPO / RTO

| Component | RPO    | RTO    | Method                                |
| --------- | ------ | ------ | ------------------------------------- |
| MongoDB   | 15 min | 1 h    | PITR + 4 h full backup                |
| S3 / GCS  | 0      | 4 h    | Cross-region replication              |
| Vault     | 1 h    | 30 min | Raft snapshots + auto-unseal (AWS KMS)|
| Logs      | 0      | 24 h   | S3 CRR + Glacier                      |

## 9. Customer controls

Customers can configure:

- IP allow-lists (CIDR)
- SSO / OIDC / SAML
- MFA enforcement
- Session timeout
- Password policy (min length, complexity, rotation)
- API key scopes
- Per-tenant data residency
- Audit log export to SIEM
- Webhook subscriptions

## 10. Contact

- **Security:** security@zenith.io
- **Privacy / DPO:** privacy@zenith.io
- **Compliance:** compliance@zenith.io
- **Sales:** sales@zenith.io
- **Support:** support@zenith.io
- **Status:** https://status.zenith.io
- **Postmaster:** https://zenith.io/postmaster (email deliverability)
