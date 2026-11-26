---
description: "Webhooks salientes con Standard Webhooks, Cloud Code Hooks de Parse Server y los validadores de Zen.Cloud."
tipo: guia
---

# ¿Cómo aviso a otros sistemas y cómo dejo que una URL externa resuelva Cloud Code?

Con webhooks para avisar de lo que ya pasó, y con Cloud Code Hooks para que una URL externa conteste durante la
petición. La decisión está en [ADR-017](../investigations/adr/17-webhooks-hooks-event-bus.md).

Las dos formas, una al lado de la otra:

| | Webhooks (`/zen/webhooks`) | Cloud Code Hooks (`/hooks`, Parse Server) |
|---|---|---|
| Para qué | Avisar de eventos: `Contact.created`, `Deal.won`… | Que una URL externa resuelva una función de Cloud Code o un trigger |
| Cuándo | Después, de forma asíncrona y con reintentos | Durante la petición, de forma síncrona |
| Formato | Standard Webhooks 1.0 | El de Parse Server, más la firma Standard Webhooks |
| Pieza | `webhooks` | `cloudHooks` |

Las dos son solo para la master key y se pueden apagar en caliente (`/zen/features`).

## Webhooks

```bash
zen webhook create --url https://api.example.com/zenith --events "Contact.*,Deal.won" --name crm
# ⚠️  Secret (solo visible ahora): whsec_…
# Configura el secreto en el receptor y verifica el endpoint (hasta entonces no recibe nada):
zen webhook verify <id>
zen webhook messages <id>            # estado de cada mensaje
zen webhook attempts <id> <messageId>
zen webhook redeliver <id> <messageId>
zen webhook recover <id> --since 2026-11-10T00:00:00Z
zen webhook rotate-secret <id> --grace-hours 24
```

### Verificar en el receptor

Con la biblioteca oficial de Standard Webhooks (`npm i standardwebhooks`; también existe para Go, Python, Ruby,
PHP, Java, C#, Rust y Elixir):

```ts
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.ZENITH_WEBHOOK_SECRET); // whsec_…
app.post("/zenith", express.raw({ type: "application/json" }), (req, res) => {
  const event = wh.verify(req.body, req.headers); // lanza si la firma o la hora no son válidas
  // Deduplica por req.headers["webhook-id"]: no cambia entre reintentos.
  res.sendStatus(204);
});
```

- **Verificación del endpoint:** una petición con la cabecera `webhook-challenge` no es una entrega. Se responde
  con `webhook-challenge-response: v1,base64(HMAC(HMAC(clave, "wev-v1"), desafío))`, donde `clave` son los bytes
  del secreto (`whsec_…` decodificado). Así lo define la extensión `endpoint-verification` de Standard Webhooks.
- **Responder rápido:** el receptor debe responder 2xx en menos de 15 s y hacer el trabajo después.
- **Retirar un endpoint:** 410 Gone lo desactiva al momento.
- **Throttling:** 429 o 503 con `retry-after` retrasa el siguiente intento.

### Producción

| Variable | Para qué |
|---|---|
| `WEBHOOK_SECRETS_KEY` | Cifra los secretos de los endpoints en la base. Igual en todas las réplicas. Sin ella se guardan en claro y se avisa |
| `ZENITH_WEBHOOKS_ALLOW_PRIVATE=1` | Solo desarrollo: permite `http` y destinos privados (localhost) |

**Protección SSRF de Zenith:**
- solo `https`;
- todas las direcciones del host tienen que ser públicas: fuera loopback, redes privadas, link-local y metadatos
  de nube;
- sin redirecciones;
- 15 s por intento.

**Para eliminar el riesgo de DNS rebinding:** las entregas deben salir por un proxy de salida que filtre destinos
(por ejemplo smokescreen) en una subred propia, y publicar las IP de salida para que los receptores las puedan
admitir.

## Cloud Code Hooks (Parse Server)

```bash
curl -X POST -H "X-Parse-Master-Key: $MASTER" -H "content-type: application/json" \
  -d '{"functionName":"score","url":"https://hooks.example.com/score"}' http://localhost:1337/hooks/functions
curl -X POST -H "X-Parse-Master-Key: $MASTER" -H "content-type: application/json" \
  -d '{"className":"GameScore","triggerName":"beforeSave","url":"https://hooks.example.com/gs"}' http://localhost:1337/hooks/triggers
curl -X PUT  -H "X-Parse-Master-Key: $MASTER" -d '{"__op":"Delete"}' http://localhost:1337/hooks/functions/score
```

**El receptor:**
- recibe `POST` con `{ functionName, params, master, user, … }` o `{ triggerName, object, original, … }`;
- responde `{ "success": … }` o `{ "error": { "code": 141, "error": "…" } }`;
- en `beforeSave`, un objeto en `success` cambia el objeto antes de guardarlo.

**Triggers soportados:** `beforeSave`, `afterSave`, `beforeDelete`, `afterDelete`, `beforeFind` y `afterFind`.

| Variable | Para qué |
|---|---|
| `PARSE_SERVER_WEBHOOK_KEY` o `ZENITH_WEBHOOK_KEY` | Se envía en `X-Parse-Webhook-Key`, como en Parse Server |
| `ZENITH_HOOKS_SECRET` (`whsec_…`) | Firma cada llamada con Standard Webhooks; el receptor la verifica como un webhook |

Respecto a Parse Server:
- el cuerpo no lleva credenciales ni las cabeceras del cliente;
- las llamadas tienen tiempo límite y protección SSRF;
- un hook `after*` que falla no deshace la operación.

## Cloud Code en el proceso: validadores y triggers de `Zen.Cloud`

```ts
// Solo master (por defecto, ADR-013): sin validador, o con solo `fields`.
Zen.Cloud.define("recalcular", async () => { /* … */ });

// Usuarios con sesión, y API keys con functions:invoke; los params se validan como en Parse.
Zen.Cloud.define("comentar", async (req) => { /* … */ }, {
  requireUser: true,
  fields: { texto: { required: true, type: "string" }, tono: { options: ["neutro", "formal"], default: "neutro" } },
});

// Cualquiera, sin sesión.
Zen.Cloud.define("estado", () => "ok", { public: true });

// Triggers: corren en el servidor real (antes no se ejecutaban).
Zen.Cloud.beforeSave("Todo", (req) => {
  if (!req.object.title) throw new Error("title is required"); // → 400 { code: 142, error: "title is required" }
  req.object.slug = String(req.object.title).toLowerCase();    // se guarda
}, { requireUser: true, fields: { owner: { constant: true } } });
```

**Validadores** (`traits/cloud/validator.ts`) con la semántica de Parse Server:

- La master key se salta el validador, salvo con `validateMasterKey: true`.
- Comprueban `requireMaster`, `requireUser`, `requireAnyUserRoles` y `requireAllUserRoles`.
- `fields` admite `required`, `type`, `default`, `options` (lista o función) y `constant`. En un update, un campo
  `constant` recupera su valor original.
- Si falla, la respuesta es 400 con `code: 142` y el texto "Validation failed. …".

**Quién puede llamar a una función** es una decisión de Zenith (ADR-013):

- solo master por defecto;
- `requireUser` o roles la abren a usuarios;
- `public: true`, a cualquiera.

Una función inexistente responde como una cerrada.

**Errores:**

- Un error lanzado en un `before*` o en `afterFind` llega al cliente como 400 / 142 con su mensaje. Un `ZenithError`
  conserva su código.
- `response.error(código, mensaje)` responde 400 con ese código.
- Un fallo en `afterSave`/`afterDelete` se registra en el log y no se devuelve, porque el objeto ya está guardado.

**Qué triggers corren:**

| Triggers | Dónde corren |
|---|---|
| `beforeSave`, `afterSave`, `beforeFind`, `afterFind`, `beforeDelete`, `afterDelete` | CRUD de `/classes` |
| `beforeSaveFile`, `afterSaveFile`, `beforeDeleteFile`, `afterDeleteFile` | almacenamiento de archivos |
| `beforeLogin`, `afterLogin`, `beforeLogout`, `afterLogout` | engine-auth (ver abajo) |

`beforeLogin` corre después de comprobar las credenciales y antes de crear la sesión. Si rechaza el login, se revoca
también lo que engine-auth ya había emitido. El logout no se bloquea nunca.

Los de LiveQuery, media y `beforePasswordResetRequest` todavía no corren: al registrarlos se avisa en el log (ver
[Lo que falta](../development/10-lo-que-falta.md)).

Funcionan igual en `zen dev` y en una app compilada, porque se leen del registro global en el momento de ejecutarse.
