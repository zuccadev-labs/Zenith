# Zenith Operational Runbooks

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../../users/README.md).

> **Audience:** SRE, Platform Engineering, On-Call Engineers.
> **Severity model:** SEV-1 (full outage, customer-impacting) · SEV-2 (degraded service) · SEV-3 (single-tenant issue or non-critical) · SEV-4 (informational).

## Index

| #  | Runbook                                          | SEV-1 | SEV-2 | SEV-3 |
| -- | ------------------------------------------------ | :---: | :---: | :---: |
| 01 | [Production deployment](./01-production-deployment.md) | | | ✓ |
| 02 | [Incident response](./02-incident-response.md)        | ✓ | ✓ | ✓ |
| 03 | [MongoDB failover](./03-mongodb-failover.md)          | ✓ | ✓ | |
| 04 | Vault unsealing            | ✓ | ✓ | |
| 05 | [API outage — Zenith backend](./05-api-outage.md)     | ✓ | | |
| 06 | [API key compromise](./06-api-key-compromise.md)      | | ✓ | |
| 07 | Plugin security incident   | | ✓ | |
| 08 | [Disaster recovery](./08-disaster-recovery.md)        | ✓ | | |
| 09 | [Backup & restore](./09-backup-restore.md)            | | ✓ | ✓ |
| 10 | Scaling & capacity        | | | ✓ |
| 11 | Certificate rotation | | | ✓ |
| 99 | [SRE cheat sheet](./99-sre-cheatsheet.md)             | ✓ | ✓ | ✓ |

## Severity escalation

| SEV | Response time | Escalation path                                 |
| --- | ------------- | ----------------------------------------------- |
| 1   | 5 min         | On-call SRE → Platform lead → VP Engineering    |
| 2   | 15 min        | On-call SRE → Platform lead                     |
| 3   | 1 h           | On-call SRE (during business hours)             |
| 4   | 24 h          | Async (issue tracker)                           |

## Communication channels

- **Internal:** `#zenith-incidents` Slack channel
- **Status page:** `status.zenith.io` (Statuspage.io)
- **Customer support:** Zendesk integration via `webhook.trait.ts`
- **War room:** Zoom (link in Slack channel topic, rotates weekly)

## Required access

| Resource         | Tool              | Auth                       |
| ---------------- | ----------------- | -------------------------- |
| Production K8s   | kubectl + oidc    | SRE Okta group             |
| Production DB    | mongo-shell + Vault | Vault dynamic creds     |
| Production Vault | vault-cli         | SRE Okta group             |
| AWS account      | aws-vault         | role `zenith-prod-admin`   |
| Status page      | Statuspage.io UI  | SRE Okta group             |
| PagerDuty        | PD web            | on-call rotation schedule  |
