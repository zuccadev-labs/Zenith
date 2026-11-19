#!/usr/bin/env bash
# Installs infra/registry/zot-config.json on the registry host deployed by deploy.sh, without touching any user or
# password (add-user.sh is for users). Backs up the current config as config.json.bak-<date>, validates the new one
# locally (JSON) and restarts the container zenith-zot (a few seconds without registry).
#
#   infra/registry/apply-config.sh root@<servidor> registry.vemar.app
#
# Rollback: copy /etc/zot/config.json.bak-<date> back, `chown 65532:65532` it and `docker restart zenith-zot`.
set -euo pipefail

host="${1:?usage: apply-config.sh <ssh user@host> <domain>}"
domain="${2:?usage: apply-config.sh <ssh user@host> <domain>}"
here="$(cd "$(dirname "$0")" && pwd)"
python3 -m json.tool "$here/zot-config.json" >/dev/null

stamp="$(date +%Y%m%d-%H%M%S)"
echo "▶ host: backup and config"
ssh "$host" "cp -p /etc/zot/config.json /etc/zot/config.json.bak-$stamp"
scp -q "$here/zot-config.json" "$host:/etc/zot/config.json.new"
ssh "$host" "set -e; install -m 0640 -o 65532 -g 65532 /etc/zot/config.json.new /etc/zot/config.json; rm -f /etc/zot/config.json.new
  docker restart zenith-zot >/dev/null
  for i in \$(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5050/v2/ | grep -q 401 && break; sleep 1; done
  curl -s -o /dev/null -w 'zot local /v2/: %{http_code}\n' http://127.0.0.1:5050/v2/"

echo "▶ check from here"
code="$(curl -s -o /dev/null -w '%{http_code}' "https://$domain/v2/")"
echo "https://$domain/v2/ without credentials: $code (401 expected)"
[[ "$code" == 401 ]] || { echo "rollback: see the header of this script (backup config.json.bak-$stamp)" >&2; exit 1; }
