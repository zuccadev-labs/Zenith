# Zenith Lab Infrastructure — Guía de Configuración DNS

## Dominio de Laboratorio: `zen.ll`

El laboratorio usa el dominio **`zen.ll`** para todos los servicios internos.
No es un TLD real (`.ll` no existe en internet), por lo que no hay riesgo de
colisión con el DNS público.

---

## Arquitectura DNS

```
Tu PC Windows / Mac / Linux
        │
        │  DNS query: postal.zen.ll → ?
        ▼
  CoreDNS (en la VM Zenith, puerto 53)
        │
        ├─ *.zen.ll  → responde localmente (zona autoritativa)
        │              registros A, MX, TXT (SPF) incluidos
        │
        └─ *.* (google.com, etc.) → forward a 1.1.1.1 / 8.8.8.8
```

**CoreDNS corre como contenedor dentro de la VM Zenith** y escucha en el
puerto 53 UDP/TCP expuesto al host.

---

## Paso 1 — Obtener la IP de la VM Zenith

Después del primer arranque de la VM en Proxmox, obtén su IP:

```bash
# En el host Proxmox:
qm guest cmd 902 network-get-interfaces
# o directamente en la consola de la VM:
ip addr show
```

Anota la IP (ej: `192.168.14.50`) y colócala en el archivo `.env`:

```env
ZENITH_VM_IP=192.168.14.50
```

---

## Paso 2 — Configurar DNS en tu PC (Windows)

### Opción A: Adaptador de red (recomendada para desarrollo diario)

1. Panel de Control → Centro de redes → Cambiar configuración del adaptador
2. Clic derecho en tu adaptador → Propiedades
3. Selecciona **Protocolo de Internet versión 4 (TCP/IPv4)** → Propiedades
4. Configura:
   - **DNS preferido:** `192.168.14.50` (IP de la VM Zenith)
   - **DNS alternativo:** `1.1.1.1` (Cloudflare — fallback para internet)
5. Aceptar

> CoreDNS reenvía todo lo que no sea `zen.ll` a Cloudflare/Google,
> así que el acceso a internet seguirá funcionando con normalidad.

### Opción B: PowerShell (rápido, reversible)

```powershell
# Listar adaptadores disponibles
Get-NetAdapter | Select Name, InterfaceDescription

# Configurar DNS en el adaptador "Wi-Fi" (cambia el nombre según el tuyo)
Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ("192.168.14.50", "1.1.1.1")

# Verificar
Resolve-DnsName postal.zen.ll
```

### Opción C: Hosts file (sin DNS, solo para acceso web — NO funciona para correo SMTP)

```
# C:\Windows\System32\drivers\etc\hosts
192.168.14.50  postal.zen.ll
192.168.14.50  keycloak.zen.ll
192.168.14.50  zitadel.zen.ll
192.168.14.50  novu.zen.ll
192.168.14.50  rustfs.zen.ll
```

> ⚠️ El archivo hosts **NO soporta registros MX**. Para que el correo
> funcione end-to-end (incluyendo envío/recepción en Postal), usa la
> Opción A o B.

---

## Paso 3 — Configurar DNS en Linux / Mac

```bash
# Linux (systemd-resolved)
sudo resolvectl dns eth0 192.168.14.50 1.1.1.1
sudo resolvectl domain eth0 zen.ll

# Mac
networksetup -setdnsservers Wi-Fi 192.168.14.50 1.1.1.1

# Verificar en cualquier OS
dig postal.zen.ll @192.168.14.50
nslookup postal.zen.ll 192.168.14.50
```

---

## Paso 4 — Agregar DNS al Router (opcional, para toda la LAN)

Si tu router soporta DNS personalizado (OpenWRT, pfSense, OPNsense, Unbound):

```
# OpenWRT / Unbound — agregar en la configuración:
server:
  local-zone: "zen.ll." transparent
  local-data: "*.zen.ll. A 192.168.14.50"

# Alternativa: conditional forwarding
# Redirigir todas las consultas de zen.ll al CoreDNS de la VM
forward-zone:
  name: "zen.ll."
  forward-addr: 192.168.14.50
```

> 📋 **Nota para el README del laboratorio:** Documentar la IP de la VM
> Zenith como referencia permanente para el equipo.

---

## Paso 5 — Verificar que CoreDNS funciona

```bash
# Desde tu PC (después de configurar el DNS):
nslookup postal.zen.ll
# Debería responder con: Address: 192.168.14.50

nslookup -type=MX zen.ll
# Debería responder: zen.ll  mail exchanger = 10 postal.zen.ll

nslookup -type=TXT zen.ll
# Debería responder: v=spf1 a mx ip4:192.168.14.50 ~all

# Verificar que internet sigue funcionando:
nslookup google.com
# Debería responder normalmente vía Cloudflare/Google
```

---

## Servicios y Puertos (referencia rápida)

| Servicio          | URL Local                          | Puerto Externo |
|-------------------|------------------------------------|----------------|
| Postal Web UI     | http://postal.zen.ll:50614         | 50614          |
| Postal SMTP       | postal.zen.ll:25614                | 25614          |
| Keycloak          | http://keycloak.zen.ll:8080        | 8080           |
| Zitadel           | http://zitadel.zen.ll:8081         | 8081           |
| Novu Dashboard    | http://novu.zen.ll:4614            | 4614           |
| Novu API          | http://novu.zen.ll:3614            | 3614           |
| RustFS Console    | http://rustfs.zen.ll:8615          | 8615           |
| MongoDB           | mongodb://192.168.14.50:53017      | 53017          |
| PostgreSQL Core   | 192.168.14.50:54614                | 54614          |
| ScyllaDB CQL      | 192.168.14.50:53042                | 53042          |
| LuxDB (Redis)     | 192.168.14.50:53079                | 53079          |
| OTel HTTP         | http://192.168.14.50:43180         | 43180          |

---

## Configurar cliente de correo para zen.ll

Para enviar correo a `cep@zen.ll` desde Thunderbird, Outlook, etc.:

1. Configurar cuenta con email: `cep@zen.ll`
2. **SMTP saliente:** `postal.zen.ll` puerto `25614` (sin TLS para desarrollo)
3. **SMTP entrante:** Configurar en Postal web UI (http://postal.zen.ll:50614)

> En entorno de laboratorio, el correo **no sale a internet** — todo queda
> dentro de la red local. Ideal para testing sin afectar dominios reales.
