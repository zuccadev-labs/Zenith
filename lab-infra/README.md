# Zenith Lab Infrastructure

> Recrearlo desde cero: [Laboratorio](../docs/development/07-laboratorio.md). DNS:
> [DNS del laboratorio](../docs/development/08-dns-del-laboratorio.md).

Infraestructura como código para el laboratorio de desarrollo Zenith.
Stack completo de servicios corriendo en una VM Debian 13 sobre Proxmox.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│  Proxmox (192.168.14.44)                                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  VM zenith-lab (ID: 902)  IP: 192.168.14.50 (estática)  │  │
│  │                                                          │  │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐   │  │
│  │  │CoreDNS  │ │ Keycloak │ │ Zitadel  │ │   Novu    │   │  │
│  │  │:53      │ │:8080     │ │:8081     │ │:3614/4614 │   │  │
│  │  └─────────┘ └──────────┘ └──────────┘ └───────────┘   │  │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐   │  │
│  │  │  Postal │ │  RustFS  │ │  ScyllaDB│ │   OTel    │   │  │
│  │  │:50614   │ │:8614/8615│ │:53042    │ │:43180     │   │  │
│  │  └─────────┘ └──────────┘ └──────────┘ └───────────┘   │  │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐                 │  │
│  │  │ MongoDB │ │PostgreSQL│ │  LuxDB   │                 │  │
│  │  │:53017   │ │:54614    │ │:53079    │                 │  │
│  │  └─────────┘ └──────────┘ └──────────┘                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│  Storage: /dev/sdd → LVM pool local-lvm-1tb (1 TB)             │
└─────────────────────────────────────────────────────────────────┘
```

## Herramientas

| Herramienta | Propósito |
|---|---|
| **Packer** | Construye la golden image (VM 901) clonando `debian-13-cloudinit` |
| **Pulumi (TypeScript)** | Aprovisionamiento de la VM de trabajo (VM 902) con IP estática |
| **Docker Compose** | Orquestación de todos los servicios dentro de la VM |
| **Ansible** | Inicialización de Postal tras el primer arranque |
| **CoreDNS** | DNS autoritativo para `zen.ll` + forward a Cloudflare/Google |

## Estructura de carpetas

```
lab-infra/
├── .env.example            # Plantilla de variables (el .env no se sube a git)
├── .gitignore
├── README.md
├── start.sh                # Arranca el laboratorio en Linux
├── start.ps1               # Arranca el laboratorio en Windows
├── qa-check.sh             # Comprobaciones tras el arranque
├── vendor-data.yaml        # cloud-init de la VM
├── ansible/
│   └── postal-init.yml     # Playbook de inicialización de Postal
├── docker/
│   ├── docker-compose.yml  # Todos los servicios
│   └── configs/
│       ├── Corefile        # CoreDNS
│       ├── zen.ll.zone     # Zona DNS zen.ll
│       └── otel-config.yml # OpenTelemetry Collector
├── packer/
│   ├── zenith-lab.pkr.hcl  # Build de la plantilla (VM 901)
│   ├── variables.pkr.hcl
│   └── scripts/
│       ├── setup.sh        # Instala Docker y Ansible dentro de la VM
│       └── finalize.sh     # Autoarranque con systemd
├── pulumi/
│   ├── Pulumi.yaml
│   ├── package.json
│   └── index.ts            # Aprovisionamiento de la VM 902 con IP fija
└── repos/                  # No se versiona: se prepara en la máquina del laboratorio
    └── postal-config/
        └── postal.yml      # Configuración de Postal (plantilla con envsubst)
```

## Servicios y Puertos

### Core Platform

| Servicio | URL/Host | Puerto externo | Uso |
|---|---|---|---|
| **CoreDNS** (DNS `zen.ll`) | `192.168.14.50` | `53` UDP/TCP | DNS LAN |
| **Keycloak** | `http://keycloak.zen.ll:8080` | `8080` | IAM alternativo |
| **Zitadel** | `http://zitadel.zen.ll:8081` | `8081` | IAM principal / OIDC |
| **Novu Dashboard** | `http://novu.zen.ll:4614` | `4614` | Notificaciones UI |
| **Novu API** | `http://novu.zen.ll:3614` | `3614` | Push/Email/Webhook |
| **Postal Web UI** | `http://postal.zen.ll:50614` | `50614` | SMTP servidor |
| **Postal SMTP** | `postal.zen.ll` | `25614` | Envío de email |
| **RustFS S3 API** | `http://rustfs.zen.ll:8614` | `8614` | Object storage S3 |
| **RustFS Console** | `http://rustfs.zen.ll:8615` | `8615` | Storage UI |
| **MongoDB** | `192.168.14.50:53017` | `53017` | DB principal (BaaS) |
| **PostgreSQL** | `192.168.14.50:54614` | `54614` | DB relacional / IAM |
| **ScyllaDB** (CQL) | `192.168.14.50:53042` | `53042` | Time-series IoT / Sesiones |
| **LuxDB** (Redis compat) | `192.168.14.50:53079` | `53079` | Cache / Rate limit |
| **OTel Collector** | `http://otel.zen.ll:43180` | `43180` | Telemetría OTLP |

### UBB — Universal Business Backend

| Servicio | URL/Host | Puerto externo | Uso |
|---|---|---|---|
| **SurrealDB** | `http://192.168.14.50:58000` | `58000` | DB multi-model (SQL+Graph+Doc) |
| **SurrealDB Dashboard** | CLI: `surreal sql --conn http://192.168.14.50:58000` | — | Admin CLI |
| **Qdrant** REST | `http://192.168.14.50:56333` | `56333` | Vector DB + Dashboard |
| **Qdrant** gRPC | `192.168.14.50:56334` | `56334` | Vector DB gRPC |
| **EMQX** MQTT/TCP | `mqtt://192.168.14.50:51883` | `51883` | MQTT 3.1.1/5.0 (IoT) |
| **EMQX** MQTT/WS | `ws://192.168.14.50:58083/mqtt` | `58083` | MQTT sobre WebSocket |
| **EMQX** Dashboard | `http://192.168.14.50:58080` | `58080` | Broker UI (usuario `admin`, contraseña `EMQX_ADMIN_PASS` del `.env`) |

### Zenith Backend

| Endpoint | URL | Puerto |
|---|---|---|
| **REST API** | `http://192.168.14.50:1337` | `1337` |
| **OpenAPI/Swagger** | `http://192.168.14.50:1337/openapi.json` | — |
| **Health** | `http://192.168.14.50:1337/health` | — |
| **Metrics** (Prometheus) | `http://192.168.14.50:1337/metrics` (master key) o el listener de métricas ([Métricas](../docs/development/04-metricas.md)) | — |
| **GraphQL** | `http://192.168.14.50:1337/graphql` | — |
| **TimeSeries** (Grafana DS) | `http://192.168.14.50:1337/timeseries` | — |
| **IoT Devices** | `http://192.168.14.50:1337/iot/devices` | — |
| **Workflows** | `http://192.168.14.50:1337/workflows` | — |
| **Audit Log** | `http://192.168.14.50:1337/compliance/audit` | — |

## Primeros pasos

### 1. Configurar variables

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

### 2. Configurar DNS en tu PC

Apuntar DNS primario a `192.168.14.50`.
Ver la guía completa: [DNS del laboratorio](../docs/development/08-dns-del-laboratorio.md)

**PowerShell (Windows):**
```powershell
Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ("192.168.14.50", "1.1.1.1")
```

**Router:** Agregar `192.168.14.50` como DNS secundario para que toda la LAN resuelva `*.zen.ll`.

### 3. Construir la imagen con Packer

```bash
cd packer/
packer init .
packer build .
# Genera VM 901 (zenith-lab-golden) en Proxmox
```

### 4. Desplegar la VM con Pulumi

```bash
cd pulumi/
# Con Node.js:
npm install
pulumi stack init dev
pulumi up

# Con Deno (alternativa):
deno run -A npm:pulumi up
```

Crea la VM 902 con IP fija `192.168.14.50` clonada desde la imagen Packer.

### 5. Verificar servicios

```bash
# Verificar DNS
nslookup postal.zen.ll 192.168.14.50
nslookup -type=MX zen.ll 192.168.14.50

# Verificar servicios core
curl -f http://192.168.14.50:50614   # Postal
curl -f http://192.168.14.50:8080    # Keycloak
curl -f http://192.168.14.50:8081    # Zitadel

# Verificar servicios UBB
curl -f http://192.168.14.50:58000/health          # SurrealDB
curl -f http://192.168.14.50:56333/collections     # Qdrant
curl -f http://192.168.14.50:1337/health           # Zenith Backend
curl -f http://192.168.14.50:1337/timeseries/health # TimeSeries / Grafana DS
curl    http://192.168.14.50:1337/plans             # Feature Plans
```

### 6. Verificar conectividad MQTT (IoT)

```bash
# Instalar MQTT client: apt install mosquitto-clients

# Publicar telemetría de prueba (simular sensor)
mosquitto_pub \
  -h 192.168.14.50 -p 51883 \
  -u test-device -P test-token \
  -t zenith/telemetry/zenith/test-device-01 \
  -m '[{"bn":"urn:dev:id:test/","bt":0,"n":"temperature","v":22.5,"u":"Cel"}]'

# Suscribirse a comandos
mosquitto_sub \
  -h 192.168.14.50 -p 51883 \
  -u test-device -P test-token \
  -t zenith/commands/zenith/test-device-01
```

### 7. Configurar Grafana con TimeSeries de Zenith

```
1. Abrir Grafana
2. Configuración → Data Sources → Add data source
3. Seleccionar: "Simple JSON" (plugin requerido: grafana-simple-json-datasource)
4. URL: http://192.168.14.50:1337/timeseries
5. Headers: X-Parse-Application-Id: <appId> | X-Parse-Master-Key: <masterKey>
6. Guardar y probar
7. En un nuevo panel: target format "<deviceId>:<metric>" — ej. "pump-A3:temperature"
```

## Seguridad

- El archivo `.env` y `packer/secrets.auto.pkrvars.hcl` están en `.gitignore` — **nunca subir al repositorio**
- Todos los secretos se inyectan en tiempo de ejecución vía variables de entorno
- `postal.yml` usa `envsubst` para leer credenciales del `.env` al arrancar
- Zitadel usa el driver `POSTGRES` (no CockroachDB)

## Arquitectura: ¿Por qué una VM Debian dedicada?

El laboratorio no se ejecuta sobre Docker Desktop (WSL2/Windows nativo) de manera intencional debido a las restricciones de red y de arquitectura de **FreeIPA** y servicios sistémicos de bajo nivel.
- FreeIPA requiere levantar `systemd` como proceso PID 1 dentro de un contenedor, además de privilegios especiales del Host (`--privileged`) y mapeo directo de `cgroups`. 
- WSL2 (Docker Desktop) tiene conflictos conocidos manejando cgroups anidados y networking estricto que requiere un Directorio Activo/DNS como FreeIPA/Zitadel. 
- Utilizando una **VM Debian en Proxmox**, garantizamos un Kernel puro Linux, una IP fija en la capa 2 de la red (`192.168.14.50`) y aislamiento total para emular un entorno de producción real sin "hacks".

## Notas de Red

- **IP fija de la VM:** `192.168.14.50` — reservar en el router por MAC o DHCP estático.
- **Dominios sslip.io:** Se utiliza `zenith-iam.192.168.14.50.sslip.io` para resolver Zitadel. `sslip.io` es un servicio *Wildcard DNS* que retorna la IP incrustada. Esto es obligatorio para engañar las estrictas políticas de *Secure Cookies* y *Redirect URIs* de los flujos de autenticación OIDC/OAuth 2.0 que exigen un Fully Qualified Domain Name (FQDN) válido sin obligar al equipo a modificar el archivo `/etc/hosts` en cada computadora local.
- **CoreDNS:** Escucha en el puerto 53 de la VM y resuelve `*.zen.ll` localmente. Todo el tráfico que no sea `zen.ll` se reenvía a `1.1.1.1` (Cloudflare) / `8.8.8.8` (Google).

## Mantenimiento y Backups (Empaquetado)

Para guardar el estado íntegro del laboratorio y sus datos (Bases de datos, configuraciones, tokens), se puede crear un backup utilizando las herramientas de Proxmox.
1. Haz un volcado de la VM directamente al disco montado:
   ```bash
   vzdump 902 --dumpdir /mnt/hdd-10tb-00/vm-templates --mode snapshot --compress zstd
   ```
2. Esto generará un archivo `.vma.zst` que sirve como imagen inmutable del laboratorio listo para restaurarse mediante `qmrestore`.
