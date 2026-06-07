# Multi-Region Active-Active Architecture

> **Status:** Design (Phase 4.0+).
> **Owner:** Platform lead.
> **Goal:** < 100 ms p95 latency for 95 % of customers, RPO < 1 s, RTO < 30 s.

## 1. Topology

```
                          Global Anycast IP
                                  │
                                  ▼
                  ┌────────────────────────────────┐
                  │  Cloudflare / Route53 Geolocation │
                  └────────────────────────────────┘
                       │              │              │
                       ▼              ▼              ▼
                 us-east-1     eu-west-1      ap-southeast-1
                  ┌─────┐         ┌─────┐           ┌─────┐
                  │ EKS │         │ EKS │           │ EKS │
                  │     │         │     │           │     │
                  │  Z  │         │  Z  │           │  Z  │
                  └──┬──┘         └──┬──┘           └──┬──┘
                     │              │                 │
                     ▼              ▼                 ▼
              ┌──────────┐  ┌──────────┐       ┌──────────┐
              │ MongoDB  │  │ MongoDB  │       │ MongoDB  │
              │ (primary │  │ (primary │       │ (primary │
              │  in us-1)│  │  in eu-1)│       │  in ap-1)│
              └────┬─────┘  └────┬─────┘       └────┬─────┘
                   │             │                  │
                   ▼             ▼                  ▼
              ┌──────────────────────────────────────────┐
              │  Cross-region async replication          │
              │  (Stream + change streams)              │
              └──────────────────────────────────────────┘
```

Each region is **active** (serves writes) for its geography. Data is
replicated asynchronously across regions within ~1 s.

## 2. Data sovereignty

| Region         | Primary data residency | Replicated to                |
| -------------- | ---------------------- | ---------------------------- |
| us-east-1      | US customers           | us-west-2 (DR), eu-west-1 (read) |
| us-west-2      | US-west customers      | us-east-1 (DR)               |
| eu-west-1      | EU customers (GDPR)    | us-east-1 (DR, encrypted)    |
| ap-southeast-1 | APAC customers         | us-east-1 (DR, encrypted)    |

**GDPR compliance:** EU customer data stays in eu-west-1 by default. The
US-east-1 replica is encrypted with EU-controlled KMS keys; if US access
is denied (legal action), the replica is unrecoverable.

## 3. Conflict resolution

Conflicts are resolved using **last-writer-wins (LWW) per field**, with a
**vector clock** for tie-breaking.

Each write carries:

```typescript
{
  "data": { ... },
  "_metadata": {
    "updatedAt": "2026-06-06T12:00:00.123Z",
    "updatedBy": "user_abc",
    "region": "eu-west-1",
    "version": 42
  }
}
```

On read, the most recent `updatedAt` wins; ties broken by `region` (lex order).

For sensitive collections (e.g. `Order`, `Payment`), conflict is
prevented by routing all writes to a single region (sticky session by
tenant).

## 4. Session affinity

Sessions are routed to the **nearest region** by IP geolocation. If the
nearest region is unavailable, the next-nearest is used. Sessions are
stored in a distributed cache (Redis Cluster, multi-region) so any
region can validate them.

## 5. Active-active for the data plane

| Service          | Active-active? | How                                           |
| ---------------- | :------------: | --------------------------------------------- |
| API              | ✅             | Cloudflare geo + anycast                       |
| WebSocket        | ✅             | Cloudflare geo + sticky session                |
| Push             | ✅             | APNs / FCM is global                          |
| Cloud functions  | ✅             | All regions run the same code                  |
| MongoDB          | ⚠️             | Sharded by tenant; per-tenant primary          |
| Redis            | ✅             | Multi-region CRDT (Redis Enterprise Active-Active) |
| S3               | ✅             | Cross-region replication                      |
| Vault            | ❌             | One region per cluster; performance standby in another |

## 6. Failover

### 6.1 Single region down

- Cloudflare removes the dead region from DNS.
- Cloudflare Workers handle auth at the edge (cached JWKS) — short-lived
  requests succeed.
- Sessions are validated by the remaining regions (cache hit on JWT
  signature + JTI in local Redis).
- Data is available from the next-nearest replica with < 1 s staleness.
- RTO: 30 s (DNS propagation).
- RPO: 1 s (last replicated write).

### 6.2 Multi-region down

- All requests routed to the remaining region(s).
- Throughput reduced; latency increased.
- Degraded mode: read-only if MongoDB primary is in the dead region.
- RTO: 1 h (manual cutover or auto-promotion of cross-region replica).
- RPO: 1 s.

## 7. Observability

Each region has independent Prometheus + Grafana. Cross-region queries
are done via Thanos or Grafana Cloud.

Key cross-region SLOs:

- **Global p95 latency:** < 100 ms (measured at the edge).
- **Replication lag:** < 1 s (p99).
- **Region health:** all regions must be healthy for "All systems operational".

## 8. Cost

Active-active roughly **doubles** the infrastructure cost. For an
Enterprise deployment:

| Region      | EKS cost | MongoDB cost | Redis cost | S3 cost | Total     |
| ----------- | -------- | ------------ | ---------- | ------- | --------- |
| us-east-1   | $3 500   | $4 200       | $1 100     | $40     | $8 840    |
| us-west-2   | $3 500   | $4 200       | $1 100     | $40     | $8 840    |
| eu-west-1   | $3 500   | $4 200       | $1 100     | $40     | $8 840    |
| ap-southeast-1 | $3 500 | $4 200       | $1 100     | $40     | $8 840    |
| **Total**   | $14 000  | $16 800      | $4 400     | $160    | **$35 360 / month** |

This is the **Enterprise+ tier**; included in the $4 999+ base price plus
usage.

## 9. Phased rollout

| Phase | Regions active            | Notes                          |
| ----- | ------------------------- | ------------------------------ |
| 4.0   | us-east-1 only            | single-region launch           |
| 4.1   | us-east-1 + us-west-2     | US multi-region                |
| 4.2   | + eu-west-1                | EU multi-region (GDPR)         |
| 4.3   | + ap-southeast-1          | APAC coverage                  |
| 5.0   | full active-active        | all regions active             |
