---
description: "Cómo se escribe una pieza nueva del motor y cómo se acopla un motor externo con un trait adaptador."
tipo: guia
---

# ¿Cómo añado una pieza al motor o acoplo un motor externo?

Una pieza es un trait de barrits con su entrada en el catálogo; un motor externo se acopla con un trait adaptador
que publica una capacidad. Qué piezas hay y cómo se encienden está en
[Piezas y motores](../users/05-piezas-y-motores.md).

## Añadir una pieza

1. **Escribe el trait** en `src/traits/<área>/<nombre>.trait.ts` con `createTraitDescriptor`. Reutiliza lo que ya
   existe:
   - `core/trait-utils.ts` (respuestas, paginación, parámetros);
   - `core/crypto.ts` (aleatorios, hashes, HMAC);
   - `security/outbound-http.ts` (peticiones salientes con protección SSRF);
   - `security/webhook-signature.ts` (Standard Webhooks);
   - `security/sanitize.ts` (quitar credenciales antes de enviar);
   - el bus de eventos (`events`, en el núcleo) para publicar y suscribirse;
   - la capa `db` y las capacidades de otros traits.
2. **Declara lo que necesita** con `consumes` y lo opcional con `uses:<capacidad>`. Lo opcional no debe romper la
   pieza si falta.
3. **Expón sus rutas** en una capacidad cuya clave contenga `routes` (`miarea_routes`), con `access` y `_openapi`.
   El router las monta, la OpenAPI las documenta y la prueba de paridad comprueba que coinciden.
4. **Añade una entrada** en `src/traits/catalog.ts` con su `id`, su `group` y su `default`.
5. Las pruebas del catálogo comprueban que la pieza no está repetida, que el motor compone sin ella y que su
   dependencia, si la tiene, está declarada.

## Acoplar motores externos

Un motor del ecosistema, como engine-auth o los motores de zutool, se acopla siempre igual: **un trait adaptador
que publica una capacidad**. Las demás piezas consumen la capacidad, sin saber si detrás hay un servicio HTTP,
una biblioteca nativa o una implementación en memoria.

| Cómo corre el motor | Cómo se acopla | Ejemplo en Zenith |
|---|---|---|
| Servicio aparte (HTTP/gRPC) | El trait llama a su API con `fetch` o el cliente gRPC, con la URL y las credenciales de `zen.config.ts` | engine-auth: login, refresco y revocación (`traits/auth/engine-auth.ts`) |
| Biblioteca nativa (`.so`/`.dll`/`.dylib`) | `openFeature("<feature>")` de `@zuccadev-labs/zutool-ffi` carga la biblioteca de esa feature por FFI; el trait expone sus funciones | Verificación local de JWT con `auth.verify` (`engine-auth.ts`) |
| Dentro del proceso | El trait implementa la capacidad directamente | Caché LRU, cola de trabajos |

Reglas:
- **Inyectable para pruebas.** El adaptador acepta su cliente o su biblioteca como opción (`fetch`, `feature`).
  Así se prueba sin el motor real, como hace `engine-auth.ts`.
- **Una capacidad por responsabilidad** (`user-manager`, `storage`, `vectordb`…). Cambiar de motor es cambiar
  de adaptador, no de consumidores.
- **Opcional cuando se puede.** Si las demás piezas pueden vivir sin el motor, lo declaran con `uses:` y el
  adaptador es una pieza más del catálogo, que se enciende y se apaga como las otras.
- **Versionado independiente.** Cada motor publica su paquete (JSR, npm o la biblioteca nativa) y Zenith fija la
  versión en `deno.json`. Mejorar un motor no obliga a tocar las demás piezas.
