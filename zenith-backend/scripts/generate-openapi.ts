/**
 * Writes ./swagger.json: the OpenAPI 3.1 spec of the engine with its default features, generated
 * from the routes the router mounts (src/openapi.ts → core/route-collection.ts).
 *
 *   deno run -A --unstable-kv scripts/generate-openapi.ts [--all-features]
 *
 * Before 2026-11-10 this script copied an old barrits generator and read `.barrits/build-manifest.json`,
 * which lists no routes, so swagger.json had 0 paths. For a project, use `zen generate openapi`.
 */
import { generateProjectOpenApi } from "../src/openapi.ts";

const ALL_FEATURES = {
  saas: true, ai: true, ecommerce: true, gdpr: true, edge: true, events: true, web3: true, federation: true,
  e2ee_media: true, vectordb: true, iot: true, agents: true, timeseries: true, workflow: true,
  multiTenant: true, compliance: true, push: true,
};

const all = Deno.args.includes("--all-features");
const spec = generateProjectOpenApi(
  { appId: "zenith", features: all ? ALL_FEATURES : {} },
  { title: "Zenith API", version: "1.0.0", serverURL: "http://localhost:1337" },
);
const paths = spec.paths as Record<string, Record<string, unknown>>;
const ops = Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0);
await Deno.writeTextFile("./swagger.json", JSON.stringify(spec, null, 2) + "\n");
console.log(`swagger.json: ${ops} operations in ${Object.keys(paths).length} paths${all ? " (all features)" : ""}.`);
Deno.exit(0);
