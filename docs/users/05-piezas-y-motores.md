---
description: "El catálogo de piezas del motor, cómo se activan al arrancar y cómo se encienden y apagan en caliente."
tipo: referencia
---

# ¿Qué piezas tiene el motor y cómo se encienden?

Zenith es un motor armado con piezas. Cada funcionalidad es un trait de barrits, o un grupo pequeño de ellos, que
declara qué capacidades provee (`provides`), cuáles necesita (`consumes`) y cuáles usa si existen
(`uses:<capacidad>`). barrits las compone en orden, de modo que cada proveedor existe antes que sus consumidores.
Por eso cada pieza se puede mejorar, sustituir o apagar por separado.

## El catálogo

`zenith-backend/src/traits/catalog.ts` es la única lista de piezas. `selectTraits`, `zen generate openapi` y las
pruebas de composición la leen, así que una pieza nueva es una entrada más ahí.

| Campo | Para qué |
|---|---|
| `id` | Nombre estable. Se usa en `features.<id>`, en `/zen/features/<id>` y en los logs |
| `group` | `core`, `data`, `security`, `transport`, `integrations`, `business`, `collaboration`, `ai` o `platform` |
| `traits` | Los traits que la forman, en orden de arranque |
| `required` | Núcleo: no se puede apagar |
| `default` | Estado cuando `zen.config.ts` no dice nada |
| `feature` | Clave de `features` que la activa, si no es el `id` |
| `when` | Condición de despliegue: que el nodo esté en `topology` |
| `requires` | Otras piezas sin las que esta no puede funcionar |

Estas son todas, en orden de arranque. «Núcleo» significa que siempre está activa; «nodo» significa que depende de
que `topology` incluya ese nodo (por defecto: `http`, `runner`, `ai`, `graphql` y `zeromq`).

| Pieza | Grupo | Por defecto | Clave en `features` | Qué hace |
|---|---|---|---|---|
| `db` | core | núcleo |  | Capa de datos común (find, create, update, delete) |
| `eventBus` | core | núcleo |  | Bus de eventos de dominio en el proceso (on, emit) |
| `objectStorage` | core | núcleo |  | Almacenamiento de objetos S3 (RustFS) |
| `crypto` | security | núcleo |  | Argon2id, HMAC y AES-GCM |
| `schema` | core | núcleo |  | Esquemas de clases (`/schemas` de Parse) |
| `users` | core | núcleo |  | Usuarios y sesiones (`/users` de Parse, engine-auth) |
| `mediaStream` | platform | sí |  | Streaming de medios (HLS) |
| `acl` | security | núcleo |  | ACL y CLP por objeto y por clase |
| `rateLimit` | security | núcleo |  | Límite de peticiones |
| `rest` | core | núcleo |  | CRUD REST de clases (`/classes` y `/batch` de Parse) |
| `cloudCode` | core | núcleo |  | Cloud Code: funciones, jobs y triggers |
| `files` | core | núcleo |  | Archivos (`/files` de Parse) |
| `observability` | platform | núcleo |  | Salud, métricas y trazas |
| `migrations` | data | núcleo |  | Migraciones de esquema |
| `database` | data | núcleo |  | Adaptador de base de datos (MongoDB o ScyllaDB) |
| `billing` | business | no | `saas` | Facturación y pagos (Stripe) |
| `search.opensearch` | data | no | `ecommerce` | Búsqueda de catálogo (OpenSearch) |
| `segmentation` | security | no | `gdpr` | Segmentación, derecho al olvido y portabilidad |
| `edge` | platform | no |  | Ejecución WebAssembly en el borde |
| `eventStreaming` | integrations | no | `events` | Registro de eventos (`_Event`) y reproducción |
| `web3` | integrations | no |  | Login con wallet e IPFS |
| `federation` | platform | no |  | Replicación multirregión (CRDT) |
| `http` | transport | núcleo, nodo `http` |  | Servidor HTTP |
| `realtime` | transport | sí, nodo `http` |  | LiveQuery por WebSocket. Requiere `http` |
| `graphql` | transport | sí, nodo `graphql` |  | API GraphQL |
| `ai` | ai | no, nodo `ai` |  | Capa de IA (LLM y tokens) |
| `runner` | platform | sí, nodo `runner` |  | Runner y API de shell |
| `grpc` | transport | sí, nodo `grpc` |  | Transporte gRPC entre nodos |
| `zeromq` | transport | sí, nodo `zeromq` |  | Transporte ZeroMQ entre nodos |
| `e2eeMedia` | security | no | `e2ee_media` | Claves E2EE y señalización SFrame |
| `featureFlags` | platform | núcleo |  | Flags por plan y kill switches |
| `vectordb` | ai | no |  | Base vectorial (búsqueda semántica y RAG) |
| `iot` | integrations | no |  | IoT: MQTT, registro de dispositivos y SenML |
| `agents.orchestrator` | ai | no | `agents` | Orquestador de agentes (ReAct y herramientas) |
| `timeseries` | data | no |  | Series temporales (ScyllaDB y Grafana) |
| `workflow` | integrations | no |  | Motor de flujos (disparador y acción) |
| `multiTenant` | security | no |  | Multi-tenant con aislamiento por fila |
| `compliance` | security | no |  | Cumplimiento y auditoría inmutable |
| `cache` | platform | sí |  | Caché LRU y Redis con invalidación por etiquetas |
| `enginePush` | integrations | sí |  | Avisos por engine-push de zutool (socket local): dispositivos, Telegram, Slack y email |
| `push` | integrations | no |  | Notificaciones push (FCM y APNs) |
| `queue` | platform | sí |  | Cola de trabajos persistente (reintentos, DLQ, prioridad) |
| `cells` | platform | sí |  | Celdas (Durable Objects): ver [Celdas](./07-celdas.md) |
| `resilience` | platform | sí |  | Circuit breaker |
| `crm` | business | sí |  | CRM |
| `erp` | business | sí |  | ERP |
| `collaboration` | collaboration | sí |  | Notas, tareas, comentarios y adjuntos |
| `workspace` | collaboration | sí |  | Miembros e invitaciones |
| `views` | collaboration | sí |  | Vistas guardadas |
| `timeline` | collaboration | sí |  | Línea de tiempo de actividad |
| `search` | data | sí |  | Búsqueda global |
| `metadata` | data | sí |  | Objetos y campos personalizados |
| `blogForum` | business | sí |  | Blog y foro |
| `agents.adk` | ai | sí | `agents` | Agentes de negocio (Google ADK) |
| `marketplace` | platform | sí |  | Marketplace de plugins |
| `notifications` | collaboration | sí |  | Notificaciones en la app (SSE) |
| `favoritesTags` | collaboration | sí |  | Favoritos y etiquetas |
| `webhooks` | integrations | sí |  | Webhooks salientes (Standard Webhooks): ver [Webhooks](./06-webhooks-y-hooks.md) |
| `cloudHooks` | integrations | sí |  | Cloud Code Hooks de Parse Server (`/hooks`) |
| `csv` | data | sí |  | Importación y exportación CSV |
| `emailSync` | integrations | sí |  | Sincronización de correo (IMAP y SMTP) |
| `calendarSync` | integrations | sí |  | Sincronización de calendario |
| `automation` | integrations | sí |  | Reglas de automatización |

`selectTraits(config)` aplica estas reglas al catálogo. Cuando lo cambié de una cadena de `if` a esta lista,
comprobé en siete configuraciones que salía la misma lista y en el mismo orden (`feature-catalog.test.ts`).

## Activar y desactivar

### Al arrancar

```ts
// zen.config.ts
export default {
  appId: "crm",
  features: {
    saas: true,        // activa billing
    blogForum: false,  // fuera blog y foro
    webhooks: true,
  },
};
```

- **Desactivar el núcleo** detiene el arranque con un error claro, por ejemplo `features.acl = false`.
- **Una clave desconocida** se avisa en el log: suele ser una errata, como `webhoks`.
- **Una pieza activa con una dependencia apagada** detiene el arranque. No falla a mitad de una petición.

La prueba `each optional feature can be turned off alone and the engine still composes` apaga cada pieza
opcional, una por una, y compone el motor. Así apareció que `automation` declaraba `notifications` y `emailSync`
como obligatorias (`consumes`) aunque funciona sin ellas. Ahora son opcionales (`uses:`).

### En caliente

Las piezas cargadas se pueden apagar sin reiniciar. Solo con la master key:

```bash
curl -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY" http://localhost:1337/zen/features
curl -X PUT -H "X-Parse-Master-Key: $ZENITH_MASTER_KEY" -H "content-type: application/json" \
     -d '{"enabled": false}' http://localhost:1337/zen/features/blogForum
```

- **Rutas:** las de una pieza apagada responden 404, como si no se hubiera cargado. El router sabe de qué pieza es
  cada ruta por la capacidad que la expone.
- **Trabajo en segundo plano:** los traits que trabajan fuera de las peticiones consultan
  `runtime-features.isEnabled(id)`, declarando `uses:runtime-features`. Por ejemplo, los webhooks no entregan
  mientras están apagados. Ese trabajo arranca con `startBackground()` (`core/lifecycle.ts`), que
  `createZenithApp` llama con la base de datos conectada.
- **Persistencia:** con base de datos, el estado se guarda en `_ZenithFeature` y las demás instancias lo recogen
  en 30 s.
- **Protecciones:**
  - el núcleo no se apaga;
  - no se apaga una pieza de la que dependen otras encendidas;
  - no se enciende una pieza cuyas dependencias están apagadas.
- **Límite:** en caliente solo se enciende lo que arrancó. Para cargar una pieza que no arrancó hay que poner
  `features.<id>: true` y reiniciar, porque el código no se carga en caliente.

## Ver también

- [Cómo se añade una pieza o se acopla un motor](../development/01-piezas-por-dentro.md).
- [ADR-013](../investigations/adr/13-composition-and-access.md): composición y acceso.
