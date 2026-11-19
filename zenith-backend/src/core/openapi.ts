/**
 * @module @zenith/core/openapi
 *
 * Public API: `generateOpenApiSchema(engine, options)`.
 *
 * Internamente delega a `generateOpenApiFromState` (en `./openapi-generator.ts`)
 * que implementa la detección automática de `*_routes` arrays — la misma
 * fuente de verdad que el router HTTP de Barrits.
 */

import { generateOpenApiFromState } from "./openapi-generator.ts";
import { collectTraitRoutes, hasTraitHealthRoute, HEALTH_ROUTE } from "./route-collection.ts";
import { apiKeyRouteSpecs } from "../security/api-keys/routes.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Metadata and extra routes of a generated OpenAPI 3.1 spec. */
export interface OpenApiOptions {
  /** `info.title` (default `Zenith API`). */
  title?: string;
  /** `info.description`; omitted when not given. */
  description?: string;
  /** `info.version` (default `1.0.0`). */
  version?: string;
  /** Base URL listed under `servers`; no `servers` entry when not given. */
  serverURL?: string;
  /** App id, written to `info["x-app-id"]`. */
  appId?: string;
  /** Tag descriptions added to (or overriding) the built-in ones, by tag name. */
  additionalTagDescriptions?: Record<string, string>;
  /** Routes outside the traits (`/health`, `/zen/api-keys`); by default, the engine's own. */
  extraRoutes?: Array<{ method: string; path: string; [key: string]: unknown }>;
}

/**
 * The routes the server mounts outside the traits: `/zen/api-keys`, and the minimal `/health`
 * when no trait serves one (as `buildDynamicRouter` decides).
 */
export function coreRoutes(
  engine: Record<string, unknown> = {},
): Array<{ method: string; path: string; [key: string]: unknown }> {
  return [
    ...(hasTraitHealthRoute(collectTraitRoutes(engine)) ? [] : [HEALTH_ROUTE]),
    ...apiKeyRouteSpecs(),
  ];
}

interface RouteEntry {
  method: string;
  path: string;
  handler?: unknown;
}

// ─── Schema Definitions for Zenith Objects ────────────────────────────────────

// deno-lint-ignore no-unused-vars
const ZENITH_SCHEMAS: Record<string, unknown> = {
  ZenithObject: {
    type: "object",
    properties: {
      objectId: { type: "string", example: "xWMyZ4YYGX" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ZenithUser: {
    type: "object",
    properties: {
      objectId: { type: "string" },
      username: { type: "string" },
      email: { type: "string", format: "email" },
      sessionToken: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ZenithSession: {
    type: "object",
    properties: {
      sessionToken: { type: "string" },
      sub: { type: "string" },
      username: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
    },
  },
  ZenithError: {
    type: "object",
    properties: {
      code: { type: "integer", example: 101 },
      error: { type: "string", example: "Invalid username/password." },
    },
  },
  CloudFunctionResult: {
    type: "object",
    properties: {
      result: {},
    },
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
  MediaStreamResult: {
    type: "object",
    properties: {
      streamId: { type: "string" },
      status: { type: "string", enum: ["live", "stopped", "connected"] },
      protocol: { type: "string", enum: ["webrtc", "hls", "srt"] },
      signaling: { type: "object" },
    },
  },
};

// ─── Path Template Converter (Barrits → OpenAPI) ─────────────────────────────

// deno-lint-ignore no-unused-vars
function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
}

// deno-lint-ignore no-unused-vars
function extractPathParams(path: string): unknown[] {
  const params: unknown[] = [];
  const matches = path.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
  for (const m of matches) {
    params.push({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
      example: m[1] === "objectId" ? "xWMyZ4YYGX" : m[1] === "className" ? "GameScore" : m[1],
    });
  }
  return params;
}

// ─── Per-Route Metadata (summary, tags, requestBody, responses) ───────────────

interface RouteSpec {
  summary: string;
  description: string;
  tags: string[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
  security?: unknown[];
}

// deno-lint-ignore no-unused-vars
const AUTH_HEADER_PARAMS = [
  {
    name: "Zen-Application-Id",
    in: "header",
    required: true,
    schema: { type: "string" },
    description: "Application ID (alias: X-Parse-Application-Id)",
  },
  {
    name: "Zen-Master-Key",
    in: "header",
    schema: { type: "string" },
    description: "Master Key — bypasses ACL (alias: X-Parse-Master-Key)",
  },
  {
    name: "Authorization",
    in: "header",
    schema: { type: "string", example: "Bearer <sessionToken>" },
    description: "JWT Session Token (alias: X-Parse-Session-Token)",
  },
];

// deno-lint-ignore no-unused-vars
function routeSpec(method: string, path: string): RouteSpec {
  const m = method.toUpperCase();

  // ── Users & Auth ────────────────────────────────────────────────
  if (path === "/users" && m === "POST") {
    return {
      summary: "Sign Up (Register User)",
      description:
        "Creates a new user. Supports classic username/password and OAuth `authData` (Google, Apple, Facebook).",
      tags: ["Auth"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                username: { type: "string", example: "john_doe" },
                password: { type: "string", example: "s3cr3t" },
                email: { type: "string", format: "email" },
                authData: {
                  type: "object",
                  description: "OAuth data (e.g. { google: { id, access_token } })",
                },
              },
              required: ["username"],
            },
          },
        },
      },
      responses: {
        "201": {
          description: "User created",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithUser" } },
          },
        },
        "400": {
          description: "Validation error",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithError" } },
          },
        },
      },
    };
  }

  if (path === "/login" && m === "POST") {
    return {
      summary: "Log In",
      description:
        "Authenticates a user with username/password or `authData`. Returns a signed JWT session token.",
      tags: ["Auth"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                username: { type: "string" },
                password: { type: "string" },
                authData: { type: "object" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Login successful",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithUser" } },
          },
        },
        "401": {
          description: "Invalid credentials",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithError" } },
          },
        },
      },
    };
  }

  if (path === "/logout" && m === "POST") {
    return {
      summary: "Log Out",
      description:
        "Invalidates the current session token and removes the session from the database.",
      tags: ["Auth"],
      responses: { "200": { description: "Logged out successfully" } },
    };
  }

  if (path === "/sessions/me" && m === "GET") {
    return {
      summary: "Get Current Session",
      description: "Returns the decoded JWT payload for the currently authenticated user.",
      tags: ["Auth"],
      responses: {
        "200": {
          description: "Session info",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithSession" } },
          },
        },
        "401": {
          description: "Unauthorized",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithError" } },
          },
        },
      },
    };
  }

  if (path === "/requestPasswordReset" && m === "POST") {
    return {
      summary: "Request Password Reset",
      description:
        "Sends a password reset link to the user's email. Silent success to prevent email enumeration.",
      tags: ["Auth"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { email: { type: "string", format: "email" } },
              required: ["email"],
            },
          },
        },
      },
      responses: { "200": { description: "Reset email sent (if account exists)" } },
    };
  }

  // ── CRUD ────────────────────────────────────────────────────────
  if (path === "/classes/:className" && m === "GET") {
    return {
      summary: "Query Objects",
      description:
        "Queries objects with full Parse-compatible filtering: `where`, `limit`, `skip`, `order`, `keys`, `include`, `count`.",
      tags: ["REST CRUD"],
      responses: {
        "200": {
          description: "Query results",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: { "$ref": "#/components/schemas/ZenithObject" },
                  },
                  count: { type: "integer" },
                },
              },
            },
          },
        },
      },
    };
  }

  if (path === "/classes/:className" && m === "POST") {
    return {
      summary: "Create Object",
      description:
        "Inserts a new object into the specified class. Runs `beforeSave` and `afterSave` Cloud Code triggers.",
      tags: ["REST CRUD"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: true,
              example: { score: 1337, playerName: "John" },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Object created",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithObject" } },
          },
        },
      },
    };
  }

  if (path === "/classes/:className/:objectId" && m === "GET") {
    return {
      summary: "Get Object by ID",
      description: "Retrieves a single object. Supports `include` for pointer resolution.",
      tags: ["REST CRUD"],
      responses: {
        "200": {
          description: "Object found",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithObject" } },
          },
        },
        "404": {
          description: "Not found",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithError" } },
          },
        },
      },
    };
  }

  if (path === "/classes/:className/:objectId" && m === "PUT") {
    return {
      summary: "Update Object",
      description:
        "Partially updates an object. Runs `beforeSave`/`afterSave` triggers with original object for diffing.",
      tags: ["REST CRUD"],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      responses: {
        "200": {
          description: "Updated",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/ZenithObject" } },
          },
        },
      },
    };
  }

  if (path === "/classes/:className/:objectId" && m === "DELETE") {
    return {
      summary: "Delete Object",
      description:
        "Deletes an object. Runs `beforeDelete`/`afterDelete` triggers. Broadcasts to LiveQuery and Federation.",
      tags: ["REST CRUD"],
      responses: { "200": { description: "Deleted" } },
    };
  }

  if (path === "/batch" && m === "POST") {
    return {
      summary: "Batch Operations",
      description:
        "Executes multiple REST operations atomically in a single HTTP request. Parse Server compatible.",
      tags: ["REST CRUD"],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { "$ref": "#/components/schemas/BatchRequest" } },
        },
      },
      responses: { "200": { description: "Batch results array" } },
    };
  }

  // ── Cloud Code ──────────────────────────────────────────────────
  if (path === "/functions/:functionName" && m === "POST") {
    return {
      summary: "Invoke Cloud Function",
      description:
        "Calls a registered Cloud Function. Runs validator (requireUser, fields, roles) before execution. Parse Server compatible.",
      tags: ["Cloud Code"],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true, example: { name: "World" } },
          },
        },
      },
      responses: {
        "200": {
          description: "Function result",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/CloudFunctionResult" } },
          },
        },
      },
    };
  }

  if (path === "/jobs/:jobName" && m === "POST") {
    return {
      summary: "Run Background Job",
      description:
        "Enqueues a background job for async execution. **Master Key required.** Returns immediately with job ID.",
      tags: ["Cloud Code"],
      security: [{ MasterKey: [] }],
      responses: {
        "202": {
          description: "Job accepted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string" }, jobId: { type: "string" } },
              },
            },
          },
        },
      },
    };
  }

  // ── Storage ─────────────────────────────────────────────────────
  if (m === "POST" && path.includes("/storage/upload")) {
    return {
      summary: "Upload File",
      description:
        "Uploads a file to the RustFS/S3 storage adapter. Runs `beforeSaveFile` and `afterSaveFile` triggers.",
      tags: ["File Storage"],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: { file: { type: "string", format: "binary" }, name: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "File uploaded",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, url: { type: "string" } },
              },
            },
          },
        },
      },
    };
  }

  // ── Media ────────────────────────────────────────────────────────
  if (m === "POST" && path === "/media/publish") {
    return {
      summary: "Publish Media Stream (WHIP)",
      description:
        "Initiates a new media stream. Supports WebRTC (WHIP protocol). Runs `beforePublish` Cloud Code trigger.",
      tags: ["Media Streaming"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                protocol: { type: "string", enum: ["webrtc", "hls"] },
                record: { type: "boolean" },
                streamId: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Stream created",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/MediaStreamResult" } },
          },
        },
      },
    };
  }

  if (m === "POST" && path === "/media/watch/:streamId") {
    return {
      summary: "Watch Stream (WHEP)",
      description:
        "Subscribes to an active stream. Returns WebRTC signaling info. Runs `beforeWatch` trigger.",
      tags: ["Media Streaming"],
      responses: {
        "200": {
          description: "Stream info",
          content: {
            "application/json": { schema: { "$ref": "#/components/schemas/MediaStreamResult" } },
          },
        },
      },
    };
  }

  if (m === "GET" && path === "/media/streams") {
    return {
      summary: "List Active Streams",
      description: "Returns all currently active media streams. Useful for admin dashboards.",
      tags: ["Media Streaming"],
      responses: {
        "200": {
          description: "Active streams",
          content: {
            "application/json": {
              schema: { type: "object", properties: { results: { type: "array" } } },
            },
          },
        },
      },
    };
  }

  if (m === "POST" && path === "/media/stop/:streamId") {
    return {
      summary: "Stop Stream",
      description: "Stops an active media stream. Only the publisher can stop their own stream.",
      tags: ["Media Streaming"],
      responses: { "200": { description: "Stream stopped" } },
    };
  }

  // ── GraphQL ──────────────────────────────────────────────────────
  if (path === "/graphql") {
    return {
      summary: "GraphQL Endpoint",
      description:
        "Executes GraphQL queries and mutations. Schema is auto-generated from all registered Zenith classes. Supports introspection.",
      tags: ["GraphQL"],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { "$ref": "#/components/schemas/GraphQLRequest" } },
        },
      },
      responses: { "200": { description: "GraphQL response" } },
    };
  }

  // ── Schema ───────────────────────────────────────────────────────
  if (path === "/schemas" && m === "GET") {
    return {
      summary: "List All Schemas",
      description:
        "Returns all class schemas registered in the Zenith engine. **Master Key recommended.**",
      tags: ["Schema Management"],
      responses: { "200": { description: "Schema list" } },
    };
  }

  if (path === "/schemas/:className" && m === "GET") {
    return {
      summary: "Get Class Schema",
      description: "Returns the schema definition for a specific class.",
      tags: ["Schema Management"],
      responses: { "200": { description: "Schema definition" } },
    };
  }

  // ── Realtime ─────────────────────────────────────────────────────
  if (path === "/live" || path === "/realtime") {
    return {
      summary: "LiveQuery WebSocket",
      description:
        "WebSocket endpoint for real-time subscriptions. Connect and send `{ op: 'subscribe', query: {...} }`. Receives `create/update/delete` events.",
      tags: ["Real-time"],
      responses: { "101": { description: "WebSocket Upgrade" } },
    };
  }

  // ── Observability ────────────────────────────────────────────────
  if (path.includes("/health") || path.includes("/metrics") || path.includes("/observability")) {
    return {
      summary: "Health / Metrics",
      description: "OpenTelemetry metrics and health check endpoint.",
      tags: ["Observability"],
      responses: { "200": { description: "Metrics data" } },
    };
  }

  // ── OpenAPI itself ───────────────────────────────────────────────
  if (path === "/openapi.json") {
    return {
      summary: "OpenAPI Spec",
      description: "Returns this OpenAPI v3.1 specification as JSON.",
      tags: ["Meta"],
      responses: { "200": { description: "OpenAPI spec JSON" } },
    };
  }

  if (path === "/swagger") {
    return {
      summary: "Swagger UI",
      description: "Interactive Swagger UI for this Zenith API.",
      tags: ["Meta"],
      responses: { "200": { description: "Swagger HTML page" } },
    };
  }

  // ── Fallback ─────────────────────────────────────────────────────
  return {
    summary: `${m} ${path}`,
    description: "Auto-generated from Barrits trait descriptor.",
    tags: ["Other"],
    responses: { "200": { description: "Success" } },
  };
}

// ─── Main Generator ───────────────────────────────────────────────────────────

/**
 * Generates an OpenAPI v3.1 specification from the Zenith engine's
 * composed route capabilities (the `*_routes` arrays from all traits).
 *
 * Uses `generateOpenApiFromState` from `./openapi-generator.ts` which detects
 * routes dynamically from any `*_routes` array in the engine state.
 *
 * This wrapper preserves the original API signature for backward compatibility
 * and adds Zenith-specific extras: meta routes, contact info, global security,
 * and Zenith-specific tag descriptions.
 */
export function generateOpenApiSchema(
  engine: Record<string, unknown>,
  options: OpenApiOptions = {},
): Record<string, unknown> {
  const {
    title = "Zenith BaaS API",
    description =
      "Auto-generated from Barrits Trait AST. Parse Server–compatible Backend-as-a-Service.",
    version = "1.0.0",
    serverURL = "http://localhost:23614",
    appId = "zenith",
  } = options;

  // 1. Generar spec base con el generador AST-based
  const spec = generateOpenApiFromState(engine, {
    title,
    description,
    version,
    serverURL,
    appId,
    extraRoutes: options.extraRoutes ?? coreRoutes(engine),
    additionalTagDescriptions: {
      ...BUILTIN_ZENITH_TAGS,
      ...options.additionalTagDescriptions,
    },
  });

  // 2. Override de info con datos de Zenith (incluye contact)
  (spec.info as Record<string, unknown>).contact = {
    name: "Zenith Platform",
    url: "https://github.com/zuccadev-labs/zenith",
  };

  // 3. Agregar las meta routes /openapi.json y /swagger
  spec.paths["/openapi.json"] = {
    get: {
      operationId: "get_openapi_json",
      summary: "OpenAPI Spec (JSON)",
      description: "Returns the full OpenAPI v3.1 spec for this Zenith instance.",
      tags: ["Meta"],
      parameters: [],
      responses: { "200": { description: "OpenAPI JSON spec" } },
    },
  };

  spec.paths["/swagger"] = {
    get: {
      operationId: "get_swagger_ui",
      summary: "Swagger UI",
      description: "Interactive Swagger documentation UI.",
      tags: ["Meta"],
      parameters: [],
      responses: { "200": { description: "HTML Swagger UI" } },
    },
  };

  // 4. Agregar tag "Meta" si no existe
  if (!spec.tags.find((t) => t.name === "Meta")) {
    spec.tags.push({ name: "Meta", description: "API spec and documentation" });
  }

  // 5. Security schemes adicionales Parse-Server compat (SessionToken alias, etc.)
  spec.components.securitySchemes.SessionToken = {
    type: "apiKey",
    in: "header",
    name: "Authorization",
    description:
      "JWT Session Token: `Bearer <token>` o `Zen-Session-Token` / `X-Parse-Session-Token`",
  };
  spec.components.securitySchemes.JavaScriptKey = {
    type: "apiKey",
    in: "header",
    name: "Zen-JavaScript-Key",
    description: "Client-side SDK key. También aceptado como `X-Parse-JavaScript-Key`.",
  };
  spec.components.securitySchemes.RestApiKey = {
    type: "apiKey",
    in: "header",
    name: "Zen-Api-Key",
    description: "REST API key para integraciones M2M. También como `X-Parse-REST-API-Key`.",
  };

  return spec as unknown as Record<string, unknown>;
}

/** Tag descriptions específicas de Zenith (Parse-Server compat). */
const BUILTIN_ZENITH_TAGS: Record<string, string> = {
  Auth: "User registration, login, session management (Parse Server parity)",
  "REST CRUD": "Object CRUD con triggers, ACL, realtime broadcasting",
  "Cloud Code": "Cloud Functions (Zen.Cloud.define) y Background Jobs",
  "File Storage": "File upload/download vía RustFS/S3 adapter",
  "Media Streaming": "WebRTC WHIP/WHEP live streaming con SFrame E2EE",
  GraphQL: "Auto-generated dynamic GraphQL API",
  "Schema Management": "Class schema definition and introspection",
  "Real-time": "LiveQuery WebSocket subscriptions",
  Observability: "Health, metrics, OpenTelemetry",
  Meta: "API spec y documentation",
  "REST\u00a0CRUD": "Object CRUD con triggers, ACL, realtime broadcasting",
  "Cloud\u00a0Code": "Cloud Functions (Zen.Cloud.define) y Background Jobs",
  "File\u00a0Storage": "File upload/download vía RustFS/S3 adapter",
  "Media\u00a0Streaming": "WebRTC WHIP/WHEP live streaming con SFrame E2EE",
  "Schema\u00a0Management": "Class schema definition and introspection",
};
