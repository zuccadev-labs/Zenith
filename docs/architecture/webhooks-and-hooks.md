# Webhooks y Cloud Code Hooks

> Vigente a 2026-11-11. Decisión: [ADR-017](../architecture-decisions/ADR-017-webhooks-hooks-event-bus.md).

Zenith habla con URLs externas de dos formas:

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
