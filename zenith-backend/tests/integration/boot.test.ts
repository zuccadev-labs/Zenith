/**
 * Zenith as it really starts: `selectTraits` + `composeZenith` for every topology, and
 * `createZenithApp` against MongoDB and the real engine-auth.
 *
 * The composition tests need nothing. The boot tests need, like engine-auth.test.ts:
 *   ZENITH_TEST_MONGO=mongodb://127.0.0.1:27999 ENGINE_AUTH_BIN=… ZUTOOL_LIB_DIR=…
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { createZenithApp, selectTraits } from "../../src/mod.ts";
import { composeZenith } from "../../src/core/compose.ts";
import { AUD, BIN, EngineAuth, LIB_DIR } from "./_engine_auth_lab.ts";

const MONGO = Deno.env.get("ZENITH_TEST_MONGO");
const PASSWORD = "otra frase larga para zenith";
const ALL_FEATURES = {
  saas: true, ai: true, ecommerce: true, gdpr: true, edge: true, events: true, web3: true, federation: true, graph: true,
  e2ee_media: true, vectordb: true, iot: true, agents: true, timeseries: true, workflow: true, multiTenant: true, compliance: true, push: true,
};

// ─── Composition ─────────────────────────────────────────────────────────────

for (const [name, config] of Object.entries({
  "only http": { topology: ["http"], features: {} },
  "default topology": { features: {} },
  "every topology and feature": { topology: ["http", "runner", "ai", "graphql", "zeromq", "grpc"], features: ALL_FEATURES },
  "scylla database": { databaseURI: "scylla://127.0.0.1:9042", features: {} },
})) {
  Deno.test(`composition: ${name}`, () => {
    const r = composeZenith(selectTraits({ appId: "a", masterKey: "m", ...config } as any));
    const caps = r.traits as Record<string, unknown>;
    for (const cap of ["db", "database-crud", "telemetry", "authentication", "ratelimit", "user-routes"]) {
      assert(cap in caps, `${cap} is provided`);
    }
  });
}

Deno.test("composition: providers are created before the traits that consume them", () => {
  const seen: string[] = [];
  const mk = (name: string, provides: string[], consumes: string[], tags: string[] = []) => ({
    name, provides, consumes, tags, requires: [], conflicts: [], state: [], runtimes: ["deno"], summary: name,
    create: (deps: any) => {
      for (const c of [...consumes, ...tags.map((t) => t.slice(5))]) seen.push(`${name}:${c}=${c in deps.traits}`);
      return Object.fromEntries(provides.map((p) => [p, {}]));
    },
  });
  // Alphabetical order would build "A" before "Z"; composeZenith must not.
  composeZenith([mk("A", ["a"], ["z"]), mk("B", ["b"], [], ["uses:z", "uses:absent"]), mk("Z", ["z"], [])]);
  assertEquals(seen.sort(), ["A:z=true", "B:absent=false", "B:z=true"]);
});

// ─── Boot ────────────────────────────────────────────────────────────────────

const ignore = !MONGO || !BIN || !LIB_DIR;

Deno.test({ name: "boot: createZenithApp on MongoDB with engine-auth — deny by default, Parse users, rate limits", ignore, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const ea = await EngineAuth.start();
  try {
    const appId = `boot${Date.now()}`;
    const master = crypto.randomUUID() + crypto.randomUUID();
    const { handler } = await createZenithApp({
      appId, masterKey: master, serverURL: "http://localhost:1/parse", port: 1,
      databaseURI: `${MONGO}/?directConnection=true`,
      features: {},
      engineAuth: {
        issuer: ea.url, clientId: "zenith", audience: AUD, libDir: LIB_DIR,
        sessionKey: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
      },
    } as any);
    assert(handler);
    const call = async (method: string, path: string, o: { body?: unknown; token?: string; master?: boolean; ip?: string } = {}) => {
      const headers: Record<string, string> = { "X-Parse-Application-Id": appId, "content-type": "application/json" };
      if (o.token) headers["X-Parse-Session-Token"] = o.token;
      if (o.master) headers["X-Parse-Master-Key"] = master;
      const req = new Request(`http://zenith.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      (req as any).__socketAddr = { hostname: o.ip ?? "198.51.100.30" };
      const r = await handler!(req);
      return { status: r.status, body: await r.json().catch(() => null) };
    };

    // Public, and nothing else for anonymous callers.
    assertEquals((await call("GET", "/health")).status, 200);
    assertEquals((await call("GET", "/openapi.json")).status, 200);
    for (const [m, p] of [["POST", "/shell/exec"], ["POST", "/runner/execute"], ["GET", "/classes/Anything"], ["DELETE", "/ratelimit/198.51.100.30"]]) {
      assertEquals((await call(m, p, m === "GET" ? {} : { body: {} })).status, 401, `${m} ${p} needs authentication`);
    }

    // Parse users through engine-auth, inside the real server.
    const su = await call("POST", "/users", { body: { username: "zeta", email: "zeta@example.test", password: PASSWORD } });
    assertEquals(su.status, 201, JSON.stringify(su.body));
    const token = su.body.sessionToken as string;
    assertMatch(token, /^r:/);
    assertEquals((await call("GET", "/users/me", { token })).body?.username, "zeta");

    // A signed-in user is still not the master key.
    const asUser = await call("DELETE", "/ratelimit/198.51.100.30", { token });
    assertEquals([asUser.status, asUser.body?.code], [403, 119]);
    assertEquals((await call("POST", "/shell/exec", { token, body: {} })).status, 403);

    // The master key, from the local network only.
    assertEquals((await call("GET", "/classes/Anything", { master: true, ip: "127.0.0.1" })).status, 200);
    assertEquals((await call("GET", "/classes/Anything", { master: true })).status, 401, "master key from outside is ignored");
    // A request whose client address is unknown is not local (it used to count as 0.0.0.0 = local).
    const blind = await handler!(new Request("http://zenith.test/classes/Anything", { headers: { "X-Parse-Application-Id": appId, "X-Parse-Master-Key": master } }));
    assertEquals(blind.status, 401, "master key without a known client address");

    // Brute force on /login is limited per client address, which a header cannot change.
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await call("POST", "/login", { body: { username: "nadie", password: "mal" }, ip: "203.0.113.50" });
      if (r.status === 429) limited++;
    }
    assert(limited >= 1, "the 11th attempt in a minute is refused");
    assertEquals((await call("POST", "/login", { body: { username: "zeta", password: PASSWORD }, ip: "203.0.113.51" })).status, 200, "other clients are not");
  } finally {
    await ea.stop();
  }
}});

Deno.test({ name: "db: the trait-facing API over Zenith's MongoDB adapter", ignore: !MONGO, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const { MongoClient } = await import("mongodb");
  const { createMongoAdapter } = await import("../../src/adapters/database/mongo.adapter.ts");
  const { createDb } = await import("../../src/traits/db/db.trait.ts");
  const client = await new MongoClient(MONGO!).connect();
  const mdb = client.db(`zenith_db_${Deno.pid}`);
  try {
    const db = createDb(() => createMongoAdapter(mdb) as any);
    const a = await db.create("Foo", { x: 1 });
    assert(a.objectId && a.createdAt);
    await db.create("Bar", { y: 2 });
    assertEquals(await db.listClasses(), ["Bar", "Foo"]);
    assertEquals((await db.read("Foo", a.objectId))?.x, 1);
    assertEquals((await db.update("Foo", { objectId: a.objectId }, { x: 5 }))?.x, 5);
    assertEquals((await db.update("Bar", { y: 2 }, { y: 3 }))?.y, 3, "update by filter");
    await db.upsert("Baz", { k: "a" }, { v: 1 });
    await db.upsert("Baz", { k: "a" }, { v: 2 });
    assertEquals((await db.find("Baz", { k: "a" })).map((d) => d.v), [2], "upsert updates instead of duplicating");
    assertEquals(await db.delete("Foo", { objectId: a.objectId }), { deleted: 1 });
    assertEquals(await db.read("Foo", a.objectId), null);
    assertEquals(await db.read("Foo", ""), null);
  } finally {
    await mdb.dropDatabase();
    await client.close();
  }
}});
