# ADR-017 — Webhooks (Standard Webhooks), Cloud Code Hooks de Parse y bus de eventos en el núcleo

> **Estado:** Aceptada
> **Fecha:** 2026-11-11
> **Sustituye en parte a:** [ADR-016](ADR-016-shared-crypto-and-single-api-keys.md) (el formato de firma de webhooks)
> **Relacionado:** `src/traits/webhooks/`, `src/traits/cloud/hooks.trait.ts`, `src/traits/events/event-bus.trait.ts`,
> `src/security/outbound-http.ts`, `src/security/webhook-signature.ts`, `src/security/sanitize.ts`, `src/core/net.ts`,
> `src/core/lifecycle.ts`, `docs/architecture/webhooks-and-hooks.md`

## Contexto

1. **Dos módulos de webhooks que se solapaban:**
   - `cloud/webhook.trait.ts`: claves del proceso, `/webhooks/endpoints`;
   - `webhooks/webhook.manager.trait.ts`: endpoints por app, `/zen/webhooks`.
2. **Ninguno funcionaba de punta a punta:**
   - El bus de eventos solo existía con `features.events`, que estaba apagado por defecto. El gestor se enganchaba
     reescribiendo `events.emit`, así que con la configuración por defecto **ningún webhook se disparaba**.
   - La entrega iba en línea con quien emitía el evento: sin tiempo límite, sin protección SSRF, siguiendo
     redirecciones, con reintentos en memoria que se perdían al reiniciar y sin reentrega.
   - El payload salía con los campos del objeto tal cual, incluidos los de sesión.
3. **ADR-016 eligió el formato de firma de Stripe** (`t=,v1=`). Es una convención de un proveedor. La
   especificación neutral vigente es **Standard Webhooks 1.0** (standardwebhooks.com), que siguen OpenAI, Twilio,
   Supabase, Kong y otros, con bibliotecas oficiales en nueve lenguajes.
4. **Parse Server ofrece Cloud Code Hooks** (`/hooks/functions`, `/hooks/triggers`; `HooksRouter.js` y
   `HooksController.js` de parse-server 9.12) y Zenith no los tenía. Esto rompía la paridad con los SDK y con la
   CLI de Parse. Además, el análisis del código de Parse mostró varias carencias que conviene no copiar:
   - la clave `X-Parse-Webhook-Key` viaja en claro y sin protección contra reenvíos;
   - no hay tiempo límite ni protección SSRF;
   - se reenvían las cabeceras del cliente, incluido el token de sesión.
   Parse Server no tiene webhooks de eventos.

## Decisión

### Bus de eventos en el núcleo

`EventBusTrait` (pieza `eventBus`, núcleo) provee `events` y `eventBus`: `on`, `off` y `emit`. CRUD ya publicaba
`<Clase>.created`, `<Clase>.updated` y `<Clase>.deleted`, y los traits de negocio publican sus eventos.
`EventStreamingTrait` (`features.events`) pasa a ser el registro: se suscribe al bus, guarda en `_Event` y sirve
`/events/emit` y `/events/replay`.

### Un solo módulo de webhooks (pieza `webhooks`)

Se queda `webhooks/webhook.manager.trait.ts` y se retira `cloud/webhook.trait.ts`.

| Aspecto | Decisión | Fuente |
|---|---|---|
| Formato | Cuerpo `{type, timestamp, data}`; cabeceras `webhook-id`, `webhook-timestamp` y `webhook-signature: v1,<base64 HMAC-SHA256(id.ts.cuerpo)>` | Standard Webhooks §Payload y §Signature |
| Secreto | `whsec_` + base64 de 32 bytes, uno por endpoint, cifrado en reposo con `WEBHOOK_SECRETS_KEY` (AES-256-GCM, AAD = endpoint) | SW §Signature: 24-64 bytes, uno por endpoint |
| Rotación | El secreto anterior firma también durante `graceHours` (24 h por defecto, máximo 7 días) | SW §Signature; Stripe permite hasta 7 días |
| Entrega | Outbox en base de datos (`ZenithWebhookMessage`), reclamada con `updateIf` sobre intentos y concesión. Sobrevive a reinicios y no duplica entre instancias | Patrón transactional outbox |
| Reintentos | Inmediato, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h, con ±10 % (unas 75 h) | SW §Retry schedule |
| Respuestas | 2xx éxito; 3xx fallo (no se siguen); 410 desactiva; 429/502/503/504 respetan `retry-after` | SW §HTTP status |
| Desactivación | Tras 5 mensajes agotados seguidos, o con 410; evento `webhook.endpoint.disabled` | SW §Disabling failing endpoints |
| SSRF | Solo https; todas las direcciones del host públicas (registros de IANA); sin credenciales en la URL; 15 s por intento | SW §SSRF, OWASP API7:2023 |
| Payload | Sin `sessionToken`, `password`, `authData` ni hashes, en cualquier nivel (`security/sanitize.ts`) | — |
| API | Solo con master key: CRUD, pausar, reanudar, probar, rotar el secreto, mensajes, intentos, reentrega con el mismo `webhook-id` y recuperación desde una fecha | SW §Additional functionality |
| En caliente | Con la pieza apagada no se encola ni se entrega. Un endpoint pausado acumula los mensajes | `/zen/features` |

La interoperabilidad se comprueba en ambos sentidos con la biblioteca oficial `standardwebhooks@1.1.1`.

### Cloud Code Hooks de Parse (pieza `cloudHooks`)

Las mismas rutas, errores (143), almacén (`_Hooks`) y semántica de respuesta (`{success}`, `{error}`, objeto de
`beforeSave`) que Parse Server. Encima, Zenith añade:
- firma Standard Webhooks con `ZENITH_HOOKS_SECRET`, además de `X-Parse-Webhook-Key` para compatibilidad;
- el mismo cliente saliente seguro;
- cuerpo sin credenciales, sin reenviar las cabeceras del cliente;
- en los `after*`, un fallo se registra y no se deshace la operación.

Cada trigger registra un solo despachador, que lee la URL vigente, así que borrar o cambiar un hook surte efecto al
momento.

### Piezas compartidas

| Pieza | Uso |
|---|---|
| `core/net.ts` | IP y CIDR; lo comparten la política de API keys y el SSRF |
| `security/outbound-http.ts` | Webhooks, Hooks y la acción `send_webhook` de las automatizaciones |
| `security/sanitize.ts` | Webhooks y Hooks |
| `core/lifecycle.ts` | `startBackground()`: el trabajo en segundo plano arranca en `createZenithApp` con la base conectada, nunca al generar la OpenAPI |

## Alternativas consideradas

- **Mantener la firma de Stripe** (ADR-016). Es más conocida, pero es de un proveedor: no firma el id del mensaje,
  usa hex y no tiene bibliotecas neutrales. Standard Webhooks resuelve todo eso y es lo que hoy adoptan los
  proveedores nuevos.
- **Reutilizar la cola de trabajos** (`queue`). Guarda los trabajos en memoria y no los recarga al reiniciar, así
  que no aguanta 75 h de reintentos. La outbox vive en el módulo de webhooks. La cola debe llevarse al mismo nivel
  para compartirla (`pending.md`).
- **Un proxy de salida** (smokescreen). Es la protección SSRF completa: elimina la carrera entre la resolución y
  la conexión (DNS rebinding). Es infraestructura, así que queda recomendado en `webhooks-and-hooks.md`.

## Consecuencias

- **Cambios incompatibles, sin publicar:**
  - el formato de firma y las cabeceras de los webhooks;
  - `/zen/webhooks/:id/deliveries` pasa a `/messages`; la CLI conserva `deliveries` como alias;
  - el SDK `ZenithWebhooks` exige la master key;
  - `EventStreamingTrait` ya no provee `events`.
- **Pruebas:**
  - `webhook-signature`: interoperabilidad con la biblioteca oficial;
  - `webhook-manager`: receptor real, reintentos, 410, pausa, rotación, reentrega, recuperación, dos instancias sin
    duplicar (detecta la carrera si se quita la concesión de la condición) y pieza apagada;
  - `outbound-http`;
  - `cloud-hooks`: con el Cloud Code real.
- **Rutas:** 230 por defecto y 274 con todas las features.
- **Pendiente:**
  - en `updateObject`, los cambios de un `beforeSave` no se guardan; afecta igual a Cloud Code y a los Hooks;
  - la verificación de endpoints de Standard Webhooks (extensión opcional) no está implementada;
  - la cola de trabajos no es duradera.
