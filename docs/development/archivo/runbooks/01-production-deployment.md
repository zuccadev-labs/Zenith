# 01 — Production Deployment

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../../../users/README.md).

> **Owner:** Platform Engineering
> **Cadence:** every Tuesday 14:00 UTC (after standup)
> **Risk level:** low for canary; medium for full rollout
> **Rollback time:** < 5 min

## Pre-flight checklist

- [ ] All CI checks green on `main` branch (lint, type-check, unit + integration + load tests).
- [ ] `CHANGELOG.md` updated with the release version.
- [ ] No open SEV-1 / SEV-2 incidents in the last 24 h.
- [ ] On-call SRE present and paged.
- [ ] Change-management ticket approved (`CHG-XXXX`).
- [ ] Customer-facing release notes drafted (Statuspage scheduled).

## Procedure

### 1. Tag the release

```bash
git tag -s v0.X.Y -m "Release v0.X.Y"
git push origin v0.X.Y
```

### 2. Build and push the container

```bash
docker build -t ghcr.io/zuccadev-labs/zenith-backend:v0.X.Y ./zenith-backend
docker push ghcr.io/zuccadev-labs/zenith-backend:v0.X.Y
```

### 3. Canary (10 % of pods, 10 min)

```bash
kubectl -n zenith set image deployment/zenith-backend \
  zenith=ghcr.io/zuccadev-labs/zenith-backend:v0.X.Y
kubectl -n zenith rollout pause deployment/zenith-backend
kubectl -n zenith get pods -l app=zenith-backend -o name | \
  xargs -I{} sh -c 'echo {}; kubectl -n zenith label {} zenith.rollout=canary --overwrite'
```

Watch canary metrics for 10 min:

- p95 latency < SLO
- Error rate < 0.5 %
- No crash-loops in logs

### 4. Full rollout

```bash
kubectl -n zenith rollout resume deployment/zenith-backend
kubectl -n zenith rollout status deployment/zenith-backend --timeout=10m
```

### 5. Verify

```bash
# Smoke tests
k6 run -e ZENITH_URL=https://api.zenith.io \
       tests/load/scenarios/smoke.js

# Health check
curl -fsS https://api.zenith.io/health | jq .
```

### 6. Post-deploy

- [ ] Update Statuspage (`All systems operational`).
- [ ] Post in `#releases` Slack channel.
- [ ] Close the CHG ticket.
- [ ] Watch SLO dashboard for 1 h.

## Rollback

```bash
kubectl -n zenith rollout undo deployment/zenith-backend
kubectl -n zenith rollout status deployment/zenith-backend --timeout=5m
```

Rollback is automatic and triggers a SEV-2 incident.
