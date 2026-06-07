/**
 * @module @zenith/core/openapi-generator
 *
 * Generador automático de OpenAPI 3.1 spec desde el state compuesto de Barrits.
 *
 * Fuente de verdad: las `*_routes` arrays declaradas por cada trait
 * (crud_routes, user_routes, billing_routes, etc.). El generador las
 * descubre dinámicamente — NO hay lista hardcoded.
 *
 * Diseño:
 *   1. Detección automática: cualquier key del state terminada en `_routes`
 *      que sea un array de `{ method, path, handler?, _openapi? }`.
 *   2. Metadata opcional por route: campo `_openapi` adjuntable por el
 *      trait para summary, description, tags, requestBody, responses,
 *      security. Sin metadata → spec básica pero válida.
 *   3. Schema registry global: los traits pueden registrar schemas
 *      reutilizables en `state._openapi_schemas` o vía la opción
 *      `additionalSchemas` del generador.
 *   4. Tags derivadas del nombre del provider (crud → "CRUD",
 *      user → "Authentication", etc.).
 *
 * Por qué NO leemos jsdoc comments del código fuente:
 *   - Requeriría parsear AST en runtime (caro, complejo).
 *   - El jsdoc en `webhook.trait.ts:25-32` YA está documentado
 *     semánticamente; lo que agregamos es metadata estructurada
 *     (no texto libre) para OpenAPI.
 *   - Si un trait quiere metadatos ricos, los adjunta via
 *     `_openapi: {...}` en el route. Convention over configuration.
 *
 * Spec generada cumple OpenAPI 3.1.0 (https://spec.openapis.org/oas/v3.1.0)
 * y es compatible con Swagger UI, Redoc, Stoplight Elements, etc.
 */

// ── Public types ─────────────────────────────────────────────────────────────

export interface OpenApiOptions {
  /** Título del API. Default: "Zenith API". */
  title?: string;
  /** Descripción del API. */
  description?: string;
  /** Versión. Default: "1.0.0". */
  version?: string;
  /** URL del servidor, ej. "https://api.example.com". */
  serverURL?: string;
  /** App ID (Parse-Server compat). Si se da, aparece en `info.x-app-id`. */
  appId?: string;
  /**
   * Schemas adicionales a registrar en `#/components/schemas/`.
   * Se mergean con los schemas built-in (ZenithObject, ZenithError, etc.)
   * y con los que los traits registren en `state._openapi_schemas`.
   */
  additionalSchemas?: Record<string, OpenApiSchema>;
  /**
   * Security schemes adicionales. Default: ya provee `apiKey`, `masterKey`,
   * `sessionToken`, `apiKeyBearer` (Phase 0.D + Parse-Server compat).
   */
  additionalSecuritySchemes?: Record<string, OpenApiSecurityScheme>;
  /**
   * Tag custom descriptions para que la doc no salga vacía.
   * `additionalTagDescriptions: { Authentication: "User management..." }`
   */
  additionalTagDescriptions?: Record<string, string>;
  /**
   * Si true, incluye el schema registry built-in (ZenithObject, etc.).
   * Default: true.
   */
  includeBuiltinSchemas?: boolean;
}

export interface OpenApiSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  format?: string;
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  required?: string[];
  items?: OpenApiSchema;
  enum?: unknown[];
  example?: unknown;
  examples?: Record<string, unknown>;
  default?: unknown;
  nullable?: boolean;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  $ref?: string;
}

export interface OpenApiSecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  description?: string;
  name?: string;
  in?: "header" | "query" | "cookie";
  scheme?: string;
  bearerFormat?: string;
  flows?: unknown;
}

export interface OpenApiSpec {
  openapi: "3.1.0";
  info: {
    title: string;
    description?: string;
    version: string;
    "x-app-id"?: string;
    "x-generated-at"?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  tags: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    schemas: Record<string, OpenApiSchema>;
    securitySchemes: Record<string, OpenApiSecurityScheme>;
    parameters: Record<string, OpenApiParameter>;
  };
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema: OpenApiSchema;
  example?: unknown;
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    description?: string;
    required?: boolean;
    content: Record<string, { schema: OpenApiSchema }>;
  };
  responses: Record<string, {
    description: string;
    content?: Record<string, { schema: OpenApiSchema }>;
    headers?: Record<string, OpenApiParameter>;
  }>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

/** Metadata opcional adjuntable a un route. */
export interface RouteOpenApiMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
  requestBody?: OpenApiOperation["requestBody"];
  responses?: OpenApiOperation["responses"];
  parameters?: OpenApiParameter[];
  security?: OpenApiOperation["security"];
  /** Tag para agrupar en la UI. Default: derivado del nombre del provider. */
  tag?: string;
}

/** Estructura mínima de un route que el generador espera. */
export interface RouteEntry {
  method: string;
  path: string;
  /** Metadata opcional para OpenAPI. */
  _openapi?: RouteOpenApiMeta;
  // Otros campos (handler, etc.) son ignorados por el generador.
  [key: string]: unknown;
}

/** State de Barrits: cualquier objeto con keys `*_routes`. */
export type ZenithState = Record<string, unknown>;

// ── Built-in schemas (Phase 0.D / Parse-Server compat) ──────────────────────

const BUILTIN_SCHEMAS: Record<string, OpenApiSchema> = {
  ZenithObject: {
    type: "object",
    description: "Base de cualquier objeto persistido en Zenith.",
    properties: {
      objectId: { type: "string", example: "xWMyZ4YYGX" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      ACL: {
        type: "object",
        additionalProperties: { type: "object" },
        description: "Access Control List (Phase 0 security)",
      },
    },
    required: ["objectId", "createdAt", "updatedAt"],
  },
  ZenithUser: {
    type: "object",
    properties: {
      objectId: { type: "string" },
      username: { type: "string", example: "alice" },
      email: { type: "string", format: "email", example: "alice@acme.example" },
      emailVerified: { type: "boolean", example: true },
      sessionToken: { type: "string", description: "Opaque, used in Authorization header" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ZenithSession: {
    type: "object",
    properties: {
      sessionToken: { type: "string" },
      sub: { type: "string", description: "userId" },
      username: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
    },
  },
  ZenithError: {
    type: "object",
    description: "Formato de error estándar de Zenith (Parse-Server compat)",
    properties: {
      code: { type: "integer", example: 101, description: "Parse error code" },
      error: { type: "string", example: "Invalid username/password." },
    },
    required: ["code", "error"],
  },
  CloudFunctionResult: {
    type: "object",
    properties: { result: {} },
    description: "Wrapper genérico para el resultado de una Cloud Function",
  },
  BatchRequest: {
    type: "object",
    properties: {
      requests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
            path: { type: "string", example: "/classes/GameScore" },
            body: { type: "object" },
          },
          required: ["method", "path"],
        },
      },
    },
  },
  GraphQLRequest: {
    type: "object",
    properties: {
      query: { type: "string", example: "{ findGameScores(limit: 5) { objectId score } }" },
      variables: { type: "object" },
    },
  },
  // Phase 0.D: API Key types
  ApiKey: {
    type: "object",
    description: "API Key metadata (nunca incluye el secret)",
    properties: {
      id: { type: "string", example: "BAV3LVUH" },
      prefix: { type: "string", example: "sk_live_BAV3LVUH" },
      env: { type: "string", enum: ["live", "test"], example: "live" },
      name: { type: "string", example: "acme-crm production" },
      scopes: { type: "array", items: { type: "string" }, example: ["data:read", "data:write"] },
      rateLimit: { type: "integer", example: 1000, description: "Requests per minute" },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: { type: "string", format: "date-time", nullable: true },
      expiresAt: { type: "string", format: "date-time", nullable: true },
    },
    required: ["id", "prefix", "env", "scopes"],
  },
  // Phase 1.E: Plugin manifest
  PluginManifest: {
    type: "object",
    description: "Plugin manifest firmado (Ed25519, JCS, ADR-004)",
    properties: {
      manifestVersion: { type: "string", enum: ["1.0"] },
      plugin: {
        type: "object",
        properties: {
          name: { type: "string", example: "crm.plugin.ts" },
          version: { type: "string", example: "1.2.3" },
          sha256: { type: "string", example: "a".repeat(64) },
          size: { type: "integer", example: 12345 },
          permissions: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "data:read",
                "data:write",
                "users:read",
                "users:write",
                "files:read",
                "files:write",
                "functions:invoke",
                "analytics:read",
                "webhooks:read",
                "webhooks:write",
              ],
            },
          },
          author: {
            type: "object",
            properties: {
              id: { type: "string", example: "acme-corp" },
              keyId: { type: "string", example: "acme-corp-ed25519-A11B3055" },
              contact: { type: "string", format: "email" },
            },
            required: ["id", "keyId"],
          },
        },
        required: ["name", "version", "sha256", "size", "permissions", "author"],
      },
      signature: {
        type: "object",
        properties: {
          alg: { type: "string", enum: ["Ed25519"] },
          keyId: { type: "string" },
          value: { type: "string", description: "Base64-encoded 64-byte signature" },
          signedAt: { type: "string", format: "date-time" },
        },
        required: ["alg", "keyId", "value", "signedAt"],
      },
    },
    required: ["manifestVersion", "plugin", "signature"],
  },
};

const BUILTIN_SECURITY_SCHEMES: Record<string, OpenApiSecurityScheme> = {
  // Phase 0.D: Bearer API key (sk_live_, pk_live_, rk_live_)
  apiKeyBearer: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "Zenith API Key",
    description: "Bearer token en formato `sk_live_<id>_<secret>` (Phase 0.D).",
  },
  // Phase 0.D: API key en header X-API-Key
  apiKeyHeader: {
    type: "apiKey",
    in: "header",
    name: "X-API-Key",
    description: "API key alternativa al Bearer.",
  },
  // Parse-Server compat: Zen-Application-Id + Zen-Master-Key
  masterKey: {
    type: "apiKey",
    in: "header",
    name: "Zen-Master-Key",
    description: "Master key administrativa. SOLO desde localhost. Bypasea ACL/CLP.",
  },
  // Parse-Server compat: session token
  sessionToken: {
    type: "apiKey",
    in: "header",
    name: "X-Parse-Session-Token",
    description: "JWT de sesión (compatibilidad Parse-Server)",
  },
  // JWT interno (RSA)
  jwtRs256: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT (RS256)",
    description: "JWT firmado con RSA, validado por la public key interna de Zenith.",
  },
};

const BUILTIN_TAG_DESCRIPTIONS: Record<string, string> = {
  Health: "Endpoints de health check, metrics y estado del cluster",
  CRUD: "Operaciones genéricas sobre clases (Create/Read/Update/Delete)",
  Authentication: "Gestión de usuarios, login, signup, session tokens",
  Webhooks: "Endpoints de webhook con verificación de firma RSA-SHA256",
  "Cloud Code": "Cloud Functions, triggers beforeSave/afterSave",
  GraphQL: "Endpoint GraphQL unificado",
  Schemas: "Definición de esquemas de clase (CREATE/UPDATE/DELETE)",
  Roles: "Gestión de roles y permisos",
  Files: "Subida, descarga y borrado de archivos",
  Push: "Notificaciones push (APNS, FCM)",
  Realtime: "WebSocket / Server-Sent Events para subscripciones en vivo",
  Analytics: "Aggregations, métricas y dashboards",
};

// ── Helpers ────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

/** Convierte path estilo Express `/users/:id` a OpenAPI `/users/{id}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

/** Extrae path params con sus nombres. */
function extractPathParams(path: string): OpenApiParameter[] {
  const out: OpenApiParameter[] = [];
  for (const m of path.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    out.push({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
      example: exampleFor(m[1]),
    });
  }
  return out;
}

function exampleFor(name: string): string {
  switch (name) {
    case "objectId":
      return "xWMyZ4YYGX";
    case "className":
      return "GameScore";
    case "functionName":
      return "helloWorld";
    case "hookName":
      return "fn:myFunction";
    case "userId":
      return "uWMyZ4YYGX";
    default:
      return name;
  }
}

/** Detecta si un valor es un array de RouteEntry. */
function isRoutesArray(value: unknown): value is RouteEntry[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const first = value[0];
  if (!first || typeof first !== "object") return false;
  const r = first as Record<string, unknown>;
  return typeof r.method === "string" && typeof r.path === "string";
}

/** Convierte provider name → tag (snake/kebab → Title Case). */
function providerToTag(provider: string): string {
  // e.g. "user_routes" → "user" → "User"
  // e.g. "crud_routes" → "crud" → "CRUD" (acronym)
  // e.g. "sframe_signaling_routes" → "sframe signaling" → "Sframe Signaling"
  const base = provider.replace(/_routes$/, "").replace(/_/g, " ");

  // Acrónimos conocidos — se preservan en mayúsculas
  const ACRONYMS = new Set([
    "crud", "api", "ui", "sdk", "iam", "iot", "graphql", "rest",
    "acl", "clp", "sso", "oidc", "oauth", "saml", "jwt", "csp",
    "http", "https", "tcp", "udp", "dns", "vpn", "cdn", "waf",
  ]);

  return base
    .split(" ")
    .map((w) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Default response cuando el trait no especifica. */
function defaultResponses(method: string): OpenApiOperation["responses"] {
  const methodLower = method.toLowerCase();
  const base = {
    "400": { description: "Bad Request - parámetros inválidos", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithError" } } } },
    "401": { description: "Unauthorized - falta API key, JWT o session token", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithError" } } } },
    "403": { description: "Forbidden - ACL/CLP denied", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithError" } } } },
    "404": { description: "Not Found - el recurso no existe", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithError" } } } },
    "429": { description: "Too Many Requests - rate limit exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithError" } } } },
    "500": { description: "Internal Server Error", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithError" } } } },
  };
  if (methodLower === "get") {
    return { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } }, ...base };
  }
  if (methodLower === "post") {
    return { "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithObject" } } } }, ...base };
  }
  if (methodLower === "put" || methodLower === "patch") {
    return { "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/ZenithObject" } } } }, ...base };
  }
  if (methodLower === "delete") {
    return { "204": { description: "No Content" }, ...base };
  }
  return base;
}

/** Default security para un route. */
function defaultSecurity(_hasRequestBody: boolean): OpenApiOperation["security"] {
  // En Zenith, todos los endpoints requieren algún tipo de auth
  // (excepto /health, que se filtra en el caller).
  return [
    { "apiKeyBearer": [] },
    { "apiKeyHeader": [] },
    { "sessionToken": [] },
    { "jwtRs256": [] },
  ];
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Genera un OpenAPI 3.1 spec desde el state compuesto de Barrits.
 *
 * @example
 * ```ts
 * import { composeTraitDescriptors } from "@zuccadev-labs/barrits";
 * import { generateOpenApiFromState } from "./openapi-generator.ts";
 *
 * const { state } = composeTraitDescriptors([...descriptors], { initialState: {} });
 * const spec = generateOpenApiFromState(state, {
 *   title: "My Zenith API",
 *   version: "1.0.0",
 *   serverURL: "https://api.example.com",
 * });
 * ```
 */
export function generateOpenApiFromState(
  state: ZenithState,
  options: OpenApiOptions = {},
): OpenApiSpec {
  const includeBuiltin = options.includeBuiltinSchemas !== false;

  // 1. Detectar todos los `*_routes` arrays en el state
  const discovered: Array<{ provider: string; routes: RouteEntry[] }> = [];
  for (const [key, value] of Object.entries(state)) {
    if (!key.endsWith("_routes")) continue;
    if (isRoutesArray(value)) {
      discovered.push({ provider: key, routes: value });
    }
  }

  // 2. Construir paths
  const paths: OpenApiSpec["paths"] = {};
  const tagSet = new Set<string>();

  for (const { provider, routes } of discovered) {
    const defaultTag = providerToTag(provider);
    for (const route of routes) {
      const method = route.method.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;

      const oaPath = toOpenApiPath(route.path);
      const pathItem = paths[oaPath] ??= {};
      const meta = route._openapi ?? {};

      const tag = meta.tag ?? defaultTag;
      const tagsForOp = meta.tags ?? [tag];
      for (const t of tagsForOp) tagSet.add(t);

      // Combinar path params con los explícitos del meta
      const pathParams = extractPathParams(route.path);
      const explicitParams = meta.parameters ?? [];
      const paramByName = new Map<string, OpenApiParameter>();
      for (const p of pathParams) paramByName.set(p.name, p);
      for (const p of explicitParams) paramByName.set(p.name, p);

      const operation: OpenApiOperation = {
        ...(meta.summary ? { summary: meta.summary } : {}),
        ...(meta.description ? { description: meta.description } : {}),
        operationId: meta.operationId ?? `${method}${oaPath.replace(/[^a-zA-Z0-9]/g, "")}`,
        tags: tagsForOp,
        parameters: paramByName.size > 0 ? [...paramByName.values()] : undefined,
        ...(meta.requestBody ? { requestBody: meta.requestBody } : {}),
        responses: meta.responses ?? defaultResponses(method),
        security: meta.security ?? defaultSecurity(
          Boolean(meta.requestBody || method === "post" || method === "put" || method === "patch"),
        ),
        ...(meta.deprecated ? { deprecated: true } : {}),
      };

      pathItem[method] = operation;
    }
  }

  // 3. Recolectar schemas adicionales del state (`_openapi_schemas`)
  const stateSchemas = (state._openapi_schemas as Record<string, OpenApiSchema> | undefined) ?? {};
  const schemas: Record<string, OpenApiSchema> = {};
  if (includeBuiltin) Object.assign(schemas, BUILTIN_SCHEMAS);
  Object.assign(schemas, stateSchemas, options.additionalSchemas ?? {});

  // 4. Security schemes
  const securitySchemes: Record<string, OpenApiSecurityScheme> = {
    ...BUILTIN_SECURITY_SCHEMES,
    ...(options.additionalSecuritySchemes ?? {}),
  };

  // 5. Tags
  const tagDescriptions: Record<string, string> = {
    ...BUILTIN_TAG_DESCRIPTIONS,
    ...(options.additionalTagDescriptions ?? {}),
  };
  const tags = [...tagSet]
    .sort()
    .map((name) => ({
      name,
      ...(tagDescriptions[name] ? { description: tagDescriptions[name] } : {}),
    }));

  // 6. Spec final
  const spec: OpenApiSpec = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Zenith API",
      version: options.version ?? "1.0.0",
      ...(options.description ? { description: options.description } : {}),
      ...(options.appId ? { "x-app-id": options.appId } : {}),
    },
    tags,
    paths,
    components: {
      schemas,
      securitySchemes,
      parameters: {},
    },
  };

  if (options.serverURL) {
    spec.servers = [{ url: options.serverURL, description: "Production" }];
  }

  return spec;
}

/**
 * Helper de compatibilidad: extrae todas las routes del state sin generar
 * un spec completo. Útil para tooling (linting, dashboards de coverage).
 */
export function extractAllRoutes(state: ZenithState): Array<{
  provider: string;
  method: string;
  path: string;
  hasMetadata: boolean;
}> {
  const out: Array<{ provider: string; method: string; path: string; hasMetadata: boolean }> = [];
  for (const [key, value] of Object.entries(state)) {
    if (!key.endsWith("_routes")) continue;
    if (!isRoutesArray(value)) continue;
    for (const r of value) {
      out.push({
        provider: key,
        method: r.method,
        path: r.path,
        hasMetadata: Boolean(r._openapi),
      });
    }
  }
  return out;
}
