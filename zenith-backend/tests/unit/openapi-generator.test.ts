/**
 * Tests del generador OpenAPI 3.1 desde el state compuesto de Barrits.
 *
 * Cobertura:
 *   - Detección automática de `*_routes` arrays
 *   - Path conversion :param → {param}
 *   - Tag derivation desde provider name
 *   - Metadata opcional via `_openapi`
 *   - Schema registry built-in
 *   - Security schemes
 *   - Default responses y security
 *   - Multiple traits agregando al mismo path
 *   - Empty state
 *   - Skip de methods inválidos
 */

// deno-lint-ignore-file no-unused-vars
import { assertEquals, assertExists, type assertStringIncludes, assertThrows } from "@std/assert";
import {
  extractAllRoutes,
  generateOpenApiFromState,
  type RouteEntry,
  type ZenithState,
} from "../../src/core/openapi-generator.ts";

Deno.test("openapi-generator: empty state produces valid empty spec", () => {
  const spec = generateOpenApiFromState({});
  assertEquals(spec.openapi, "3.1.0");
  assertEquals(spec.info.title, "Zenith API");
  assertEquals(spec.info.version, "1.0.0");
  assertEquals(Object.keys(spec.paths).length, 0);
  assertEquals(spec.tags.length, 0);
  // Built-in schemas + security schemes
  assertExists(spec.components.schemas.ZenithObject);
  assertExists(spec.components.schemas.ZenithError);
  assertExists(spec.components.schemas.ApiKey);
  assertExists(spec.components.schemas.PluginManifest);
  assertExists(spec.components.securitySchemes.apiKeyBearer);
  assertExists(spec.components.securitySchemes.masterKey);
});

Deno.test("openapi-generator: detects `*_routes` arrays automatically", () => {
  const state: ZenithState = {
    crud_routes: [
      { method: "GET", path: "/classes/:className", handler: () => new Response() },
      { method: "POST", path: "/classes/:className", handler: () => new Response() },
    ],
    user_routes: [
      { method: "POST", path: "/users", handler: () => new Response() },
    ],
  };
  const spec = generateOpenApiFromState(state);
  assertEquals(Object.keys(spec.paths).length, 2);
  assertExists(spec.paths["/classes/{className}"]);
  assertExists(spec.paths["/users"]);
  assertExists(spec.paths["/classes/{className}"].get);
  assertExists(spec.paths["/classes/{className}"].post);
  assertExists(spec.paths["/users"].post);
});

Deno.test("openapi-generator: derives tags from provider name", () => {
  const state: ZenithState = {
    crud_routes: [{ method: "GET", path: "/classes/:c", handler: () => null }],
    user_routes: [{ method: "POST", path: "/users", handler: () => null }],
    billing_routes: [{ method: "GET", path: "/billing/usage", handler: () => null }],
  };
  const spec = generateOpenApiFromState(state);
  const tagNames = spec.tags.map((t) => t.name).sort();
  assertEquals(tagNames, ["Billing", "CRUD", "User"]);
});

Deno.test("openapi-generator: extracts path params with examples", () => {
  const state: ZenithState = {
    crud_routes: [
      { method: "GET", path: "/classes/:className/:objectId", handler: () => null },
    ],
  };
  const spec = generateOpenApiFromState(state);
  const op = spec.paths["/classes/{className}/{objectId}"].get;
  assertEquals(op.parameters?.length, 2);
  const className = op.parameters?.find((p) => p.name === "className");
  const objectId = op.parameters?.find((p) => p.name === "objectId");
  assertEquals(className?.in, "path");
  assertEquals(className?.required, true);
  assertEquals(className?.example, "GameScore");
  assertEquals(objectId?.example, "xWMyZ4YYGX");
});

Deno.test("openapi-generator: respects _openapi metadata on routes", () => {
  const state: ZenithState = {
    billing_routes: [
      {
        method: "POST",
        path: "/billing/subscriptions",
        handler: () => null,
        _openapi: {
          summary: "Crear suscripción",
          description: "Crea una suscripción para un customer ID dado",
          tags: ["Subscriptions"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ApiKey" },
              },
            },
          },
          responses: {
            "201": { description: "Created" },
            "402": { description: "Payment Required" },
          },
          deprecated: false,
        },
      },
    ],
  };
  const spec = generateOpenApiFromState(state);
  const op = spec.paths["/billing/subscriptions"].post;
  assertEquals(op.summary, "Crear suscripción");
  assertEquals(op.description, "Crea una suscripción para un customer ID dado");
  assertEquals(op.tags, ["Subscriptions"]);
  assertExists(op.requestBody);
  assertEquals(op.requestBody?.required, true);
  assertEquals(op.responses["201"].description, "Created");
  assertEquals(op.responses["402"].description, "Payment Required");
});

Deno.test("openapi-generator: default responses per method", () => {
  const state: ZenithState = {
    t_routes: [
      { method: "GET", path: "/x", handler: () => null },
      { method: "POST", path: "/x", handler: () => null },
      { method: "PUT", path: "/x", handler: () => null },
      { method: "DELETE", path: "/x", handler: () => null },
    ],
  };
  const spec = generateOpenApiFromState(state);
  assertExists(spec.paths["/x"].get?.responses["200"]);
  assertExists(spec.paths["/x"].post?.responses["201"]);
  assertExists(spec.paths["/x"].put?.responses["200"]);
  assertExists(spec.paths["/x"].delete?.responses["204"]);
});

Deno.test("openapi-generator: security follows the route's access, like the router", () => {
  const state: ZenithState = {
    t_routes: [
      { method: "GET", path: "/closed", handler: () => null },
      { method: "GET", path: "/open", access: "public", handler: () => null },
      { method: "GET", path: "/users-only", access: "user", handler: () => null },
      { method: "GET", path: "/readable", access: "user", scope: "data:read", handler: () => null },
    ],
  };
  const spec = generateOpenApiFromState(state);
  // Unset access is "master", the router's default (ADR-013).
  assertEquals(spec.paths["/closed"].get.security, [{ masterKey: [] }]);
  assertEquals(spec.paths["/open"].get.security, []);
  // A user route without a scope does not accept API keys: sessions only.
  assertEquals(spec.paths["/users-only"].get.security, [{ sessionToken: [] }, { jwtRs256: [] }]);
  // With a scope, API keys too, and the scope is documented.
  assertEquals(spec.paths["/readable"].get.security, [
    { apiKeyBearer: ["data:read"] },
    { apiKeyHeader: ["data:read"] },
    { sessionToken: [] },
    { jwtRs256: [] },
  ]);
});

Deno.test("openapi-generator: kebab-case route capabilities are documented too", () => {
  const spec = generateOpenApiFromState({
    "crud-routes": [{ method: "GET", path: "/classes/:className" }],
  });
  assertExists(spec.paths["/classes/{className}"].get);
  assertEquals(spec.paths["/classes/{className}"].get.tags, ["CRUD"]);
});

Deno.test("openapi-generator: skips invalid HTTP methods", () => {
  const state: ZenithState = {
    t_routes: [
      { method: "GET", path: "/a", handler: () => null },
      { method: "FOO", path: "/b", handler: () => null } as unknown as RouteEntry,
      { method: "weird", path: "/c", handler: () => null } as unknown as RouteEntry,
    ],
  };
  const spec = generateOpenApiFromState(state);
  assertExists(spec.paths["/a"]);
  assertEquals(spec.paths["/b"], undefined);
  assertEquals(spec.paths["/c"], undefined);
});

Deno.test("openapi-generator: skips non-arrays and empty arrays", () => {
  const state: ZenithState = {
    a_routes: "not an array",
    b_routes: [],
    c_routes: [{ method: "GET", path: "/x", handler: () => null }],
    d_routes: [{ method: "GET" }] as unknown as RouteEntry[], // falta path
  };
  const spec = generateOpenApiFromState(state);
  assertEquals(Object.keys(spec.paths).length, 1);
  assertExists(spec.paths["/x"]);
});

Deno.test("openapi-generator: merges additional schemas and security", () => {
  const state: ZenithState = {
    t_routes: [{ method: "GET", path: "/x", handler: () => null }],
  };
  const spec = generateOpenApiFromState(state, {
    additionalSchemas: {
      Customer: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    additionalSecuritySchemes: {
      oauth2: {
        type: "oauth2",
        flows: { implicit: { authorizationUrl: "https://x", scopes: {} } },
      },
    },
  });
  assertExists(spec.components.schemas.Customer);
  assertExists(spec.components.securitySchemes.oauth2);
});

Deno.test("openapi-generator: reads _openapi_schemas from state", () => {
  const state: ZenithState = {
    _openapi_schemas: {
      Tenant: {
        type: "object",
        properties: { id: { type: "string" }, plan: { type: "string" } },
      },
    },
    t_routes: [{ method: "GET", path: "/x", handler: () => null }],
  };
  const spec = generateOpenApiFromState(state);
  assertExists(spec.components.schemas.Tenant);
});

Deno.test("openapi-generator: includeBuiltinSchemas=false excludes built-ins", () => {
  const spec = generateOpenApiFromState({}, { includeBuiltinSchemas: false });
  assertEquals(spec.components.schemas.ZenithObject, undefined);
  assertEquals(spec.components.schemas.ZenithError, undefined);
});

Deno.test("openapi-generator: serverURL becomes servers entry", () => {
  const spec = generateOpenApiFromState({}, { serverURL: "https://api.acme.com" });
  assertEquals(spec.servers?.length, 1);
  assertEquals(spec.servers?.[0].url, "https://api.acme.com");
});

Deno.test("openapi-generator: appId propagates to x-app-id", () => {
  const spec = generateOpenApiFromState({}, { appId: "zen-acme-prod" });
  assertEquals(spec.info["x-app-id"], "zen-acme-prod");
});

Deno.test("openapi-generator: operationId is auto-generated from method+path", () => {
  const state: ZenithState = {
    t_routes: [
      { method: "GET", path: "/users/:id", handler: () => null },
      { method: "POST", path: "/users", handler: () => null },
    ],
  };
  const spec = generateOpenApiFromState(state);
  assertEquals(spec.paths["/users/{id}"].get.operationId, "get_users_By_id");
  assertEquals(spec.paths["/users"].post.operationId, "post_users");
});

Deno.test("openapi-generator: explicit operationId wins over auto-generated", () => {
  const state: ZenithState = {
    t_routes: [{
      method: "GET",
      path: "/users",
      handler: () => null,
      _openapi: { operationId: "listUsers" },
    }],
  };
  const spec = generateOpenApiFromState(state);
  assertEquals(spec.paths["/users"].get.operationId, "listUsers");
});

Deno.test("openapi-generator: deprecated flag propagates", () => {
  const state: ZenithState = {
    t_routes: [{
      method: "GET",
      path: "/old",
      handler: () => null,
      _openapi: { deprecated: true },
    }],
  };
  const spec = generateOpenApiFromState(state);
  assertEquals(spec.paths["/old"].get.deprecated, true);
});

Deno.test("openapi-generator: handles realistic multi-trait state", () => {
  // Simula un state compuesto típico de Zenith
  const state: ZenithState = {
    crud_routes: [
      { method: "GET", path: "/classes/:className", handler: () => null },
      { method: "GET", path: "/classes/:className/:objectId", handler: () => null },
      { method: "POST", path: "/classes/:className", handler: () => null },
      { method: "PUT", path: "/classes/:className/:objectId", handler: () => null },
      { method: "DELETE", path: "/classes/:className/:objectId", handler: () => null },
    ],
    user_routes: [
      { method: "POST", path: "/users", handler: () => null },
      { method: "POST", path: "/login", handler: () => null },
      { method: "GET", path: "/users/me", handler: () => null },
    ],
    billing_routes: [
      { method: "GET", path: "/billing/usage", handler: () => null },
    ],
    webhook_routes: [
      {
        method: "POST",
        path: "/webhooks/:hookName",
        handler: () => null,
        _openapi: {
          summary: "Webhook entrante",
          description: "Verifica firma RSA-SHA256, despacha a Cloud Code",
          tags: ["Webhooks"],
        },
      },
    ],
  };
  const spec = generateOpenApiFromState(state, {
    title: "Acme CRM API",
    version: "2.0.0",
    serverURL: "https://api.acme.com",
    appId: "zen-acme",
  });

  // 5 paths diferentes
  assertEquals(Object.keys(spec.paths).length, 7);
  assertEquals(spec.info.title, "Acme CRM API");
  assertEquals(spec.info["x-app-id"], "zen-acme");
  assertEquals(spec.servers?.[0].url, "https://api.acme.com");

  // El webhook debe tener metadata rica
  const webhook = spec.paths["/webhooks/{hookName}"].post;
  assertEquals(webhook.summary, "Webhook entrante");
  assertEquals(webhook.tags, ["Webhooks"]);

  // El user_routes debe tener método POST con default response 201
  const userCreate = spec.paths["/users"].post;
  assertEquals(userCreate.responses["201"].description, "Created");

  // Tags únicos
  const tagNames = spec.tags.map((t) => t.name).sort();
  assertEquals(tagNames, ["Billing", "CRUD", "User", "Webhooks"]);
});

Deno.test("openapi-generator: extractAllRoutes helper", () => {
  const state: ZenithState = {
    crud_routes: [
      { method: "GET", path: "/a", handler: () => null },
      {
        method: "POST",
        path: "/b",
        handler: () => null,
        _openapi: { summary: "rich metadata" },
      },
    ],
    user_routes: [
      { method: "POST", path: "/users", handler: () => null },
    ],
  };
  const all = extractAllRoutes(state);
  assertEquals(all.length, 3);
  assertEquals(all[0].provider, "crud_routes");
  assertEquals(all[0].hasMetadata, false);
  assertEquals(all[1].hasMetadata, true);
  assertEquals(all[2].provider, "user_routes");
});

Deno.test("openapi-generator: generated spec is valid OpenAPI 3.1 JSON", () => {
  const state: ZenithState = {
    t_routes: [{
      method: "POST",
      path: "/x",
      handler: () => null,
      _openapi: {
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ZenithObject" } },
          },
        },
      },
    }],
  };
  const spec = generateOpenApiFromState(state);
  const json = JSON.stringify(spec);
  const parsed = JSON.parse(json);
  assertEquals(parsed.openapi, "3.1.0");
  assertExists(parsed.paths["/x"].post);
  assertEquals(
    parsed.paths["/x"].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ZenithObject",
  );
});

Deno.test("openapi-generator: paths and security schemes are alphabetically stable", () => {
  // Diffs en git deben ser estables
  const state: ZenithState = {
    z_routes: [{ method: "GET", path: "/z", handler: () => null }],
    a_routes: [{ method: "GET", path: "/a", handler: () => null }],
    m_routes: [{ method: "GET", path: "/m", handler: () => null }, {
      method: "POST",
      path: "/a",
      handler: () => null,
    }],
  };
  const spec = generateOpenApiFromState(state);
  // Los tags están ordenados alfabéticamente
  const tagNames = spec.tags.map((t) => t.name);
  assertEquals(tagNames, [...tagNames].sort());
  // Pero los paths conservan orden de inserción (OpenAPI no requiere orden en paths)
  // Lo importante: regenerar el mismo state produce el mismo JSON
  const spec2 = generateOpenApiFromState(state);
  assertEquals(JSON.stringify(spec), JSON.stringify(spec2));
});

Deno.test("openapi-generator: a route declared twice fails instead of documenting one silently", () => {
  // The router serves only one of them; the spec must not hide which (fail-closed, barrits).
  const state: ZenithState = {
    a_routes: [{ method: "GET", path: "/x", handler: () => null }],
    b_routes: [{ method: "GET", path: "/x", handler: () => null }],
  };
  assertThrows(() => generateOpenApiFromState(state), Error, "Duplicated route GET /x");
});

Deno.test("openapi-generator: operationIds stay unique when paths differ only in punctuation", () => {
  const state: ZenithState = {
    a_routes: [{ method: "GET", path: "/zen/apikeys", handler: () => null }],
    b_routes: [{ method: "GET", path: "/zen/api-keys", handler: () => null }],
  };
  const spec = generateOpenApiFromState(state);
  assertEquals(spec.paths["/zen/apikeys"].get.operationId, "get_zen_apikeys");
  assertEquals(spec.paths["/zen/api-keys"].get.operationId, "get_zen_api_keys");
});

Deno.test("openapi-generator: path with same name in two providers merges HTTP methods", () => {
  // Si dos traits exponen rutas al mismo path, se mergean los métodos
  const state: ZenithState = {
    a_routes: [{ method: "GET", path: "/shared", handler: () => null }],
    b_routes: [{ method: "POST", path: "/shared", handler: () => null }],
  };
  const spec = generateOpenApiFromState(state);
  const shared = spec.paths["/shared"];
  assertExists(shared.get);
  assertExists(shared.post);
});

Deno.test("openapi-generator: explicit security overrides default", () => {
  const state: ZenithState = {
    t_routes: [{
      method: "GET",
      path: "/public",
      handler: () => null,
      _openapi: { security: [] }, // endpoint público
    }],
  };
  const spec = generateOpenApiFromState(state);
  assertEquals(spec.paths["/public"].get.security, []);
});

Deno.test("openapi-generator: webhook with body uses default request body schema", () => {
  const state: ZenithState = {
    webhook_routes: [{
      method: "POST",
      path: "/webhooks/:hookName",
      handler: () => null,
      _openapi: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  event: { type: "string" },
                  data: { type: "object" },
                },
              },
            },
          },
        },
      },
    }],
  };
  const spec = generateOpenApiFromState(state);
  const body = spec.paths["/webhooks/{hookName}"].post.requestBody;
  assertEquals(body.required, true);
  const schema = body?.content["application/json"].schema;
  assertEquals(schema?.properties.event.type, "string");
});
