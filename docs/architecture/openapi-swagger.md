# OpenAPI y Swagger en Zenith

> Vigente a 2026-11-10. Sustituye a la versión anterior, que afirmaba que el servidor y el generador
> compartían la misma fuente. No era cierto: el generador perdía entre el 26 % y el 38 % de las rutas.

## Una sola lista de rutas

`zenith-backend/src/core/route-collection.ts` decide qué rutas sirve el motor:

- **Rutas de los traits:** cada trait expone las suyas bajo una capacidad cuya clave contiene
  `routes`. Vale cualquier forma: `crud-routes`, `user_routes`, `routes`…
- **Rutas fuera de los traits:** `GET /health` (`HEALTH_ROUTE`) y `/zen/api-keys`
  (`apiKeyRouteSpecs()` en `security/api-keys/routes.ts`, que sale de la misma función que crea los handlers).

Esa lista la usan tanto el router (`buildDynamicRouter`) como el generador
(`generateOpenApiFromState`). La prueba `tests/unit/openapi-parity.test.ts` compara lo que monta el
router con lo que documenta la spec. Lo hace con las features por defecto (230 rutas) y con todas
(274). Falla si sobra o falta una ruta, o si la seguridad documentada no coincide con la exigida.

## Seguridad documentada = seguridad aplicada

Cada operación toma su `security` del `access` de la ruta, igual que la aplica el pipeline (ADR-013):

| `access` | `security` en la spec |
|---|---|
| `public` | `[]` |
| `user` | sesión (`sessionToken`, `jwtRs256`); API key (`apiKeyBearer`, `apiKeyHeader`) solo si la ruta declara `scope`, que aparece en la lista del esquema. Si es `per-operation`, lo explica la extensión `x-api-key-scope` |
| `master` o sin declarar | `masterKey` (solo se acepta desde localhost) |

Una ruta puede sobrescribirla con `_openapi.security`.

## Dónde se genera

| Qué | Cómo | Contenido |
|---|---|---|
| Servidor en marcha | `GET /openapi.json` y `GET /swagger` (públicas) | Las rutas montadas, más `POST /functions/<fn>` y `POST /jobs/<job>` por cada función y job registrados en `cloud/` |
| Un proyecto, sin arrancarlo | `zen generate openapi` (o `docs`) | Compone los traits que eligen `features` y `topology` de `zen.config.ts`, sin base de datos. Termina con error si la spec sale vacía |
| Desde código | `generateProjectOpenApi(config)` de `@zuccadev-labs/zenith/openapi` | Lo mismo que `zen generate openapi` |
| El motor | `deno run -A --unstable-kv scripts/generate-openapi.ts [--all-features]` en `zenith-backend/` | Escribe `swagger.json` |

Con `zen dev` las rutas cuelgan de la raíz (`/swagger`). En el arranque multi-app de
`apps.config.ts` cuelgan del `mountPath` de cada app (por ejemplo `/parse/swagger`). Un binario hecho
con `zen compile` sirve la misma spec, porque se genera en memoria a partir del código enlazado.

## barrits y OpenAPI

Desde barrits 0.3.1, `generateOpenApiFromState` delega el documento en `generateOpenApiFromRoutes`
(`@zuccadev-labs/barrits/schema/openapi`), el generador por rutas de barrits. Zenith le pasa:

- **Las rutas:** las de `route-collection.ts`, más `extraRoutes`. Son las mismas que monta el router.
- **Los valores por defecto de Zenith,** como metadatos de cada ruta: ejemplos de parámetros de ruta y
  respuestas con `ZenithError`.
- **La seguridad, los esquemas y las etiquetas:** `securityFor` (tabla anterior), los esquemas
  `Zenith*`, los esquemas de seguridad y `providerToTag`.

Después añade lo que barrits no cubre: `info.x-app-id`, `x-api-key-scope` y las rutas de `/openapi.json`
y `/swagger`.

barrits falla si dos rutas tienen el mismo método y ruta, o el mismo `operationId`, en vez de
documentar solo una. Así apareció `/health` montado dos veces, y `/zen/apikeys` (workspace) y
`/zen/api-keys` compartiendo un `operationId`. Los `operationId` usan el formato de barrits
(`get_users_By_id`, `get_zen_api_keys`). El anterior (`getusersid`) quitaba la puntuación y podía
repetirse. El cambio se hizo antes de publicar Zenith, así que ningún cliente generado depende del
formato anterior.

El generador antiguo de barrits (`generateOpenApiSchema`) sigue sin servir a Zenith: documenta un
endpoint por trait.
