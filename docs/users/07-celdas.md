---
description: "Celdas (Durable Objects): actores con SQLite propio para el estado de una sola cosa; proveedores local y celld."
tipo: guia
---

# ¿Dónde guardo el estado que pertenece a una sola cosa?

En una celda. La decisión está en [ADR-019](../investigations/adr/19-cells.md) y el código, en
`zenith-backend/src/traits/cells/`.

Una **celda** es un actor de un solo hilo con su propia base de datos SQLite, al que se llega por nombre o por id.
Tiene la API de los Durable Objects de Cloudflare, que también implementa [celld](https://celld.dev). Úsala para
el estado que pertenece a una sola cosa: una conversación con un agente, una sala, un limitador, la ejecución de un
flujo.

|                                   | Proveedor `local` (por defecto)            | Proveedor `celld` (experimental)                              |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Dónde corre                       | En el proceso de Zenith                    | En una flota celld (uno o más nodos)                          |
| Estado                            | Un archivo SQLite por celda en `cells.dir` | El bucket de la flota (S3, GCS o Azure)                       |
| Escritor único                    | Por proceso (no compartir `dir`)           | Por flota, con época de _fencing_ y _failover_                |
| Capacidades de Zenith en la celda | Sí, por `env` (IA, herramientas…)          | Solo `env` y `vars` (los _service bindings_ están pendientes) |

## Escribir una celda

Una clase normal con constructor `(ctx, env)` es la forma más portable: corre igual en Zenith, en celld y en
Cloudflare.

```ts
// cloud/main.ts
import { Zen } from "@zuccadev-labs/zenith";

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS msgs (at INTEGER, user TEXT, text TEXT)");
  }
  async post(user, text) {
    this.ctx.storage.sql.exec("INSERT INTO msgs VALUES (?, ?, ?)", Date.now(), user, text);
    const n = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", n);
    if (n === 1) await this.ctx.storage.setAlarm(Date.now() + 24 * 3600_000); // limpieza diaria
    return n;
  }
  recent(limit = 20) {
    return this.ctx.storage.sql.exec(
      "SELECT * FROM msgs ORDER BY at DESC LIMIT ?",
      limit,
    ).toArray();
  }
  async alarm(info) {
    this.ctx.storage.sql.exec("DELETE FROM msgs WHERE at < ?", Date.now() - 7 * 24 * 3600_000);
    await this.ctx.storage.setAlarm(Date.now() + 24 * 3600_000);
  }
}

Zen.Cells.define("Room", Room, { binding: "ROOMS" });

Zen.Cloud.define("postMessage", async (req) => {
  if (!req.user) throw new Error("login required"); // los ids no son credenciales
  return await Zen.Cells.get("ROOMS", req.params.room).post(req.user.objectId, req.params.text);
});
```

También se puede extender `DurableObject`, que Zenith exporta: guarda `this.ctx` y `this.env`.

### La API

- **`env.ROOMS`** (`DurableObjectNamespace`):
  - `idFromName(nombre)` e `idFromString(hex)`; `idFromString` rechaza ids de otro espacio;
  - `newUniqueId()`;
  - `get(id)` y `getByName(nombre)`, que devuelven el _stub_.
- **El _stub_:**
  - `fetch(request)` llega al manejador `fetch()` de la celda;
  - cualquier otro método público es RPC. Los argumentos y resultados se copian con `structuredClone`;
  - los métodos que empiezan por `_` no son llamables.
- **`ctx.storage`:**
  - `get`, `put`, `delete` y `list` (`prefix`, `start`, `startAfter`, `end`, `reverse`, `limit`), y `deleteAll`;
  - `kv.get`, `kv.put`, `kv.delete` y `kv.list`, síncronos;
  - `sql.exec(query, ...bindings)`, con `toArray()`, `one()`, `raw()`, `columnNames`, `rowsRead`, `rowsWritten` y
    `databaseSize`;
  - `transaction(async txn => …)` y `transactionSync(() => …)`, que se pueden anidar;
  - `getAlarm`, `setAlarm` y `deleteAlarm`;
  - `sync()`.
- **`ctx.blockConcurrencyWhile(fn)`:** ningún otro evento entra hasta que `fn` termina. Límite: 30 s.
- **`ctx.waitUntil(promesa)`** y **`ctx.abort()`**.
- **`alarm({ retryCount, isRetry })`:** si lanza, se reintenta con espera exponencial: 2 s, 4 s… hasta
  `alarmRetries` veces.

### El modelo de concurrencia

Una celda recibe un evento a la vez:

- Las llamadas a `storage` son síncronas por dentro, así que un `get` seguido de un `put` no se entrelaza con otro
  evento.
- Un evento que espera otra cosa (`fetch`, un temporizador, otra celda) deja entrar al siguiente, como en celld y
  Cloudflare.
- Para que un leer-modificar-escribir abarque una espera, se usa `blockConcurrencyWhile`, o una cola en memoria si
  dura más de 30 s, como hacen las sesiones de agentes.

## Configuración

```ts
// zen.config.ts
export default {
  appId: "miapp",
  features: { cells: true }, // activa por defecto
  cells: {
    dir: "/var/lib/zenith/cells", // por defecto ZENITH_CELLS_DIR o .zenith/cells (más /<appId>)
    maxResidentCells: 1000,
    maxStorageBytesPerCell: 256 * 1024 * 1024,
    hibernateAfterMs: 60_000,
    kv: ["CACHE"], // env.CACHE: KVNamespace (una celda por espacio)
    queues: ["EMAILS"], // env.EMAILS: Queue, sobre la cola de trabajos
    vars: { REGION: "eu" },
  },
};
```

Un consumidor de cola se registra con `engine.cells.consume("EMAILS", async (batch, env) => { … })`. Los mensajes
sin `ack` (porque el consumidor lanza o llama a `retry()`) vuelven a la cola de trabajos con su espera.

## Administración (solo master key)

| Ruta                                         | Qué hace                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /zen/cells`                             | Proveedor, clases, celdas residentes, activaciones, hibernaciones y alarmas pendientes |
| `GET /zen/cells/:binding`                    | Celdas de una clase que existen (`local`)                                              |
| `POST /zen/cells/:binding/:name/rpc/:method` | `{ "args": [...] }`: llama a un método de la celda `:name`                             |
| `POST /zen/cells/:binding/:name/hibernate`   | Hiberna la celda ya, si está inactiva                                                  |

## Agentes

Con `cells` activa, cada sesión de `ZenithADKAgents` es la celda `ZenithAgentSession` (binding `AGENT_SESSIONS`,
nombre = `sessionId`):

```bash
curl -X POST $Z/zen/agents/crm_assistant/sessions -H "X-Parse-Master-Key: …"          # → objectId
curl -X POST $Z/zen/agents/crm_assistant/sessions/$SID/messages -d '{"input":"hola"}' …  # un turno
curl $Z/zen/agents/crm_assistant/sessions/$SID/messages …                                # historial
```

- **Historial:** el modelo recibe el historial de la sesión en cada turno (los últimos 50 mensajes).
- **Orden:** los turnos de una sesión van en orden y de uno en uno; las sesiones distintas corren en paralelo.
- **Agente:** la sesión queda ligada a su agente.
- **Compatibilidad:** `POST /zen/agents/:agentId/run` con `sessionId` toma el mismo camino.

## Proveedor celld (experimental)

1. **Instalar celld** fuera del sistema y verificar su procedencia:

   ```bash
   gh release download v0.6.3 --repo denoland/celld -p 'celld-x86_64-unknown-linux-gnu.gz'
   gh attestation verify celld-x86_64-unknown-linux-gnu.gz --repo denoland/celld
   gunzip celld-x86_64-unknown-linux-gnu.gz && chmod +x celld-x86_64-unknown-linux-gnu
   ```

   `celld deploy` y `celld dev` necesitan `esbuild` en el `PATH`.

2. **Generar el proyecto.** Cada clase va en un módulo autocontenido:

   ```ts
   import { celldDeploy, generateCelldProject } from "@zuccadev-labs/zenith";
   await generateCelldProject({
     name: "miapp",
     outDir: "./celld",
     classes: [{ className: "Room", binding: "ROOMS", module: "./cells/room.js" }],
   });
   ```

   Escribe estos archivos:
   - `wrangler.json`, con los bindings y la migración `new_sqlite_classes`;
   - `zenith-entry.js`, que envuelve cada clase como subclase de `DurableObject`, porque celld y Cloudflare solo
     aceptan RPC en esas;
   - `zenith-router.js`;
   - una copia de cada módulo.

3. **Desplegar:** `celldDeploy({ projectDir: "./celld", bucket: "s3://…" })` ejecuta `celld deploy`. Los nodos se
   arrancan con `celld --bucket …` (ver la documentación de celld). `ZENITH_CELLS_TOKEN` debe llegar a los nodos
   como variable del Worker. No va en `vars`, porque `vars` se guarda en el bucket.

4. **Usarlo desde Zenith:**

   ```ts
   cells: {
     provider: "celld",
     celld: { url: "https://cells.interno:8080", tokenEnv: "ZENITH_CELLS_TOKEN", experimental: true },
   }
   ```

   `Zen.Cells.get("ROOMS", "sala-1").post(…)` viaja por HTTP al _router_, que exige el token.

Para desarrollo, `startCelldDev({ projectDir, port, token })` arranca `celld dev` con el token en `.dev.vars`
(modo 0600).

## Diferencias

**Del proveedor `local` respecto a celld y Cloudflare:**

- **Durabilidad:** es la del disco local (WAL con `synchronous=FULL`). No hay bucket ni réplicas. `sync()` vuelve
  enseguida.
- **Isolate:** el código de las celdas comparte isolate con Zenith. Las celdas son código de confianza.
- **Faltan:** WebSockets hibernables, facets, _stubs_ como argumentos de RPC, jurisdicciones y la coalescencia
  automática de escrituras sin `await`. Cada `put` es atómico por sí mismo; para agrupar escrituras se usa
  `transactionSync`.
- **`sql.exec`:** rechaza `ATTACH`, `VACUUM INTO`, los PRAGMA que no sean de lectura del esquema y las tablas
  `_cf_*`/`_zc_*`.
- **`deleteAll()`:** no borra la alarma.
- **KV:** las lecturas son consistentes (un solo escritor), y `cacheTtl` y el mínimo de 60 s de `expirationTtl` no
  se aplican.
- **Queue:** lotes de un mensaje, y `attempts` siempre vale 1.

**Del proveedor `celld`:**

- El RPC viaja como JSON: sin `Map`, `Date` ni binarios.
- `newUniqueId()` es `newUniqueIdAsync()`.
- El id hexadecimal de un nombre lo calcula celld (`resolveId`).
- KV y Queue no están cableados.

## Pruebas

```bash
cd zenith-backend
TMPDIR=$HOME/.cache/zutool-tmp deno test -A --no-check --unstable-kv tests/unit/cells-*.test.ts
```

- **`cells-local`:** ids, _input gate_, `blockConcurrencyWhile`, hibernación, alarmas (reintentos, reinicio),
  storage, SQL, transacciones y límites.
- **`cells-bindings`:** KV, Queue, `Zen.Cells` y rutas de administración.
- **`cells-agents`:** las sesiones de agentes como celdas.
- **`cells-celld`:** proyecto generado, _router_, cliente HTTP y la prueba _end-to-end_ contra `celld dev`. Esta
  última se salta si no hay `CELLD_BIN` y `ESBUILD_DIR`, ni copias en `$HOME/.cache/zutool-tmp/celld-bin`.
