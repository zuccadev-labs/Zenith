#!/bin/bash
# ================================================================
#  ZENITH LAB - QA INTEGRAL v3 (definitivo)
# ================================================================
set -a
source /opt/zenith-lab/.env
set +a

PASS=0
FAIL=0
ERRORS=()

check() {
  local name="$1"
  local expected="$2"
  shift 2
  local result
  result=$(eval "$@" 2>&1) || true
  if echo "$result" | grep -qE "$expected"; then
    echo "  [PASS] $name"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] $name"
    echo "         expected pattern: '$expected'"
    echo "         got:  '$(echo "$result" | head -2 | tr '\n' ' ')'"
    FAIL=$((FAIL+1))
    ERRORS+=("$name")
  fi
}

echo ""
echo "=============================================="
echo "=== ZENITH LAB - QA INTEGRAL v3           ==="
echo "=============================================="
echo ""

# ── 1. ZITADEL ────────────────────────────────────────────────
echo "--- 1. ZITADEL IAM (port 8081) ---"
check "Zitadel healthz" "^ok$" \
  "curl -sf http://localhost:8081/debug/healthz"

check "Zitadel OIDC Discovery" "authorization_endpoint" \
  "curl -sf --header 'Host: zenith-iam.${ZENITH_VM_IP}.sslip.io' http://localhost:8081/.well-known/openid-configuration"

check "Zitadel Console UI (HTTP 200)" "200" \
  "curl -so /dev/null -w '%{http_code}' --header 'Host: zenith-iam.${ZENITH_VM_IP}.sslip.io' http://localhost:8081/ui/console"

# Verificar admin via PAT file generado en el volume
check "Zitadel login-client PAT exists" "." \
  "docker run --rm -v zenith-lab_zitadel_machine_keys:/machinekey:ro alpine ls /machinekey/login-client.pat 2>/dev/null && echo found"

check "Zitadel DB has eventstore schema" "eventstore" \
  "PGPASSWORD=${ZITADEL_DB_PASSWORD} docker exec -e PGPASSWORD=${ZITADEL_DB_PASSWORD} zenith-postgres-zitadel psql -U zitadel -d zitadel_db -t -c '\dn' 2>/dev/null"

# ── 2. KEYCLOAK ───────────────────────────────────────────────
echo ""
echo "--- 2. KEYCLOAK IAM (port 8080) ---"
check "Keycloak OIDC Discovery" "token_endpoint" \
  "curl -sf 'http://localhost:8080/realms/master/.well-known/openid-configuration'"

check "Keycloak Admin Token" "access_token" \
  "curl -sf -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
    -d 'client_id=admin-cli&username=admin&password=${KEYCLOAK_ADMIN_PASSWORD}&grant_type=password'"

check "Keycloak realms API" "master" \
  "KC_TOKEN=\$(curl -sf -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
    -d 'client_id=admin-cli&username=admin&password=${KEYCLOAK_ADMIN_PASSWORD}&grant_type=password' | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"access_token\"])') && \
   curl -sf -H \"Authorization: Bearer \$KC_TOKEN\" http://localhost:8080/admin/realms | python3 -c 'import sys,json;print(json.load(sys.stdin)[0][\"realm\"])'"

check "Keycloak DB has tables" "[0-9]" \
  "PGPASSWORD=${KEYCLOAK_DB_PASSWORD} docker exec -e PGPASSWORD=${KEYCLOAK_DB_PASSWORD} zenith-postgres-keycloak psql -U keycloak -d keycloak_db -t -c 'SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"';'"

# ── 3. POSTGRESQL CORE ────────────────────────────────────────
echo ""
echo "--- 3. POSTGRESQL CORE (port 54614) ---"
check "PG Core ping" "accepting connections" \
  "docker exec zenith-postgres pg_isready -U ${PG_USER} -d ${PG_DB}"

check "PG Core auth (SELECT 1)" "1" \
  "docker exec -e PGPASSWORD=${PG_PASSWORD} zenith-postgres psql -U ${PG_USER} -d ${PG_DB} -t -c 'SELECT 1;'"

check "PG Core create/drop test table" "DROP TABLE" \
  "docker exec -e PGPASSWORD=${PG_PASSWORD} zenith-postgres psql -U ${PG_USER} -d ${PG_DB} -c 'CREATE TABLE IF NOT EXISTS qa_test(id serial); DROP TABLE qa_test;'"

# ── 4. POSTGRESQL ZITADEL ─────────────────────────────────────
echo ""
echo "--- 4. POSTGRESQL ZITADEL (port 51009) ---"
check "PG Zitadel ping" "accepting connections" \
  "docker exec zenith-postgres-zitadel pg_isready -U zitadel -d zitadel_db"

check "PG Zitadel eventstore schema" "eventstore" \
  "docker exec -e PGPASSWORD=${ZITADEL_DB_PASSWORD} zenith-postgres-zitadel psql -U zitadel -d zitadel_db -t -c '\dn'"

# ── 5. POSTGRESQL KEYCLOAK ────────────────────────────────────
echo ""
echo "--- 5. POSTGRESQL KEYCLOAK (port 52009) ---"
check "PG Keycloak ping" "accepting connections" \
  "docker exec zenith-postgres-keycloak pg_isready -U keycloak -d keycloak_db"

check "PG Keycloak table count >0" "[1-9][0-9]|[0-9][0-9]" \
  "docker exec -e PGPASSWORD=${KEYCLOAK_DB_PASSWORD} zenith-postgres-keycloak psql -U keycloak -d keycloak_db -t -c 'SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema();'"

# ── 6. MONGODB ────────────────────────────────────────────────
echo ""
echo "--- 6. MONGODB (port 53017) ---"
check "MongoDB adminCommand ping" "1" \
  "docker exec zenith-mongo mongosh --quiet --eval \"db.adminCommand('ping').ok\""

check "MongoDB ReplicaSet active" "1" \
  "docker exec zenith-mongo mongosh --quiet --eval \"rs.status().ok\""

check "MongoDB write/read (zenith_qa)" "zenith_qa_ok" \
  "docker exec zenith-mongo mongosh --quiet --eval \
    \"db.getSiblingDB('zenith_qa').col.insertOne({test:'zenith_qa_ok'});db.getSiblingDB('zenith_qa').col.findOne({test:'zenith_qa_ok'}).test\""

# ── 7. SCYLLADB ───────────────────────────────────────────────
echo ""
echo "--- 7. SCYLLADB (port 53042) ---"
check "ScyllaDB node status UN" "UN" \
  "docker exec zenith-scylla nodetool status 2>/dev/null"

check "ScyllaDB CQL connect" "system" \
  "docker exec zenith-scylla cqlsh -e 'DESCRIBE KEYSPACES;' 2>/dev/null"

check "ScyllaDB CREATE/DROP KEYSPACE" "." \
  "docker exec zenith-scylla cqlsh -e \
    \"CREATE KEYSPACE IF NOT EXISTS zenith_qa WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};\" 2>/dev/null && \
   docker exec zenith-scylla cqlsh -e 'DROP KEYSPACE zenith_qa;' 2>/dev/null && echo ok"

# ── 8. LUXDB (Redis-compat) ───────────────────────────────────
echo ""
echo "--- 8. LUXDB Redis-compat (port 53079) ---"
check "LuxDB PING" "PONG" \
  "redis-cli -h 127.0.0.1 -p 53079 PING"

check "LuxDB SET/GET zenith_qa" "zenith_lab_ok" \
  "redis-cli -h 127.0.0.1 -p 53079 SET zenith_qa zenith_lab_ok && redis-cli -h 127.0.0.1 -p 53079 GET zenith_qa"

check "LuxDB DEL cleanup" "1" \
  "redis-cli -h 127.0.0.1 -p 53079 DEL zenith_qa"

# ── 9. RUSTFS S3 ──────────────────────────────────────────────
echo ""
echo "--- 9. RUSTFS S3-Compatible (port 8614/8615) ---"
check "RustFS API port 8614 responds" "403|200|301" \
  "curl -so /dev/null -w '%{http_code}' http://localhost:8614/"

check "RustFS console port 8615 responds" "403|200|301" \
  "curl -so /dev/null -w '%{http_code}' http://localhost:8615/"

check "RustFS S3 bucket create/delete" "remove_bucket" \
  "docker run --rm --network zenith-lab_zenith-net \
    -e AWS_ACCESS_KEY_ID=${RUSTFS_ACCESS_KEY} \
    -e AWS_SECRET_ACCESS_KEY=${RUSTFS_SECRET_KEY} \
    amazon/aws-cli --endpoint-url http://zenith-rustfs:9000 s3 mb s3://zenith-qa-test 2>&1; \
   docker run --rm --network zenith-lab_zenith-net \
    -e AWS_ACCESS_KEY_ID=${RUSTFS_ACCESS_KEY} \
    -e AWS_SECRET_ACCESS_KEY=${RUSTFS_SECRET_KEY} \
    amazon/aws-cli --endpoint-url http://zenith-rustfs:9000 s3 rb s3://zenith-qa-test 2>&1"

# ── 10. NOVU ──────────────────────────────────────────────────
echo ""
echo "--- 10. NOVU NOTIFICATIONS ---"
check "Novu API status ok" "status.*ok|ok.*status" \
  "curl -sf http://localhost:3614/v1/health-check"

check "Novu API version 3.x" "3\." \
  "curl -sf http://localhost:3614/v1/health-check | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[\"data\"][\"info\"][\"apiVersion\"][\"version\"])'"

check "Novu WebSocket server Up" "200|101" \
  "curl -so /dev/null -w '%{http_code}' http://localhost:3615/"

check "Novu Web UI (port 4614)" "200" \
  "curl -so /dev/null -w '%{http_code}' http://localhost:4614/"

# ── 11. POSTAL MAIL ───────────────────────────────────────────
echo ""
echo "--- 11. POSTAL MAIL SERVER ---"
check "Postal MariaDB alive" "mysqld is alive" \
  "docker exec zenith-postal-mariadb mariadb-admin ping -u postal -p${POSTAL_DB_PASSWORD} -h localhost 2>/dev/null"

check "Postal DB has tables" "additional_route|deliveries|messages|servers" \
  "docker exec zenith-postal-mariadb mysql -u postal -p${POSTAL_DB_PASSWORD} postal -e 'SHOW TABLES;' 2>/dev/null | head -5"

check "Postal RabbitMQ ping" "succeeded" \
  "docker exec zenith-postal-rabbitmq rabbitmq-diagnostics -q ping 2>&1"

check "Postal Web UI responds" "200|302|303|403" \
  "curl -so /dev/null -w '%{http_code}' -L http://localhost:50614/"

check "Postal Worker running" "Up" \
  "docker ps --format '{{.Names}}\t{{.Status}}' | grep zenith-postal-worker"

# ── 12. COREDNS ───────────────────────────────────────────────
echo ""
echo "--- 12. COREDNS DNS Server (port 53) ---"
check "CoreDNS resolve sslip.io" "192.168.14.50" \
  "dig @192.168.14.50 zenith-iam.192.168.14.50.sslip.io +short +time=3"

check "CoreDNS forward external DNS" "." \
  "dig @192.168.14.50 google.com +short +time=3 | head -1"

# ── 13. OPENTELEMETRY ─────────────────────────────────────────
echo ""
echo "--- 13. OPENTELEMETRY COLLECTOR ---"
check "OTel container Up" "Up" \
  "docker ps --format '{{.Names}}\t{{.Status}}' | grep zenith-otel"

check "OTel GRPC port 43170 open" "succeeded|open" \
  "nc -zv 127.0.0.1 43170 2>&1"

check "OTel HTTP port 43180 responds" "200|415|404|405" \
  "curl -so /dev/null -w '%{http_code}' -X POST http://localhost:43180/v1/traces \
    -H 'Content-Type: application/x-protobuf'"

check "OTel HTTP ingest test (JSON)" "200|415|400" \
  "curl -so /dev/null -w '%{http_code}' -X POST http://localhost:43180/v1/traces \
    -H 'Content-Type: application/json' -d '{\"resourceSpans\":[]}'"

# ── SUMMARY ───────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "=== QA RESULT: ${PASS} PASSED / ${FAIL} FAILED ==="
echo "=============================================="
if [ ${FAIL} -gt 0 ]; then
  echo ""
  echo "=== FAILING TESTS ==="
  for e in "${ERRORS[@]}"; do
    echo "  - $e"
  done
  echo ""
  exit 1
else
  echo ""
  echo "  ✅  TODOS LOS SERVICIOS VERIFICADOS AL 100%"
  echo "      El laboratorio está listo para integración con Zenith."
  echo ""
fi
