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

### La composición completa de traits no arranca
Hoy no arranca con barrits 0.1.0, y no es por la autenticación:
- `ZenithSchemaManagement`, `ZenithRestCrud` y otros consumen `db`, `cloud` o `telemetry`, que ningún trait provee;
- `ZenithCoreServer` crea `initKeys`, pero no lo declara en `provides`.

Ninguna prueba arranca `createZenithApp`, porque `engine.test.ts` está excluida. La fachada de engine-auth se
prueba componiendo su trait y el pipeline real.

Hay que unificar los nombres de capacidad (`database-crud`, no `db`) y leer las dependencias de `deps.traits`.

### `_Session` solo con master key
Cuando el CRUD genérico funcione, `/classes/_Session` debe quedar reservado a la master key. Contiene refresh
tokens sellados, que son inútiles sin `sessionKey`, pero no deben salir del servidor.

### Funciones que esperan a engine-auth
- recuperación de contraseña y verificación de correo: hoy responden 501;
- MFA (TOTP y passkeys).

### ScyllaDB y las sesiones
Las sesiones necesitan `updateIf` para el lease del refresh. Sobre Scylla, configurar `engineAuth` hace fallar el
arranque con un error claro.

### Dependencias atrasadas
Por la regla de usar siempre la última versión estable o LTS, hay que actualizar:
- `@zuccadev-labs/barrits` 0.1.0 → 0.3.0;
- `mongodb` ^6.5 → la versión actual del driver;
- OpenTelemetry, que hoy da avisos de dependencias peer.

### Importar el binding sin desactivar la protección de Deno
Hasta el 2026-11-10 a las 15:52 (hora local), `@zuccadev-labs/zutool-ffi@0.1.0` tiene menos de 24 h, y Deno no
lo instala sin `--min-dep-age 0`. Después basta con `deno install`. No se desactiva la protección en `deno.json`.
