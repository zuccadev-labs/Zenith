#!/bin/bash
# ──────────────────────────────────────────────────────────────────────
#  Zenith Lab — setup.sh
#  Provisioner de Packer: se ejecuta DENTRO de la VM recién clonada.
#  Instala Docker, Docker Compose plugin, Ansible, gettext (envsubst).
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "=== [setup.sh] Waiting for cloud-init to finish ==="
cloud-init status --wait 2>/dev/null || true

echo "=== [setup.sh] System update ==="
apt-get update -y
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  gettext-base \
  ansible \
  qemu-guest-agent \
  net-tools \
  dnsutils \
  redis-tools \
  dos2unix \
  netcat-openbsd

# ── Docker Engine (repo oficial) ──────────────────────────────────────
echo "=== [setup.sh] Installing Docker ==="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  | gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

# ── Habilitar Docker al arranque ──────────────────────────────────────
systemctl enable docker
systemctl start docker

# ── Añadir usuario SSH al grupo docker ───────────────────────────────
# El usuario por defecto del cloud-init template es 'debian'
usermod -aG docker debian 2>/dev/null || true
# El usuario zenith se configura via cloud-init en Pulumi (si existe)
usermod -aG docker zenith 2>/dev/null || true

# ── Crear estructura de directorios del laboratorio ───────────────────
echo "=== [setup.sh] Creating /opt/zenith-lab structure ==="
mkdir -p /opt/zenith-lab/{configs,repos,ansible}
mkdir -p /opt/zenith-lab/repos/{luxdb,postal-config}
chown -R debian:debian /opt/zenith-lab 2>/dev/null || \
  chown -R root:root /opt/zenith-lab

# ── Habilitar y arrancar QEMU Guest Agent ─────────────────────────────
systemctl enable qemu-guest-agent
systemctl start qemu-guest-agent || true

echo "=== [setup.sh] Done — Docker $(docker --version) installed ==="
