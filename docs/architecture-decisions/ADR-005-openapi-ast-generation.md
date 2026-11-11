# ADR-005: OpenAPI 3.1 Generado desde el AST Compuesto de Barrits

- **Estado:** Accepted
- **Fecha:** 2026-06-06
- **Decisores:** Zenith Core Team
- **Sprint:** Phase 1.F (cierra H-6)
- **Prerrequisito:** [ADR-004-plugin-signing.md](./ADR-004-plugin-signing.md)

## Contexto

El generador OpenAPI actual (`src/core/openapi.ts`) está hardcoded:

- Solo describe `/health`, `/metrics`, `/openapi.json` y `/swagger`.
- Hardcoded de 7 schemas básicos.
- Cada vez que se agrega un trait, hay que **editar manualmente** `openapi.ts` para incluir las nuevas routes en la spec.
- Las descripciones de las 100+ rutas Parse-Server compat (CRUD, auth, schemas, etc.) **no existen** en la spec — el developer no tiene documentación.
- El equipo de frontend no puede generar clientes tipados automáticamente.
- El SOC no puede auditar la superficie de ataque sin abrir el código.

### Estado anterior (hardcoded)

```typescript
// src/core/openapi.ts:147-394
const ZENITH_SCHEMAS: Record<string, unknown> = { /* 7 schemas */ };
const AUTH_HEADER_PARAMS = [ /* ... */ ];
function routeSpec(method: string, path: string): RouteSpec { /* if-elseif */ }
// 250+ LOC de if/else por path conocido
```

Esto era una bomba de tiempo: cada `getRealtimeRoutes()`, `getWebhookRoutes()` agregado a un trait requería tocar `openapi.ts`.

## Decisión

Implementamos un generador **automático** que descubre dinámicamente todas las
rutas HTTP declaradas en los traits, leyendo la **misma fuente de verdad** que
usa el router de Barrits: las `*_routes` arrays en el state compuesto.

### Arquitectura

```
composeTraitDescriptors([...descriptors], { initialState: {} })
  ↓
state con keys como:
  - crud_routes:       [{method, path, handler, _openapi?}, ...]
  - user_routes:       [...]
  - billing_routes:    [...]
  - webhook_routes:    [...]
  - 30+ más traits...
  - _openapi_schemas?: { CustomType: {...} }
        ↓
generateOpenApiFromState(state, options)
        ↓
OpenAPI 3.1 spec (paths, tags, components, security)
```

### Detección automática

```typescript
// src/core/openapi-generator.ts:397
for (const [key, value] of Object.entries(state)) {
  if (!key.endsWith("_routes")) continue;
  if (isRoutesArray(value)) {
    discovered.push({ provider: key, routes: value });
  }
}
```

**No hay lista hardcoded** de providers. Si un trait expone
`x_routes: [...]`, automáticamente aparece en la spec.

### Metadata opcional por route

Cada route puede adjuntar `_openapi: {...}` para enriquecer la spec:

```typescript
{
  method: "POST",
  path: "/users",
  handler: async (req, ctx) => ...,
  _openapi: {
    summary: "Registrar usuario",
    description: "Crea un usuario nuevo",
    tags: ["Authentication"],
    requestBody: {
      required: true,
      content: { "application/json": { schema: {...} } },
    },
    responses: {
      "201": { description: "Created", ... },
      "409": { description: "Username ya existe" },
    },
    security: [], // público
    deprecated: false,
  }
}
```

Si `_openapi` está ausente, el generador aplica defaults sensatos:
- summary derivado del method+path
- tags derivados del provider name (`crud_routes` → "CRUD")
- responses por método (GET → 200, POST → 201, DELETE → 204, etc.)
- security: bearer + apiKey + session + JWT (todos opcionales)

### Schemas reutilizables

Built-in (auto-incluidos):
- `ZenithObject`, `ZenithUser`, `ZenithSession`, `ZenithError`
- `CloudFunctionResult`, `BatchRequest`, `GraphQLRequest`
- `ApiKey` (Phase 0.D)
- `PluginManifest` (Phase 1.E)

Custom (provistos por traits vía `state._openapi_schemas`):
```typescript
return {
  _openapi_schemas: { Customer: {...}, Invoice: {...} },
  crud_routes: [...],
};
```

O por el caller vía `additionalSchemas`:
```typescript
generateOpenApiFromState(state, {
  additionalSchemas: { Tenant: { type: "object", ... } },
});
```

### Security schemes (Phase 0.D compat)

| Scheme | Tipo | Uso |
|---|---|---|
| `apiKeyBearer` | http + bearer | Phase 0.D: `sk_live_*`, `pk_live_*`, `rk_live_*` |
| `apiKeyHeader` | apiKey header | Alternativa a Bearer (X-API-Key) |
| `masterKey` | apiKey header | Solo localhost, bypassa ACL |
| `sessionToken` | apiKey header | Parse-Server compat |
| `jwtRs256` | http + bearer | JWT interno RSA |

### Compatibilidad con la API anterior

`generateOpenApiSchema(engine, options)` se mantiene como **wrapper**:

```typescript
// src/core/openapi.ts:405
export function generateOpenApiSchema(engine, options) {
  const spec = generateOpenApiFromState(engine, options);
  // + meta routes (/openapi.json, /swagger)
  // + info.contact
  // + extra Parse-Server compat security schemes
  return spec;
}
```

Cero breaking change para callers existentes.

## Trade-offs

### Positivos

1. **Zero maintenance.** Agregar un trait = automáticamente en la spec.
   No hay que tocar `openapi.ts` para routes nuevas.
2. **Single source of truth.** El router de Barrits y la spec OpenAPI
   leen del mismo `*_routes` array. Imposible que se desincronicen.
3. **Custom metadata opt-in.** Traits críticos pueden adjuntar `_openapi`
   para descripciones ricas. El resto usa defaults sensatos.
4. **Compatible con tooling estándar.** La spec es OpenAPI 3.1.0 puro:
   funciona con Swagger UI, Redoc, Stoplight Elements, openapi-generator,
   etc.
5. **Testeable.** 24 tests cubren happy path + todas las failure modes.
6. **Discovery-driven.** El team no necesita recordar agregar un nuevo
   provider; cualquier cosa que matche `*_routes` array entra.

### Negativos

1. **Defaults son básicos.** Sin `_openapi` metadata, un endpoint sale
   con summary "POST /users" y responses genéricos. La spec es válida
   pero no es "linda".
2. **No infiere schemas de los handlers.** El handler es una closure
   opaca; no podemos leer qué request/response type espera. La
   metadata se especifica manualmente.
3. **No soporta jsdoc parsing en runtime.** En `webhook.trait.ts:24-33`
   hay jsdoc rico (`@barrits-trait http-endpoint POST /webhooks/:hookName
   @description Webhook seguro...`). Ese jsdoc es solo documentación
   humana; no se parsea en runtime.
4. **Diffs en git pueden ser grandes.** Cambiar un trait regenera paths
   en orden diferente. Mitigado por sorts estables en tags.

### Neutrales

- El tamaño de la spec crece con cada trait. Una binario Zenith
  full-stack genera una spec de ~200KB — perfectamente manejable.
- Requiere Deno 2.x+ (WebCrypto + `Object.entries` estable).

## Alternativas consideradas

### 1. Parsear jsdoc en runtime con un AST parser

```typescript
const parsed = parseJsdoc(sourceFile);
const summary = parsed.summary;
const description = parsed.description;
```

**Rechazado porque:**
- Agregar `deno_ast` como dependencia (300KB+) solo para esto.
- JSDoc no es un estándar OpenAPI: `@param foo` no mapea a query param
  sin reglas custom.
- Imposible inferir `requestBody` schema desde jsdoc.
- Hacerlo bien requeriría un lenguaje de anotaciones custom (overkill).

### 2. Hand-written `openapi.ts` (status quo)

**Rechazado porque:**
- Ya está en deuda técnica: 250+ LOC de if/else.
- Cada trait nuevo requiere editar `openapi.ts`.
- Drift entre spec y realidad: el router puede tener 50 routes y la
  spec solo 8.

### 3. Generar OpenAPI desde un TypeScript compiler API

**Rechazado porque:**
- El compiler API de TS es lento (segundos por archivo).
- Requiere `tsc` o `@swc/core` como dep.
- No agrega información que no esté en `*_routes`.

### 4. Usar `@zuccadev-labs/barrits/schema` (cuando exista v0.2+)

**Resuelto el 2026-11-10 con barrits 0.3.1.** `generateOpenApiSchema` documenta un endpoint por trait,
así que no sirve. barrits 0.3.1 añade `generateOpenApiFromRoutes`, un generador por rutas, y
`generateOpenApiFromState` delega en él: Zenith solo aporta sus valores por defecto, su seguridad y
sus extensiones. El contrato público no cambia, salvo el formato de `operationId`, que pasa a ser el de
barrits porque el anterior repetía ids (ver `docs/architecture/openapi-swagger.md`).

Lo que sigue es el análisis original: El plan original era delegar a
`generateOpenApiSchema(manifest)` de barrits. Investigando el package
(JSR 0.1.7), ese export **no existe** todavía. La nota en
`openapi.ts:7-11` lo describe como "available in Barrits v0.2+".

Cuando se publique barrits v0.2 con esa API, este generador puede
delegar a barrits o seguir siendo el adaptador. El contrato público
no cambia.

## Implementación

### Archivos

| Archivo | LOC | Función |
|---|---|---|
| `src/core/openapi-generator.ts` | ~500 | Implementación del generador AST-based |
| `src/core/openapi.ts` | refactor | Wrapper de compatibilidad |
| `tests/unit/openapi-generator.test.ts` | ~410 | 24 tests |
| `src/traits/cloud/webhook.trait.ts` | +35 | Metadata rica para webhook |
| `src/traits/auth/user.trait.ts` | +85 | Metadata para /users y /login |
| `src/traits/billing/billing.trait.ts` | +35 | Metadata para /billing/subscribe |

### Tests (24 total)

- empty state produces valid empty spec
- detects `*_routes` arrays automatically
- derives tags from provider name (con acronym awareness: CRUD, API, etc.)
- extracts path params with examples
- respects `_openapi` metadata on routes
- default responses per method
- default security scheme is included
- skips invalid HTTP methods
- skips non-arrays and empty arrays
- merges additional schemas and security
- reads `_openapi_schemas` from state
- `includeBuiltinSchemas=false` excludes built-ins
- `serverURL` becomes servers entry
- `appId` propagates to `x-app-id`
- operationId auto-generation
- explicit operationId wins
- deprecated flag propagates
- realistic multi-trait state
- `extractAllRoutes` helper
- generated spec is valid OpenAPI 3.1 JSON
- paths are stable (deterministic generation)
- path with same name in two providers merges HTTP methods
- explicit security overrides default
- webhook with body uses custom request body schema

## Métricas de éxito

| Métrica | Antes | Después |
|---|---|---|
| Routes en la spec generadas automáticamente | 0 (hardcoded) | **100+** (todas las `*_routes` descubiertas) |
| LOC en `openapi.ts` que requieren mantenimiento | 250+ | ~50 (wrapper) |
| Schemas registrados | 7 | 9 built-in + N custom |
| Security schemes | 4 | 5 + 3 Parse-Server compat |
| Tests del generador | 0 | 24 |
| Cobertura de la spec vs realidad | ~10% | **100%** |
| Tiempo para agregar un nuevo trait a la spec | minutos (edición manual) | **0 segundos** (automático) |

## Consecuencias operativas

### Para developers

- Para que un endpoint aparezca con docs rica, agregar `_openapi` al
  route object. Convention: cada vez que agreguen una route, dediquen
  5 min a la metadata.
- Para custom types en el response, registrarlos en
  `_openapi_schemas` en el return del trait.

### Para el SOC / auditoría

- La spec OpenAPI en `/openapi.json` es ahora la fuente de verdad para
  la superficie de ataque.
- Diff en git del archivo `openapi.json` (si se commitea) muestra
  exactamente qué endpoints se agregaron/modificaron.

### Para el frontend

- Pueden correr `openapi-generator-cli generate -i openapi.json -g
  typescript-fetch -o ./sdk` y obtener un cliente tipado.
- El equipo ya no necesita mantener docs separadas: la spec ES la doc.

## Plan de migración

### Fase 1 (este ADR)

- ✅ Implementar el generador.
- ✅ Tests exhaustivos.
- ✅ Mantener compatibilidad con `generateOpenApiSchema` viejo.
- ✅ Adjuntar metadata rica a 3 traits críticos (webhook, user, billing).

### Fase 2

- [ ] Adjuntar metadata a los otros 37 traits.
- [ ] Commitear `openapi.json` al repo (snapshot para el frontend SDK).
- [ ] CI check: si la spec cambió sin justificación, falla el build.
- [ ] Publicar la spec en `/docs` (Swagger UI estático).

### Fase 3

- [x] Delegar en barrits: `generateOpenApiFromRoutes` (barrits 0.3.1), 2026-11-10.
- [ ] Soporte para `requestBody` inferido desde TS types (usando
      `tsc --noEmit --emitDeclarationOnly` + parsing).
- [ ] Plugin de VSCode que muestre la OpenAPI spec inline en cada
      `*_routes` array.

## Referencias

- OpenAPI 3.1.0 Specification: https://spec.openapis.org/oas/v3.1.0
- Barrits `composeTraitDescriptors`: la fuente del state.
- [ADR-003 — API Keys](file:///D:/zuccadev/Documentos/Programacion/labs-packages/Zenith/docs/architecture-decisions/ADR-003-api-keys.md): scopes compatibles con `security` schemes
- [ADR-004 — Plugin Signing](file:///D:/zuccadev/Documentos/Programacion/labs-packages/Zenith/docs/architecture-decisions/ADR-004-plugin-signing.md): `PluginManifest` schema

## Apéndice: ejemplo completo

```typescript
// Estado compuesto después de composeTraitDescriptors:
const state = {
  crud_routes: [
    {
      method: "GET",
      path: "/classes/:className",
      handler: handleFind,
    },
  ],
  user_routes: [
    {
      method: "POST",
      path: "/users",
      handler: handleRegister,
      _openapi: {
        summary: "Registrar nuevo usuario",
        tags: ["Authentication"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["username", "password"],
            properties: {
              username: { type: "string" },
              password: { type: "string", format: "password" },
            },
          } } },
        },
        responses: {
          "201": { description: "Created", content: {
            "application/json": { schema: { $ref: "#/components/schemas/ZenithUser" } }
          } },
          "409": { description: "Username ya existe" },
        },
      },
    },
  ],
  _openapi_schemas: {
    Tenant: {
      type: "object",
      properties: { id: { type: "string" }, plan: { type: "string" } },
    },
  },
};

const spec = generateOpenApiFromState(state, {
  title: "Acme CRM API",
  version: "2.0.0",
  serverURL: "https://api.acme.com",
  appId: "zen-acme",
});

// spec.paths["/users"].post.summary === "Registrar nuevo usuario"
// spec.paths["/classes/{className}"].get  ← path auto-converted
// spec.components.schemas.Tenant  ← from _openapi_schemas
```
