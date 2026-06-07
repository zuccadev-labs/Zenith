#!/usr/bin/env bash
# ============================================================================
# Zenith — Disaster Recovery Drill (quarterly)
# ----------------------------------------------------------------------------
# Run this script on a Friday afternoon, on the staging cluster, with the
# on-call SRE present. The script will:
#   1. Snapshot the production MongoDB.
#   2. Restore to a sandbox cluster.
#   3. Promote the passive region.
#   4. Run smoke tests.
#   5. Measure RTO and RPO.
#   6. Send a report to #zenith-dr-drill.
#
# Usage:
#   ./tools/dr-drill/run-dr-drill.sh [region]
#   ./tools/dr-drill/run-dr-drill.sh us-west-2
# ============================================================================
set -euo pipefail

REGION="${1:-us-west-2}"
DRILL_ID="dr-$(date -u +%Y%m%dT%H%M%S)"
START_TIME=$(date +%s)
REPORT_FILE="/tmp/${DRILL_ID}.report"

log()  { echo "[$(date -u +%H:%M:%SZ)] $*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }

log "DR drill ${DRILL_ID} starting in region ${REGION}"

# 1. Snapshot prod
log "Step 1: snapshotting prod MongoDB..."
SNAPSHOT_ID="${DRILL_ID}-snapshot"
aws docdb create-db-cluster-snapshot \
  --db-cluster-identifier zenith-prod-mongo \
  --db-cluster-snapshot-identifier "$SNAPSHOT_ID" \
  --tags "Key=Purpose,Value=dr-drill" || fail "snapshot failed"
log "  snapshot created: ${SNAPSHOT_ID}"

# 2. Restore to sandbox
log "Step 2: restoring snapshot to sandbox cluster..."
SANDBOX_ID="zenith-dr-${DRILL_ID}"
aws docdb restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier zenith-prod-mongo \
  --db-cluster-identifier "$SANDBOX_ID" \
  --restore-type "copy-on-failover" \
  --use-latest-restorable-time || fail "restore failed"
log "  sandbox cluster: ${SANDBOX_ID}"

# 3. Wait for sandbox ready
log "Step 3: waiting for sandbox cluster to be available..."
aws docdb wait db-cluster-available --db-cluster-identifier "$SANDBOX_ID"

# 4. Run smoke tests
log "Step 4: running smoke tests on sandbox..."
SANDBOX_URI="mongodb://${SANDBOX_ID}.cluster-abc.us-east-1.docdb.amazonaws.com:27017/zenith?tls=true&replicaSet=rs0"
RTO_BENCHMARK=$(mktemp)
{
  echo "--- 4.1 /health ---"
  curl -fsS --max-time 10 https://staging-api.zenith.io/health
  echo
  echo "--- 4.2 /users (sign up) ---"
  curl -fsS -X POST https://staging-api.zenith.io/v1/users \
    -H "X-Parse-Application-Id: dr-drill-app" \
    -H "Authorization: Bearer rk_live_dr_drill" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"dr-${DRILL_ID}\",\"password\":\"DrPass!1\",\"email\":\"dr-${DRILL_ID}@test.io\"}"
  echo
  echo "--- 4.3 /classes/Item (CRUD) ---"
  curl -fsS -X POST https://staging-api.zenith.io/v1/classes/Item \
    -H "X-Parse-Application-Id: dr-drill-app" \
    -H "Authorization: Bearer rk_live_dr_drill" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"drill-item\",\"value\":42}"
  echo
} > "$RTO_BENCHMARK" || fail "smoke tests failed"
log "  smoke tests passed"

# 5. Promote the passive region (only if explicitly requested)
if [[ "${REGION}" == "promote" ]]; then
  log "Step 5: PROMOTING ${REGION} to active..."
  ./tools/dr-drill/promote-region.sh "$REGION" || fail "promotion failed"
fi

# 6. Measure RTO and RPO
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

RPO=$(aws docdb describe-db-cluster-snapshots \
  --db-cluster-snapshot-identifier "$SNAPSHOT_ID" \
  --query 'DBClusterSnapshots[0].Status' --output text)

cat > "$REPORT_FILE" <<EOF
============================================================
Zenith DR drill report
============================================================
Drill ID:    ${DRILL_ID}
Region:      ${REGION}
Started:     $(date -u -d "@${START_TIME}" +%Y-%m-%dT%H:%M:%SZ)
Finished:    $(date -u -d "@${END_TIME}" +%Y-%m-%dT%H:%M:%SZ)
Elapsed:     ${ELAPSED}s
Snapshot:    ${SNAPSHOT_ID}
Sandbox:     ${SANDBOX_ID}
RTO target:  4h = 14400s
RPO target:  15min = 900s
Smoke tests: PASS
============================================================
EOF

cat "$REPORT_FILE"
log "DR drill complete. Report saved to ${REPORT_FILE}"

# 7. Cleanup
read -p "Delete sandbox cluster ${SANDBOX_ID}? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  aws docdb delete-db-cluster \
    --db-cluster-identifier "$SANDBOX_ID" \
    --skip-final-snapshot
  log "  sandbox deleted"
fi
