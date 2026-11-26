# Piezas y motores de Zenith

> Vigente a 2026-11-11. Código: `zenith-backend/src/core/feature-catalog.ts`, `src/traits/catalog.ts`,
> `src/core/runtime-features.ts`.

Zenith es un motor armado con piezas. Cada funcionalidad es un **trait de barrits**, el núcleo de composición, o
un grupo pequeño de ellos. Cada pieza declara qué capacidades **provee** (`provides`), cuáles **necesita**
(`consumes`) y cuáles **usa si existen** (`uses:<capacidad>`). barrits las compone y las ordena para que cada
proveedor exista antes que sus consumidores. Así, cada pieza se puede mejorar, sustituir o apagar por separado.

## El catálogo: una sola lista de piezas

`src/traits/catalog.ts` es la lista de todas las piezas. Cada entrada tiene:

| Campo | Para qué |
|---|---|
| `id` | Nombre estable. Se usa en `features.<id>`, en `/zen/features/<id>` y en los logs |
| `group` | `core`, `data`, `security`, `transport`, `integrations`, `business`, `collaboration`, `ai`, `platform` |
| `traits` | Los traits que la forman, en orden de arranque |
| `required` | Núcleo: base de datos, usuarios, ACL, CRUD, Cloud Code, archivos… No se puede apagar |
| `default` | Estado cuando `zen.config.ts` no dice nada |
| `feature` | Clave histórica, si no coincide con el id (`saas` → `billing`, `e2ee_media` → `e2eeMedia`) |
| `when` | Condición de despliegue (`topology`, tipo de base de datos) |
| `requires` | Otras piezas sin las que esta no puede funcionar |

`selectTraits(config)` ya no es una cadena de `if`: aplica estas reglas al catálogo. Produce exactamente la misma
lista y el mismo orden que antes, comprobado en siete configuraciones (`feature-catalog.test.ts`).

### Activar y desactivar al arrancar

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

### Encender y apagar en caliente

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

## Añadir una funcionalidad

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
