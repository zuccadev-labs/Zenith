#!/usr/bin/env bash
# Deploys the Zenith image registry (Zot, open source, OCI 1.1 with referrers for cosign signatures and
# attestations) on a host that already runs Docker and Caddy, and wires the CI to it.
#
#   infra/registry/deploy.sh root@209.38.1.195 registry.example.com
#
# Additive and reversible (docs/architecture/registry.md, "Rollback"):
# - on the host: /etc/zot (config + htpasswd), /var/lib/zot (data), a container "zenith-zot" on 127.0.0.1 with a
#   memory cap, and one site block appended to the Caddyfile after a timestamped backup and `caddy validate`;
# - in GitHub (gh): the variable ZENITH_REGISTRY and the secrets ZENITH_REGISTRY_USER/PASSWORD for the CI.
# Passwords are generated here, sent only as bcrypt hashes, and the reader's is printed once at the end.
# The DNS record of the domain must exist (A record to the host) before Caddy can get its certificate.
set -euo pipefail

host="${1:?usage: deploy.sh <ssh user@host> <domain>}"
domain="${2:?usage: deploy.sh <ssh user@host> <domain>}"
port="${ZOT_PORT:-5050}"
zot_image="ghcr.io/project-zot/zot-linux-amd64:v2.1.23"
repo="${GITHUB_REPO:-zuccadev-labs/Zenith}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ci_pw="$(openssl rand -hex 32)"
reader_pw="$(openssl rand -hex 32)"
{
  docker run --rm httpd:2.4-alpine htpasswd -nbB ci "$ci_pw"
  docker run --rm httpd:2.4-alpine htpasswd -nbB reader "$reader_pw"
} | sed '/^$/d' > "$work/htpasswd"
cp "$here/zot-config.json" "$work/config.json"

echo "▶ host: files"
ssh "$host" 'install -d -m 0750 /etc/zot && install -d -m 0750 /var/lib/zot'
scp -q "$work/config.json" "$host:/etc/zot/config.json"
scp -q "$work/htpasswd" "$host:/etc/zot/htpasswd"
# Zot runs as an unprivileged uid with every capability dropped: it must own what it reads and writes.
ssh "$host" 'chmod 0640 /etc/zot/config.json /etc/zot/htpasswd && chown -R 65532:65532 /etc/zot /var/lib/zot'

echo "▶ host: container"
ssh "$host" "docker pull -q $zot_image >/dev/null && docker rm -f zenith-zot >/dev/null 2>&1 || true
  docker run -d --name zenith-zot --restart unless-stopped --user 65532:65532 --memory 384m --pids-limit 256 \
    --read-only --security-opt no-new-privileges --cap-drop ALL \
    -p 127.0.0.1:$port:5000 \
    -v /etc/zot/config.json:/etc/zot/config.json:ro -v /etc/zot/htpasswd:/etc/zot/htpasswd:ro \
    -v /var/lib/zot:/var/lib/zot \
    $zot_image serve /etc/zot/config.json >/dev/null
  for i in \$(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/v2/ | grep -q 401 && break; sleep 1; done
  curl -s -o /dev/null -w 'zot local /v2/: %{http_code}\n' http://127.0.0.1:$port/v2/"

echo "▶ host: Caddy"
ssh "$host" "set -e
  if grep -q '^$domain {' /etc/caddy/Caddyfile; then echo 'site block already present'; else
    cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-zenith-registry-\$(date +%Y%m%d-%H%M%S)
    printf '\n%s {\n\trequest_body {\n\t\tmax_size 2GB\n\t}\n\treverse_proxy 127.0.0.1:$port\n}\n' '$domain' >> /etc/caddy/Caddyfile
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl reload caddy"

echo "▶ GitHub: variable and secrets for the CI"
gh variable set ZENITH_REGISTRY -R "$repo" --body "$domain"
printf '%s' ci | gh secret set ZENITH_REGISTRY_USER -R "$repo"
printf '%s' "$ci_pw" | gh secret set ZENITH_REGISTRY_PASSWORD -R "$repo"

echo "▶ smoke test"
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$domain/v2/" || true)"
  [[ "$code" == 401 ]] && break
  sleep 2
done
echo "https://$domain/v2/ without credentials: $code (401 expected)"
printf '%s' "$reader_pw" | docker login "$domain" -u reader --password-stdin >/dev/null && echo "reader login: OK"
docker logout "$domain" >/dev/null
echo
echo "Reader (pull-only) password, shown once; keep it in your password manager:"
echo "  user: reader  password: $reader_pw"
