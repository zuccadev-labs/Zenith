import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTraitDescriptor } from "@zuccadev-labs/barrits";
import type { FeatureEntry } from "../../src/core/feature-catalog.ts";
import { FEATURE_STATE_CLASS, type RuntimeFeatures, runtimeFeaturesTrait } from "../../src/core/runtime-features.ts";
import { composeZenith } from "../../src/core/compose.ts";
import { buildDynamicRouter } from "../../src/core/router.ts";

const routesTrait = (name: string, cap: string, path: string) =>
  createTraitDescriptor({
    name,
    provides: [cap],
    consumes: [],
    state: [],
    runtimes: ["deno"],
    create: () => ({ [cap]: [{ method: "GET", path, access: "public", handler: () => new Response("ok") }] }),
  });

const Core = routesTrait("Core", "core_routes", "/core");
const Hooks = routesTrait("Hooks", "hooks_routes", "/hooks-demo");
const Child = routesTrait("Child", "child_routes", "/child");
const ENTRIES: FeatureEntry[] = [
  { id: "core", group: "core", required: true, summary: "core", traits: [Core] },
  { id: "hooks", group: "integrations", default: true, summary: "hooks", traits: [Hooks] },
  { id: "child", group: "integrations", default: true, requires: ["hooks"], summary: "child", traits: [Child] },
];
const CONFIG = { appId: "a" } as never;

/** In-memory db with the two calls the registry uses. */
function fakeDb() {
  const rows: Record<string, any>[] = [];
  return {
    rows,
    find: async (_c: string) => rows.map((r) => ({ ...r })),
    upsert: async (_c: string, where: { featureId: string }, data: Record<string, any>) => {
      const r = rows.find((x) => x.featureId === where.featureId);
      if (r) Object.assign(r, data);
      else rows.push({ ...data });
    },
  };
}

function boot(db?: unknown) {
  const traits: unknown[] = [runtimeFeaturesTrait(ENTRIES, CONFIG, { refreshMs: 3_600_000 }), Core, Hooks, Child];
  if (db) {
    traits.unshift(createTraitDescriptor({ name: "Db", provides: ["db"], consumes: [], state: [], runtimes: ["deno"], create: () => ({ db }) }));
  }
  const composition = composeZenith(traits);
  const router = buildDynamicRouter(composition as never).dispatch();
  const call = (path: string, method = "GET", body?: unknown) =>
    router(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), { masterKey: true } as never);
  return { registry: (composition.traits as any)["runtime-features"] as RuntimeFeatures, call };
}

Deno.test("runtime features: a feature turned off answers 404 until it is turned on, without restarting", async () => {
  const { call } = boot();
  assertEquals((await call("/hooks-demo")).status, 200);
  await call("/zen/features/child", "PUT", { enabled: false });
  const off = await call("/zen/features/hooks", "PUT", { enabled: false });
  assertEquals(off.status, 200);
  assertEquals((await off.json()).enabled, false);
  assertEquals((await call("/hooks-demo")).status, 404);
  assertEquals((await call("/core")).status, 200, "other features keep working");
  await call("/zen/features/hooks", "PUT", { enabled: true });
  assertEquals((await call("/hooks-demo")).status, 200);
});

Deno.test("runtime features: the core and dependencies are protected", async () => {
  const { registry } = boot();
  await assertRejects(() => registry.set("core", false), Error, "core");
  await assertRejects(() => registry.set("hooks", false), Error, "required by child");
  await registry.set("child", false);
  await registry.set("hooks", false);
  await assertRejects(() => registry.set("child", true), Error, "requires hooks");
  await assertRejects(() => registry.set("nope", true), Error);
  assertEquals(registry.list().map((f) => [f.id, f.enabled]), [["core", true], ["hooks", false], ["child", false]]);
});

Deno.test("runtime features: /zen/features lists every loaded feature and validates the body", async () => {
  const { call } = boot();
  const list = await (await call("/zen/features")).json();
  assertEquals(list.results.map((f: any) => f.id), ["core", "hooks", "child"]);
  assert(list.results[0].required);
  await assertRejects(async () => await call("/zen/features/hooks", "PUT", { enabled: "no" }), Error, "enabled");
});

Deno.test("runtime features: the state is saved and another instance picks it up", async () => {
  const db = fakeDb();
  const a = boot(db);
  await a.registry.set("child", false);
  assertEquals(db.rows, [{ featureId: "child", enabled: false, changedBy: "master" }]);
  assertEquals(FEATURE_STATE_CLASS, "_ZenithFeature");
  const b = boot(db);
  await b.registry.start();
  assertEquals(b.registry.isEnabled("child"), false);
  assertEquals((await b.call("/child")).status, 404);
});
