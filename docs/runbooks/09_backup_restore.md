# 09 — Backup & Restore

> ⚠️ **Estado (2026-11-10): diseño aspiracional.** Describe un servicio alojado (dominios `zenith.io`, regiones, planes, certificaciones, equipos de guardia) que no existe. No es una guía de uso; lo vigente está en [docs/index.md](../index.md).

> **Owner:** Database SRE
> **Tooling:** `mongodump`/`mongorestore`, AWS S3, AWS Backup, HashiCorp Vault Raft snapshots.

## Backup windows

| Backup type       | Window (UTC)     | Duration  | Storage class   |
| ----------------- | ---------------- | --------- | --------------- |
| MongoDB full      | daily 02:00      | ~30 min   | S3 Standard     |
| MongoDB incr      | every 15 min     | < 1 min   | S3 Standard     |
| MongoDB oplog PITR| continuous       | real-time | S3 Standard     |
| Vault Raft snap   | hourly           | < 10 s    | S3 + Glacier    |
| S3 buckets        | CRR real-time    | real-time | S3 CRR          |
| API keys metadata | on change        | < 1 s     | Vault + S3      |

All backups are encrypted with `AES-256-GCM` using a customer-managed KMS key.

## Restore procedures

### Restore MongoDB to a point in time

```bash
# 1. Identify the target timestamp (UTC)
TARGET="2026-06-06T14:30:00Z"

# 2. Stop the application (or enable maintenance mode)
kubectl -n zenith scale deployment/zenith-backend --replicas=0

# 3. Restore full backup closest to the target
LATEST=$(aws s3api list-objects-v2 \
  --bucket zenith-mongo-backups \
  --prefix daily/ \
  --query 'Contents[?LastModified<=`'"$TARGET"'`] | sort_by(@, &LastModified) | [-1].Key' \
  --output text)
aws s3 cp "s3://zenith-mongo-backups/$LATEST" /tmp/full.dump
mongorestore --drop --gzip /tmp/full.dump

# 4. Apply oplog up to the target timestamp
LATEST_OPLOG=$(aws s3api list-objects-v2 \
  --bucket zenith-mongo-backups \
  --prefix oplog/ \
  --query 'Contents[?LastModified<=`'"$TARGET"'`] | sort_by(@, &LastModified) | [-1].Key' \
  --output text)
aws s3 cp "s3://zenith-mongo-backups/$LATEST_OPLOG" /tmp/oplog.bson
mongorestore --oplogReplay --oplogLimit="$TARGET" /tmp/oplog.bson

# 5. Validate
mongo --eval 'db.adminCommand({dbHash: 1})'

# 6. Restart the application
kubectl -n zenith scale deployment/zenith-backend --replicas=6
```

### Promote a passive region (multi-region)

```bash
# 1. Verify replica set health in passive region
ssh mongo-2.us-west-2.zenith.internal 'mongo --eval "rs.status()"'

# 2. Demote the old primary
ssh mongo-1.us-east-1.zenith.internal \
  'mongo --eval "rs.stepDown(120)"'

# 3. Reconfigure the application to point to the new region
kubectl -n zenith set env deployment/zenith-backend \
  ZENITH_MONGO_URI="mongodb://mongo.us-west-2.zenith.internal:27017/zenith?replicaSet=zenith-rs&w=majority"

# 4. Roll the backend
kubectl -n zenith rollout restart deployment/zenith-backend

# 5. Verify
curl -fsS https://api.zenith.io/health
```

### Restore Vault from a Raft snapshot

```bash
# 1. Stop Vault
kubectl -n zenith scale statefulset/vault --replicas=0

# 2. Restore the snapshot
kubectl -n zenith exec -it vault-0 -- \
  vault operator raft snapshot restore /backups/vault-2026-06-06T140000.snap

# 3. Restart Vault
kubectl -n zenith scale statefulset/vault --replicas=3
```

## Post-restore validation

- [ ] `dbHash` matches a known-good hash (compare with the dashboard).
- [ ] All shards / collections present (`db.getCollectionInfos()`).
- [ ] Application smoke tests pass.
- [ ] API key signing works (vault unwrap test).
- [ ] Push, file upload, cloud functions all return 200.
- [ ] Open a post-incident if data was lost beyond RPO.

## Backup integrity

Daily cron runs `mongorestore --dryRun` against a sandbox cluster and
asserts the doc count of the top-20 collections matches the production
counts. Failure pages the on-call SRE.
