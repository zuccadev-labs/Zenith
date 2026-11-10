/**
 * The OpenAPI spec documents exactly what the router mounts, with the access the router enforces.
 *
 * Before route-collection.ts the router mounted any key containing "routes" and the generator only
 * `*_routes`: 57 of 223 routes (default features) and 101 of 267 (all features) were missing from
 * /openapi.json, among them /classes, /login and /files.
 */
import { assertEquals } from "@std/assert";
import { selectTraits } from "../../src/mod.ts";
import { composeZenith } from "../../src/core/compose.ts";
import { buildDynamicRouter } from "../../src/core/router.ts";
import { generateOpenApiSchema } from "../../src/core/openapi.ts";
import { apiKeyRouteSpecs } from "../../src/security/api-keys/routes.ts";
import type { ZenithConfig } from "../../src/core/types.ts";

const ALL_FEATURES = {
  saas: true, ai: true, ecommerce: true, gdpr: true, edge: true, events: true, web3: true, federation: true,
  e2ee_media: true, vectordb: true, iot: true, agents: true, timeseries: true, workflow: true,
  multiTenant: true, compliance: true, push: true,
};

const toSpecPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function check(features: Record<string, boolean>) {
  const config = {
    appId: "parity", masterKey: "x".repeat(64), databaseURI: "mongodb://127.0.0.1:1/parity",
    topology: ["http", "runner", "ai", "graphql", "zeromq", "grpc"], features,
  } as unknown as ZenithConfig;
  const engine = composeZenith(selectTraits(config)).traits as Record<string, unknown>;

  // What the server mounts: the dynamic router plus the API key routes (server.trait.ts).
  const router = buildDynamicRouter(engine);
  for (const r of apiKeyRouteSpecs()) router.on(r.method as "GET", r.path, () => Promise.resolve(new Response()), r.access);
  // "*" matches every method; OpenAPI cannot say that, so it is not documented.
  const mounted = router.list().filter((r) => r.method !== "*");

  const spec = generateOpenApiSchema(engine) as { paths: Record<string, Record<string, { security?: unknown[] }>> };
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)),
  );

  const missing = mounted.map((r) => `${r.method} ${toSpecPath(r.path)}`).filter((k) => !documented.has(k));
  assertEquals(missing, [], "mounted but not documented");

  // /openapi.json and /swagger are added by mod.ts at boot; everything else must be mounted.
  const mountedKeys = new Set(mounted.map((r) => `${r.method} ${toSpecPath(r.path)}`));
  const phantom = [...documented].filter((k) => !mountedKeys.has(k) && !/ \/(openapi\.json|swagger)$/.test(k));
  assertEquals(phantom, [], "documented but not mounted");

  // Security follows access: public routes need nothing, master routes need the master key.
  for (const r of mounted) {
    const op = spec.paths[toSpecPath(r.path)][r.method.toLowerCase()];
    if (r.access === "public") assertEquals(op.security, [], `${r.method} ${r.path} is public`);
    if (r.access === "master") assertEquals(op.security, [{ masterKey: [] }], `${r.method} ${r.path} needs the master key`);
  }
  return mounted.length;
}

Deno.test("openapi parity: default features", () => {
  const n = check({});
  if (n < 200) throw new Error(`only ${n} routes mounted: the composition changed, review this test`);
});

Deno.test("openapi parity: all features", () => {
  check(ALL_FEATURES);
});
