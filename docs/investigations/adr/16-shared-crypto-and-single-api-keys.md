---
description: "ADR-016 — Primitivas criptográficas compartidas, firma de webhooks y un solo sistema de API keys."
tipo: adr
estado: aceptada
---

# ADR-016 — Primitivas criptográficas compartidas, firma de webhooks y un solo sistema de API keys

> **Estado:** Aceptada
> **Fecha:** 2026-11-11
> **Relacionado:** `zenith-backend/src/core/crypto.ts`, `src/security/webhook-signature.ts`,
> `src/security/api-keys/`, `src/traits/workspace/workspace.trait.ts`, `sdk/Typescript/src/objects/ZenithFile.ts`,
> [ADR-015](./15-api-key-access-policy.md)
> **Sustituida en parte por:** [ADR-017](./17-webhooks-hooks-event-bus.md): la firma de webhooks sigue Standard Webhooks, no el esquema de Stripe

## Contexto

Al unificar las API keys apareció el mismo patrón en más sitios: cada módulo tenía su propia versión de la misma
función de seguridad, y varias copias tenían fallos.

1. **Dos sistemas de API keys.**
   - **`/zen/api-keys` (`security/api-keys`):** el que aplica los scopes, la política de IP y la caducidad
     (ADR-015).
   - **`/zen/apikeys` (trait workspace, clase `ZenithApiKey`):** guardaba las keys con SHA-256 sin sal, y ningún
     middleware las aceptaba.

   El SDK de cliente y su ejemplo para navegador usaban el segundo, con scopes que no existen (`read:*`,
   `functions`). Una key creada por un usuario habría tenido los permisos de toda la app, es decir, una escalada
   de privilegios. Además, los dos sistemas compartían `operationId`, y la spec no era OpenAPI válida.
2. **Nueve copias de las mismas primitivas:**
   - bytes aleatorios en hexadecimal (5);
   - SHA-256 en hexadecimal (7);
   - comparación en tiempo constante (2);
   - base64url (1).
3. **Firmas sin HMAC y con clave conocida.**
   - **Afectados:** las URLs firmadas de `storage` y la firma de auditoría de `compliance`.
   - **Cómo firmaban:** `sha256(datos + clave)`, que no es un MAC.
   - **Sin la variable de entorno:** la clave era `"default"`, así que cualquiera podía firmar.
4. **Secretos de API key sesgados.** `byte % 62` hace que 8 de los 62 caracteres salgan un 25 % más a menudo.
5. **Dos firmas de webhook incompatibles.**
   - **Qué firmaban:** `cloud/webhook.trait.ts` y `webhooks/webhook.manager.trait.ts` firmaban solo el cuerpo,
     con la marca de tiempo en milisegundos.
   - **Qué verificaban:** la verificación esperaba `"<t>.<cuerpo>"`, así que una firma propia nunca verificaba.
   - **En una rotación:** la clave anterior dejaba de valer al instante.
6. **Tokens de invitación en claro.** Se guardaban en la base de datos, a diferencia de los tokens de sesión,
   que ya se guardaban como hash.

## Decisión

**Clasificar cada funcionalidad de seguridad y darle un único dueño, que reutilizan todos los módulos.**

| Clase | Dueño | Contenido |
|---|---|---|
| Primitivas | `core/crypto.ts` | Aleatorios, incluido `randomString` uniforme por rechazo; hex y base64url (`@std/encoding`); SHA-256; HMAC-SHA256; comparación en tiempo constante; `signingKey` |
| Protocolo de webhooks | `security/webhook-signature.ts` | `t=<segundos>,v1=<HMAC-SHA256(t.cuerpo)>` (esquema de Stripe); tolerancia de 5 min; varios `v1` y varios secretos para la rotación |
| API keys | `security/api-keys/` | El único sistema: `/zen/api-keys`, `zen api-keys` y `ZenithAPIKey` del SDK, todos sobre `ApiKeyManager` |
| Contraseñas y API keys (hash lento) | Argon2id (`@node-rs/argon2`) | Sin cambios |

**Reglas que siguen los módulos:**
- **Firmar datos:** con HMAC (`hmacSha256Hex`), nunca concatenando y haciendo hash.
- **Clave de firma:** sale de `signingKey(ENV)`. Sin la variable no hay clave fija: se usa una clave aleatoria
  del proceso y se avisa, así que lo firmado solo vale en esa instancia hasta que se reinicia.
- **Secretos de un solo uso** (sesión, invitación): se entregan una vez y se guardan como SHA-256.
- **Comparar secretos:** con `timingSafeEqual` o `timingSafeEqualString`.
- **Gestionar API keys:** solo con la master key (ADR-015). El SDK lo comprueba antes de llamar, y el ejemplo para
  navegador explica cómo hacerlo con la CLI o desde el servidor, en vez de hacerlo.

## Alternativas consideradas

### Mantener `/zen/apikeys` como keys de usuario (estilo token personal)

**Pros:** un usuario podría crearse keys sin la master key.

**Contras:**
- Hay que diseñarlo antes. Una key tendría que actuar como su usuario (ACL y CLP del usuario, no scopes de app), y
  el middleware no lo soporta.
- Mantener dos almacenes de keys duplica la superficie de ataque.

Si se necesita, será una extensión de `security/api-keys`, por ejemplo con un campo `subject`, no un segundo
sistema.

### Utilidades criptográficas en cada trait

**Pros:** cada trait es independiente.

**Contras:** es la situación de partida, con las cuatro copias defectuosas descritas en el contexto.

## Consecuencias

- **Cambios incompatibles, sin afectar a nadie** (Zenith y `@zuccadev-labs/zenith-client` no están publicados):
  - `ZenithAPIKey.create` recibe un objeto de opciones y exige la master key;
  - los webhooks llevan `t` en segundos y firman `"<t>.<cuerpo>"`;
  - las invitaciones guardan `tokenHash`;
  - las firmas de `storage` y `compliance` cambian de valor.
- **Pruebas:**
  - `core-crypto.test.ts`: vectores FIPS 180-2 y RFC 4231, y sesgo;
  - `webhook-signature.test.ts`: la ida y vuelta firmar → verificar del trait. Falla con el código anterior;
  - `workspace-invitations.test.ts`.
- **La spec pierde las 3 operaciones de `/zen/apikeys`:** quedan 220 rutas por defecto y 264 con todas las
  features.
- **Pendiente:**
  - las URLs firmadas de `storage` no las verifica ninguna ruta;
  - hay dos traits de webhooks (`cloud/webhook` y `webhooks/webhook.manager`) que se solapan. Ver `pending.md`.
