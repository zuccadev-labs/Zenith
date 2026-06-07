# SRE Cheat Sheet — Zenith

> **Print and pin to your wall.** Updated quarterly.

## Endpoints

| Service          | URL                                    | Auth                |
| ---------------- | -------------------------------------- | ------------------- |
| Production API   | `https://api.zenith.io`                | API key + App ID    |
| Staging API      | `https://staging-api.zenith.io`        | same                |
| Admin dashboard  | `https://admin.zenith.io`              | OIDC                |
| Status page      | `https://status.zenith.io`             | public              |
| Grafana          | `https://grafana.zenith.io`            | OIDC                |
| Prometheus       | `https://prometheus.zenith.internal`   | mTLS                |
| Vault            | `https://vault.zenith.internal:8200`   | AppRole             |
| PagerDuty        | `https://zenith.pagerduty.com`         | SSO                 |
| Slack            | `#zenith-incidents`                    | Zenith bot          |

## Common kubectl one-liners

```bash
# Get all zenith pods and their status
kubectl -n zenith get pods -l app.kubernetes.io/name=zenith

# Tail logs from the oldest pod
kubectl -n zenith logs -l app.kubernetes.io/name=zenith --tail=100 -f

# Exec into a pod
kubectl -n zenith exec -it deploy/zenith -- /bin/sh

# Port-forward to local debugging
kubectl -n zenith port-forward svc/zenith 8080:8080

# Top by memory
kubectl -n zenith top pods -l app.kubernetes.io/name=zenith --sort-by=memory

# Force a restart (all pods)
kubectl -n zenith rollout restart deployment/zenith

# Roll back to previous version
kubectl -n zenith rollout undo deployment/zenith

# Check the current rollout status
kubectl -n zenith rollout status deployment/zenith

# Cordon a node (drain before maintenance)
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

## MongoDB quick checks

```bash
# Connect via Vault-issued dynamic creds
VAULT_TOKEN=$(vault login -method=oidc -token-only)
MONGO_PASS=$(vault read -field=password database/creds/zenith-app)
mongosh "mongodb://zenith:${MONGO_PASS}@mongodb.zenith-prod.svc.cluster.local:27017/zenith?tls=true"

# Replica set status
mongosh --eval 'rs.status()' | jq '.members[] | {name, stateStr, health}'

# Current connections
mongosh --eval 'db.serverStatus().connections'

# Slow queries (> 100ms)
mongosh --eval 'db.system.profile.find({millis: {$gt: 100}}).sort({ts: -1}).limit(10)'

# Index usage
mongosh --eval 'db.aggregate_info.aggregate([{$indexStats: {}}])'
```

## Vault quick checks

```bash
# Status
vault status

# Health
vault operator diagnose

# List secret paths
vault kv list secret/tenants/

# Rotate the JWT signing key (planned maintenance)
vault write -f transit/keys/zenith-jwt/rotate

# Unseal (emergency)
vault operator unseal <unseal-key-1>
vault operator unseal <unseal-key-2>
vault operator unseal <unseal-key-3>
```

## Prometheus / Grafana quick checks

```promql
# Current availability SLO
1 - (sum(rate(http_requests_total{job="zenith",code=~"5.."}[30d])) / sum(rate(http_requests_total{job="zenith"}[30d])))

# Current p95
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="zenith"}[5m])) by (le))

# Top 10 slowest routes
topk(10,
  histogram_quantile(0.95,
    sum(rate(http_request_duration_seconds_bucket{job="zenith"}[1h])) by (le, route)
  )
)

# Top 10 routes by error rate
topk(10,
  sum(rate(http_requests_total{job="zenith",code=~"5.."}[5m])) by (route)
  / sum(rate(http_requests_total{job="zenith"}[5m])) by (route)
)
```

## Incident response

| Step                | Command / URL                                     |
| ------------------- | ------------------------------------------------- |
| Acknowledge page    | PagerDuty mobile app                              |
| Open war room       | Slack: `#zenith-incidents`                        |
| Declare severity    | `!severity SEV-1 <summary>` in channel            |
| Page IC             | `@oncall-ic` in channel                           |
| Status page update  | `https://status.zenith.io/admin`                  |
| Logs                | `kubectl -n zenith logs -l app=zenith -f`         |
| Metrics             | `https://grafana.zenith.io/d/zenith-sre`          |
| Traces              | `https://grafana.zenith.io/explore?datasource=...`|
| Roll back           | `kubectl -n zenith rollout undo deployment/zenith`|
| Page DBA            | `@dba-oncall` in channel                          |
| Page Security       | `@security-oncall` in channel                     |
| Page VP Eng         | `@vp-eng` in channel                              |
| Post-mortem doc     | `https://zenith.atlassian.net/wiki/postmortem`    |

## Useful links

- Runbooks: <https://docs.zenith.io/runbooks/>
- Architecture: <https://docs.zenith.io/architecture/01_c4_model.md>
- ADR log: <https://docs.zenith.io/architecture-decisions/>
- On-call schedule: <https://zenith.pagerduty.com/schedules>
- Escalation: <https://zenith.pagerduty.com/escalation_policies>
- Slack channel: <https://zenith.slack.com/archives/zenith-incidents>
