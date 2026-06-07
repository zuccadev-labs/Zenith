# 08 — Disaster Recovery

> **Owner:** VP Engineering + Platform lead
> **RTO:** 4 hours (recovery time objective)
> **RPO:** 15 minutes (recovery point objective, last continuous backup)
> **Test cadence:** quarterly full DR drill; monthly backup-restore smoke test.

## Threat model

| Scenario                        | Probability | Impact   | DR plan    |
| ------------------------------- | ----------- | -------- | ---------- |
| Single AZ failure               | medium      | low      | Multi-AZ   |
| Single region failure           | low         | high     | Multi-region (active-passive) |
| Accidental data deletion        | medium      | high     | Point-in-time restore |
| Ransomware / data corruption    | low         | critical | Restore from immutable backup |
| Vault compromise                | very low    | critical | Vault HA + offline root tokens |

## Backup strategy

| Component   | Method                     | Frequency          | Retention          | Storage         |
| ----------- | -------------------------- | ------------------ | ------------------ | --------------- |
| MongoDB     | `mongodump` + PITR oplog   | continuous + 4 h   | 30 d hot, 1 y cold | S3 + Glacier    |
| Vault       | Raft snapshots             | 1 h                | 30 d               | S3 + HSM-encrypted |
| S3 / GCS    | Cross-region replication   | real-time          | 30 d CRR           | multi-region    |
| Logs        | Loki → S3                  | real-time          | 90 d               | S3              |
| API keys    | Vault KV (encrypted)       | on change          | 30 d backup        | S3 + Glacier    |

See `09_backup_restore.md` for restore procedures.

## Active-passive multi-region

| Region   | Role     | Replica set | Latency to primary  |
| -------- | -------- | ----------- | ------------------- |
| us-east-1| primary  | 3 nodes     | —                   |
| us-west-2| passive  | 3 nodes     | 70 ms RTT           |
| eu-west-1| passive  | 3 nodes     | 90 ms RTT           |

Promotion: run `09_backup_restore.md#promote-passive` after declaring DR.

## Runbook — full region loss

1. **Declare DR** in `#zenith-incidents`: `DR-1 — <region> lost`.
2. **Page DR team:** VP Eng, Platform lead, Security lead, Customer Success lead.
3. **Promote passive region** (see `09_backup_restore.md`).
4. **Update DNS:** lower TTL to 60 s (already pre-set); flip `api.zenith.io` to passive region's load balancer.
5. **Update Vault:** rotate root tokens, re-initialize any AppRole that was region-specific.
6. **Customer comms:** Statuspage + email blast + Zendesk macros.
7. **Status:** once stable, run `09_backup_restore.md#post-dr-validation`.

## Validation (quarterly drill)

- [ ] Restore MongoDB from S3 backup into a sandbox cluster.
- [ ] Run integration tests against the restored cluster.
- [ ] Time the full restore: must be < RPO × 2.
- [ ] Time the full promotion: must be < RTO / 2.
- [ ] Sign off in the DR drill report.

## Communication

- Internal: `#zenith-incidents` and `#leadership`.
- External: Statuspage (`Major outage`), customer email within 1 h, post-mortem within 5 business days.
- Legal/PR: notify if any customer data is at risk of exposure (GDPR, CCPA).
