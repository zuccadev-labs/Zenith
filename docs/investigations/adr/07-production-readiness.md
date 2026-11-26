---
description: "ADR-007: Production Readiness Cleanup (Phase 2.H)."
tipo: adr
estado: aceptada
---

# ADR-007: Production Readiness Cleanup (Phase 2.H)

**Status**: Accepted
**Date**: 2026-06-06
**Authors**: @zuccadev
**Phase**: 2.H (Technical Debt Resolution)
**Closes**: H-8 partial, ERP test gap, boilerplate imports, 3 un-registered adapters

---

## Context

Después de cerrar las decisiones de arquitectura mayores (Phases 0–1), quedaban varias brechas técnicas concretas que impedían que Zenith fuera **production-ready en sentido estricto**:

| # | Gap | Impacto |
|---|---|---|
| G-1 | `MongoDBStore` (ADR-003) era un stub que lanzaba `Error: not implemented` | API keys no funcionaban en producción multi-nodo |
| G-2 | `tests/integration/erp.test.ts` usaba runner custom `ZenithTestSuite` que **nunca ejecutaba** los tests al ser importado por `deno test` | 6 tests ERP reportaban "0 passed" en CI |
| G-3 | `tests/integration/security.test.ts` tenía el mismo problema | 6 tests security reportaban "0 passed" |
| G-4 | `src/adapters/{git,vault,lux-cache}.adapter.ts` movidos en Phase 0.A **no se importaban en `src/mod.ts`** | `Zen.Plugins.Git/Vault/CacheAdapter` no existían al boot, errores silenciosos |
| G-5 | `example/zenith-backend-boilerplate/cloud/examples/*.ts` fallaban `deno check` por tipos `unknown` y API incorrecta | DX rota: developer que corría `deno check` veía errores |
| G-6 | `09-custom-routes.ts` usaba `Zen.API.defineRoute("GET", path, handler)` (3 args) cuando la API real es `defineRoute({...})` (1 objeto) | El example no funcionaba al ejecutarse |

---

## Decision

### 1. MongoDBStore real con lazy import + change streams

`src/security/api-keys/store.ts`:

- Implementación completa con `npm:mongodb` driver (vía `await import()` para lazy load).
- **Índices automáticos** (idempotentes) en `init()`:
  - `id` UNIQUE (lookup O(log n))
  - `appId` (listByApp O(log n))
  - `expiresAt` TTL (`expireAfterSeconds: 0`) — MongoDB borra keys expiradas
  - `rotationExpiresAt` TTL — idem para grace period de rotación
- **Change streams** opcionales (`enableChangeStream: true`) que notifican a otros nodos del cluster cuando una key se crea/actualiza/revoca. Latencia de propagación: <1s. Requiere replica set.
- **Write concern**: `majority`. **Retryable writes**: habilitado.
- **Sanitización de patches**: `update()` rechaza modificaciones a `id`, `hash`, `createdAt`, `createdBy` (defense-in-depth).
- **TTL-compatible serialization**: `expiresAt` y `rotationExpiresAt` se convierten a `Date` antes de persistir (MongoDB TTL solo opera sobre `Date`, no sobre `string`).
- **Lazy import**: el driver `mongodb` (~5 MB) solo se carga si se instancia `MongoDBStore`. Single-node dev y tests no lo pagan.
- **Multi-app**: una sola colección con todas las apps (filtrada por `appId` en queries).

Tests:
- **3 unit tests** (siempre corren): constructor validation, init required, default config.
- **10 integration tests** (corren solo si `MONGO_TEST_URI` está configurado): put/get roundtrip, listByApp filtering, update, delete, TTL index verification, change stream callback.

### 2. Deno test bridge para suites custom

`tests/unit/zenith-test-runner.ts`:

- Añadido `ZenithTestSuite.getTests(): readonly TestCase[]` para exponer la lista de tests al bridge sin romper encapsulation.
- Bridge en `erp.test.ts` y `security.test.ts`:

```ts
for (const [i, t] of suite.getTests().entries()) {
  Deno.test({
    name: `[erp] ${i + 1}. ${t.name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const { ZenithTestHarness } = await import("../unit/zenith-test-runner.ts");
      const harness = await ZenithTestHarness.create(defaultOptions);
      try { await t.fn(harness); }
      catch (e) { throw new Error(`[erp] ${t.name} failed: ${(e as Error).message}`); }
    },
  });
}
```

- Mantiene retrocompat: `if (import.meta.main) suite.run(...)` sigue funcionando para ejecución standalone.
- `sanitizeOps: false, sanitizeResources: false` necesario porque el harness crea timers y resources que Deno test runner normalmente limpia.

### 3. Auto-registro de DevOps adapters en `src/mod.ts`

```ts
// Phase 0.A movió git/vault/lux-cache de plugins/ a src/adapters/.
// Como son plugins con side-effects (registran en ZenPlugins global),
// importarlos aquí garantiza que estén disponibles sin import manual.
import "./adapters/git.adapter.ts";
import "./adapters/vault.adapter.ts";
import "./adapters/lux-cache.adapter.ts";
```

- `git` y `vault` se registran siempre (solo añaden métodos a `ZenPlugins`, no hacen I/O).
- `lux-cache` internamente chequea `LUX_DB_URL` antes de activarse (ver `lux-cache.adapter.ts:11`).

### 4. Boilerplate fixes (4 examples)

- `01-user-auth.ts:18`, `02-rest-crud.ts:33`, `03-file-storage.ts:9`: `request.params` se castea a un tipo explícito (`{ username?: string; ... }`) en lugar de `unknown`.
- `09-custom-routes.ts:7`: API call corregida de `(method, path, handler)` a `({ method, path, security, handler })`.

---

## Alternatives Considered

### A. MongoDBStore con Redis en su lugar

- **Pro**: Redis es más rápido para key-value lookups.
- **Con**: Redis no tiene change streams nativos. La replicación cross-node requiere Sentinel/Cluster.

**Rechazado** porque MongoDB es el default de Zenith (ya en `databaseURI`); añadir Redis como dependencia nueva es overhead.

### B. Implementar protobuf change streams en el cliente

- **Pro**: portable a otros DBs (PostgreSQL LISTEN/NOTIFY, MySQL binlog).
- **Con**: cada backend tiene su propia API. Mucho código.

**Rechazado**. MongoDB change streams cubren el 90% del caso (multi-nodo single-region). Roadmap v2: PostgreSQL LISTEN/NOTIFY adapter.

### C. Bridge Deno test con `Deno.test.each()` o table-driven tests

- **Pro**: idiomático en Deno 1.40+.
- **Con**: requiere reescribir todos los tests del suite, rompiendo el patrón `suite.test(name, fn)` que developers conocen de Jest/Mocha.

**Rechazado** por backward compat. El bridge preserva el patrón custom + integra con Deno native runner.

### D. Auto-register adapters con feature flags

- **Pro**: opt-in explícito.
- **Con**: añade DX complexity. Los 3 adapters son livianos (no I/O en import-time, excepto `lux-cache` que ya tiene su propio guard).

**Rechazado** por simplicidad. El guard de `lux-cache` (`LUX_DB_URL`) ya es el feature flag efectivo.

---

## Consequences

### Positive

- **G-1**: API keys funcionan en producción multi-nodo. Cambio de cluster consistente en <1s vía change streams.
- **G-2, G-3**: +12 tests (6 ERP + 6 security) ahora se ejecutan en CI. 0 antes.
- **G-4**: `Zen.Plugins.Git/Vault/CacheAdapter` disponibles out-of-the-box. No más errores silenciosos.
- **G-5, G-6**: `deno check example/...` ahora pasa. DX limpia.

### Negative

- **MongoDB dependency**: el `MongoDBStore` requiere `mongodb` driver (~5 MB). Mitigación: lazy import.
- **MongoDB replica set requerido** para change streams. Para single-node dev, el `enableChangeStream: false` fallback funciona (TTL sigue operando).
- **Tests integration skipped sin MongoDB**: si no se configura `MONGO_TEST_URI`, los 10 integration tests del store se skipean. Documentado en el archivo de test.

### Neutral

- El bridge a Deno native runner usa `as any` casts en algunos lugares (harness types no están expuestos). Roadmap v1.0: tipar el harness completamente.

---

## Files Changed

- **MODIFIED** `src/security/api-keys/store.ts`: `MongoDBStore` real (300 LOC adicionales).
- **MODIFIED** `src/mod.ts`: 3 imports auto-registrados (git/vault/lux-cache).
- **MODIFIED** `tests/unit/zenith-test-runner.ts`: `getTests()` accessor.
- **MODIFIED** `tests/integration/erp.test.ts`: bridge a Deno.test.
- **MODIFIED** `tests/integration/security.test.ts`: bridge a Deno.test.
- **MODIFIED** `example/zenith-backend-boilerplate/cloud/examples/{01-user-auth,02-rest-crud,03-file-storage,09-custom-routes}.ts`: type fixes.
- **NEW** `tests/unit/mongodb-store.test.ts` (3 unit + 10 integration = 13 tests, 1 ignored sin MONGO).

**Total tests**: 178 passing (vs 163 antes), +15 netos (3 MongoDBStore unit + 6 ERP + 6 security).

**Total tests ignorados**: 9 (vs 8 antes; +1 por el test que documenta cómo habilitar integration tests).

---

## Migration Path

1. **Single-node dev** (status quo): `InMemoryStore` sigue siendo el default. No requiere cambios.
2. **Producción multi-nodo**: cambiar a `MongoDBStore` en el bootstrap:

```ts
// Antes
const apiKeyStore = new InMemoryStore();

// Después
const apiKeyStore = new MongoDBStore({
  uri: Deno.env.get("MONGO_URI")!,
  dbName: "zenith",
  enableChangeStream: true,
  onRemoteChange: (e) => {
    // Invalidar cache local cuando otra instancia modifica una key
    apiKeyCache.invalidate(e.appId);
  },
});
await apiKeyStore.init();
```

3. **MongoDB replica set setup**:
   ```bash
   docker run -d --name zenith-mongo -p 27017:27017 mongo:7 --replSet rs0
   docker exec zenith-mongo mongosh --eval 'rs.initiate()'
   ```

---

## References

- ADR-003 (API Keys) — defines the `ApiKeyStore` interface
- ADR-001 (Folder Unification) — moved git/vault/lux-cache to `src/adapters/`
- H-8 in `06_security_microservices_audit.md` (partial close)
- https://www.mongodb.com/docs/drivers/node/current/fundamentals/connection/
- https://www.mongodb.com/docs/manual/changeStreams/
- https://www.mongodb.com/docs/manual/core/index-ttl/
