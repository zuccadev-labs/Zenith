# ADR-010 — Backup & Disaster Recovery Strategy

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../users/README.md).

> **Status:** Accepted
> **Date:** 2026-06-06
> **Deciders:** VP Engineering, Security lead, Platform lead
> **Supersedes:** none
> **Related:** `docs/runbooks/08_disaster_recovery.md`, `docs/runbooks/09_backup_restore.md`

## Context

Zenith stores customer data across multiple systems: MongoDB (primary),
S3/GCS (files), Vault (secrets, API keys, JWT keys), and Loki (logs).
A loss of any of these systems is a SEV-1 / SEV-2 event. We need a
documented, tested backup and disaster recovery strategy with explicit
RTO/RPO targets.

## Decision

We adopt the following strategy:

### Recovery targets

| System        | RTO   | RPO   | Method                          |
| ------------- | ----- | ----- | ------------------------------- |
| MongoDB       | 1 h   | 15 min| Continuous oplog + 4 h full     |
| S3 / GCS      | 4 h   | 0     | Cross-region replication        |
| Vault         | 30 min| 1 h   | Raft snapshots + HSM root       |
| Logs (Loki)   | 24 h  | 0     | S3 CRR + Glacier                |
| API keys      | 15 min| 0     | Vault KV encrypted at rest      |

### Storage

- All backups encrypted with **AWS KMS CMK** (customer-managed).
- Cross-region replication for all S3 buckets (`us-east-1` ↔ `us-west-2`).
- Glacier transition after 30 days for cost optimisation.
- Vault root tokens split via **Shamir's Secret Sharing** (5-of-8) and
  stored in physical safes at 3 geographically distinct offices.

### Validation

- **Daily:** `mongorestore --dryRun` against a sandbox cluster.
- **Monthly:** full restore smoke test (RTO < 1 h, RPO < 15 min).
- **Quarterly:** full DR drill (region failover + restore + validation).
- **Annually:** third-party penetration test of the restore procedure.

### Retention

| Tier       | Retention | Storage class |
| ---------- | --------- | ------------- |
| Hot        | 30 days   | S3 Standard   |
| Warm       | 90 days   | S3 IA         |
| Cold       | 1 year    | S3 Glacier    |
| Archive    | 7 years   | S3 Deep Archive |

## Consequences

### Positive

- Customer SLA of 99.95 % is achievable.
- GDPR "right to erasure" workflows are compatible (selective restore).
- Ransomware is survivable (offline + immutable backups).

### Negative

- ~$4 800/month additional cost for cross-region + Glacier.
- DR drills require scheduled downtime windows (max 1 h per quarter).
- Restores > 100 GB take > 30 min; large tenants need a separate runbook.

### Neutral

- Backup tooling (`mongodump`, `aws s3 sync`) is standard; no custom code.
