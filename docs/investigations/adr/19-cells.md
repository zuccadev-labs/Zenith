# ADR-019 — La celda (Durable Object) como unidad estándar de trabajo con estado, local o sobre celld

> **Estado:** Aceptada (fase 1 implementada; proveedor `celld` experimental)
> **Fecha:** 2026-11-19
> **Deciders:** product owner de Zenith, equipo de backend
> **Supersedes:** none
> **Related:** `zenith-backend/src/traits/cells/*`, `src/traits/agents/adk.agents.trait.ts`,
> `tests/unit/cells-*.test.ts`, [docs/architecture/cells.md](../architecture/cells.md),
> [ADR-013](ADR-013-composition-and-access.md), [ADR-017](ADR-017-webhooks-hooks-event-bus.md);
> celld 0.6.3 (https://celld.dev, https://github.com/denoland/celld, Apache-2.0)

## Contexto

Zenith guarda casi todo su estado en la base de datos común (MongoDB o ScyllaDB) y el resto en memoria de cada
proceso. Faltaba una pieza para el estado que pertenece a **una sola cosa** y que necesita **un solo escritor**:
una conversación con un agente, una sala, un limitador de peticiones, la ejecución de un flujo. Los síntomas:

- **Agentes:** `ZenithADKAgents.run(agentId, input, ctx, sessionId)` guardaba la sesión en `ADKSession`, pero
  nunca pasaba el historial al modelo. Dos turnos simultáneos de la misma sesión se pisaban, porque cada uno
  reescribía `messages`.
- **Orquestador, `realtime` y `ratelimit`:** viven en `Map`s de un proceso. No sobreviven a un reinicio y no se
  reparten entre nodos.
- **`workflow`:** programa con `setInterval` y una conversión aproximada de cron. No tiene pasos duraderos.

celld (Deno, Apache-2.0, v0.6.3) es un runtime autoalojado de **Durable Objects** compatible con Cloudflare.
Cada objeto es una **celda**: un actor de un solo hilo con su propia base de datos SQLite. Tiene un escritor
único por celda, con época de _fencing_. La conmutación por fallo tarda unos 20 s y una celda hibernada despierta
en unos 4 ms. El estado vive en un bucket S3, GCS o Azure, y se despliega con `celld deploy` desde un
`wrangler.json`. Encima ofrece KV, Queues, D1, R2, Workflows y Cron, todos construidos sobre celdas.

El product owner pidió que celld sea el motor de uso y el estándar de todo en Zenith, empezando por los agentes.

### Qué tiene celld y qué tenía Zenith

| Primitiva de celld                                                  | Zenith antes                                                   | Zenith con esta decisión (fase 1)                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Durable Object / celda: escritor único, SQLite propio, _input gate_ | No existía. Estado en la base común o en memoria               | **`cells`**, proveedor `local`: una instancia por id, un archivo SQLite por celda, _input gate_, `blockConcurrencyWhile`   |
| `DurableObjectNamespace`/`Id`/`Stub`, `fetch` y RPC                 | —                                                              | Lo mismo, con ids HMAC por app y clase como en celld, `fetch` y RPC con copia estructurada                                 |
| `ctx.storage`: KV, `sql.exec`, transacciones                        | Base común por clase (`db`)                                    | `get/put/delete/list/deleteAll`, `kv.*` síncrono, `sql.exec`, `transaction`/`transactionSync`                              |
| Alarmas (una por objeto)                                            | `delayMs` de la cola y `setInterval` de `workflow`             | `setAlarm`/`getAlarm`/`deleteAlarm` y `alarm(info)`, con reintentos. Despiertan celdas hibernadas y sobreviven a reinicios |
| Hibernación y desalojo por inactividad                              | —                                                              | Hibernación tras `hibernateAfterMs`; vuelve desde SQLite                                                                   |
| Límites de residencia y por objeto                                  | —                                                              | `maxResidentCells` (LRU), `maxStorageBytesPerCell`, 30 s en `blockConcurrencyWhile`                                        |
| Propiedad por escritura condicional en bucket, época, _failover_    | `federation` (CRDT LWW) y gRPC/ZeroMQ, sin escritor único      | Un proceso por directorio en `local`. Lo distribuido es `celld`                                                            |
| Replicación LTX y RPO 0                                             | Copias de Mongo ([ADR-010](ADR-010-backup-strategy.md))        | `local`: WAL con `synchronous=FULL` en disco local. `celld`: el bucket                                                     |
| KV                                                                  | `cache` (LRU/Redis) y `Zen.Config` (Deno KV)                   | Binding `KVNamespace` sobre una celda por espacio, como celld                                                              |
| Queues                                                              | `queue` (`_Job`, reintentos, DLQ)                              | Binding `Queue` y consumidor `queue(batch, env)` sobre `queue`                                                             |
| R2                                                                  | `storage`/`files` (RustFS/S3)                                  | Pendiente: binding R2 sobre `storage`                                                                                      |
| D1                                                                  | `db` (Mongo/Scylla)                                            | Pendiente. El caso por objeto ya lo cubre `sql.exec`                                                                       |
| Workflows (pasos duraderos)                                         | `workflow` (pipelines con historial)                           | Pendiente: sobre celdas y alarmas                                                                                          |
| Cron Triggers (una vez por ocurrencia en la flota)                  | `workflow.scheduleWorkflow` (`setInterval`)                    | Pendiente: sobre alarmas                                                                                                   |
| WebSockets hibernables, facets                                      | `realtime` (WS en memoria)                                     | Pendiente                                                                                                                  |
| Workers, Dynamic Workers, Containers                                | Cloud Code, `runner` (workers de Deno), `edge` (WASM)          | Sin cambios. El _entry_ generado para celld es un Worker                                                                   |
| Agentes como celdas                                                 | Sesiones en `ADKSession` sin historial; orquestador en memoria | Sesiones ADK como celdas, el camino por defecto si `cells` está activa                                                     |

## Decisión

1. **La celda es la unidad estándar del trabajo con estado de Zenith.** Las sesiones y conversaciones de agentes,
   las salas, los limitadores y las ejecuciones de flujos se modelan como celdas: estado propio, un escritor y un
   evento a la vez. La base común queda para los datos compartidos y consultables (clases de Parse, CRM…).
2. **La superficie es la de Cloudflare Durable Objects, que celld implementa.** Comprende
   `DurableObjectNamespace` (`idFromName`, `idFromString`, `newUniqueId`, `get`, `getByName`),
   `DurableObjectId` y `DurableObjectStub` (`fetch` y RPC), y `DurableObjectState`
   (`storage` con KV, `sql.exec`, transacciones y alarmas, `blockConcurrencyWhile`, `waitUntil`, `abort`).
   Se completa con los bindings `KVNamespace` y `Queue`. R2, Workflows y Cron siguen la misma regla cuando se
   añadan.
   - **Portabilidad:** una clase escrita contra `ctx` y `env`, como clase normal con constructor `(ctx, env)`,
     corre sin cambios en Zenith, en celld y en Cloudflare.
   - **RPC en celld y Cloudflare:** el RPC exige `extends DurableObject` de `cloudflare:workers`. Deno no puede
     importar ese módulo, así que el _entry_ generado envuelve cada clase normal en esa subclase.
3. **La capacidad `cells` vive en el trait `ZenithCells`** (pieza `cells`, activa por defecto y perezosa: no toca
   disco hasta que corre una celda). Se configura con `config.cells` tras la composición. Cloud Code la usa con
   `Zen.Cells.define(clase, Clase, { binding })` y `Zen.Cells.get(binding, nombre)`. Las rutas de administración
   son solo para la master key: `GET /zen/cells`, `GET /zen/cells/:binding`,
   `POST /zen/cells/:binding/:name/rpc/:method` y `POST /zen/cells/:binding/:name/hibernate`.
4. **Hay dos proveedores:**
   - **`local`** (por defecto; desarrollo y un nodo):
     - un escritor por id en este proceso y un archivo SQLite por celda (`node:sqlite`, sin dependencias);
     - el _input gate_ entrega un evento por macrotarea, así que el código no se entrelaza hasta que espera algo
       que no es storage, como en celld;
     - `blockConcurrencyWhile` y `transaction` cierran la puerta, con un límite de 30 s que reinicia la celda;
     - alarmas indexadas en `_index.sqlite`, con reintentos exponenciales;
     - hibernación por inactividad y límites de residencia y de tamaño.
   - **`celld`** (producción distribuida; **experimental**, exige `cells.celld.experimental: true`):
     - Zenith genera el proyecto Wrangler con `generateCelldProject`: `wrangler.json` con los bindings y la
       migración `new_sqlite_classes`, el _entry_ que envuelve las clases y un _router_;
     - lo despliega con `celld deploy` o lo arranca con `celld dev`, usando el binario que se indique
       (`CELLD_BIN`); Zenith nunca instala celld;
     - las llamadas llegan por HTTP con `CelldCellsClient`, a
       `/__zenith/cells/<BINDING>/<name:…|id:…>/{rpc/<método>|fetch/…|id}`, con token _bearer_
       (`ZENITH_CELLS_TOKEN`). Sin token configurado, el _router_ responde 503.
5. **Agentes primero.** Con `cells` activa, cada sesión ADK es la celda `ZenithAgentSession` (binding
   `AGENT_SESSIONS`, nombre = `sessionId`):
   - guarda el historial en su SQLite y lo pasa al modelo en cada turno;
   - los turnos de una sesión van en orden y de uno en uno, con una cadena en memoria, porque una llamada al modelo
     puede pasar de los 30 s de `blockConcurrencyWhile`; las sesiones distintas corren en paralelo;
   - la sesión queda ligada a su agente.

   El contexto de la petición llega a las herramientas por referencia, no por RPC. `AgentSessionCell` solo
   depende de `env.AGENT_RUNTIME`, así que la misma clase puede ir a celld.

## Migración del trait de agentes

- **`ZenithADKAgents`:** `run(agentId, input, ctx, sessionId)` toma el camino de la celda cuando existe `cells`.
  Conserva la forma del resultado y añade `turn` y `backend: "cells"`. `ADKSession.messages` sigue escribiéndose,
  ahora como espejo de toda la conversación. Se añaden `history()`, `sessionBackend` y
  `GET`/`POST /zen/agents/:agentId/sessions/:sessionId/messages`. Sin `cells` (`features.cells: false`), el camino
  anterior queda igual. Es el camino por defecto porque las pruebas lo cubren: historial, orden, paralelismo entre
  sesiones, hibernación, reinicio, contexto de las herramientas y API anterior (`tests/unit/cells-agents.test.ts`).
- **`ZenithAgentOrchestrator`** (`agents.orchestrator`, experimental y apagado por defecto) aún no se migra.
  El paso siguiente es que `runAgent` acepte `sessionId` y use la misma celda.
- **Sesiones anteriores en `ADKSession`:** no se copian. Su historial no llegaba al modelo, y la celda empieza
  vacía con el mismo `sessionId`.

## Seguridad

- **Aislamiento:**
  - en `local`, el código de una celda corre en el mismo isolate que Zenith: las celdas son código de confianza
    (Cloud Code, traits), no código de usuarios, que sigue yendo a `runner` o `edge`;
  - entre celdas, el aislamiento es de datos: un archivo por celda, sin API para leer otra, y `sql.exec` rechaza
    `ATTACH`/`DETACH`, `VACUUM INTO`, los PRAGMA que no sean de lectura del esquema y las tablas `_cf_*`/`_zc_*`;
  - el RPC copia argumentos y resultados (`structuredClone`), así que ninguna celda recibe referencias vivas de
    otra.
- **Cuotas por celda** (`local`): tamaño máximo de la base (`PRAGMA max_page_count`; la escritura que lo supera
  falla con `storage_limit` y se revierte), claves de 2 KiB y valores de 2 MiB, 30 s en `blockConcurrencyWhile`, y
  celdas residentes limitadas: hiberna la menos usada o falla con `capacity`. No hay cuota de CPU ni de memoria
  por celda.
- **Ids:** no son credenciales: un nombre se puede derivar. La autorización la comprueba el código que llama, sea
  una función de Cloud Code o una ruta.
  - Las rutas `/zen/cells` y las de sesiones de agentes son solo para la master key.
  - Antes de abrir las sesiones a usuarios hay que comprobar que la sesión es del usuario.
- **celld:**
  - el token _bearer_ se compara en tiempo constante, y sin token configurado todo falla (503);
  - el tráfico entre nodos de celld es HTTP plano, así que van en red privada o WireGuard/Tailscale, con TLS en el
    _ingress_;
  - las credenciales del bucket equivalen a administrar la flota;
  - `vars` se guarda en el bucket, así que nunca lleva secretos.
- **Binario:** celld se verifica con su atestación de procedencia (`gh attestation verify --repo denoland/celld`)
  y se instala fuera del sistema. Zenith no lo descarga.

## Alternativas consideradas

### Seguir con la base común más bloqueos

Un documento por sesión en Mongo con `updateIf` (concurrencia optimista) y reintentos.

**Pros:**

- No añade piezas.

**Cons:**

- Cada turno pasa por la base común, con reintentos bajo contención.
- No hay alarmas ni hibernación.
- No resuelve salas, limitadores ni flujos.
- No es portable a celld ni a Cloudflare.

### Adoptar celld como único runtime desde ya

Todo el estado de celdas en una flota celld, sin proveedor local.

**Pros:**

- Distribuido y con _failover_ desde el primer día.

**Cons:**

- Obliga a tener un bucket y nodos celld incluso en desarrollo y en instalaciones de un nodo.
- Las celdas no ven las capacidades en proceso de Zenith (IA, `db`) sin _service bindings_, que aún no existen.
- celld es beta (0.6.3).

### API propia de actores

Una interfaz de Zenith distinta de la de Durable Objects.

**Pros:**

- Libertad de diseño.

**Cons:**

- No es portable.
- Reinventa semánticas (_input gate_, alarmas) que celld y Cloudflare ya definen y prueban.

## Consecuencias

### Positivas

- Las sesiones de agentes tienen memoria real y orden por sesión, y una sesión inactiva no ocupa memoria.
- Una clase de celda se mueve de `local` a celld o a Cloudflare sin reescribirse. Lo comprueba la prueba
  _end-to-end_ contra celld 0.6.3: la misma clase de `tests/fixtures/cells/counter-cell.js` corre en los dos
  proveedores, con 25 llamadas concurrentes serializadas, `fetch`, alarma y persistencia tras reiniciar el nodo.
- KV y Queues se integran con la cola duradera existente, en lugar de duplicarla.

### Negativas

- **`local` no es distribuido:** dos procesos no deben compartir `dir`. Para varios nodos hace falta celld.
- **Semántica más débil que la de celld** (ver [cells.md](../architecture/cells.md#diferencias)):
  - no hay _output gate_ porque no hace falta: cada escritura ya está en disco al volver;
  - el _input gate_ es por macrotarea;
  - la durabilidad es la del disco local, no la de un bucket.
- **Limitaciones del proveedor `celld` en esta fase:** el RPC viaja como JSON, sin `Map`, `Date` ni binarios;
  `newUniqueId()` es asíncrono (`newUniqueIdAsync`); y cada módulo de celda debe ser autocontenido.

### Neutrales

- Pieza nueva en el catálogo: `cells` (`features.cells`), con `config.cells` y la variable `ZENITH_CELLS_DIR`.
- `swagger.json` incluye las rutas nuevas.

## Lo que NO está hecho

- **Proveedor `celld` en producción:** no se ha probado `celld deploy` contra un bucket real ni una flota de varios
  nodos. La prueba usa `celld dev`, un nodo con almacén local. Por eso sigue siendo experimental.
- **Celdas en celld con capacidades de Zenith:** faltan _service bindings_ de vuelta a Zenith (IA, `db`, herramientas).
  Hasta entonces, `AgentSessionCell` solo corre en celld si se le da otro `AGENT_RUNTIME`.
- **Bindings:** faltan R2 sobre `storage`, Workflows y Cron sobre alarmas, D1, WebSockets hibernables y facets.
  En celld no hay KV ni Queue cableados.
- **Migraciones:** de `realtime` (salas), `ratelimit`, `workflow` y el orquestador de agentes a celdas.
- **Cuotas:** de CPU y de peticiones por celda, y métricas de celdas en `observability`.
- **Sesiones abiertas a usuarios:** comprobar que la sesión pertenece al usuario.

## Referencias

- celld: [README](https://github.com/denoland/celld#readme),
  [Durable Objects](https://github.com/denoland/celld/blob/main/docs/services/durable-objects.md),
  [compatibilidad con Cloudflare](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md),
  [garantías](https://github.com/denoland/celld/blob/main/docs/guarantees.md),
  [limitaciones](https://github.com/denoland/celld/blob/main/docs/limitations.md)
- Cloudflare: [Durable Objects](https://developers.cloudflare.com/durable-objects/),
  [reglas de Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- Guía: [docs/architecture/cells.md](../architecture/cells.md)
