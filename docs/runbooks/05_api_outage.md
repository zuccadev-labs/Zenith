# 05 — API Outage (Zenith Backend)

> **Owner:** On-call SRE
> **Trigger:** `GET /health` returns 5xx for > 1 min, or error rate > 5 % on any route.

## Triage (first 5 min)

1. Open the SRE Grafana board: `https://grafana.zenith.io/d/zenith-api`.
2. Check:
   - Pod status (`kubectl -n zenith get pods`)
   - Recent deploys (`kubectl -n zenith rollout history`)
   - MongoDB primary (`mongo --eval 'rs.status()'`)
   - Vault health (`vault status`)

## Common causes

| Symptom                              | Likely cause           | Mitigation                           |
| ------------------------------------ | ---------------------- | ------------------------------------ |
| All pods crash-looping               | Bad deploy             | `kubectl rollout undo`               |
| 502 from ingress, pods OK            | Bad ingress config     | Re-apply Cloudflare + ingress YAML   |
| All requests timing out              | MongoDB down           | See `03_mongodb_failover.md`         |
| 401s across the board                | Vault down / JWKS stale| See `04_vault_unsealing.md`          |
| 429s across the board                | Rate-limit misconfig   | Increase per-key rate limit          |
| Latency spike, no error spike        | GC pause or disk I/O   | Check JVM/Deno metrics, dmesg        |

## Mitigations

### Roll back the deploy

```bash
kubectl -n zenith rollout undo deployment/zenith-backend
kubectl -n zenith rollout status deployment/zenith-backend --timeout=5m
```

### Drain a bad pod

```bash
kubectl -n zenith delete pod -l app=zenith-backend,zenith.rollout=canary
```

### Throttle at the ingress

In Cloudflare dashboard:

- Security → WAF → Custom rules → Rate limit: `1000 req / 10 s / IP`.
- Enable "Under Attack Mode" if DDoS is suspected.

### Restart a single pod

```bash
kubectl -n zenith delete pod <pod-name>
```

## Escalation

If the outage is not resolved in 15 min, escalate to:

- Platform lead
- VP Engineering
- Customer Success lead (for status page + customer comms)

See `02_incident_response.md` for full escalation policy.
