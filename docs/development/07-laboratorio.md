# Recrear el laboratorio desde cero (versiones de noviembre de 2026)

El laboratorio está pensado para ser desechable: `start.sh` destruye la VM 902 y la vuelve a clonar desde la
plantilla 901, que Packer construye con el `docker-compose.yml` y el `.env` dentro. Empezar de cero es, por tanto,
**reconstruir la plantilla y volver a clonar**. No hay datos que migrar.

## Requisitos de cómputo

Medidos el 2026-11-10 con todos los servicios recién arrancados y vacíos, en local y con tope de memoria por
contenedor:

| Grupo | Servicios | RAM medida en reposo |
|---|---|---|
| Bases de datos | MongoDB 9, PostgreSQL ×3, MariaDB, ScyllaDB (reserva fija 512 MB), SurrealDB, Qdrant | ~1,6 GB |
| Mensajería e IoT | EMQX, RabbitMQ, LuxDB | ~0,4 GB |
| IAM | Keycloak (~550 MB), Zitadel y su login | ~0,85 GB |
| Notificaciones | Novu API, worker, ws, dashboard | ~0,8–1,2 GB |
| Correo y resto | Postal web y worker, RustFS, OTel, CoreDNS | ~0,4 GB |
| **Total** | | **~4 GB en reposo** |

Hay que sumar el backend de Zenith (~0,5 GB), el sistema y Docker (~1 GB) y el margen para carga: Keycloak, Novu
y Scylla crecen claramente con uso.

**Imágenes:** ~16 GB. Las tres de Novu ocupan casi 7.

| | Mínimo (funciona) | Recomendado |
|---|---|---|
| vCPU | 4 (lo actual) | 6 |
| RAM | 12 GB (lo actual) | 16 GB |
| Disco | 60 GB (lo actual, justo) | 100 GB |

**Disco:** con 60 GB el sistema y las imágenes ya ocupan ~20 GB. Una actualización descarga las imágenes nuevas
antes de borrar las viejas, y los datos y logs crecen. Los valores están en `pulumi/index.ts` (VM) y en la
plantilla de Packer.

## Qué se probó y se corrigió antes de recrearlo

Todos los servicios se levantaron en local, con volúmenes vacíos y las versiones nuevas, fase por fase:

- **MariaDB 12:** no incluye `mysqladmin`. El healthcheck fallaba, así que Postal no arrancaba y
  `zenith-lab-init` esperaba para siempre. Ahora se usan `healthcheck.sh` y `mariadb-admin`.
- **Qdrant y SurrealDB:** no traen `wget`, así que sus healthchecks nunca pasaban. Ahora se usan `/dev/tcp` y
  `surreal is-ready`.
- **EMQX 6:**
  - aceptaba conexiones MQTT anónimas (`EMQX_ALLOW_ANONYMOUS` era de EMQX 4). Ahora tiene autenticador de
    usuario y contraseña;
  - el healthcheck pasa a usar `/status`.
- **Zitadel:**
  - el healthcheck asumía TLS;
  - el login enviaba un `Host` distinto del dominio de la instancia.
- **Keycloak:** `KC_BOOTSTRAP_ADMIN_*` sustituye a `KEYCLOAK_ADMIN`, que está obsoleta.
- **LuxDB:** imagen oficial 0.37.1. El clon 0.12.1 no tenía `BRPOPLPUSH`, así que el worker de Novu no podía
  tomar trabajos. Ahora exige `LUX_PASSWORD` (variable nueva del `.env`), y Novu usa la base 0.
- **Comprobaciones con éxito:**
  - Postal 3.3.7 con MariaDB 12.3 y RabbitMQ 4.4: inicializa, crea su usuario administrador y su worker arranca;
  - Novu 3.19: sano, sin errores de cola;
  - CoreDNS 1.15 resuelve `zen.ll` y los nombres externos.

## Procedimiento

1. **Comprobar `lab-infra/.env`.** Debe tener todas las variables de `.env.example`, incluida `LUX_PASSWORD`.
   Comprueba la interpolación sin arrancar nada:
   ```bash
   docker compose --env-file lab-infra/.env -f lab-infra/docker/docker-compose.yml config -q
   ```
2. **Reconstruir la plantilla 901** (copia el compose y el `.env` nuevos y descarga las imágenes nuevas):
   ```bash
   cd lab-infra/packer && packer build .
   ```
3. **Recrear la VM 902** desde la plantilla. `start.sh` destruye la anterior junto con sus discos, así que los
   volúmenes empiezan vacíos:
   ```bash
   cd lab-infra && ./start.sh
   ```
4. **Primer arranque.** `zenith-lab-init.service` inicializa Postal (base de datos y usuario administrador) una
   sola vez y deja `/opt/zenith-lab/.ansible-init-done`.
5. **Verificar:** `./qa-check.sh`.

Si la VM sigue existiendo y solo se quieren vaciar sus datos, en la VM:
```bash
cd /opt/zenith-lab && docker compose down -v
sudo rm /opt/zenith-lab/.ansible-init-done
docker compose --env-file .env up -d
sudo systemctl start zenith-lab-init
```
`down -v` borra **todos** los volúmenes del laboratorio, y no se puede deshacer.
