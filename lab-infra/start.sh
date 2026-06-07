#!/bin/bash
set -e

PVE_IP="192.168.14.44"
TEMPLATE_ID=901
VM_ID=902
VM_IP="192.168.14.50"
SSH_KEY_PATH="$HOME/.ssh/id_rsa.pub"

echo -e "\033[1;36m=========================================\033[0m"
echo -e "\033[1;36m🚀 Zenith Lab Automator (Proxmox CLI)\033[0m"
echo -e "\033[1;36m=========================================\033[0m"

if [ ! -f "$SSH_KEY_PATH" ]; then
    echo "Error: No se encontró llave pública SSH en $SSH_KEY_PATH"
    exit 1
fi
SSH_KEY=$(cat "$SSH_KEY_PATH")

echo -e "\n[1/4] Destruyendo VM $VM_ID antigua (si existe)..."
ssh -o BatchMode=yes root@$PVE_IP "qm stop $VM_ID 2>/dev/null; qm destroy $VM_ID --destroy-unreferenced-disks 1 --purge 1 2>/dev/null || true"

echo "[2/4] Clonando Golden Image ($TEMPLATE_ID -> $VM_ID) en local-lvm-1tb..."
ssh root@$PVE_IP "qm clone $TEMPLATE_ID $VM_ID --name zenith-lab --full 1 --storage local-lvm-1tb"

echo "[3/4] Inyectando configuraciones (IP: $VM_IP, Llave SSH)..."
ssh root@$PVE_IP <<EOF
echo "$SSH_KEY" > /tmp/zenith_ssh.pub
qm set $VM_ID --ipconfig0 ip=$VM_IP/24,gw=192.168.14.1
qm set $VM_ID --sshkeys /tmp/zenith_ssh.pub
qm set $VM_ID --cpu host
rm /tmp/zenith_ssh.pub
EOF

echo "[4/5] Encendiendo VM..."
ssh root@$PVE_IP "qm start $VM_ID"

echo "[5/5] Esperando agente e inicializando base de datos de Postal..."
sleep 20
ssh root@$PVE_IP <<EOF
qm guest exec $VM_ID -- sh -c 'sudo docker run --rm --network zenith-lab_zenith-net -v /opt/zenith-lab/postal.yml:/config/postal.yml:ro ghcr.io/postalserver/postal:latest postal initialize 2>&1 || true'
EOF

echo -e "\n\033[1;32m✅ ¡Zenith Lab Desplegado Exitosamente!\033[0m"
echo "La máquina está arrancando. Docker subirá los contenedores automáticamente."
echo "En un par de minutos podrás acceder a:"
echo " - SSH: ssh debian@$VM_IP"
echo " - Keycloak: http://192.168.14.50:8080"
echo " - Zitadel: http://192.168.14.50:8081"
echo " - Postal: http://192.168.14.50:50614"
