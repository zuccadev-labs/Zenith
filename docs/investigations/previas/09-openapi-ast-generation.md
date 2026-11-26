# 09 — OpenAPI 3.1 desde el AST Compuesto de Barrits: Generación Automática de la Superficie de Ataque

> ℹ️ **Estado: histórico.** Investigación previa al diseño actual; sus imports y rutas (`@zenith/core`, `src/cli/`…) no son los del código. Índice vigente: [docs/index.md](../index.md).

> **Fase**: Sprint 2 — Phase 1.F (Enterprise Hardening)
> **Autor**: Equipo Zenith — @zuccadev-labs
> **Fecha**: 2026-06-06
> **Estado**: Implementado v1.0 — 24/24 tests pasando
> **Cierra**: H-6 (OpenAPI incompleto / desincronizado con el router)
> **Prerrequisito**: [08_plugin_signing_supply_chain.md](./08_plugin_signing_supply_chain.md)

---

## 1. Resumen Ejecutivo

### 1.1 El problema

El generador OpenAPI de Zenith (`src/core/openapi.ts`) estaba escrito a mano
con un patrón de "specs hardcoded":

```typescript
// 250+ líneas de if/else por cada path conocido
function routeSpec(method: string, path: string): RouteSpec {
  if (method === "POST" && path === "/users") return { summary: "Registrar", ... };
  if (method === "POST" && path === "/login") return { summary: "Login", ... };
  // ... 30 paths más
}
```

**Consecuencias reales:**

- **Drift constante:** cada vez que un developer agregaba una route a un
  trait (ej. `crm_routes` en `crm.plugin.ts`), la spec OpenAPI NO se
  actualizaba. El frontend SDK se generaba con endpoints que no
  existían, o le faltaban endpoints críticos.
- **Superficie de ataque invisible:** el SOC no podía auditar la spec
  para entender qué endpoints estaban expuestos. La única forma era
  hacer `grep` en los 40+ archivos de traits.
- **DX pobre:** el developer frontend tenía que mantener un SDK separado
  a mano, con alta tasa de error.
- **Cero automatización:** agregar un endpoint = editar 3 archivos
  manualmente (trait, openapi.ts, docs).

### 1.2 La solución

**Detección automática de `*_routes` arrays en el state compuesto de
Barrits**, con metadata opcional por route para descripciones ricas.

```typescript
// ANTES: 250 LOC hardcoded
function routeSpec(method, path) { /* if/else */ }

// DESPUÉS: 5 LOC, descubre todo dinámicamente
for (const [key, value] of Object.entries(state)) {
  if (!key.endsWith("_routes")) continue;
  if (isRoutesArray(value)) {
    discovered.push({ provider: key, routes: value });
  }
}
```

El state de Barrits **es** la fuente de verdad. El router HTTP y la spec
OpenAPI leen del mismo `*_routes` array. **Imposible que se
desincronicen.**

### 1.3 Resultados

| Métrica | Antes | Después |
|---|---|---|
| Routes en la spec generadas automáticamente | 0 (hardcoded) | **100+** (todas las `*_routes`) |
| LOC en `openapi.ts` que requieren mantenimiento | 250+ | ~50 (wrapper) |
| Schemas registrados | 7 | 9 built-in + N custom |
| Security schemes | 4 | 5 + 3 Parse-Server compat |
| Tests del generador | 0 | 24 |
| Cobertura spec vs realidad | ~10% | **100%** |
| Tiempo para agregar nuevo trait a la spec | minutos (manual) | **0 segundos** (automático) |

---

## 2. Decisiones Arquitectónicas (ADR)

### 2.1 Por qué detección dinámica y no lista hardcoded

El estado anterior tenía `routeSpec()` con un switch sobre paths. Cada
vez que un developer agregaba `crm_routes` a un plugin, había que
agregar el case al switch.

**Con detección dinámica:**

```typescript
// Cualquier key del state terminada en `_routes` que sea array de
// {method, path, ...} se incluye automáticamente.
for (const [key, value] of Object.entries(state)) {
  if (!key.endsWith("_routes")) continue;
  if (isRoutesArray(value)) discovered.push({ provider: key, routes: value });
}
```

**Ventajas:**

1. **Zero config.** El developer no necesita "registrar" el trait en
   ningún lado. Si sigue la convención `*_routes`, automáticamente
   aparece en la spec.
2. **Consistencia imposible de romper.** El router de Barrits y la
   spec OpenAPI leen del mismo array. Si cambia uno, cambia el otro.
3. **Plugins externos funcionan out-of-the-box.** Un plugin de
   terceros que exporta `chatbot_routes` se documenta solo.

**Validación:** `isRoutesArray()` rechaza silenciosamente valores que no
cumplan el shape `{method, path, ...}`. Cero crash en runtime.

### 2.2 Por qué metadata opcional via `_openapi` field

Tres alternativas evaluadas:

| Approach | Pro | Contra |
|---|---|---|
| **AST parsing del jsdoc** | Sin código extra | Requiere `deno_ast` (300KB), no infiere schemas |
| **Decorator `@openapi`** | Type-safe, descubrible | Requiere runtime transformer, complica Deno compile |
| **`_openapi: {...}` en el route** ✅ | Zero deps, convention over configuration | "Magic string" como key |

La opción `_openapi` es la más pragmática:

- El route object ya es un literal TypeScript; agregar un campo más es
  trivial.
- Es discoverable: el developer que lee el código ve `_openapi` y sabe
  qué es.
- Es opt-in: los traits existentes siguen funcionando, solo no tendrán
  metadata rica.
- No requiere tooling extra: el type-checker valida el shape.

**Convention:** el campo `_openapi` con underscore prefix es una señal
de "metadata, no es parte del route real" — el handler no lo lee.

### 2.3 Por qué OpenAPI 3.1 y no Swagger 2.0 / OpenAPI 3.0

- **3.1 (2021):** soporta `webhooks`, `oneOf` con discriminator,
  `const`, `examples` como map (vs array), JSON Schema 2020-12 alignment.
- **3.0 (2017):** sigue siendo la versión más adoptada; algunas tools
  aún no migran a 3.1.
- **Swagger 2.0 (legacy):** no soporta nullable nativo, ni
  `$ref` recursivo, ni discriminated unions.

**Decisión:** 3.1.0. Las herramientas modernas (Swagger UI, Redoc,
Stoplight Elements, openapi-generator) lo soportan. Parse-Server
también genera 3.1 desde 2023.

**Justificación de adoptar antes que la mayoría:** somos un BaaS nuevo,
no tenemos legacy de 3.0. Adoptar 3.1 desde día 1 evita migraciones
futuras.

### 2.4 Por qué schemas built-in auto-incluidos

El usuario que abre `/openapi.json` espera ver inmediatamente
`ZenithObject`, `ZenithUser`, `ZenithError`, etc. sin tener que
configurar nada. Por eso el generator los incluye por default.

**Trade-off:** la spec pesa más. Pero 9 schemas built-in suman ~5KB
JSON. Insignificante.

**Override:** `includeBuiltinSchemas: false` los excluye, útil para
generar specs internos minimalistas.

### 2.5 Por qué no inferir schemas de los handlers

Considerado pero rechazado: parsear el código del handler para extraer
types TS del request/response.

**Por qué no:**

1. **El handler es opaco.** Es una closure `(req, ctx) => Response`.
   El body puede venir de un body parser, de un adapter, de un
   wrapper. No hay forma estándar de inferir el tipo.
2. **TypeScript types se borran en runtime.** `deno compile` produce
   un binario sin types. `tsx` puede preservar types pero requiere
   un transformer custom.
3. **El costo/beneficio es malo.** Para inferir schemas necesitaríamos
   `@swc/core` o `typescript` como deps (50MB+), todo para ahorrar
   al developer escribir 20 líneas de JSON Schema en `_openapi`.

**Alternativa más simple:** usar `ts-json-schema-generator` solo en
build time (no runtime), pero esto requiere cambiar el modelo de
"spec se genera al boot" a "spec se genera en CI". Out of scope para
esta fase.

### 2.6 Por qué no jsdoc parsing en runtime

Considerado: `webhook.trait.ts:24-33` tiene jsdoc rico:

```typescript
/**
 * @barrits-trait http-endpoint POST /webhooks/:hookName
 * @description Webhook seguro con verificación de firma RSA-SHA256.
 * ...
 */
```

**Por qué no parsearlo:**

1. Requiere `deno_ast` (300KB+) como dep.
2. JSDoc no es un estándar OpenAPI. `@param foo` no mapea
   trivialmente a query param.
3. Imposible inferir `requestBody` schema desde jsdoc.
4. Hacerlo bien requiere un lenguaje de anotaciones custom
   (overkill).

**Decisión:** el jsdoc es para developers humanos (en VSCode hover
tips). El `_openapi` es para la spec machine-readable. Son canales
separados. Si alguien quiere ambos, que duplique la info. No es
ideal pero es explícito y testeable.

---

## 3. Diseño Técnico

### 3.1 Flujo end-to-end

```
┌────────────────────────────────────────────────────────────┐
│  Trait files (user.trait.ts, billing.trait.ts, etc.)       │
│  Declaren routes como literales:                           │
│                                                            │
│    return {                                                │
│      crud_routes: [{                                       │
│        method: "POST",                                     │
│        path: "/users",                                     │
│        handler: ...,                                       │
│        _openapi: { ... }    ← metadata opcional            │
│      }]                                                    │
│    }                                                       │
└────────────────────────────────────────────────────────────┘
                          │
                          │ composeTraitDescriptors([...])
                          ▼
┌────────────────────────────────────────────────────────────┐
│  Barrits state:                                            │
│    {                                                       │
│      crud_routes: [...],                                   │
│      user_routes: [...],                                   │
│      billing_routes: [...],                                │
│      webhook_routes: [...],                                │
│      _openapi_schemas?: { ... }   ← schemas custom         │
│    }                                                       │
└────────────────────────────────────────────────────────────┘
                          │
                          │ generateOpenApiFromState(state, opts)
                          ▼
┌────────────────────────────────────────────────────────────┐
│  OpenAPI 3.1 spec:                                         │
│    {                                                       │
│      openapi: "3.1.0",                                     │
│      info: { title, version, ... },                        │
│      tags: [...],                                          │
│      paths: { "/users": { post: {...} } },                 │
│      components: { schemas, securitySchemes }              │
│    }                                                       │
└────────────────────────────────────────────────────────────┘
                          │
                          │ JSON.stringify
                          ▼
                    HTTP GET /openapi.json
                          │
                          │ Sirve a:
                          │ - Swagger UI
                          │ - Redoc
                          │ - openapi-generator → SDK
                          │ - SOC audit
```

### 3.2 El contrato del state

El generador hace **asumpciones específicas** sobre el shape del state:

```typescript
// Cualquier key terminada en `_routes` que sea array:
type RoutesArray = Array<{
  method: string;            // "GET" | "POST" | "PUT" | ...
  path: string;              // "/users/:id" (Express-style)
  handler?: Function;        // ignorado por el generador
  _openapi?: {               // metadata opcional
    summary?: string;
    description?: string;
    tags?: string[];
    operationId?: string;
    deprecated?: boolean;
    requestBody?: { ... };
    responses?: { ... };
    parameters?: { ... }[];
    security?: { ... }[];
    tag?: string;            // override del default tag
  };
}>;

// Y opcionalmente, schemas custom registrados por traits:
type CustomSchemas = Record<string, OpenApiSchema>;
```

**Validación:** `isRoutesArray()` verifica que `value[0].method` y
`value[0].path` sean strings. Si no, se ignora silenciosamente (fail
soft, no crash).

### 3.3 Conversión de paths

Express usa `:param` para path params. OpenAPI usa `{param}`.

```typescript
function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

// ":className/:objectId" → "{className}/{objectId}"
// "/users/:userId/posts" → "/users/{userId}/posts"
```

El regex `:([a-zA-Z_][a-zA-Z0-9_]*)` solo matchea identificadores
válidos (no acepta `:`, `-`, etc. en el nombre).

### 3.4 Tag derivation

Cada provider genera un tag. Reglas:

```typescript
// snake_case → Title Case
"crud_routes"      → "CRUD"     // acrónimo conocido
"user_routes"      → "User"     // Title case
"sframe_signaling_routes" → "Sframe Signaling"  // multi-word

// Lista de acrónimos preservados en mayúsculas:
const ACRONYMS = new Set([
  "crud", "api", "ui", "sdk", "iam", "iot", "graphql", "rest",
  "acl", "clp", "sso", "oidc", "oauth", "saml", "jwt", "csp",
  "http", "https", "tcp", "udp", "dns", "vpn", "cdn", "waf",
]);
```

Si el trait quiere un tag custom, usa `_openapi.tag` o `_openapi.tags`.

### 3.5 Defaults sensatos

Para un route sin `_openapi`:

- **summary:** ausente (la spec sigue siendo válida).
- **operationId:** `${method}${path_sin_chars_especiales}` (ej.
  `getusersid`).
- **tags:** `[providerToTag(provider)]` (ej. `["User"]`).
- **parameters:** solo los path params auto-extraídos.
- **responses:** default por método:
  - GET → 200
  - POST → 201 con `ZenithObject` schema
  - PUT/PATCH → 200 con `ZenithObject`
  - DELETE → 204
  - Todos los métodos → 400, 401, 403, 404, 429, 500 con `ZenithError`
- **security:** todos los schemes built-in (cualquiera satisface).

### 3.6 Tipos TypeScript

El generator exporta tipos que el trait puede importar:

```typescript
import type { RouteOpenApiMeta } from "../core/openapi-generator.ts";

const loginMeta: RouteOpenApiMeta = {
  summary: "Login",
  tags: ["Authentication"],
  // ...
};
```

Esto le da al developer:
- Autocompletion en el IDE.
- Type-check en build time (schemas mal formados se detectan).
- Documentación inline (JSDoc en la interface).

### 3.7 Schemas built-in — qué y por qué

| Schema | Uso | Justificación |
|---|---|---|
| `ZenithObject` | Todo objeto persistido | Base de cualquier `find`/`get` response |
| `ZenithUser` | `_User` class | Login, register, getMe |
| `ZenithSession` | Login response | Token-based auth |
| `ZenithError` | Errores Parse-Server compat | Compat con clientes Parse |
| `CloudFunctionResult` | Wrapper genérico | `Zen.Cloud.run()` results |
| `BatchRequest` | `/batch` endpoint | Parse-Server compat |
| `GraphQLRequest` | `/graphql` endpoint | Body de query |
| `ApiKey` (Phase 0.D) | List/create API keys | Documenta Phase 0.D |
| `PluginManifest` (Phase 1.E) | Plugin signing | Documenta Phase 1.E |

Cada schema tiene `description`, `example`, y campos `required`
explícitos. Swagger UI y Redoc los muestran prominente.

---

## 4. Integración con el resto de Zenith

### 4.1 Wrapper de compatibilidad

`src/core/openapi.ts` mantiene la signature original:

```typescript
export function generateOpenApiSchema(
  engine: Record<string, unknown>,
  options: OpenApiOptions = {},
): Record<string, unknown> {
  // 1. Genera spec base con el nuevo motor
  const spec = generateOpenApiFromState(engine, options);

  // 2. Agrega Zenith-specific extras:
  //    - /openapi.json y /swagger meta routes
  //    - info.contact
  //    - Security schemes Parse-Server compat (SessionToken, etc.)
  //    - Tag descriptions específicos

  return spec;
}
```

Cero breaking change. El handler `/openapi.json` en el server sigue
llamando `generateOpenApiSchema(engine, ...)`. Internamente ahora
delega al nuevo generador.

### 4.2 Metadata adjuntada a traits críticos

Adjuntamos `_openapi` rico a 3 traits de alta visibilidad:

- `webhook.trait.ts` — POST /webhooks/:hookName
- `user.trait.ts` — POST /users, GET /login, POST /login
- `billing.trait.ts` — POST /billing/subscribe

Los otros 37 traits siguen generando OpenAPI básico (con defaults).
No es bloqueante: el developer puede enriquecer progresivamente.

### 4.3 El "Generador 2.0" pendiente

Cuando barrits v0.2+ publique `generateOpenApiSchema(manifest)` en
`jsr:@zuccadev-labs/barrits/schema`, evaluaremos:

- **Opción A:** delegar completamente a barrits. Riesgo: si barrits
  cambia el schema, Zenith se rompe.
- **Opción B:** mantener nuestro adaptador y agregar tests de
  compatibilidad contra la spec de barrits.

Por ahora, el contrato público `generateOpenApiSchema(engine, options)`
no cambia, así que la migración será invisible para los callers.

### 4.4 SDK generation para frontend

Una vez que `/openapi.json` está completo, el equipo frontend puede:

```bash
# TypeScript fetch client
npx openapi-generator-cli generate \
  -i http://localhost:23614/openapi.json \
  -g typescript-fetch \
  -o ./sdk/zenith-client

# O un client más moderno
npx @hey-api/openapi-ts -i http://localhost:23614/openapi.json -o ./sdk
```

El SDK generado tiene tipos exactos para cada endpoint, requests, y
responses. Cero drift entre backend y frontend.

---

## 5. Decisiones de Testing

### 5.1 Cobertura (24 tests)

| Categoría | Tests | Qué cubre |
|---|---|---|
| **Happy path** | 5 | state vacío, detection, paths, info, meta routes |
| **Metadata** | 4 | `_openapi` field, custom tags, operationId, deprecated |
| **Defaults** | 3 | responses per method, security schemes, tag derivation |
| **Edge cases** | 4 | methods inválidos, arrays vacíos, paths duplicados |
| **Customization** | 5 | additionalSchemas, additionalSecurity, _openapi_schemas, includeBuiltin, serverURL |
| **Output stability** | 3 | JSON parseable, paths estables, determinístico |

### 5.2 Casos negativos cubiertos

- `skips invalid HTTP methods` — si un route tiene `method: "FOO"`,
  se ignora silenciosamente.
- `skips non-arrays and empty arrays` — si `a_routes: "string"`,
  no se incluye.
- `path with same name in two providers merges HTTP methods` — si
  dos traits exponen `/shared`, los métodos se mergean en un solo
  path item.

### 5.3 Determinismo

```typescript
Deno.test("openapi-generator: paths and security schemes are alphabetically stable", () => {
  // Mismo state → mismo JSON
  const spec1 = generateOpenApiFromState(state);
  const spec2 = generateOpenApiFromState(state);
  assertEquals(JSON.stringify(spec1), JSON.stringify(spec2));
});
```

Importante para diffs en git cuando se commitea la spec.

### 5.4 Por qué no testeamos contra Swagger UI

Considerado pero fuera de scope:

- Levantar Swagger UI requiere Node + npm + un build completo.
- El test sería "integration", no "unit".
- Mejor: tener un smoke test E2E (manual) que el developer
  verifique en CI.

---

## 6. Limitaciones Conocidas

### 6.1 Lo que este ADR NO resuelve

| Limitación | Mitigación posible | Cuándo |
|---|---|---|
| Sin inferencia de schemas de los handlers | `ts-json-schema-generator` en CI | Fase 2 |
| Sin jsdoc parsing | Anotaciones custom `@openapi` o Zod schemas | No prioritario |
| Spec pesa 200KB con todos los traits | Lazy generation + delta updates | Out of scope |
| Sin soporte para webhooks (OpenAPI 3.1) | Agregar `webhooks` field | Cuando haya webhooks salientes |
| Sin discriminator ni `oneOf` automático | Manual en `_openapi` | Manual |

### 6.2 Trade-offs aceptados

1. **Defaults básicos.** Sin `_openapi` metadata, los endpoints salen
   con descriptions genéricas. Aceptable porque la spec sigue siendo
   **válida** y **autodescubrible**. El developer la enriquece cuando
   quiere.

2. **Sin schemas generados automáticamente de TS types.** Costo
   prohibitivo en runtime. La alternativa es hacerlo en CI con
   `ts-json-schema-generator`, lo cual es trabajo para Fase 2.

3. **El generador se ejecuta en cada request a `/openapi.json`.** La
   spec se cachea en memoria? No en esta versión. Si el cluster tiene
   50 traits y la spec pesa 200KB, cada request a `/openapi.json`
   toma ~5ms para regenerar. Para producción, agregar cache de 60s.

### 6.3 Compatibilidad hacia atrás

- `generateOpenApiSchema(engine, options)` mantiene signature.
- El output es **más rico** que antes (más paths, más schemas, más
  security schemes). Si un caller asumía que la spec tenía solo 4
  paths, ahora puede sorprenderse. Pero el JSON es válido OpenAPI 3.1,
  así que cualquier consumer estándar lo acepta.

---

## 7. Operación

### 7.1 Workflow del developer

**Para agregar un nuevo endpoint a un trait:**

```typescript
// Antes: 3 archivos a editar (trait, openapi.ts, docs)
// Después: 1 archivo (trait)
return {
  user_routes: [
    {
      method: "POST",
      path: "/users/forgot-password",
      handler: async (req, ctx) => { /* ... */ },
      _openapi: {
        summary: "Solicitar reset de password",
        description: "Envía email con token de reset",
        tags: ["Authentication"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            properties: { email: { type: "string", format: "email" } },
            required: ["email"],
          } } },
        },
        responses: {
          "200": { description: "Email enviado" },
          "404": { description: "Email no registrado" },
        },
      },
    },
  ],
};
```

**Para agregar un schema custom:**

```typescript
return {
  _openapi_schemas: {
    Invoice: {
      type: "object",
      properties: {
        id: { type: "string" },
        amount: { type: "number" },
        currency: { type: "string", example: "USD" },
      },
      required: ["id", "amount", "currency"],
    },
  },
  billing_routes: [
    {
      method: "POST",
      path: "/invoices",
      handler: ...,
      _openapi: {
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } },
        },
      },
    },
  ],
};
```

### 7.2 Monitoreo

Métricas recomendadas:

- `zenith_openapi_spec_size_bytes` — gauge del tamaño actual.
- `zenith_openapi_paths_total` — counter de paths generados.
- `zenith_openapi_schemas_total` — counter de schemas registrados.
- `zenith_openapi_routes_missing_metadata` — cuántos routes NO
  tienen `_openapi` (debería tender a 0 en producción).

### 7.3 Diff review en PRs

Si el repo commitea `openapi.json` snapshot (recomendado para
clientes generados), el diff del PR muestra exactamente:

- Qué endpoints nuevos se agregaron.
- Qué endpoints cambiaron de summary/responses.
- Qué schemas se modificaron.

Esto es un **excelente audit trail** para code review.

---

## 8. Lecciones Aprendidas

### 8.1 El bug del case-insensitive method

Inicialmente el código tenía:

```typescript
if (method === "GET") { ... }
```

Pero `method = route.method.toLowerCase()` ya estaba en lowercase.
Resultado: 4 tests fallaban porque los defaults responses no se
aplicaban.

**Lección:** cuando un valor se normaliza a lowercase arriba, no
volver a comparar con uppercase abajo. Usar siempre la forma
normalizada.

### 8.2 El bug de "acrónimos"

La heurística original de `providerToTag` usaba `length <= 4` para
detectar acrónimos. Resultado: "user" (4 letras) se convertía a
"USER" (uppercase), pero el developer esperaba "User" (title case).

**Lección:** los heurísticas de longitud son frágiles. Mejor una
lista explícita de acrónimos (`CRUD`, `API`, `JWT`, etc.) con
Title Case como default.

### 8.3 El bug del tag set vs tags en operation

Inicialmente el generador agregaba `defaultTag` al `tagSet`, pero
después usaba `meta.tags ?? [defaultTag]` en la operation. Si el
trait override los tags con `meta.tags: ["Webhooks"]` (con S), el
tagSet quedaba con "Webhook" (sin S) y la operation con "Webhooks".

**Lección:** la fuente de verdad debe ser única. Derivar el tagSet
directamente de las tags que realmente se usan en las operations.

### 8.4 Por qué no `x-generated-at` timestamp

Inicialmente el spec tenía `"x-generated-at": new Date().toISOString()`.
Cada llamada producía un timestamp diferente → el output no era
determinístico → diffs en git ilegibles.

**Lección:** los generators deben ser **puros** (mismo input →
mismo output). Timestamps y UUIDs van fuera, o como extension
fields opcionales que el caller controla.

---

## 9. Roadmap Post-1.F

### 9.1 Fase 2 (próximo sprint)

- [ ] Adjuntar `_openapi` metadata a los 37 traits restantes
      (priorizando los más usados: schemas, files, push, analytics).
- [ ] Commitear `openapi.json` snapshot al repo.
- [ ] CI check: `zenith generate-spec` se ejecuta en CI, falla si
      la spec regenerada difiere del snapshot sin justificación.
- [ ] Agregar cache a `/openapi.json` con TTL 60s.

### 9.2 Fase 3 (largo plazo)

- [ ] Inferencia de schemas con `ts-json-schema-generator` en build time.
- [ ] Soporte para `webhooks` field de OpenAPI 3.1 (cuando haya
      webhooks salientes de Zenith).
- [ ] Discriminated unions automáticos para union types.
- [ ] Plugin de VSCode que muestre el OpenAPI spec en un panel
      lateral mientras editas un trait.

---

## 10. Referencias

### Estándares

- OpenAPI 3.1.0: https://spec.openapis.org/oas/v3.1.0
- JSON Schema 2020-12 (alineado con OpenAPI 3.1)
- Swagger UI: https://swagger.io/tools/swagger-ui/
- Redoc: https://redocly.com/redoc/

### Barrits

- `composeTraitDescriptors()` — fuente del state compuesto.
- ADR-005 (en construcción): uso de barrits v0.2+ schema generator
  cuando esté disponible.

### Internas

- [ADR-003 — API Keys](file:///D:/zuccadev/Documentos/Programacion/labs-packages/Zenith/docs/architecture-decisions/ADR-003-api-keys.md): compat de scopes con security schemes
- [ADR-004 — Plugin Signing](file:///D:/zuccadev/Documentos/Programacion/labs-packages/Zenith/docs/architecture-decisions/ADR-004-plugin-signing.md): `PluginManifest` schema
- `src/core/openapi-generator.ts` — implementación completa (~500 LOC)
- `src/core/openapi.ts` — wrapper de compatibilidad
- `tests/unit/openapi-generator.test.ts` — 24 tests
- `src/traits/cloud/webhook.trait.ts` — ejemplo de `_openapi` rico
- `src/traits/auth/user.trait.ts` — ejemplo de `_openapi` en login
- `src/traits/billing/billing.trait.ts` — ejemplo de `_openapi` en billing

---

**Aprobado por:** Core Team
**Implementado por:** @zuccadev-labs
**Tests:** 24/24 pasando
**LOC del generador:** ~500
**LOC de tests:** ~410
**LOC de metadata en traits:** ~155 (3 traits)
**Compatibilidad:** 100% (signature pública sin cambios)
