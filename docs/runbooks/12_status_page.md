# Zenith — Status Page

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../index.md).

> **Live:** https://status.zenith.io
> **Tool:** Statuspage.io (or self-hosted Cachet)

## Components

| Component               | Description                                   | Impact if down            |
| ----------------------- | --------------------------------------------- | ------------------------- |
| **API — us-east-1**     | Primary region API                            | US customers affected     |
| **API — us-west-2**     | Secondary region API                          | US-west customers         |
| **API — eu-west-1**     | European region API                           | EU customers affected     |
| **API — ap-southeast-1**| Asian region API                              | APAC customers affected   |
| **Dashboard**           | Admin dashboard at admin.zenith.io            | Admin operations slowed   |
| **WebSocket**           | Real-time queries                             | Live queries fail         |
| **Push — APNs**         | Apple Push Notification service               | iOS push fails            |
| **Push — FCM**          | Firebase Cloud Messaging                      | Android push fails         |
| **Push — Web**          | Web Push                                      | Web push fails            |
| **File storage**        | S3 uploads + downloads                        | Files unavailable         |
| **Backups**             | MongoDB PITR + S3 cross-region               | Restore degraded          |
| **Vault**               | HashiCorp Vault (HA cluster)                  | Secret rotation fails     |
| **Status page itself**  | https://status.zenith.io                     | Customer comms degraded   |

## Incident status values

- 🟢 **Operational** — no issues
- 🟡 **Degraded performance** — slower than usual, no errors
- 🟠 **Partial outage** — some customers affected
- 🔴 **Major outage** — full outage, all customers affected
- 🔵 **Maintenance** — scheduled maintenance window
- ⚪ **Under maintenance** — planned work in progress

## Status page template (per incident)

```markdown
## [SEV-1] Elevated error rates on API — us-east-1

**Status:** Investigating → Identified → Monitoring → Resolved
**Components affected:** API — us-east-1, Push — FCM
**Started:** 2026-06-06 12:00 UTC
**Resolved:** 2026-06-06 13:15 UTC
**Duration:** 1 h 15 min

### What happened

Between 12:00 and 12:45 UTC, customers in the us-east-1 region experienced
elevated 5xx error rates (≈8 %) on all API routes. Push notifications to
FCM were also affected. WebSocket and file storage were not affected.

### What we did

1. **12:02** — alert fired, on-call SRE paged.
2. **12:05** — incident declared SEV-1; war room opened.
3. **12:12** — root cause identified: a misconfigured MongoDB index
   caused connection pool exhaustion.
4. **12:25** — failover to a secondary replica.
5. **12:45** — primary recovered, connections drained.
6. **13:15** — full restoration confirmed.

### What's next

Post-mortem will be published within 5 business days at
<https://zenith.io/incidents/2026-06-06-sev1>.

We're adding two follow-up items:
- Auto-detect connection pool exhaustion (5 min → 1 min detection)
- Quorum-based failover with at least 2 healthy secondaries

### Subscribe

Subscribe to component updates at <https://status.zenith.io/subscribe>.
```

## Communication rules

- **First update:** within 15 min of detection.
- **Updates:** every 30 min for SEV-1, every 1 h for SEV-2.
- **Resolution update:** within 15 min of fix.
- **Post-mortem:** within 5 business days.
- **Proactive notification:** for any change that may affect customers
  (maintenance, security, performance).
- **Avoid jargon:** customers are engineers, not SREs.
- **Be honest:** if we don't know, say "we don't know yet".
