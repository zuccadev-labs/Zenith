import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  FeatureConfigError,
  type FeatureEntry,
  selectFeatures,
  traitsOf,
  validateCatalog,
} from "../../src/core/feature-catalog.ts";
import { FEATURE_CATALOG } from "../../src/traits/catalog.ts";
import { composeZenith } from "../../src/core/compose.ts";
import { selectTraits } from "../../src/mod.ts";

const quiet = () => {};
const ALL_TOPOLOGY = ["http", "runner", "ai", "graphql", "zeromq", "grpc"];
const allOn = Object.fromEntries(
  FEATURE_CATALOG.filter((e) => !e.required).map((e) => [e.feature ?? e.id, true]),
);
const names = (traits: unknown[]) => traits.map((t) => (t as { name: string }).name);

Deno.test("feature catalog: ids are unique, defaults declared, dependencies exist", () => {
  validateCatalog(FEATURE_CATALOG);
  assertThrows(
    () =>
      validateCatalog([{ id: "a", group: "core", summary: "", traits: [], default: true }, {
        id: "a",
        group: "core",
        summary: "",
        traits: [],
        default: true,
      }]),
    FeatureConfigError,
    "duplicated",
  );
  assertThrows(
    () => validateCatalog([{ id: "a", group: "core", summary: "", traits: [] }]),
    FeatureConfigError,
    "default",
  );
  assertThrows(
    () =>
      validateCatalog([{
        id: "a",
        group: "core",
        summary: "",
        traits: [],
        default: true,
        requires: ["b"],
      }]),
    FeatureConfigError,
    "unknown",
  );
});

Deno.test("feature catalog: every trait appears in exactly one feature", () => {
  const seen = new Map<unknown, string>();
  for (const e of FEATURE_CATALOG) {
    const traits = typeof e.traits === "function"
      ? [
        ...e.traits({ appId: "a" } as never),
        ...e.traits({ appId: "a", databaseURI: "scylla://x" } as never),
      ]
      : e.traits;
    for (const t of new Set(traits)) {
      assert(!seen.has(t), `${(t as { name: string }).name} is in "${seen.get(t)}" and "${e.id}"`);
      seen.set(t, e.id);
    }
  }
});

Deno.test("feature catalog: selectTraits keeps the boot order and defaults it had as an if-chain", () => {
  // Captured from the if-chain selectTraits before the catalog (2026-11-11), then: the event bus
  // became core (after ZenithDb), the process-level ZenithWebhook was retired and Parse's Cloud Code
  // Hooks were added (ADR-017), ZenithEnginePush (notices by zutool's engine-push socket) and
  // ZenithCells (cells / Durable Objects, ADR-019).
  const legacyDefault = [
    "ZenithDb",
    "ZenithEventBus",
    "ZenithRustFSAdapter",
    "ZenithCrypto",
    "ZenithSchemaManagement",
    "ZenithUserManagement",
    "ZenithMediaStream",
    "ZenithACL",
    "ZenithRateLimit",
    "ZenithRestCrud",
    "ZenithCloudCode",
    "ZenithFileStorage",
    "ZenithObservability",
    "ZenithMigration",
    "ZenithDatabaseMongo",
    "ZenithCoreServer",
    "ZenithRealtime",
    "ZenithGraphQL",
    "ZenithRunner",
    "ZenithShellAPI",
    "ZenithZeroMQ",
    "ZenithFeatureFlags",
    "ZenithCache",
    "ZenithEnginePush",
    "ZenithJobQueue",
    "ZenithCells",
    "ZenithCircuitBreaker",
    "ZenithCRMTrait",
    "ZenithERPTrait",
    "ZenithCollaboration",
    "ZenithWorkspace",
    "ZenithViews",
    "ZenithTimeline",
    "ZenithSearch",
    "ZenithMetadata",
    "ZenithBlogForum",
    "ZenithADKAgents",
    "ZenithPluginMarketplace",
    "ZenithNotifications",
    "ZenithFavoritesTags",
    "ZenithWebhookManager",
    "ZenithCloudHooks",
    "ZenithCSV",
    "ZenithEmailSync",
    "ZenithCalendarSync",
    "ZenithAutomation",
  ];
  const log = console.log;
  console.log = quiet;
  try {
    // Plus the runtime registry, first (runtime-features.ts).
    assertEquals(names(selectTraits({ appId: "a" } as never)), [
      "ZenithRuntimeFeatures",
      ...legacyDefault,
    ]);
    assertEquals(
      names(selectTraits({ appId: "a", databaseURI: "scylla://x" } as never)),
      [
        "ZenithRuntimeFeatures",
        ...legacyDefault.map((n) => n === "ZenithDatabaseMongo" ? "ZenithDatabaseScylla" : n),
      ],
    );
  } finally {
    console.log = log;
  }
});

Deno.test("feature catalog: legacy keys keep their meaning (agents, cache/queue/resilience on by default)", () => {
  const ids = (features: Record<string, boolean>) =>
    selectFeatures(FEATURE_CATALOG, { appId: "a", features } as never, quiet).map((e) => e.id);
  assert(ids({}).includes("agents.adk") && !ids({}).includes("agents.orchestrator"));
  assert(
    ids({ agents: true }).includes("agents.orchestrator") &&
      ids({ agents: true }).includes("agents.adk"),
  );
  assert(!ids({ agents: false }).includes("agents.adk"));
  for (const k of ["cache", "queue", "resilience", "webhooks", "crm"]) {
    assert(ids({}).includes(k), `${k} on by default`);
    assert(!ids({ [k]: false }).includes(k), `${k} can be turned off`);
  }
  assert(ids({ saas: true }).includes("billing"));
});

Deno.test("feature catalog: the core cannot be disabled; unknown keys are reported", () => {
  assertThrows(
    () => selectFeatures(FEATURE_CATALOG, { appId: "a", features: { acl: false } } as never, quiet),
    FeatureConfigError,
    "core",
  );
  const warnings: string[] = [];
  selectFeatures(
    FEATURE_CATALOG,
    { appId: "a", features: { webhoks: true } } as never,
    (m) => warnings.push(m),
  );
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("webhoks"));
});

Deno.test("feature catalog: an active feature whose dependency is disabled fails at boot, not at request time", () => {
  const cat: FeatureEntry[] = [
    { id: "base", group: "core", default: true, summary: "", traits: [] },
    { id: "child", group: "core", default: true, requires: ["base"], summary: "", traits: [] },
  ];
  assertEquals(selectFeatures(cat, { appId: "a" } as never).map((e) => e.id), ["base", "child"]);
  assertThrows(
    () => selectFeatures(cat, { appId: "a", features: { base: false } } as never),
    FeatureConfigError,
    "requires",
  );
  assertEquals(
    selectFeatures(cat, { appId: "a", features: { base: false, child: false } } as never).map((e) =>
      e.id
    ),
    [],
  );
});

Deno.test("feature catalog: each optional feature can be turned off alone and the engine still composes", () => {
  const log = console.log;
  console.log = quiet;
  try {
    for (const e of FEATURE_CATALOG.filter((x) => !x.required)) {
      const key = e.feature ?? e.id;
      const config = {
        appId: "a",
        masterKey: "m",
        topology: ALL_TOPOLOGY,
        features: { ...allOn, [key]: false },
      } as never;
      const features = selectFeatures(FEATURE_CATALOG, config, quiet);
      assert(!features.some((f) => (f.feature ?? f.id) === key), `${e.id} is off`);
      const r = composeZenith(traitsOf(features, config));
      for (const cap of ["db", "database-crud", "authentication", "user-routes"]) {
        assert(cap in (r.traits as object), `${cap} without ${e.id}`);
      }
    }
  } finally {
    console.log = log;
  }
});
