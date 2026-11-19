#!/usr/bin/env bash
# Adds (or rotates) one user of the registry deployed by deploy.sh, with the rights infra/registry/zot-config.json
# gives that name. Run it yourself: the password is generated here, kept in the GNOME keyring
# (zkeyring, service zenith-registry, item <user>-password) and reaches the server only as a bcrypt hash.
#
#   infra/registry/add-user.sh root@<servidor> registry.vemar.app engines
#
# On the host it backs up /etc/zot/{config.json,htpasswd} as *.bak-<date>, replaces that user's htpasswd line,
# installs the config of this repository and restarts the container zenith-zot (a few seconds without registry).
# Rollback: restore both backups, `chown 65532:65532` them and `docker restart zenith-zot`.
set -euo pipefail

host="${1:?usage: add-user.sh <ssh user@host> <domain> <user>}"
domain="${2:?usage: add-user.sh <ssh user@host> <domain> <user>}"
user="${3:?usage: add-user.sh <ssh user@host> <domain> <user>}"
[[ "$user" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "user: lowercase letters, digits and dashes" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
grep -q "\"$user\"" "$here/zot-config.json" || { echo "zot-config.json gives '$user' no rights" >&2; exit 2; }
keyring="${ZKEYRING:-$HOME/.local/bin/zkeyring}"

pw="$(openssl rand -hex 32)"
printf '%s' "$pw" | "$keyring" store zenith-registry "$user-password"
line="$(printf '%s\n' "$pw" | docker run -i --rm httpd:2.4-alpine htpasswd -niB "$user" | sed '/^$/d')"
[[ "$line" == "$user:\$2"* ]] || { echo "htpasswd gave no bcrypt line" >&2; exit 1; }

echo "▶ host: backup, htpasswd and config"
stamp="$(date +%Y%m%d-%H%M%S)"
ssh "$host" "set -e; cp -p /etc/zot/config.json /etc/zot/config.json.bak-$stamp; cp -p /etc/zot/htpasswd /etc/zot/htpasswd.bak-$stamp"
printf '%s\n' "$line" | ssh "$host" "set -e; t=\$(mktemp); grep -v '^$user:' /etc/zot/htpasswd > \"\$t\" || true; cat >> \"\$t\"
  install -m 0640 -o 65532 -g 65532 \"\$t\" /etc/zot/htpasswd; rm -f \"\$t\""
scp -q "$here/zot-config.json" "$host:/etc/zot/config.json.new"
ssh "$host" "set -e; install -m 0640 -o 65532 -g 65532 /etc/zot/config.json.new /etc/zot/config.json; rm -f /etc/zot/config.json.new
  docker restart zenith-zot >/dev/null
  for i in \$(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5050/v2/ | grep -q 401 && break; sleep 1; done
  curl -s -o /dev/null -w 'zot local /v2/: %{http_code}\n' http://127.0.0.1:5050/v2/"

echo "▶ check from here"
code="$(curl -s -o /dev/null -w '%{http_code}' -u "$user:$pw" "https://$domain/v2/")"
echo "https://$domain/v2/ as $user: $code (200 expected)"
[[ "$code" == 200 ]] || { echo "rollback: see the header of this script (backups *.bak-$stamp)" >&2; exit 1; }
echo "Password of '$user' in the keyring: zkeyring get zenith-registry $user-password"
