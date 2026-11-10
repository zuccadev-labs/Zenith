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

### Dos sistemas de API keys
- **Las del servidor** (`/zen/api-keys`, `ApiKeyManager` sobre MongoDB) son las que autentican peticiones.
- **Las de workspace** (`/zen/apikeys`, colección `ZenithApiKey`) se crean, pero el pipeline no las valida.
  Hay que unificarlas o retirar las de workspace. `ZenithAPIKey` del SDK usa las de workspace.

### El motor aún no está en JSR
`zen init` apunta `@zuccadev-labs/zenith` al `src/mod.ts` del monorepo. Al publicar el motor en JSR, cambiar
`CORE_ENTRY` en `zenith-cli/zen.ts` por `jsr:@zuccadev-labs/zenith`.

### `zenith-cli/ai_harness.ts`
No lo usa nada. Sus herramientas son simuladas; `process_payment` responde "Payment Dispatched" sin cobrar. No
debe conectarse a un agente tal como está.

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

### Errores de tipos: resueltos (2026-11-10)
El ejemplo de Vite (20) y el CLI (7) compilan sin errores. Quedan avisos de estilo de lint, que ya existían: 61 en
el ejemplo y unos 45 en el CLI, sobre todo `any`.

### Laboratorio
Se recrea desde cero; no hay datos que migrar. El procedimiento, los requisitos de cómputo y las correcciones
probadas están en `lab-infra/docs/recrear-desde-cero.md`.

Pendiente:
- **Credenciales MQTT de los dispositivos.** EMQX ya no acepta conexiones anónimas, así que cada dispositivo
  necesita usuario y contraseña en EMQX. Lo correcto es que EMQX le pregunte a Zenith por HTTP
  (`deviceId`/`deviceToken` contra `deviceTokenHash` del trait IoT); esa ruta aún no existe.
- **Recursos de la VM:** se recomiendan 6 vCPU, 16 GB y 100 GB de disco (hoy 4, 12 y 60).

### Imagen Docker
- **Base de ejecución:** `debian:13-slim`. distroless no sirve porque `@node-rs/argon2` busca `/usr/bin/ldd`
  para elegir el binario de glibc.
- **Sistema de archivos de solo lectura:** montar `/data` con escritura y `/tmp` con escritura y `exec`; ahí se
  extraen y se cargan los addons nativos.
- **`apps.config.ts`:** trae por defecto las IP del laboratorio (Scylla en `192.168.14.50:53042`). En producción
  hay que pasar todas las URI por entorno.
