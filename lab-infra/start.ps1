param(
    [string]$PveIp = "192.168.14.44",
    [int]$TemplateId = 901,
    [int]$VmId = 902,
    [string]$VmIp = "192.168.14.50"
)

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "🚀 Zenith Lab Automator (Proxmox CLI)" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Verificar SSH Key
$SshKeyPath = "$env:USERPROFILE\.ssh\id_rsa.pub"
if (-Not (Test-Path $SshKeyPath)) {
    Write-Error "No se encontró llave pública SSH en $SshKeyPath. Por favor, genera una con ssh-keygen."
}
$SshKey = Get-Content $SshKeyPath | Out-String

Write-Host "`n[1/4] Destruyendo VM $VmId antigua (si existe)..."
ssh -o BatchMode=yes root@$PveIp "qm stop $VmId 2>/dev/null; qm destroy $VmId --destroy-unreferenced-disks 1 --purge 1 2>/dev/null || true"

Write-Host "[2/4] Clonando Golden Image ($TemplateId -> $VmId) en local-lvm-1tb..."
ssh root@$PveIp "qm clone $TemplateId $VmId --name zenith-lab --full 1 --storage local-lvm-1tb"

Write-Host "[3/4] Inyectando configuraciones (IP: $VmIp, Llave SSH)..."
ssh root@$PveIp @"
echo `"$SshKey`" > /tmp/zenith_ssh.pub
qm set $VmId --ipconfig0 ip=$VmIp/24,gw=192.168.14.1
qm set $VmId --sshkeys /tmp/zenith_ssh.pub
qm set $VmId --cpu host
rm /tmp/zenith_ssh.pub
"@

Write-Host "[4/5] Encendiendo VM..."
ssh root@$PveIp "qm start $VmId"

Write-Host "[5/5] Esperando agente e inicializando base de datos de Postal (puede tomar unos segundos)..."
Start-Sleep -Seconds 20
ssh root@$PveIp @"
qm guest exec $VmId -- sh -c 'sudo docker run --rm --network zenith-lab_zenith-net -v /opt/zenith-lab/postal.yml:/config/postal.yml:ro ghcr.io/postalserver/postal:3.3.7 postal initialize 2>&1 || true'
"@

Write-Host "`n✅ ¡Zenith Lab Desplegado Exitosamente!" -ForegroundColor Green
Write-Host "La máquina está arrancando. Docker subirá los contenedores automáticamente."
Write-Host "En un par de minutos podrás acceder a:"
Write-Host " - SSH: ssh debian@$VmIp"
Write-Host " - Keycloak: http://192.168.14.50:8080"
Write-Host " - Zitadel: http://192.168.14.50:8081"
Write-Host " - Postal: http://192.168.14.50:50614"
