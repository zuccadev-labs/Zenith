# ADR-013 — Composición por capacidades y acceso denegado por defecto

> **Estado:** Aceptada
> **Fecha:** 2026-11-09
> **Relacionado:** `zenith-backend/src/core/compose.ts`, `src/core/router.ts`, `src/traits/db/db.trait.ts`, ADR-012

## Contexto

`createZenithApp` no arrancaba con ninguna configuración:
- 49 traits consumían `db` y 40 consumían `telemetry`, y ningún trait proveía esas dos capacidades;
- `ZenithCoreServer` pedía nombres que no existían (`access-control`, `rate-limiting`…) y creaba `initKeys` sin
  declararlo;
- dos pares de traits declaraban el mismo estado o la misma capacidad.

Ninguna prueba arrancaba la app completa, así que nadie lo notaba.

Detrás había dos problemas de fondo:
- **Dónde se leen las dependencias:** los 66 traits leían `deps["x"]`, pero barrits entrega las capacidades en
  `deps.traits`. Ningún trait recibía nada.
- **El orden de creación:** barrits ordena por `requires` (nombres de trait) y, en caso de empate, alfabéticamente.
  Un trait que leía una capacidad al crearse dependía de cómo se llamara su proveedor.

Al arreglarlo apareció un riesgo de seguridad: 264 rutas se montarían de golpe y la mayoría no comprueba
permisos. Entre ellas, `/shell/exec`, `/runner/execute`, `/secrets/:path`, `/edge/deploy` y `DELETE /ratelimit/:key`.

## Decisión

**Composición** (`composeZenith`):
- **`consumes`:** lo que el trait no puede dejar de tener. Si falta, la composición falla.
- **Tag `uses:<capacidad>`:** lo opcional, que depende de una feature. Puede no existir, y el trait comprueba antes
  de usarlo.
- **El orden:** `requires` se calcula a partir de ambas listas, así que el proveedor siempre se crea antes que
  quien lo consume.
- **`ZenithDb`:** provee `db` sobre el adaptador que dé `database-crud` (Mongo, Scylla o Surreal), con la API que ya
  usaban los traits (`find`, `read`, `create`, `update`, `delete`, `upsert`, `updateIf`).
- **`ZenithObservability`:** provee `telemetry` (`log`, `warn`, `error`, `withSpan`).
- **ScyllaDB:** solo se conecta si la app la usa.

**Acceso** (router):
- Cada ruta declara `access`:
  - `public`;
  - `user`: usuario verificado o API key;
  - `master`: master key, `Zen-Internal-Token` o API key con alcance `*`.
- **Por defecto es `master`.** Una ruta nueva nace cerrada (OWASP, denegar por defecto).
- **Son públicas:** `/health`, `/ready`, `/version`, `/openapi.json`, `/swagger` y las rutas Parse de usuarios.
- **El límite de peticiones** usa la IP resuelta por el pipeline (H-02), no la cabecera `X-Forwarded-For` de
  cualquier cliente. Antes llamaba a un método inexistente, `checkLimit`.

## Consecuencias

- Zenith arranca con la topología mínima, con la de por defecto y con todas las features. `tests/integration/boot.test.ts`
  lo prueba contra MongoDB 9.0.4 y engine-auth reales.
- Las rutas de negocio (CRM, ERP, CRUD `/classes`, LiveQuery, funciones Cloud…) quedan **solo con master key** hasta
  revisarlas una por una y abrirlas con `access: "user"`. Ver `zenith-backend/docs/pending.md`. Es una restricción
  deliberada: abrirlas sin revisar expondría ejecución remota y secretos.
- **Funciones Cloud (2026-11-11): se abren una a una.** `POST /functions/:name` es `public` para el router y la
  decisión es de cada función, por su validador (`traits/cloud/validator.ts`):
  - sin validador, o solo con `fields`, la función sigue siendo **solo master**;
  - con `requireUser` o roles, la pueden usar los usuarios, y las API keys con `functions:invoke`;
  - con `public: true`, cualquiera.

  Una función que no existe responde igual que una cerrada, así que sin master key no se puede averiguar qué
  funciones hay.
- Para añadir un trait:
  - declara en `consumes` lo obligatorio y en `uses:` lo opcional;
  - lee las capacidades de `deps.traits`;
  - pon `access` en cada ruta.
