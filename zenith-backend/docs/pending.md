# Pendientes del backend

## Plugin de e-commerce

### Migrar carritos y órdenes a `ownerId`
Los documentos anteriores no tienen `ownerId`. Hasta migrarlos, solo la Master Key accede a los carritos con usuario, y sus dueños no ven esas órdenes. Hay que copiar el id del puntero `user` a `ownerId` en `Cart` y `Order`.

### `sessionId` de invitados
El `sessionId` funciona como secreto del carrito y debe tener al menos 16 caracteres. Los clientes y SDK deben generarlo al azar con `crypto.randomUUID()` y mandarlo en cada llamada.

### Cargar las reglas por país
`store_setCountryRule` guarda impuesto, moneda y envío de cada país o subdivisión. No hay tasas por defecto: sin una regla activa para el destino, el checkout se rechaza. Hay que cargar las tasas reales de cada país donde se venda.

### Conversión de moneda
El carrito usa una sola moneda y debe coincidir con la de la regla del destino. No hay conversión.

### Compatibilidad con ScyllaDB
`ScyllaAdapter` no implementa `updateIf`, así que el checkout no funciona sobre ese motor: falla con un error claro en lugar de arriesgar una sobreventa.

## Núcleo

### Revisar los plugins que usan `defineSchema`
`Zen.Cloud.defineSchema()` ya funciona: `Zen.DB.insert()` aplica valores por defecto y exige los campos requeridos. Antes no hacía nada, así que hay que revisar los inserts de CRM y ERP. Solo se valida al insertar, no al actualizar.

### Conectar `defineSchema` con `SchemaManagementTrait`
Cada uno tiene su propio registro de clases. Conviene unificarlos para que las clases de los plugins aparezcan en las rutas de esquemas.

## Autenticación (engine-auth, ADR-012)

### Abrir las rutas de negocio a usuarios (ADR-013)
Desde que se deniega por defecto, solo son públicas la salud, la documentación y las rutas Parse de usuarios.
**El CRUD `/classes` y `/batch` ya están abiertos a usuarios** (ADR-014). Todo lo demás sigue exigiendo la master
key hasta revisarlo trait por trait:
- **Ya resuelto en el router:** `ctx.user` y `ctx.master` llegan a todos los handlers (antes nadie los rellenaba).
- **Pendiente en cada handler:**
  - que compruebe los permisos de cada objeto;
  - que no lea datos internos sin ACL.

Siguientes, por prioridad para los clientes Parse: las funciones Cloud (`/functions/*`) y LiveQuery. LiveQuery
debe filtrar cada evento por ACL, como ya hace el CRUD.

No deben abrirse nunca a usuarios: `/shell/*`, `/runner/*`, `/secrets/*`, `/edge/deploy`, `/ratelimit/*`,
`/schemas` y `/migrations`.

### El adaptador de Mongo y `$inQuery`
`$inQuery` ejecuta su subconsulta sin ACL ni CLP sobre cualquier colección. El CRUD lo rechaza a los usuarios. Si
se quiere ofrecer, el adaptador tiene que pasar la subconsulta por las mismas comprobaciones.

### `updatedAt` no se actualiza
El adaptador de Mongo descarta `updatedAt` en `update`, así que conserva el valor de la creación. Parse lo
actualiza en cada escritura.

### Funciones que esperan a engine-auth
- recuperación de contraseña y verificación de correo: hoy responden 501;
- MFA (TOTP y passkeys).

### ScyllaDB y las sesiones
Las sesiones necesitan `updateIf` para el lease del refresh. Sobre Scylla, configurar `engineAuth` hace fallar el
arranque con un error claro.

### Antigüedad mínima de las dependencias
`deno.json` mantiene la protección de Deno (no instala versiones con menos de 24 h) para todo lo de terceros y
exime solo nuestros paquetes, `@zuccadev-labs/barrits` y `@zuccadev-labs/zutool-ffi`.

`deno.lock` está versionado desde el 2026-11-10. La imagen Docker instala con `deno install --frozen`, así que se
construye con las versiones exactas del lock y sus hashes, sin volver a resolverlas. La protección de 24 h solo se
aplica al añadir o actualizar una dependencia.

## Dependencias (2026-11-09)

Todo está en su última versión estable o LTS. Hay tres excepciones, forzadas por compatibilidad:
- **TypeScript 6.0.3 en el ejemplo de Vite:** typescript-eslint 8.72 solo admite `<6.1`. El SDK ya usa TypeScript 7.
- **`@solana/web3.js` 1.99:** la 3.x existe, pero el wallet-adapter exige `^1.99`.
- **Proxmox en Pulumi:** se usa `VmLegacy`, el recurso estable de la v8; `Vm` está marcado como experimental.

### Errores que ya existían (no los causa la actualización)
- **Ejemplo de Vite:** 18 errores de tipos.
  - MUI 9 retiró las props de sistema (`<Typography fontWeight={800}>` pasa a `sx={{ fontWeight: 800 }}`).
  - El SDK no declara `attributes` en `ZenithObject` ni el segundo argumento de `upload`.
  - El build de Vite sí funciona.
- **CLI:** 7 errores de tipos, iguales antes y después.
  - Hay comandos sin `run` exportado.
  - `parseArgs` con `number`.
  - Importa `manager.ts` del backend, que necesita `@node-rs/argon2`, y el CLI no lo tiene en su import map.

### Laboratorio (`lab-infra/docker`): migrar los datos antes de actualizar en `192.168.14.50`
Las imágenes ahora tienen versión fija (ninguna `:latest`). Si los volúmenes ya tienen datos, hay que migrarlos;
no basta con cambiar la imagen:
- **MongoDB 7.0 → 9.0:** pasar por 8.0 y subir `featureCompatibilityVersion` en cada salto.
- **PostgreSQL 15 → 18:** `pg_dump`/`pg_restore` o `pg_upgrade`. La imagen 18 guarda los datos en
  `/var/lib/postgresql/18/docker`; el volumen se monta ahora en `/var/lib/postgresql`.
- **ScyllaDB 5.2 → 2026.1 (LTS):** actualizar por versiones intermedias. Desde 2025 la licencia es source-available.
- **MariaDB 10.11 → 12.3 (LTS):** después, `mariadb-upgrade`.
- **RabbitMQ 3.12 → 4.4:** activar todos los feature flags antes del salto. Hay que probar Postal con la 4.x.
- **SurrealDB → v4:** exportar e importar. El almacenamiento es `rocksdb:`, en lugar de `file:`.
- **Novu 3:** la imagen `web` se sustituye por `dashboard` (puerto 4000, variables `VITE_*`).

### Imagen Docker
- **Base de ejecución:** `debian:13-slim`. distroless no sirve porque `@node-rs/argon2` busca `/usr/bin/ldd`
  para elegir el binario de glibc.
- **Sistema de archivos de solo lectura:** montar `/data` con escritura y `/tmp` con escritura y `exec`; ahí se
  extraen y se cargan los addons nativos.
- **`apps.config.ts`:** trae por defecto las IP del laboratorio (Scylla en `192.168.14.50:53042`). En producción
  hay que pasar todas las URI por entorno.
