# 03 — MongoDB Failover

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../index.md).

> **Owner:** Database SRE
> **Trigger:** MongoDB primary unreachable, `mongo` health check failing, or replication lag > 30 s sustained.

## Pre-flight

- Replica set: 3 nodes (1 primary + 2 secondaries) across 3 AZs.
- Automatic failover enabled (`replSetFailoverTimeoutMillis` = 10 s).
- Driver: official MongoDB driver with `retryWrites=true` and `retryReads=true`.

## Detection

Symptoms in alerts / dashboards:

- `mongodb_up{node="primary"} == 0` for > 30 s
- `mongodb_replset_member_health != 1`
- Application logs: `MongoServerSelectionError`, `No primary found`

## Automatic failover (replica set)

The replica set elects a new primary within 10–30 s. The application
driver retries automatically. **No human action is required for
single-primary loss** if the secondaries are healthy.

## Manual failover (when automation fails)

```bash
# 1. SSH to one of the healthy secondaries
ssh mongo-2.zenith.internal

# 2. Confirm current state
mongo --eval 'rs.status()'

# 3. Force a new primary
mongo --eval 'rs.stepDown(60, 30)'   # on the current primary, if reachable

# 4. If primary is unreachable, freeze it and elect a new one
mongo --host mongo-2 --eval '
  cfg = rs.conf();
  cfg.members.forEach(m => { if (m.host == "mongo-1:27017") m.priority = 0 });
  rs.reconfig(cfg, { force: true });
'

# 5. Confirm
mongo --eval 'rs.status()' | jq '.members[] | {name, stateStr}'
```

## Post-failover

- [ ] `mongodb_up{node="primary"} == 1`.
- [ ] Application error rate back to baseline within 5 min.
- [ ] Replication lag (`mongodb_replset_member_replication_lag`) < 5 s.
- [ ] New primary logs: `election succeeded`.
- [ ] Open a post-mortem if the failover took > 1 min.

## Common pitfalls

- **Split-brain:** never reconfigure a replica set with two members thinking they are primary. Always use `rs.stepDown` first.
- **DNS caching:** drivers may cache the old primary's hostname. Use `mongo+srv://` for SRV-based discovery.
- **Write concern:** ensure all writes use `w:"majority"` for durability.
- **Backups:** backups may pause during failover (WiredTiger flush). Resume is automatic.
