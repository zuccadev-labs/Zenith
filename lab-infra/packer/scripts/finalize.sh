#!/bin/bash
# ──────────────────────────────────────────────────────────────────────
#  Zenith Lab — finalize.sh
#  Provisioner de Packer: configura servicios systemd y prepara archivos
#  críticos como postal.yml (con envsubst) y limpia el .env de CRLF/BOM.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "=== [finalize.sh] Configuring Zenith Lab ==="

cd /opt/zenith-lab

# ── 1. Limpiar .env de CRLF (Windows) y BOM UTF-8 ────────────────────
echo "--- [1/5] Cleaning .env (CRLF + BOM)..."
dos2unix /opt/zenith-lab/.env 2>/dev/null || sed -i 's/\r//' /opt/zenith-lab/.env
# Eliminar BOM si existe
sed -i '1s/^\xef\xbb\xbf//' /opt/zenith-lab/.env
# Verificar
source /opt/zenith-lab/.env
echo "      PG_USER='${PG_USER}' ZITADEL_MASTERKEY_len=${#ZITADEL_MASTERKEY}"
echo "      ZENITH_VM_IP='${ZENITH_VM_IP}'"

# ── 2. Generar postal.yml desde template con variables reales ─────────
echo "--- [2/5] Generating postal.yml from template (envsubst)..."
# Asegurarnos que NO es un directorio (Docker crea directorios vacíos si no existe)
if [ -d /opt/zenith-lab/postal.yml ]; then
  rmdir /opt/zenith-lab/postal.yml
fi
envsubst < /opt/zenith-lab/repos/postal-config/postal.yml > /opt/zenith-lab/postal.yml
echo "      postal.yml generated OK:"
grep -E 'host:|password:|username:' /opt/zenith-lab/postal.yml | head -8

# ── 3. Escribir zenith-lab.service ───────────────────────────────────
echo "--- [3/5] Writing zenith-lab.service..."
tee /etc/systemd/system/zenith-lab.service > /dev/null << 'SVCEOF'
[Unit]
Description=Zenith Lab Infrastructure
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/zenith-lab
ExecStart=/usr/bin/docker compose --env-file .env up -d
ExecStop=/usr/bin/docker compose down
Restart=no

[Install]
WantedBy=multi-user.target
SVCEOF

# ── 4. Escribir zenith-lab-init.service ──────────────────────────────
echo "--- [4/5] Writing zenith-lab-init.service..."
tee /etc/systemd/system/zenith-lab-init.service > /dev/null << 'INITEOF'
[Unit]
Description=Zenith Lab First Boot Init (Ansible)
Requires=zenith-lab.service
After=zenith-lab.service
ConditionPathExists=!/opt/zenith-lab/.ansible-init-done

[Service]
Type=simple
WorkingDirectory=/opt/zenith-lab
# Limpiar CRLF/BOM del .env en runtime (por si acaso)
ExecStartPre=/bin/bash -c 'dos2unix /opt/zenith-lab/.env 2>/dev/null; sed -i "1s/^\xef\xbb\xbf//" /opt/zenith-lab/.env'
ExecStart=/bin/bash -c '\
  set -a; source /opt/zenith-lab/.env; set +a; \
  \
  echo "=== Waiting for MariaDB..."; \
  until docker exec zenith-postal-mariadb mysqladmin ping -h localhost -u postal -p"${POSTAL_DB_PASSWORD}" > /dev/null 2>&1; do \
    echo "Waiting for MariaDB..."; sleep 5; \
  done; \
  \
  echo "=== Regenerating postal.yml with live env vars..."; \
  [ -d /opt/zenith-lab/postal.yml ] && rmdir /opt/zenith-lab/postal.yml || true; \
  envsubst < /opt/zenith-lab/repos/postal-config/postal.yml > /opt/zenith-lab/postal.yml; \
  \
  echo "=== Running Ansible init playbook..."; \
  /usr/bin/ansible-playbook /opt/zenith-lab/ansible/postal-init.yml \
  && touch /opt/zenith-lab/.ansible-init-done \
  && echo "=== Init completed successfully ==="'

[Install]
WantedBy=multi-user.target
INITEOF

# ── 5. Habilitar servicios ────────────────────────────────────────────
echo "--- [5/5] Enabling services..."
systemctl daemon-reload
systemctl enable zenith-lab.service
systemctl enable zenith-lab-init.service

echo "=== Template provisioning complete. Services will autostart on first VM boot. ==="
