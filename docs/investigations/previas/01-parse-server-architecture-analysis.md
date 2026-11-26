# 01 — Análisis Arquitectónico de Parse Server y Mapeo a Zenith

> ℹ️ **Estado: histórico.** Investigación previa al diseño actual; sus imports y rutas (`@zenith/core`, `src/cli/`…) no son los del código. Índice vigente: [docs/index.md](../../users/README.md).

> **Fase**: Investigación & Análisis  
> **Autor**: Equipo Zenith — @zuccadev-labs  
> **Fecha**: 2026-05-21  
> **Estado**: Draft v1.0  
> **Prerrequisito**: [00_intro.md](./00-intro.md)

---

## 1. Propósito de Este Documento

Este documento constituye la **fase de análisis profundo** del proyecto Zenith. Su objetivo es diseccionar la arquitectura interna de [Parse Server](https://github.com/parse-community/parse-server) — el BaaS open-source más maduro del ecosistema — para entender sus patrones de diseño, aciertos y limitaciones. A partir de este análisis, se formula cómo cada componente se **traslada, reimagina y mejora** dentro de Zenith usando el motor de orquestación determinista de `@zuccadev-labs/barrits` y la programación orientada a traits.

### 1.1 ¿Por Qué Parse Server Como Referencia?

| Factor | Justificación |
|--------|--------------|
| **Madurez** | +10 años de desarrollo, millones de apps en producción (ex-Facebook/Meta) |
| **Arquitectura completa** | Cubre CRUD, Auth, Cloud Code, LiveQuery, Push, Files, GraphQL |
| **Patrón Adapter** | Ya usa un patrón de adaptadores para DB, Storage, Cache, Email, Push |
| **Ecosistema SDK** | SDKs para iOS, Android, JS, Flutter, .NET, PHP, Arduino |
| **Comunidad** | Open-source activo con gobernanza clara |
| **Documentación** | Extensa y bien estructurada |

### 1.2 ¿Por Qué No Simplemente Usar Parse Server?

| Limitación de Parse Server | Cómo lo Resuelve Zenith |
|---------------------------|------------------------|
| **Acoplado a Node.js + Express** | Deno nativo con opción de compilación a un binario único que lee Cloud Functions externas dinámicamente, o segmentación en múltiples binarios acoplables (ej. un binario solo para streaming, otro para auth) para escalar según demanda. |
| **OOP clásica con herencia** | Programación orientada a traits con contratos declarativos |
| **Estado mutable global** | Estado inmutable gestionado por Barrits con transformaciones puras |
| **Adapters con validación débil** | Contratos `@barrits-provides` / `@barrits-consumes` con validación estática |
| **No diseñado para IA** | AST + Discovery Graphs para que LLMs generen código sin alucinaciones |
| **Dashboard acoplado conceptualmente** | Dashboard como binario separado e independiente |
| **Sin soporte nativo para microservicios** | Cada trait puede compilarse como binario independiente o compuesto |

---

## 2. Anatomía de Parse Server — Análisis del Código Fuente

### 2.1 Punto de Entrada: `ParseServer.ts`

```
Flujo de Inicialización:
┌──────────────────────────────────────────────────────┐
│  new ParseServer(options)                            │
│  ├─ Deprecator.scanParseServerOptions(options)       │
│  ├─ validateKeyNames(options, optionsBlueprint)      │
│  ├─ injectDefaults(options)                          │
│  ├─ Parse.initialize(appId, jsKey, masterKey)        │
│  ├─ Config.validateOptions(options)                  │
│  ├─ controllers.getControllers(options) ─────────────┤
│  │   ├─ getLoggerController(options)                 │
│  │   ├─ getFilesController(options)                  │
│  │   ├─ getUserController(options)                   │
│  │   ├─ getCacheController(options)                  │
│  │   ├─ getAnalyticsController(options)              │
│  │   ├─ getLiveQueryController(options)               │
│  │   ├─ getDatabaseController(options) ──────────────┤
│  │   │   ├─ MongoStorageAdapter (default)            │
│  │   │   └─ PostgresStorageAdapter (si URI postgres) │
│  │   ├─ getHooksController(options)                  │
│  │   ├─ getAuthDataManager(options)                  │
│  │   └─ getParseGraphQLController(options)           │
│  └─ Config.put(options + allControllers)             │
│                                                      │
│  server.start()                                      │
│  ├─ databaseController.performInitialization()       │
│  ├─ hooksController.load()                           │
│  ├─ cacheController.adapter.connect()                │
│  ├─ liveQueryController.connect()                    │
│  ├─ Cargar Cloud Code (cloud function/string)        │
│  ├─ Security CheckRunner (opcional)                  │
│  └─ state = 'ok'                                     │
│                                                      │
│  server.app (Express app)                            │
│  ├─ middlewares.allowCrossDomain                     │
│  ├─ middlewares.handleParseAuth                      │
│  ├─ FilesRouter (antes del body parser)              │
│  ├─ /health endpoint                                 │
│  ├─ PagesRouter                                      │
│  ├─ express.json() body parser                       │
│  ├─ middlewares.allowMethodOverride                  │
│  ├─ middlewares.handleParseHeaders                   │
│  ├─ middlewares.enforceRouteAllowList                │
│  ├─ Rate limiting                                    │
│  ├─ middlewares.handleParseSession                   │
│  ├─ requestContextMiddleware (IoC)                   │
│  ├─ PromiseRouter (all 18+ routers merged)           │
│  └─ middlewares.handleParseErrors                    │
└──────────────────────────────────────────────────────┘
```

**Observaciones Clave:**
- Parse Server es esencialmente un **constructor de una aplicación Express**
- La configuración monolítica se valida contra un blueprint de opciones
- Los controladores se instancian en un bloque síncrono y se inyectan en `Config`
- El estado global se gestiona via `Config.put()` y `AppCache`

### 2.2 Patrón Controller-Adapter

Este es el corazón arquitectónico de Parse Server:

```
┌─────────────────────────────────┐
│        AdaptableController      │  ← Clase base abstracta
│  ├─ adapter (Symbol privado)    │
│  ├─ appId                       │
│  ├─ options                     │
│  ├─ expectedAdapterType()       │  ← Subclases deben implementar
│  └─ validateAdapter()           │  ← Verifica proto del adapter
└───────────┬─────────────────────┘
            │ hereda
  ┌─────────┴─────────────────────────────────┐
  │                                           │
  ▼                                           ▼
┌──────────────────┐  ┌─────────────────────┐  ...más
│ FilesController  │  │ CacheController     │
│  ├─ adapter:     │  │  ├─ adapter:        │
│  │ GridFSBucket  │  │  │ InMemoryCache    │
│  │ S3Adapter     │  │  │ RedisCache       │
│  │ GCSAdapter    │  │  └─ get/put/del     │
│  └─ create/del   │  └────────────────────┘
└──────────────────┘
```

**Controladores identificados en el código fuente:**

| Controlador | Adapter por Defecto | Función |
|------------|-------------------|---------|
| `DatabaseController` | `MongoStorageAdapter` / `PostgresStorageAdapter` | CRUD, schemas, queries, ACL/CLP |
| `FilesController` | `GridFSBucketAdapter` | Upload, download, delete archivos |
| `CacheController` | `InMemoryCacheAdapter` | Cache de sesiones, roles, schemas |
| `LoggerController` | `WinstonLoggerAdapter` | Logging estructurado |
| `UserController` | Email adapter (configurable) | Verificación email, password reset |
| `PushController` | `@parse/push-adapter` | APNS, FCM push notifications |
| `AnalyticsController` | `AnalyticsAdapter` (noop) | Tracking de eventos |
| `LiveQueryController` | Interno (WebSocket) | Suscripciones en tiempo real |
| `HooksController` | DB-backed | Webhooks externos |
| `ParseGraphQLController` | Interno | Auto-generación de schema GraphQL |
| `SchemaController` | DB-backed + cache | Gestión de schemas de clases |

**El `AdapterLoader`** es el mecanismo de resolución flexible:
```javascript
// Acepta: función, string (require), objeto {module, options}, 
//         objeto {class, options}, objeto {adapter, options}, o instancia directa
loadAdapter(adapter, defaultAdapter, options)
```

### 2.3 Sistema de Cloud Code (Triggers)

El sistema de triggers es un **registro global en memoria** organizado por categorías:

```
_triggerStore[applicationId] = {
  Functions:  { functionName: handler },
  Jobs:       { jobName: handler },
  Validators: { "triggerType.className": validatorFn },
  Triggers:   {
    beforeSave:   { ClassName: handler },
    afterSave:    { ClassName: handler },
    beforeDelete: { ClassName: handler },
    afterDelete:  { ClassName: handler },
    beforeFind:   { ClassName: handler },
    afterFind:    { ClassName: handler },
    beforeLogin:  { _User: handler },
    afterLogin:   { _User: handler },
    afterLogout:  { _Session: handler },
    beforeConnect:    { @Connect: handler },
    beforeSubscribe:  { ClassName: handler },
    afterEvent:       { ClassName: handler },
    beforePasswordResetRequest: { _User: handler },
  },
  LiveQuery: [handler, ...]
}
```

**API de Cloud Code (`Parse.Cloud`):**
- `Parse.Cloud.define(name, handler, validator)` → Cloud Functions
- `Parse.Cloud.job(name, handler)` → Background Jobs
- `Parse.Cloud.beforeSave(Class, handler, validator)` → Trigger pre-escritura
- `Parse.Cloud.afterSave(Class, handler, validator)` → Trigger post-escritura
- `Parse.Cloud.beforeDelete/afterDelete` → Triggers de eliminación
- `Parse.Cloud.beforeFind/afterFind` → Triggers de consulta
- `Parse.Cloud.beforeLogin/afterLogin/afterLogout` → Triggers de autenticación
- `Parse.Cloud.beforeConnect/beforeSubscribe` → Triggers de LiveQuery
- `Parse.Cloud.afterLiveQueryEvent` → Filtrado de eventos en tiempo real
- `Parse.Cloud.sendEmail(data)` → Envío de email via adapter

### 2.4 Capa REST (`rest.js`)

Operaciones CRUD como **funciones puras** (sin estado propio):

```javascript
// Las 5 operaciones fundamentales:
rest.create(config, auth, className, restObject, context)
rest.find(config, auth, className, restWhere, restOptions, context)
rest.get(config, auth, className, objectId, restOptions, context)
rest.update(config, auth, className, restWhere, restObject, context)
rest.del(config, auth, className, objectId, context)
```

Cada operación:
1. Verifica seguridad de roles (`enforceRoleSecurity`)
2. Ejecuta triggers `before*` 
3. Delega a `RestQuery` o `RestWrite`
4. Ejecuta triggers `after*`
5. Notifica a LiveQuery

### 2.5 Sistema de Autenticación (`Auth.js`)

```
Auth {
  config, cacheController, installationId
  isMaster, isMaintenance, isReadOnly
  user (Parse.User | null)
  userRoles[], fetchedRoles, rolePromise
}

Niveles de acceso:
├─ master(config)      → isMaster: true (bypassa ACL/CLP)
├─ maintenance(config) → isMaintenance: true (acceso interno)
├─ readOnly(config)    → isMaster: true, isReadOnly: true
├─ nobody(config)      → Sin autenticación
└─ getAuthForSessionToken({config, sessionToken})
   → Valida token de sesión → Resuelve usuario → Carga roles
```

**Proveedores de Auth:**
- AuthDataManager gestiona proveedores externos (OAuth, LDAP, etc.)
- Cada proveedor implementa: `validator`, `beforeFind`, `policy` (solo/additional)
- Soporte para MFA via `policy: 'additional'`

### 2.6 Middleware Chain

El flujo de una request HTTP atraviesa 12 capas de middleware:

```
Request HTTP
  │
  ├─1→ allowCrossDomain (CORS)
  ├─2→ allowDoubleForwardSlash (normalización URL)
  ├─3→ handleParseAuth (resolución de master/maintenance key en headers)
  ├─4→ FilesRouter (binarios antes del JSON parser)
  ├─5→ /health endpoint
  ├─6→ PagesRouter (páginas HTML)
  ├─7→ express.json() body parser
  ├─8→ allowMethodOverride (_method en body)
  ├─9→ handleParseHeaders (resolución completa de auth, config, info)
  ├─10→ enforceRouteAllowList
  ├─11→ Rate Limiting
  ├─12→ handleParseSession (resolución de sessionToken → Auth)
  ├─13→ requestContextMiddleware (IoC del usuario)
  ├─14→ PromiseRouter (despacho a routers)
  └─15→ handleParseErrors (manejo global de errores)
```

### 2.7 Sistema de Routers

Parse Server registra **18 routers** que cubren toda la API:

| Router | Endpoints | Función |
|--------|----------|---------|
| `ClassesRouter` | `/classes/:className` | CRUD genérico |
| `LiveQueryRouter` | `/classes` (WebSocket) | Suscripciones en tiempo real y webhooks |
| `UsersRouter` | `/users`, `/login`, `/logout`, `/verifyPassword` | Gestión de usuarios |
| `SessionsRouter` | `/sessions` | Gestión de sesiones |
| `RolesRouter` | `/roles` | Control de acceso basado en roles |
| `FunctionsRouter` | `/functions/:functionName` | Cloud Functions |
| `CloudCodeRouter` | `/cloud_code/jobs` | Cloud Jobs |
| `SchemasRouter` | `/schemas` | Gestión de schemas |
| `FilesRouter` | `/files/:filename` | Upload/download de archivos |
| `PushRouter` | `/push` | Push notifications |
| `InstallationsRouter` | `/installations` | Registro de dispositivos |
| `HooksRouter` | `/hooks` | Webhooks |
| `GlobalConfigRouter` | `/config` | Configuración global |
| `GraphQLRouter` | `/graphql-config` | Config de GraphQL |
| `LogsRouter` | `/scriptlog` | Logs del servidor |
| `AnalyticsRouter` | `/events` | Analytics |
| `AudiencesRouter` | `/push_audiences` | Audiencias para push |
| `AggregateRouter` | `/aggregate/:className` | Operaciones de agregación |
| `SecurityRouter` | `/security` | Verificación de seguridad |

---

## 3. Patrones de Diseño Identificados

### 3.1 Patrones Que Parse Server Usa Bien

| Patrón | Dónde Se Usa | Valoración |
|--------|-------------|------------|
| **Strategy (via Adapters)** | DB, Files, Cache, Email, Push, Logger, PubSub, Analytics | ⭐⭐⭐⭐ Excelente abstracción |
| **Factory** | `AdapterLoader.loadAdapter()` | ⭐⭐⭐ Flexible pero sin tipado fuerte |
| **Middleware Chain** | Express middleware pipeline | ⭐⭐⭐⭐ Bien organizado |
| **Observer** | Cloud Code triggers, LiveQuery | ⭐⭐⭐ Funcional pero acoplado |
| **Router** | 18 routers con PromiseRouter | ⭐⭐⭐ Organizado pero rígido |
| **Singleton** | Config, AppCache, _triggerStore | ⭐⭐ Estado global mutable |

### 3.2 Anti-Patrones y Deuda Técnica

| Anti-Patrón | Impacto | Ubicación |
|------------|---------|-----------|
| **Estado global mutable** | `Config.put()`, `AppCache`, `_triggerStore` como singletons globales | Dificulta testing y multi-tenancy |
| **Herencia clásica** | `AdaptableController` como clase base | Inflexible, jerarquía rígida |
| **Validación por reflexión** | `validateAdapter()` usa `Object.getOwnPropertyNames(Type.prototype)` | Frágil, no captura interfaces |
| **Mezcla CJS/ESM** | `require()` + `import` en el mismo archivo | Indica migración incompleta |
| **God Object** | `DatabaseController.js` tiene 70K bytes, 2000+ líneas | Responsabilidades mezcladas |
| **Strings como claves** | `_triggerStore[appId][category][type+'.'+className]` | Sin tipado estático |
| **Acoplamiento a Express** | `ParseServer.app()` retorna una Express app directamente | No portable a otros runtimes |

---

## 4. Mapeo Parse Server → Zenith con Barrits

### 4.1 Filosofía de Traducción

```
Parse Server (OOP + Express + Node.js)
  │
  │  TRANSFORMACIÓN
  │  ┌──────────────────────────────────────┐
  │  │ 1. Clases → Traits declarativos      │
  │  │ 2. Herencia → Composición de traits  │
  │  │ 3. Estado mutable → Estado inmutable │
  │  │ 4. Express → HTTP puro de Deno       │
  │  │ 5. require() → ESM imports           │
  │  │ 6. Singletons → Inyección de deps    │
  │  │ 7. Validación runtime → Contratos    │
  │  │    estáticos con AST                 │
  │  └──────────────────────────────────────┘
  │
  ▼
Zenith (Traits + Deno + Barrits)
```

### 4.2 Tabla de Mapeo Componente a Componente

| Parse Server | Zenith Equivalente | Trait Barrits | Descripción |
|-------------|-------------------|--------------|-------------|
| `ParseServer` (constructor) | `zen.config.ts` + `createZenithServer()` | `ZenServerTrait` | Punto de entrada compositivo |
| `Config` | `ZenConfig` (inmutable) | `ConfigTrait` | Configuración validada por contratos |
| `AdaptableController` | Eliminado | N/A — Los traits **son** el controller+adapter | Sin clase base, composición directa |
| `DatabaseController` | `DatabaseTrait` | `@barrits-provides: database-crud` | CRUD como funciones puras |
| `MongoStorageAdapter` | `MongoAdapter` | `@barrits-provides: database-driver` | Adapter puro, sin herencia |
| `PostgresStorageAdapter` | `PostgresAdapter` | `@barrits-provides: database-driver` | Intercambiable con Mongo |
| `FilesController` + adapter | `FileStorageTrait` | `@barrits-provides: file-storage` | S3/GCS/Local como adapters |
| `CacheController` + adapter | `CacheTrait` | `@barrits-provides: cache` | Deno KV por defecto |
| `UserController` | `UserManagementTrait` | `@barrits-provides: user-management` | Auth + Email verification |
| `Auth.js` | `AuthTrait` + `SessionTrait` | `@barrits-provides: auth-session` | Separación clara auth vs session |
| `SchemaController` | `SchemaTrait` | `@barrits-provides: schema-management` | Schema validation + migration |
| `triggers.js` | `HooksTrait` | `@barrits-provides: lifecycle-hooks` | beforeSave/afterSave como traits |
| `Parse.Cloud` | `CloudFunctionsTrait` | `@barrits-provides: cloud-functions` | Functions + Jobs |
| `LiveQuery/` | `RealtimeTrait` | `@barrits-provides: realtime` | WebSocket nativo para data pub/sub |
| N/A (Nuevo) | `MediaStreamTrait` | `@barrits-provides: media-stream` | WebRTC/RTMP nativo para video/audio |
| `Push/` | `PushTrait` | `@barrits-provides: push-notifications` | APNS/FCM |
| `middlewares.js` | `composePipeline()` | Pipeline de traits | Sin Express, pipeline funcional |
| `Routers/` | `RouterTrait` | `@barrits-provides: http-routing` | Routing declarativo |
| `GraphQL/` | `GraphQLTrait` (plugin) | `@barrits-provides: graphql` | Opcional, como trait separado |

### 4.3 Ejemplo: Configuración Comparada

**Parse Server (actual):**
```javascript
const server = new ParseServer({
  databaseURI: 'mongodb://localhost:27017/dev',
  cloud: './cloud/main.js',
  appId: 'myAppId',
  masterKey: 'myMasterKey',
  fileKey: 'optionalFileKey',
  serverURL: 'http://localhost:1337/parse',
  liveQuery: { classNames: ['Message'] },
  push: { adapter: pushAdapter },
  emailAdapter: { module: 'sendgrid', options: {...} },
});
await server.start();
app.use('/parse', server.app);
```

**Zenith con Barrits (propuesto):**
```typescript
// zen.config.ts — Punto de entrada compositivo
import { createTraitDescriptor, composeTraitDescriptors } from "@zuccadev-labs/barrits";
import { ZenServer } from "@zenith/core";
import { MongoAdapter } from "@zenith/adapters/mongo";
import { DenoKvCache } from "@zenith/adapters/deno/kv";
import { RealtimeTrait } from "@zenith/traits/realtime";
import { PushTrait } from "@zenith/traits/push";

// Cada aspecto del servidor es un trait separado
const dbTrait = createTraitDescriptor({
  name: "Database",
  provides: ["database-crud", "database-schema"],
  state: ["connectionPool"],
  runtime: "deno",
  create: (deps) => MongoAdapter({ uri: "mongodb://localhost:27017/dev" })
});

const authTrait = createTraitDescriptor({
  name: "Auth",
  provides: ["auth-session", "user-management"],
  consumes: ["database-crud", "cache"],
  state: ["sessionCache"],
  create: (deps) => ({
    authenticate: async (credentials) => { /* ... */ },
    createSession: async (user) => { /* ... */ },
  })
});

const cacheTrait = createTraitDescriptor({
  name: "Cache",
  provides: ["cache"],
  runtime: "deno",
  create: () => DenoKvCache({ path: "./data/cache.kv" })
});

// Composición declarativa — Barrits valida contratos automáticamente
const server = ZenServer({
  appId: "myAppId",
  masterKey: Deno.env.get("MASTER_KEY"),
  traits: composeTraitDescriptors({
    input: [dbTrait, authTrait, cacheTrait, RealtimeTrait, PushTrait],
    conflictStrategy: "error"  // Falla si hay conflictos
  }),
  port: 1337,
});

// Un solo binario, zero-config deployment
await server.start();
// → deno compile --output zenith-server zen.config.ts
```

### 4.4 Ejemplo: Cloud Code Comparado

**Parse Server:**
```javascript
Parse.Cloud.beforeSave('GameScore', (request) => {
  if (request.object.get('score') < 0) {
    throw 'Score must be positive';
  }
  request.object.set('verified', true);
});

Parse.Cloud.define('calculateTotal', async (request) => {
  const query = new Parse.Query('Order');
  query.equalTo('userId', request.user.id);
  const orders = await query.find({ useMasterKey: true });
  return orders.reduce((sum, o) => sum + o.get('total'), 0);
});
```

**Zenith con Barrits:**
```typescript
// Hooks como traits declarativos con contratos
const gameScoreHooks = createTraitDescriptor({
  name: "GameScoreHooks",
  provides: ["hook:beforeSave:GameScore"],
  consumes: ["database-crud"],
  create: (deps) => ({
    beforeSave: async (context) => {
      if (context.object.score < 0) {
        throw new ZenError("Score must be positive");
      }
      return { ...context.object, verified: true };  // Retorno inmutable
    }
  })
});

// Cloud Functions como traits portables
const orderFunctions = createTraitDescriptor({
  name: "OrderFunctions",
  provides: ["function:calculateTotal"],
  consumes: ["database-crud", "auth-session"],
  create: (deps) => ({
    calculateTotal: async (request) => {
      const orders = await deps.database.find("Order", {
        where: { userId: request.user.id }
      });
      return orders.reduce((sum, o) => sum + o.total, 0);
    }
  })
});
```

---

## 5. Decisiones Arquitectónicas para Zenith

### 5.1 Decisiones Tomadas (con Justificación)

| # | Decisión | Justificación | Alternativa Descartada |
|---|---------|--------------|----------------------|
| D-01 | **Deno como runtime** | Binario único, TypeScript nativo, Web APIs, seguridad por defecto, Deno KV integrado | Node.js (requiere transpilación, node_modules pesados) |
| D-02 | **Traits en lugar de clases** | Composición > herencia, contratos estáticos, portabilidad, LLM-friendly | OOP clásica (jerarquía rígida, acoplamiento) |
| D-03 | **Estado inmutable** | Predecible, testeable, thread-safe, reproducible | Estado mutable (race conditions, side effects) |
| D-04 | **Pipeline funcional en lugar de Express** | Sin dependencias externas, composable, portable | Express/Oak (acoplamiento al framework) |
| D-05 | **Contratos `provides/consumes`** | Validación estática pre-runtime, documentación auto-generada, IA determinista | Duck typing (errores tardíos, no verificable) |
| D-06 | **Config como trait inmutable** | Un solo lugar de verdad, versionable, validación en build-time | Config global mutable (Parse Server style) |
| D-07 | **Dashboard como binario separado** | Núcleo limpio y ligero, despliegue independiente | Dashboard integrado (contamina el runtime) |
| D-08 | **Database-agnostic desde día 1** | MongoDB primero, con PostgreSQL, MySQL, ScyllaDB planificados | Solo MongoDB (limitaría adopción) |

### 5.2 Decisiones Pendientes

| # | Decisión | Opciones | Impacto |
|---|---------|---------|---------|
| P-01 | Nombre del archivo de config | `zen.config.ts` vs `zenith.config.ts` | Ergonomía del developer |
| P-02 | Protocolo de realtime | WebSocket nativo vs MQTT vs ambos | Compatibilidad IoT |
| P-03 | Formato de schema | JSON Schema vs TypeScript types vs Barrits contracts | DX y validación |
| P-04 | CLI tool | `zenith` vs `zen` como comando | Branding |
| P-05 | Plugin system | Traits como plugins vs sistema de plugins separado | Extensibilidad |

---

## 6. Arquitectura Propuesta para Zenith

### 6.1 Diagrama de Capas

```
┌──────────────────────────────────────────────────────────────┐
│                        CAPA DE ENTRADA                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │  HTTP/REST  │  │  GraphQL   │  │ WebSocket  │            │
│  │  (nativo)   │  │  (plugin)  │  │ (realtime) │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        └───────────────┬───────────────┘                     │
│                        ▼                                     │
│  ┌─────────────────────────────────────────────────┐        │
│  │           Pipeline de Request (funcional)        │        │
│  │  composePipeline(request,                        │        │
│  │    cors, auth, rateLimit, routing, validation)   │        │
│  └──────────────────────┬──────────────────────────┘        │
├─────────────────────────┼────────────────────────────────────┤
│                  CAPA DE LÓGICA                              │
│        ┌────────────────┼────────────────┐                  │
│        ▼                ▼                ▼                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Router   │  │  Lifecycle   │  │   Cloud      │          │
│  │  Trait    │  │  Hooks Trait │  │  Functions   │          │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘          │
│       └───────────────┬───────────────┘                     │
│                       ▼                                      │
│  ┌─────────────────────────────────────────────────┐        │
│  │              REST Operations (puras)             │        │
│  │    create | find | get | update | delete          │        │
│  └──────────────────────┬──────────────────────────┘        │
├─────────────────────────┼────────────────────────────────────┤
│                  CAPA DE DOMINIO                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Auth   │  │  Schema  │  │   ACL    │  │   User   │   │
│  │  Trait   │  │  Trait   │  │   Trait  │  │  Trait   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       └──────────────┼─────────────┼──────────────┘         │
│                      ▼             ▼                         │
├─────────────────────────────────────────────────────────────┤
│                CAPA DE INFRAESTRUCTURA                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Database │  │   File   │  │  Cache   │  │  Email   │   │
│  │ Adapter  │  │ Adapter  │  │ Adapter  │  │ Adapter  │   │
│  │ (Mongo/  │  │ (S3/GCS/ │  │ (DenoKV/ │  │ (SMTP/   │   │
│  │  PG/etc) │  │  Local)  │  │  Redis)  │  │  API)    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │  Push    │  │  Logger  │  │  Queue   │                  │
│  │ Adapter  │  │ Adapter  │  │ Adapter  │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Arquitectura de Carpetas Propuesta

```
zenith/
├── deno.json                        # Config de Deno (importmap, tasks)
├── zen.config.ts                    # Punto de entrada del usuario
├── src/
│   ├── core/                        # Núcleo inmutable
│   │   ├── mod.ts                   # Re-exporta todo el core
│   │   ├── server.ts                # createZenithServer()
│   │   ├── config.ts                # ZenConfig (inmutable)
│   │   ├── pipeline.ts              # Request pipeline funcional
│   │   ├── router.ts                # Router declarativo
│   │   ├── errors.ts                # Códigos de error estándar
│   │   └── types.ts                 # Tipos compartidos
│   │
│   ├── traits/                      # Traits del dominio
│   │   ├── mod.ts                   # Re-exporta traits
│   │   ├── auth/
│   │   │   ├── auth.trait.ts        # AuthTrait
│   │   │   ├── session.trait.ts     # SessionTrait
│   │   │   ├── acl.trait.ts         # ACLTrait
│   │   │   └── providers/           # OAuth, LDAP, JWT, etc.
│   │   ├── database/
│   │   │   ├── database.trait.ts    # DatabaseTrait
│   │   │   ├── schema.trait.ts      # SchemaTrait
│   │   │   └── migration.trait.ts   # MigrationTrait
│   │   ├── storage/
│   │   │   └── file.trait.ts        # FileStorageTrait
│   │   ├── cloud/
│   │   │   ├── functions.trait.ts   # CloudFunctionsTrait
│   │   │   ├── hooks.trait.ts       # LifecycleHooksTrait
│   │   │   └── jobs.trait.ts        # BackgroundJobsTrait
│   │   ├── realtime/
│   │   │   └── realtime.trait.ts    # RealtimeTrait (LiveQuery equiv)
│   │   ├── push/
│   │   │   └── push.trait.ts        # PushNotificationsTrait
│   │   ├── user/
│   │   │   └── user.trait.ts        # UserManagementTrait
│   │   └── analytics/
│   │       └── analytics.trait.ts   # AnalyticsTrait
│   │
│   ├── adapters/                    # Implementaciones concretas
│   │   ├── database/
│   │   │   ├── mongo.adapter.ts     # MongoDB
│   │   │   ├── postgres.adapter.ts  # PostgreSQL
│   │   │   ├── mysql.adapter.ts     # MySQL (futuro)
│   │   │   └── scylladb.adapter.ts  # ScyllaDB (futuro)
│   │   ├── storage/
│   │   │   ├── s3.adapter.ts        # AWS S3
│   │   │   ├── gcs.adapter.ts       # Google Cloud Storage
│   │   │   └── local.adapter.ts     # Sistema de archivos local
│   │   ├── cache/
│   │   │   ├── deno-kv.adapter.ts   # Deno KV (default)
│   │   │   └── redis.adapter.ts     # Redis
│   │   ├── email/
│   │   │   ├── smtp.adapter.ts      # SMTP directo
│   │   │   └── postal.adapter.ts    # Postal (self-hosted)
│   │   ├── push/
│   │   │   ├── apns.adapter.ts      # Apple Push
│   │   │   └── fcm.adapter.ts       # Firebase Cloud Messaging
│   │   ├── auth/
│   │   │   ├── keycloak.adapter.ts  # Keycloak
│   │   │   ├── zitadel.adapter.ts   # Zitadel
│   │   │   └── jwt.adapter.ts       # JWT nativo
│   │   └── logger/
│   │       └── deno.adapter.ts      # Logger nativo de Deno
│   │
│   ├── rest/                        # Operaciones REST puras
│   │   ├── mod.ts
│   │   ├── query.ts                 # RestQuery equivalente
│   │   ├── write.ts                 # RestWrite equivalente
│   │   └── operations.ts            # create, find, get, update, delete
│   │
│   ├── api/                         # Definición de rutas
│   │   ├── classes.route.ts
│   │   ├── users.route.ts
│   │   ├── sessions.route.ts
│   │   ├── functions.route.ts
│   │   ├── files.route.ts
│   │   ├── schemas.route.ts
│   │   ├── push.route.ts
│   │   └── health.route.ts
│   │
│   ├── plugins/                     # Extensiones opcionales
│   │   ├── graphql/                 # GraphQL como plugin
│   │   ├── blockchain/              # Web3 integration (à la Moralis)
│   │   └── ai/                      # LLM integration
│   │
│   └── cli/                         # CLI tool
│       ├── mod.ts                   # Entrada del CLI
│       ├── init.ts                  # `zen init`
│       ├── dev.ts                   # `zen dev`
│       └── compile.ts               # `zen compile` → binario
│
├── dashboard/                       # Binario separado
│   └── ...                          # (proyecto independiente)
│
├── sdk/                             # SDKs cliente
│   ├── js/                          # JavaScript/TypeScript SDK
│   └── ...                          # Futuros: iOS, Android, Flutter
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
└── docs/
    ├── investigations/              # ← Estás aquí
    ├── development/
    └── agents/
```

---

## 7. Stack Tecnológico Definitivo

| Capa | Tecnología | Justificación |
|------|-----------|--------------|
| **Runtime** | Deno 2.x | TypeScript nativo, Web APIs, `deno compile`, permisos granulares |
| **Orquestación** | `@zuccadev-labs/barrits` | Traits, composición determinista, AST, contratos |
| **HTTP** | `Deno.serve()` | API nativa, zero dependencies |
| **Base de datos** | MongoDB (inicial) → PostgreSQL, MySQL, ScyllaDB | Flexibilidad via adapters |
| **Cache** | Deno KV (default) → Redis (escalado) | Zero-config inicial |
| **Realtime** | WebSocket nativo de Deno | Sin dependencias como socket.io |
| **Auth** | JWT nativo + Keycloak/Zitadel (proveedores) | Estándares de la industria |
| **Email** | Postal (self-hosted) + SMTP | Control total del correo |
| **Secrets** | HashiCorp Vault integration | Gestión segura de credenciales |
| **Container** | Binario único via `deno compile` | Sin Docker para desarrollo |
| **Orchestration** | Kubernetes-ready | Escalado horizontal |

---

## 8. Conclusiones y Próximos Pasos

### 8.1 Hallazgos Principales

1. **Parse Server es una excelente referencia de "qué construir"** pero no de "cómo construirlo" para la era actual
2. **El patrón Controller-Adapter se traduce naturalmente a Traits** eliminando la jerarquía de herencia
3. **Cloud Code triggers → Lifecycle Hooks como traits** con contratos explícitos
4. **La capa REST es sorprendentemente funcional** (funciones puras) — se puede preservar este diseño
5. **La mayor oportunidad está en el estado**: pasar de singletons mutables a estado inmutable gestionado

### 8.2 Próximos Documentos

| Documento | Contenido |
|-----------|----------|
| `02_barrits_deep_dive.md` | Análisis profundo de `@zuccadev-labs/barrits` — traits, composición, AST |
| `03_zenith_architecture.md` | Arquitectura detallada de Zenith — diagramas, flujos, contratos |
| `04_database_trait_design.md` | Diseño del trait de base de datos — adapters, queries, migrations |
| `05_auth_trait_design.md` | Diseño del sistema de autenticación — providers, sessions, ACL |
| `06_cloud_functions_design.md` | Sistema de Cloud Functions y Hooks |
| `07_realtime_design.md` | LiveQuery reimaginado con WebSocket nativo |
| `08_sdk_design.md` | Diseño del SDK JavaScript/TypeScript |

---

> **Nota**: Este documento es un artefacto vivo que se actualizará conforme avance la investigación. Las decisiones marcadas como "pendientes" requieren discusión del equipo antes de pasar a la fase de implementación.
