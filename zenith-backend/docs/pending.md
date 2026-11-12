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

### Corregido el 2026-11-10 (antes oculto por `--no-check`)
Las pruebas se ejecutan con `--no-check`, así que la verificación de tipos de la publicación encontró 14
errores. Varios eran fallos reales:
- **`grpc.callService`** hacía `new` sobre el módulo de grpc-js, así que fallaba siempre, e ignoraba el nombre del
  servicio. Ahora es una llamada unaria a `/<servicio>/<método>` con mensajes JSON.
- **El SSE de notificaciones** enviaba texto a `Response`. Deno exige bytes; ahora pasa por `TextEncoderStream`.
- **El cliente de Vault nunca se había subido a git.** La regla `**/secrets/` de `.gitignore` ignoraba
  `src/security/secrets/`, así que un clon no arrancaba. Ahora hay una excepción para esa carpeta.

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

### Dos sistemas de API keys: resuelto el 2026-11-11 (ADR-016)
Queda uno solo: `/zen/api-keys` (`security/api-keys`). Se retiraron `/zen/apikeys` y la clase `ZenithApiKey` del
trait workspace. `ZenithAPIKey` del SDK usa ya `/zen/api-keys`, con la master key. El nombre `ZenithApiKey` sigue
reservado en `metadata`.

### Dos traits de webhooks que se solapan: resuelto el 2026-11-11 (ADR-017)
Queda `webhooks/webhook.manager.trait.ts`, completo según Standard Webhooks: outbox, reintentos, rotación,
reentrega, recuperación y SSRF. Se retiró `cloud/webhook.trait.ts`. El bus de eventos pasó al núcleo; antes,
con la configuración por defecto, ningún webhook se disparaba. Se añadieron los Cloud Code Hooks de Parse
(`/hooks`).

### La cola de trabajos no era duradera: resuelto el 2026-11-11
`queue/job.queue.trait.ts` guarda los trabajos en `_Job` y los reparte entre instancias con el mismo
mecanismo que los webhooks (`core/outbox.ts`: `updateIf` con concesión). Un trabajo de una instancia que se
cae lo retoma otra al vencer la concesión. Tiene reintentos exponenciales, una cola de mensajes muertos con
`retry` y claves de idempotencia. Probado con MongoDB real: un trabajo encolado por una instancia lo procesa
otra arrancada después (`tests/integration/pieces-e2e.test.ts`).

### `beforeSave` no podía cambiar un objeto al actualizarlo: resuelto el 2026-11-11
`updateObject` guarda también lo que cambia el trigger (`triggerChanges` en `crud.guard.ts`) y vuelve a
validar el resultado, como Parse Server. Probado con MongoDB real y un hook de `/hooks`; la prueba falla si se
quita el arreglo.

### Verificación de endpoints de webhooks: resuelto el 2026-11-11
Implementada la extensión de Standard Webhooks: un endpoint nuevo empieza `unverified`, no recibe eventos y
`POST /zen/webhooks/:id/verify` le manda un desafío firmado. Pasa con `webhook-challenge-response` (coincide con el
vector de la especificación). Cambiar la URL lo vuelve a `unverified`. `ZENITH_WEBHOOKS_VERIFY=0` lo desactiva.

### URLs firmadas de `storage`: resuelto el 2026-11-11
`GET /files/:objectId/:filename` (público) sirve el archivo solo con firma HMAC válida y sin caducar (tiempo
constante; máximo 7 días, como AWS SigV4). `GET /zen/files/:filename/url` (master) la genera, con el prefijo de
montaje (`X-Forwarded-Prefix`). De paso: nadie creaba el directorio de archivos y el error de escritura se tragaba,
así que cada subida perdía el contenido; y el contenido se guardaba con un id distinto del `objectId` del registro.
Probado con MongoDB y en el contenedor.

### `POST /zen/workspace/invitations/accept` toma `userId` del cuerpo
Con acceso master (el valor por defecto) es una herramienta de administración. Si se abre a usuarios (ADR-013),
el miembro debe ser `ctx.user`, nunca el `userId` del cuerpo.

### Publicación (preparada el 2026-11-10, sin publicar)
Los paquetes ya pasan `deno publish --dry-run` y `npm pack`, con licencia MIT:
- **Servidor:** `@zuccadev-labs/zenith` 0.1.0 (motor, con los subpaths `./openapi` y `./plugin-signing`) y
  `@zuccadev-labs/zenith-cli` 0.2.0 (`zen`), en JSR; `@zuccadev-labs/create-zenith` 0.1.0, en npm.
- **Cliente:** `@zuccadev-labs/zenith-client` 0.2.0, en npm. Antes se llamaba `@zuccadev-labs/zenith-sdk`; se
  renombró para que el nombre diga de qué lado está. El ejemplo de Vite lo importaba como `@zuccadev-labs/zenith`,
  el nombre del motor.

Orden de publicación: primero el motor, luego el CLI (depende de él) y por último `create-zenith`. `zen init`
escribe `jsr:@zuccadev-labs/zenith@^ENGINE_VERSION`; desde el monorepo enlaza el motor local (`ZENITH_ENGINE`
fuerza cualquiera de los dos). El CLI usa el motor local por `links` en su `deno.json`. Hay que publicar con
`--unstable-kv` en los comandos documentados, porque el motor abre Deno KV al componer.

### Scopes de las API keys: resuelto el 2026-11-10
Antes, `denied()` daba acceso `user` a cualquier API key válida, así que una `pk_` de solo lectura podía escribir.
Ahora se comprueba en dos capas:
- **Router:** una ruta `user` solo acepta API keys si declara `scope`. Sin `scope`, las rechaza (falla en cerrado).
- **CRUD:** cada operación comprueba su scope (`data:read`, `data:create`, `data:write` o `data:delete`; para
  `_User`, `users:read` o `users:write`). `/batch` comprueba cada suboperación, porque pasa por las mismas
  funciones. Las rutas del CRUD declaran `scope: "per-operation"`.

La OpenAPI documenta el scope en la `security` de cada operación. Una sesión con una key a la vez queda
limitada por la key. Pruebas: `tests/integration/api-key-scopes.test.ts` (verificada por mutación) y
`core-router`. No había keys emitidas en producción, así que el cambio no afectó a ningún cliente.

Las keys con scope `*` tienen su propia política (ADR-015):
- solo `sk_`;
- `allowedIps` obligatoria;
- caducan en 90 días como máximo;
- no pueden gestionar keys.

Cualquier key puede llevar `allowedIps`. Pendiente, como en Stripe: políticas por ASN o país, aprobación de
acciones sensibles para keys de agentes y avisos activos de los intentos bloqueados.

### Rutas `express` de cloudcode que nadie sirve
`CloudCodeTrait.express.get/post/put/delete` guarda las rutas en un mapa que ningún componente lee, así que nunca se
montan. Las rutas propias que sí se sirven son las de `Zen.API.defineRoute` (`core/cloud.ts`). Hay que unificar
ambas o retirar `express`. Su envoltorio ya espera al handler; antes, un handler `async` respondía `{}`.

### barrits y OpenAPI: el estándar existe, pero no basta para Zenith (análisis del 2026-11-10)
**El estándar de barrits** (guía `docs/users/ES/packages/ts_js/10-deno-baas-core.md`, ejemplo
`examples/example-deno-baas`) funciona así:
1. Cada endpoint es un trait con JSDoc pegado a su `export`: `@barrits-trait` y
   `@barrits-tags http:method=GET http:path=/api/x`, o la etiqueta `http-endpoint`.
2. `barrits build` genera `.barrits/build-manifest.json`.
3. `generateOpenApiSchema(manifest)` (`src/barrits/schema/openapi.ts`) produce la OpenAPI 3.1.

**Por qué no da el swagger completo de Zenith:**
- **Un trait, una operación.** Los traits de Zenith exponen listas de rutas: con las features por defecto,
  43 traits exponen 217 rutas (223 con `/health`, `/zen/api-keys` y las de metadatos). Solo el CRUD tiene 7.
- **Sin detalle.** No genera parámetros, `requestBody`, seguridad ni respuestas distintas de 200, y marca la API
  como `x-experimental`. Las 217 rutas de los traits de Zenith ya traen todo eso en `_openapi`.
- **Las rutas no están en el AST.** Se construyen dentro de `create()`, así que un análisis estático del código
  no las ve. Solo existen tras la composición.
- **Ni el ejemplo oficial usa el manifiesto real:** lo construye a mano («in a real BaaS, the manifest is
  generated at build time») e importa de `src/`, no del paquete.
- **El paquete no lo publica bien.** JSR 0.3.0 no exporta `./schema/openapi` ni `./ioc`. La guía los importa
  como `@zuccadev-labs/barrits/schema` y el README como `/schema/openapi`, y ninguna de las dos rutas existe en
  JSR. El ejemplo, además, tiene una errata: `@baritr-provides`.
- **Zenith no se descubre.** Los 68 bloques `@barrits-trait` están encima de los `import`, no pegados al
  `export`. `barrits.config.ts` usa `traitsDiscovery.conventions`, que no existe (la clave correcta es
  `discoveryRoots`). Sin carpeta `barrits/`, la CLI sube hasta `labs-packages/barrits`.

**Hecho en barrits 0.3.1 (2026-11-10), como versión aditiva tras la 0.3.0 publicada:**
- un contrato de rutas por capacidad (`*routes` con `method`, `path`, `access`, `scope` y `_openapi`) y
  `generateOpenApiFromRoutes`, validado con el código real de Zenith (221/221 rutas por defecto, 265/265 con
  todas las features);
- `jsr.json` exporta `./schema/openapi`, `./ioc` y `./deno/cli`, y la documentación usa esas rutas;
- la errata `@baritr-provides` y los ejemplos rotos, corregidos.

`generateOpenApiFromState` delega ya en barrits (ver `docs/architecture/openapi-swagger.md`). Queda pendiente,
por separado, pegar los JSDoc a los `export` y corregir `barrits.config.ts`, para que `barrits build` describa
los traits de Zenith (IoC, inspección). Esto no hace falta para la OpenAPI.

### `zenith-backend/scripts/zen.ts`: un segundo `zen` antiguo
Usa puerto 3000 y las opciones `--app-id`, `--port` y `--target-dir`, distintas del CLI real (`zenith-cli`). Lo usan
las tareas `dev`, `compile` y `build` de `zenith-backend/deno.json` para el arranque multi-app. Hay más tareas
rotas: `lab:up` y `lab:down` apuntan a `lab-infra/docker-compose.yml` (el real está en
`lab-infra/docker/docker-compose.yml`) y `verify` llama a `coverage:check`, que no existe.

### `zenith-cli/deno.lock`: resuelto el 2026-11-11
El lock refleja el grafo de las pruebas y los puntos de entrada; `deno test --frozen`, `deno check --frozen` y
`zen generate` con el motor local pasan con él congelado.

### `package-lock.json` ignorado: resuelto el 2026-11-11
Ya se versiona. El SDK no compilaba desde cero (React era solo `peerDependency`); ahora también es
`devDependency` y `npm ci && tsc` pasa en limpio.

### Código fuente de core-class-barrel ilegible
`apps/core-class-barrel`, el proyecto Rust del que salió barrits, tiene 115 de sus 127 archivos fuente con
contenido aleatorio: conservan el tamaño, tienen entropía 7,96 bits/byte y no llevan cabecera. Es el patrón de
archivos cifrados de NTFS (EFS) leídos desde Linux. La copia en `Programacion-recuperado/` está igual. Solo se
podrían recuperar desde el Windows que los cifró, con su certificado. barrits 0.3.0 es el sucesor y está completo
en `labs-packages/barrits`.

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

### Pruebas de mTLS y pin SPKI: resuelto el 2026-11-11
Las 8 pruebas de `mtls.test.ts` no fallaban por el `openssl` del sistema (3.5.7 admite `-addext`): la prueba
pasaba `"-addext basicConstraints=…"` como un solo argumento. Al corregirlo apareció un fallo real en
`extractSpkiFromCertDer`: leía mal la longitud de `tbsCertificate` y nunca encontraba la clave, así que
`computeSpkiPin` fallaba con cualquier certificado. Además devolvía solo el contenido del SPKI, no la
estructura completa que hashea RFC 7469. Ahora el pin coincide con el de OpenSSL
(`x509 -pubkey | pkey -pubin -outform der | sha256`).

### GitHub Actions no se ejecutaba: CI reescrito el 2026-11-11
El workflow probaba una carpeta que no existe (`src/test/`), sin `--unstable-kv` ni Mongo, y con
`trivy-action@master` sin fijar. El nuevo (`ci.yml`, ver `docs/testing.md`) ejecuta lint (0 errores tras limpiar
40), typecheck, pruebas unitarias con lock congelado, integración contra MongoDB, CLI, SDK, build de la imagen y
Trivy. Que GitHub lance las ejecuciones en el repo privado depende de la organización (Settings → Actions y
facturación de minutos): no lo puedo cambiar con los permisos de este token.

### Imagen Docker: no arrancaba (resuelto el 2026-11-11)
El binario de `deno compile` no incluía `apps.config.ts`; ahora va con `--include`. Además: actualizaciones de
seguridad de Debian en la imagen final (Trivy: 0 CRITICAL/HIGH con arreglo) y `ZENITH_FILES_DIR=/data/files`.
Probado arrancando el contenedor de solo lectura con MongoDB y ScyllaDB reales.

### Prueba del laboratorio completo (`engine.test.ts`): al día el 2026-11-11
Estaba escrita antes de ADR-012/013 y no podía pasar. Ahora arranca engine-auth real y pasa 20/20 contra MongoDB,
ScyllaDB, RustFS, LuxDB y engine-auth locales (receta en `docs/testing.md`). Destapó:
- **`GET /sessions/me` (Parse Server) no existía.** Ya existe: devuelve la sesión en el formato de Parse, sin el
  refresh token sellado.
- **`loadCloudCode` no aceptaba URLs `file://`:** las daba por "no encontradas" y no cargaba el código cloud.
- **`GET /login` con la contraseña en la URL:** Parse lo admite y Zenith responde 405 a propósito. Las credenciales
  en una URL acaban en logs de proxies y servidores; solo `POST /login`.
- **`/functions/:name` se abre por función (hecho el 2026-11-11).** Con el validador de Parse (`requireUser`, roles,
  `fields`) o `public: true`; sin validador sigue siendo solo master (ADR-013). Ver
  `docs/architecture/webhooks-and-hooks.md`.

### Cloud Code: validadores y triggers de `Zen.Cloud` (2026-11-11)
Revisando `/functions` aparecieron tres fallos, ya corregidos y probados (unidad, engine-auth real y `zen dev` con
MongoDB):
- **Los validadores no se aplicaban** (ni en funciones ni en triggers), aunque la OpenAPI decía que sí.
- **Los triggers de `Zen.Cloud` no se ejecutaban nunca:** `beforeSave`/`afterSave`/`before|afterFind`/
  `before|afterDelete`, los de archivos y los de login/logout. Solo se copiaban las funciones.
- **`response.error(141, …)` tumbaba la respuesta:** el código de Parse se usaba como estado HTTP.

**Pendiente:** los triggers de LiveQuery (`beforeConnect`, `beforeSubscribe`, `afterLiveQueryEvent`,
`onLiveQueryEvent`), de media (`beforePublish`, `beforeWatch`, `onStreamEvent`) y `beforePasswordResetRequest`
(el reseteo de contraseña aún responde 501). Se registran, pero ningún trait los lee. Ahora registrarlos avisa una
vez en el log en vez de fallar en silencio.

### El chart probado en Kubernetes real (2026-11-11)
Desplegado en kind con Calico: el pod llega a Ready, pasa `helm test` y la NetworkPolicy se aplica de verdad en
entrada y salida. Fallos encontrados y corregidos (detalle en `docs/testing.md`):
- puerto fijo en la app;
- `/health` inaccesible para las sondas;
- sin volúmenes escribibles y UID incorrecto;
- NetworkPolicy sin salida a bases de datos externas;
- `helm test` siempre fallido.

**Pendiente:** desplegar `values-prod.yaml` completo, con ingress-nginx, Vault y cert-manager, en un clúster de
prueba.

## Futuro (requiere plan de pago o infraestructura)
Detalle en `docs/architecture/supply-chain.md`:
- **CodeQL:** su licencia no permite usarlo en repos privados sin GitHub Advanced Security. Lo cubren Semgrep,
  Trivy, Checkov, hadolint, zizmor, actionlint, OSV-Scanner y `deno audit` (todos libres, en el CI).
- **Protección de `main` y rulesets:** no existen para repos privados en el plan gratuito de organizaciones.
- **CI en cada push y PR:** hoy solo arranca a mano. `tools/ship.sh` hace push, lanza el CI de ese commit y espera
  el veredicto. La causa la puede ver un administrador de la organización en Settings → Actions.
- **Atestaciones nativas de GitHub:** exigen Enterprise en repos privados. Cubiertas sin pagar (2026-11-11) con
  provenance SLSA v1 firmada con cosign, y la imagen se publica, firma y atesta en un registro Zot propio
  (`docs/architecture/registry.md`; desplegado en `registry.vemar.app` el 2026-11-12, con la clave de cosign activa).

