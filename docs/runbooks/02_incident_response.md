# 02 — Incident Response

> **Owner:** On-call SRE
> **Activation:** paged by PagerDuty, or any engineer via `#zenith-incidents`
> **Goal:** restore customer-impacting service within the SLO.

## First 5 minutes

1. **Acknowledge** the page in PagerDuty.
2. **Open `#zenith-incidents`** Slack channel (or join if it exists).
3. **Declare SEV** level in channel topic: `SEV-X — <one-line summary>`.
4. **Page the incident commander** (default: on-call SRE; rotate weekly).
5. **Start the timer:** `Incident started at HH:MM UTC`.

## Roles (assign immediately)

| Role              | Default                  | Responsibility                                      |
| ----------------- | ------------------------ | --------------------------------------------------- |
| Incident Commander| First responder          | Decisions, comms, escalation                        |
| Tech Lead         | Senior on-call engineer  | Investigation, mitigations                         |
| Comms Lead        | Engineering manager      | Status page, customer support, exec updates         |
| Scribe            | Any volunteer            | Live timeline in the incident doc                   |

## Investigation

### 1. Triage dashboard

Open the Zenith SRE Grafana board:

- **API health:** RPS, error rate, p95/p99 latency (per route)
- **Saturation:** CPU, memory, connection pools
- **Dependencies:** MongoDB, Vault, Postal, S3, Keycloak
- **Recent deploys:** in the last 4 h?
- **Customer impact:** which tenants, which endpoints, which regions

### 2. Hypotheses (in priority order)

1. **Recent deploy** — see `kubectl rollout history`.
2. **Dependency outage** — MongoDB, Vault, S3, etc.
3. **Resource saturation** — CPU, memory, file descriptors, conn pool.
4. **Bad config** — env var change, secret rotation, DNS.
5. **External attack** — DDoS, credential stuffing.
6. **Cascading bug** — feature flag flipped, scheduled job.

### 3. Mitigations

- **Roll back** if the deploy was within 4 h.
- **Drain traffic** from saturated pods: `kubectl cordon && kubectl drain`.
- **Throttle** at the ingress (Cloudflare WAF rule).
- **Failover** MongoDB replica (see `03_mongodb_failover.md`).
- **Disable feature flag** if a specific feature is at fault.

## Communication

### Status page

Update every 30 min (SEV-1) or 1 h (SEV-2) with:

- Component(s) affected
- Current status (`Investigating`, `Identified`, `Monitoring`, `Resolved`)
- Customer-visible impact

### Internal

- Slack: post 5-line summary every 30 min.
- Email: optional update to `leadership@` for SEV-1 only.

### Customer support

- Brief Zendesk macros in `#zenith-support`.
- Status page link in auto-replies.

## Resolution

- [ ] Customer impact ended.
- [ ] Error rate and latency back to baseline.
- [ ] SLO dashboard green for 15 min.
- [ ] Status page set to `Resolved`.
- [ ] Incident doc shared in `#zenith-incidents`.

## Post-incident (within 5 business days)

- [ ] **Post-mortem** doc written (template in `docs/templates/postmortem.md`).
- [ ] **Blameless review** meeting scheduled (60 min, all-hands).
- [ ] **Action items** logged in the issue tracker with owner and due date.
- [ ] **Runbook updates** if the runbook was wrong or missing.
- [ ] **Detection improvements** if the incident was > 15 min undetected.
